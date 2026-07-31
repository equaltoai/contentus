import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STATUS_BYTE_LIMIT, statusByteLength } from '../src/lib/compose/budget.ts';
import {
	LESSER_VISIBILITIES,
	fromLesserVisibility,
	toLesserVisibility,
} from '../src/lib/cms/visibility.ts';
import { loadHandler, renderRoute, withStubbedGraphql } from '../scripts/render-routes.mjs';

/**
 * Face 3 probes (M3.2–M3.5).
 *
 * Two kinds of assertion, and the split is deliberate. The contract-facing
 * logic — the visibility mapping and the byte budget — is tested directly,
 * because those two decide who can see a post and whether it will be accepted
 * at all, and a test with a bundler between it and the shipped code is a test
 * of the bundler too. Everything else runs against `build/server/handler.mjs`,
 * exactly as lesser's SSR host invokes it, because what ships is what the built
 * handler produces.
 */

const handler = await loadHandler();

const INSTANCE_HEADERS = {
	host: 'instance.example.com',
	'x-lesser-forwarded-host': 'instance.example.com',
	'x-lesser-forwarded-proto': 'https',
};

const SOURCE_ID = 'https://instance.example.com/objects/abc';

function sourceFixture(overrides = {}) {
	return {
		id: SOURCE_ID,
		content: '<p>SOURCE-BODY-SENTINEL</p>',
		visibility: 'PUBLIC',
		sensitive: false,
		spoilerText: null,
		createdAt: '2026-07-31T00:00:00Z',
		actor: { id: 'actor-1', username: 'ada', domain: null, displayName: 'Ada' },
		attachments: [{ id: 'media-1' }],
		agentAttribution: null,
		...overrides,
	};
}

function respondWithSource(source) {
	return ({ operation }) =>
		operation === 'ContentusSourceStatus' ? { data: { object: source } } : { data: null };
}

function composeRoute(path, fixtures = {}) {
	return withStubbedGraphql(respondWithSource(fixtures.source ?? null), () =>
		renderRoute(handler, { name: 'compose', path, headers: INSTANCE_HEADERS, expectStatus: 200 })
	);
}

/* -------------------------------------------------------------------------
 * Visibility: the field that decides who can see a post
 * ---------------------------------------------------------------------- */

test('the followers-only case is the only name that actually differs', () => {
	assert.equal(toLesserVisibility('public'), 'PUBLIC');
	assert.equal(toLesserVisibility('unlisted'), 'UNLISTED');
	assert.equal(toLesserVisibility('direct'), 'DIRECT');
	// greater speaks Mastodon's `private`; lesser's enum says FOLLOWERS.
	assert.equal(toLesserVisibility('private'), 'FOLLOWERS');
});

test('every lesser visibility round-trips through the compose vocabulary', () => {
	for (const visibility of LESSER_VISIBILITIES) {
		assert.equal(
			toLesserVisibility(fromLesserVisibility(visibility)),
			visibility,
			`${visibility} must survive the round trip`
		);
	}
});

test('an unmapped visibility narrows rather than widens', () => {
	// If the two vocabularies ever drift, the safe answer to "who should see
	// this" is fewer people. Defaulting to PUBLIC would turn a mapping bug into
	// a disclosure.
	assert.equal(toLesserVisibility('followers-only'), 'DIRECT');
	assert.equal(toLesserVisibility(''), 'DIRECT');
});

/* -------------------------------------------------------------------------
 * The byte budget: what lesser will actually accept
 * ---------------------------------------------------------------------- */

test('the budget counts UTF-8 bytes, which is what lesser measures', () => {
	// Go's len() over a string is bytes. JavaScript's .length is UTF-16 units.
	// They agree on ASCII and disagree on everything else.
	assert.equal(statusByteLength('hello'), 5);
	assert.equal(statusByteLength('é'), 2);
	assert.equal(statusByteLength('日'), 3);
	assert.equal(statusByteLength('🌍'), 4);
});

test('a post the character counter calls short can still exceed the budget', () => {
	// This is the exact case the composer's budget notice exists for: 200 emoji
	// are 400 UTF-16 units — comfortably under a 500 limit by the vendored
	// counter — and 800 bytes to the instance.
	const text = '🌍'.repeat(200);

	assert.ok(text.length < STATUS_BYTE_LIMIT, 'the vendored counter would call this under limit');
	assert.ok(
		statusByteLength(text) > STATUS_BYTE_LIMIT,
		'while lesser measures it as over the limit'
	);
});

test('the content warning is counted, because the composer counts it', () => {
	assert.equal(statusByteLength('ab', 'cd'), 4);
});

/* -------------------------------------------------------------------------
 * The route: four intents, one server-rendered surface
 * ---------------------------------------------------------------------- */

test('a cold deep link to /compose renders a complete composer', async () => {
	const { value } = await composeRoute('/l/compose');

	assert.equal(value.status, 200);
	assert.match(value.html, /class="compose-root/, 'the compound must have rendered');
	assert.match(value.html, /compose-visibility-select/, 'visibility is a first-class control');
	assert.match(value.html, /Content warning/, 'the CW control is on the surface');
	assert.match(value.html, /Mark as sensitive/, 'sensitive is its own control');
	assert.match(value.html, /compose-submit/, 'and there is something to press');
});

test('the composer renders for an anonymous visitor, and says why they cannot post', async () => {
	// The session lives in sessionStorage, so the server cannot know who is
	// asking. Rendering the form and stating the requirement beats a page that
	// flashes from "sign in" to a form a beat later.
	const { value } = await composeRoute('/l/compose');

	assert.match(value.html, /compose-editor/);
	assert.match(value.html, /Sign in to post/);
});

test('visibility and the content warning are not hidden behind a menu', async () => {
	const { value } = await composeRoute('/l/compose');

	// Product design §5 is explicit about this. `<select>` and a checkbox on
	// the surface, not entries in an overflow.
	assert.match(value.html, /<select[^>]*id="compose-visibility"/);
	assert.match(value.html, /type="checkbox"/);
});

test('a reply intent server-renders its target context', async () => {
	const { value, requests } = await composeRoute(
		`/l/compose?inReplyTo=${encodeURIComponent(SOURCE_ID)}`,
		{ source: sourceFixture() }
	);

	assert.equal(value.status, 200);
	assert.match(value.html, /Replying to/);
	assert.match(value.html, /@ada/);
	assert.ok(
		requests.some((request) => request.operation === 'ContentusSourceStatus'),
		'the server must have resolved the reply target'
	);
});

test('the reply-target lookup is anonymous, so an SSR document cannot leak', async () => {
	const { requests } = await composeRoute(`/l/compose?inReplyTo=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture(),
	});

	// No token is attached on the server pass by construction. A public status
	// resolves; anything narrower comes back null and the client fills it in
	// with the session token. That is what keeps a cached SSR document from
	// carrying a status its reader could not otherwise see.
	for (const request of requests) {
		assert.equal(
			request.url,
			'https://instance.example.com/api/graphql',
			'the server must talk to the edge-verified host'
		);
	}
});

test('the source body is never rendered into the composer', async () => {
	const { value } = await composeRoute(`/l/compose?inReplyTo=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture(),
	});

	// Object.content is what lesser's own sanitizer stored on write. Showing it
	// would take an {@html} sink in contentus-owned source, which the
	// renderer-authority audit blocks — and stripping tags client-side to make
	// a "safe preview" would be the same violation wearing a hat. The strip
	// states metadata and links out instead.
	assert.doesNotMatch(value.html, /SOURCE-BODY-SENTINEL/);
	assert.match(value.html, /Open the original/);
});

test('a quote intent is a quote, not a reply', async () => {
	const { value } = await composeRoute(`/l/compose?quote=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture(),
	});

	assert.match(value.html, /Quoting/);
	assert.doesNotMatch(value.html, /Replying to/);
});

test('an edit intent seeds the editor and hides what cannot be edited', async () => {
	const { value } = await composeRoute(`/l/compose?edit=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture({ content: 'the original words' }),
	});

	assert.match(value.html, /the original words/, 'the stored content seeds the editor');
	assert.match(value.html, /Save changes/, 'and the action says what it does');

	// UpdateStatusInput carries no visibility and no poll: a posted status keeps
	// its reach, and a poll with votes is not rewritten underneath them. So the
	// controls are absent rather than present-and-ignored.
	assert.doesNotMatch(value.html, /compose-visibility-select/);
	assert.doesNotMatch(value.html, /Add a poll/);
});

test('delete is offered only where there is something to delete', async () => {
	const editing = await composeRoute(`/l/compose?edit=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture(),
	});
	const fresh = await composeRoute('/l/compose');

	assert.match(editing.value.html, /Delete post/);
	assert.doesNotMatch(fresh.value.html, /Delete post/);
});

test('agent attribution is absent for a session that is not an agent', async () => {
	// lesser applies agentAttribution only when the caller's token carries agent
	// claims and drops it for everyone else, so offering the fields to every
	// poster would be attribution theatre. The server pass is anonymous, so the
	// panel must not be in the document at all.
	const { value } = await composeRoute('/l/compose');

	assert.doesNotMatch(value.html, /Posting as an agent/);
});

test('a malformed link carrying two intents resolves to exactly one', async () => {
	// Guessing which the caller meant would make the composer depend on
	// parameter order in a URL somebody else built. Edit wins, by declared rule.
	const { value } = await composeRoute(
		`/l/compose?inReplyTo=${encodeURIComponent(SOURCE_ID)}&edit=${encodeURIComponent(SOURCE_ID)}`,
		{ source: sourceFixture() }
	);

	assert.match(value.html, /Editing/);
	assert.doesNotMatch(value.html, /Replying to/);
});

test('the composer is a panel on desktop and a keyed sheet on mobile', async () => {
	const { value } = await composeRoute('/l/compose');

	// One document, two presentations. The Panel is the desktop chrome product
	// design §5 names; `data-page` is what the mobile rules key off.
	assert.match(value.html, /contentus-compose-panel/);
	assert.match(value.html, /gr-shell-panel__body/);
	assert.match(value.html, /data-page="compose"/);
	assert.match(value.html, /contentus-compose-close/, 'and the sheet has a way out');
});

test('hydration for a deep-linked reply resolves the same intent as the document', async () => {
	// Without the query string travelling to the hydration endpoint, a
	// deep-linked reply would hydrate into a blank new post.
	const { value } = await withStubbedGraphql(respondWithSource(sourceFixture()), () =>
		renderRoute(handler, {
			name: 'hydration',
			path: `/l/_facetheory/hydration?path=%2Fcompose&search=${encodeURIComponent(
				`inReplyTo=${SOURCE_ID}`
			)}`,
			headers: INSTANCE_HEADERS,
			expectStatus: 200,
		})
	);

	const props = JSON.parse(value.html);
	assert.equal(props.compose.intent.mode, 'reply');
	assert.equal(props.compose.intent.statusId, SOURCE_ID);
	assert.equal(props.compose.source.authorUsername, 'ada');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a cold deep link to /compose renders a complete page and no write control', async () => {
	// The server pass is anonymous by construction: the session lives in
	// sessionStorage. So the document it can honestly produce is the page and
	// its sign-in requirement — never a form that cannot post.
	const { value } = await composeRoute('/l/compose');

	assert.equal(value.status, 200);
	assert.match(value.html, /Sign in to post/, 'the requirement is stated');
	assert.match(value.html, /contentus-compose-panel/, 'inside the surface it will eventually fill');

	for (const [control, pattern] of [
		['the editor', /compose-editor/],
		['the compose form', /class="compose-root/],
		['the visibility select', /compose-visibility-select/],
		['the content warning', /Content warning/],
		['the sensitive toggle', /Mark as sensitive/],
		['the schedule control', /Schedule for later/],
		['the poll control', /Add a poll/],
		['the submit button', /compose-submit/],
	]) {
		assert.doesNotMatch(value.html, pattern, `${control} must not be in the anonymous document`);
	}
});

test('the anonymous visitor is offered the way in, not a form that cannot post', async () => {
	const { value } = await composeRoute('/l/compose');

	// `session` is `unknown` on the server — it has not read sessionStorage
	// because it cannot — so the button appears only after the client looks.
	// The requirement is stated either way.
	assert.match(value.html, /Sign in to post/);
	assert.match(value.html, /Posting requires an account on this instance/);

	// Scoped to the composer's own notice: the shell's sidebar carries a
	// sign-in button of its own, which is a different control with a different
	// rule. This one appears only once the client has read sessionStorage.
	const notice = value.html.slice(
		value.html.indexOf('class="contentus-notice"'),
		value.html.indexOf('</section>', value.html.indexOf('class="contentus-notice"'))
	);
	assert.ok(notice.length > 0, 'the notice must be in the document');
	assert.doesNotMatch(notice, /<button/, 'the server asserts no session state');
});

test('visibility and the content warning are first-class controls in the composer', () => {
	// A SOURCE-SHAPE assertion, and it says so. The controls are no longer in
	// the anonymous document — that is the point of the test above — and
	// `node --test` has no DOM to mount the authenticated composer in. What is
	// still checkable here is product design §5's actual claim: these two are
	// siblings on the composer surface rather than entries in an overflow menu.
	const source = readFileSync(new URL('../src/lib/routes/Compose.svelte', import.meta.url), 'utf8');
	const controls = source.slice(
		source.indexOf('<div class="contentus-compose-controls">'),
		source.indexOf('</div>', source.indexOf('<div class="contentus-compose-controls">'))
	);

	assert.ok(controls.length > 0, 'the controls row must exist');
	assert.match(controls, /<ComposeVisibilitySelect \/>/);
	assert.match(controls, /<ContentWarningField \/>/);
	assert.match(controls, /<SensitiveField \/>/);
	assert.doesNotMatch(source, /<details/, 'no control is folded behind a disclosure');
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

test('an edit intent server-renders its context and none of its actions', async () => {
	const { value } = await composeRoute(`/l/compose?edit=${encodeURIComponent(SOURCE_ID)}`, {
		source: sourceFixture({ content: 'the original words' }),
	});

	// The strip says what is being edited. The editor that would hold the
	// stored content, and the delete that would destroy it, are write intents:
	// they mount for a session, not for a cacheable anonymous document.
	assert.match(value.html, /Editing/);
	assert.doesNotMatch(
		value.html,
		/the original words/,
		'the stored content is not in the document'
	);
	assert.doesNotMatch(value.html, /Save changes/);
	assert.doesNotMatch(value.html, /Delete post/);
});

test('delete never appears in a document the server rendered', async () => {
	// Deleting is irreversible and federates. It is the last control that
	// should exist in a page the server produced without knowing who is asking.
	for (const path of ['/l/compose', `/l/compose?edit=${encodeURIComponent(SOURCE_ID)}`]) {
		const { value } = await composeRoute(path, { source: sourceFixture() });
		assert.doesNotMatch(value.html, /Delete post/, `${path} must not offer delete`);
	}
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { STATUS_BYTE_LIMIT, statusByteLength } from '../src/lib/compose/budget.ts';
import {
	AGENT_TRIGGER_DEFAULT,
	AGENT_TRIGGER_TYPES,
	createNoteVariables,
	scheduleStatusVariables,
	updateStatusVariables,
} from '../src/lib/cms/compose-inputs.ts';
import {
	LESSER_VISIBILITIES,
	fromLesserVisibility,
	normalizeVisibility,
	reachesWiderThan,
	seedVisibilityFrom,
	toLesserVisibility,
} from '../src/lib/cms/visibility.ts';
import { composeSeed } from '../src/lib/compose/seed.ts';
import { buildComposeSubmission } from '../src/lib/compose/submission.ts';
import {
	NO_CLIENT_SIZE_CEILING,
	PICKER_MEDIA_TYPES,
	rejectionMessage,
} from '../src/lib/compose/media-policy.ts';
import { loadHandler, renderRoute, withStubbedGraphql } from '../scripts/render-routes.mjs';

/**
 * Face 3 probes (M3.2–M3.5, extended in the PR #53 round-2 rework).
 *
 * THREE KINDS OF ASSERTION, and which one a claim gets is not arbitrary.
 *
 *   1. DIRECT, against dependency-free shipped modules. Everything that
 *      decides what goes over the wire — the visibility mapping and the reach
 *      rules, the seeds, the submit decision, the GraphQL variable builders,
 *      the byte budget — is loaded and called. No bundler stands between the
 *      assertion and the code, so these are claims about what ships.
 *   2. BUILT-HANDLER, against `build/server/handler.mjs`, invoked exactly as
 *      lesser's SSR host invokes it. What ships is what the handler produces,
 *      including whatever the vendored components emit.
 *   3. SOURCE-SHAPE, reading a file and asserting about its text. Weakest of
 *      the three and used only where the other two cannot reach — a browser
 *      API set on an XHR, the wiring between two tested functions inside a
 *      component. Every one of them says so in its own body.
 *
 * What no probe here claims is that the composer BEHAVES correctly in a
 * browser: `node --test` has no DOM, so the mounted composer is exercised
 * through its pure parts and its server-rendered document, and the rest is the
 * instance-verification step.
 */

/** A source status as the seeds read it, at whatever reach the case needs. */
function seedSource(visibility, overrides = {}) {
	return {
		visibility,
		content: 'the original words',
		sensitive: false,
		spoilerText: null,
		...overrides,
	};
}

/** The extras store as it stands at submit time, with nothing set. */
function emptyExtras(overrides = {}) {
	return {
		sensitive: false,
		attachmentIds: [],
		poll: null,
		scheduledAt: null,
		inReplyToId: null,
		quoteId: null,
		agentAttribution: null,
		editingStatusId: null,
		...overrides,
	};
}

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
 * Reach: a reply is never seeded wider than the post it answers (F1)
 * ---------------------------------------------------------------------- */

test('a reply seeds the reach of the post it answers, exactly', () => {
	// The defect this replaces: `defaultVisibility: 'public'`, hard-coded, for
	// every intent. A reader replying to a direct message sent it to everyone.
	assert.equal(seedVisibilityFrom('DIRECT'), 'direct');
	assert.equal(seedVisibilityFrom('FOLLOWERS'), 'private');
	assert.equal(seedVisibilityFrom('UNLISTED'), 'unlisted');
	assert.equal(seedVisibilityFrom('PUBLIC'), 'public');
});

test('an unreadable source reach seeds the narrowest, not the widest', () => {
	// `fromLesserVisibility` widens to public on an unknown value because it
	// only ever drove a control's initial selection. This one decides the reach
	// a post is actually sent at, so it does the opposite.
	assert.equal(fromLesserVisibility('who-knows'), 'public');
	assert.equal(seedVisibilityFrom('who-knows'), 'direct');
	assert.equal(seedVisibilityFrom(null), 'direct');
	assert.equal(seedVisibilityFrom(undefined), 'direct');
	assert.equal(seedVisibilityFrom(''), 'direct');
});

test('normalising a server reach keeps case but not nonsense', () => {
	assert.equal(normalizeVisibility('public'), 'PUBLIC');
	assert.equal(normalizeVisibility('Followers'), 'FOLLOWERS');
	assert.equal(normalizeVisibility('SOMETHING_NEW'), 'DIRECT');
});

test('wider means wider, in the contract order and no other', () => {
	assert.ok(reachesWiderThan('PUBLIC', 'DIRECT'));
	assert.ok(reachesWiderThan('PUBLIC', 'FOLLOWERS'));
	assert.ok(reachesWiderThan('UNLISTED', 'FOLLOWERS'));
	assert.ok(reachesWiderThan('FOLLOWERS', 'DIRECT'));

	// Equal is not wider, and narrower certainly is not.
	assert.ok(!reachesWiderThan('DIRECT', 'DIRECT'));
	assert.ok(!reachesWiderThan('PUBLIC', 'PUBLIC'));
	assert.ok(!reachesWiderThan('DIRECT', 'PUBLIC'));
	assert.ok(!reachesWiderThan('FOLLOWERS', 'UNLISTED'));
});

test('every intent seeds a reach no wider than its source', () => {
	// The invariant, checked over the whole cross product rather than the four
	// cases somebody thought to write down.
	for (const parent of LESSER_VISIBILITIES) {
		for (const mode of ['reply', 'quote']) {
			const seeded = toLesserVisibility(composeSeed(mode, seedSource(parent)).visibility);
			assert.ok(
				!reachesWiderThan(seeded, parent),
				`${mode} to ${parent} seeded ${seeded}, which is wider`
			);
		}
	}
});

test('a new post has no parent to inherit from and seeds public', () => {
	assert.equal(composeSeed('new', null).visibility, 'public');
});

/* -------------------------------------------------------------------------
 * The seeds, end to end into the GraphQL variables (F1, F2)
 * ---------------------------------------------------------------------- */

test('a reply to a DIRECT status sends DIRECT', () => {
	// Seed -> submit decision -> GraphQL variables, all shipped code. This is
	// the finding's exact scenario: the reader accepts the default and posts.
	const seed = composeSeed('reply', seedSource('DIRECT'));

	const submission = buildComposeSubmission({
		mode: 'reply',
		form: { content: 'answering you', visibility: seed.visibility },
		extras: emptyExtras({ inReplyToId: SOURCE_ID }),
	});

	assert.equal(submission.kind, 'create');

	const { input } = createNoteVariables(submission.input);
	assert.equal(input.visibility, 'DIRECT');
	assert.equal(input.inReplyToId, SOURCE_ID);
});

test('a reply to a FOLLOWERS status sends FOLLOWERS', () => {
	const seed = composeSeed('reply', seedSource('FOLLOWERS'));
	const submission = buildComposeSubmission({
		mode: 'reply',
		form: { content: 'answering you', visibility: seed.visibility },
		extras: emptyExtras({ inReplyToId: SOURCE_ID }),
	});

	assert.equal(createNoteVariables(submission.input).input.visibility, 'FOLLOWERS');
});

test('a scheduled reply carries the inherited reach too', () => {
	// The schedule path is a different mutation with a different input shape,
	// so the rule has to hold there separately or it does not hold.
	const seed = composeSeed('reply', seedSource('DIRECT'));
	const submission = buildComposeSubmission({
		mode: 'reply',
		form: { content: 'later', visibility: seed.visibility },
		extras: emptyExtras({ inReplyToId: SOURCE_ID, scheduledAt: '2026-08-01T00:00:00Z' }),
	});

	assert.equal(submission.kind, 'schedule');
	assert.equal(scheduleStatusVariables(submission.input).input.visibility, 'DIRECT');
});

test('a poster who widens past the parent still gets what they asked for', () => {
	// No clamp, on purpose: lesser accepts the reach the caller asks for, and a
	// client overriding an explicit choice would invent a rule the contract
	// does not have. `ReachNotice` is what makes the choice visible.
	const submission = buildComposeSubmission({
		mode: 'reply',
		form: { content: 'answering you', visibility: 'public' },
		extras: emptyExtras({ inReplyToId: SOURCE_ID }),
	});

	assert.equal(createNoteVariables(submission.input).input.visibility, 'PUBLIC');
	assert.ok(reachesWiderThan('PUBLIC', 'DIRECT'), 'and the notice condition is true for it');
});

test('an edit seeds the sensitive flag and the warning from the status', () => {
	const seed = composeSeed(
		'edit',
		seedSource('PUBLIC', { sensitive: true, spoilerText: 'spoilers for chapter 9' })
	);

	assert.equal(seed.content, 'the original words');
	assert.equal(seed.sensitive, true);
	assert.equal(seed.contentWarning, 'spoilers for chapter 9');
	assert.equal(seed.contentWarningEnabled, true);
});

test('leaving an edit alone changes neither the gate nor the warning', () => {
	// The F2 defect: an unseeded editor sent `sensitive: false` on every save,
	// silently ungating the media on a post whose author had gated it.
	const source = seedSource('PUBLIC', { sensitive: true, spoilerText: 'chapter 9' });
	const seed = composeSeed('edit', source);

	const submission = buildComposeSubmission({
		mode: 'edit',
		form: {
			content: seed.content,
			visibility: seed.visibility,
			contentWarning: seed.contentWarning,
		},
		extras: emptyExtras({ sensitive: seed.sensitive, editingStatusId: SOURCE_ID }),
	});

	assert.equal(submission.kind, 'update');

	const { id, input } = updateStatusVariables(submission.id, submission.input);
	assert.equal(id, SOURCE_ID);
	assert.equal(input.sensitive, true, 'the gate survives a save that did not touch it');
	assert.equal(input.spoilerText, 'chapter 9', 'and so does the warning');
});

test('removing the warning on an edit sends an explicit empty spoiler', () => {
	// lesser seeds `spoilerText` from the stored status and replaces it only
	// when the input carries the field, so an omitted empty warning leaves the
	// old one standing on a post whose composer showed none.
	const seed = composeSeed('edit', seedSource('PUBLIC', { spoilerText: 'chapter 9' }));

	const submission = buildComposeSubmission({
		mode: 'edit',
		// `Compose.Root` forwards `contentWarning` as undefined once the toggle
		// is off, which is exactly what the operator removing it produces.
		form: { content: seed.content, visibility: seed.visibility, contentWarning: undefined },
		extras: emptyExtras({ editingStatusId: SOURCE_ID }),
	});

	const { input } = updateStatusVariables(submission.id, submission.input);
	assert.equal(input.spoilerText, '', 'present and empty, which is how lesser clears it');
	assert.ok(
		Object.hasOwn(input, 'spoilerText'),
		'omitting it would preserve the warning the composer just removed'
	);
});

test('turning the sensitive gate off on an edit sends false, not nothing', () => {
	const submission = buildComposeSubmission({
		mode: 'edit',
		form: { content: 'unchanged', visibility: 'public', contentWarning: undefined },
		extras: emptyExtras({ sensitive: false, editingStatusId: SOURCE_ID }),
	});

	const { input } = updateStatusVariables(submission.id, submission.input);
	assert.equal(input.sensitive, false);
	assert.ok(Object.hasOwn(input, 'sensitive'), 'a removed gate has to be sent to be removed');
});

test('a new post with no warning sends no spoiler at all', () => {
	// The create path keeps the opposite rule, and must: a post carrying
	// `spoilerText: ""` would be asserting an empty warning it does not have.
	const submission = buildComposeSubmission({
		mode: 'new',
		form: { content: 'hello', visibility: 'public', contentWarning: undefined },
		extras: emptyExtras(),
	});

	const { input } = createNoteVariables(submission.input);
	assert.ok(!Object.hasOwn(input, 'spoilerText'));
});

test('a reply inherits neither the warning nor the gate of its parent', () => {
	// lesser has no rule that an answer inherits either, and an invented
	// warning would be attributed to the person replying.
	const seed = composeSeed(
		'reply',
		seedSource('PUBLIC', { sensitive: true, spoilerText: 'chapter 9' })
	);

	assert.equal(seed.sensitive, false);
	assert.equal(seed.contentWarning, '');
	assert.equal(seed.contentWarningEnabled, false);
	assert.equal(seed.content, '', 'and it does not inherit the body either');
});

test('the byte guard refuses before choosing a mutation', () => {
	const submission = buildComposeSubmission({
		mode: 'new',
		form: { content: '🌍'.repeat(200), visibility: 'public' },
		extras: emptyExtras(),
	});

	assert.equal(submission.kind, 'rejected');
	assert.match(submission.message, /800 bytes/);
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

/* -------------------------------------------------------------------------
 * Agent provenance: only what lesser records (F4)
 * ---------------------------------------------------------------------- */

test('the trigger vocabulary is lesser’s closed set, verbatim', () => {
	// `allowedAgentAttributionTriggerTypes` in lesser's
	// graph/mutation_resolvers_notes.go. Anything else is a validation error,
	// not a tolerated extra — so a free-text control over this turned a valid
	// post into a rejected one.
	assert.deepEqual([...AGENT_TRIGGER_TYPES], ['scheduled', 'mention', 'hashtag_watch', 'manual']);
	assert.equal(AGENT_TRIGGER_DEFAULT, 'manual', 'what lesser records when the field is absent');
	assert.ok(AGENT_TRIGGER_TYPES.includes(AGENT_TRIGGER_DEFAULT));
});

test('the attribution panel offers the enum and nothing lesser ignores', () => {
	// SOURCE-SHAPE, and it says so: the panel renders only for an agent
	// session, which `node --test` cannot mount. What is checkable is which
	// controls exist at all — the defect was a control bound to a field the
	// server discards.
	const source = readFileSync(
		new URL('../src/lib/compose/AgentAttributionField.svelte', import.meta.url),
		'utf8'
	);
	const script = source.slice(source.indexOf('<script'));

	assert.match(script, /AGENT_TRIGGER_TYPES/, 'the trigger control is driven by the enum');
	assert.match(script, /<select/, 'and it is a select, not a text box over a closed set');

	for (const ignored of ['delegatedBy', 'delegatedByDid', 'scopes', 'constraints', 'modelId']) {
		assert.doesNotMatch(
			script,
			new RegExp(`\\b${ignored}\\b`),
			`${ignored} is derived by lesser from token claims; a control for it would be theatre`
		);
	}
});

/* -------------------------------------------------------------------------
 * Media: the instance decides, and nothing vanishes quietly (F6, F7)
 * ---------------------------------------------------------------------- */

test('a rejected file is named to the poster, not to the console', () => {
	// The defect this whole area exists for: `console.warn` and a silent
	// `return false`, so a file simply never appeared and the instance was never
	// asked. greater-v0.13.0 reports it instead; contentus turns it into a
	// sentence.
	const message = rejectionMessage([{ name: 'holiday.heic', type: 'image/heic' }], {
		kind: 'unsupported-type',
		allowedTypes: PICKER_MEDIA_TYPES,
	});

	assert.ok(message, 'there must be something to show');
	assert.match(message, /holiday\.heic/, 'by name');
	assert.match(message, /composer refusing rather than the instance/, 'and by whose refusal it is');

	assert.equal(
		rejectionMessage([], { kind: 'unsupported-type', allowedTypes: [] }),
		null,
		'and silence when nothing was rejected'
	);
});

test('the client imposes no size ceiling of its own', () => {
	// lesser's MaxUploadSize is unadvertised and instance-configurable. The
	// vendored 10 MiB default was a guess that silently dropped files an
	// instance would have accepted.
	assert.ok(NO_CLIENT_SIZE_CEILING > 10 * 1024 * 1024 * 1024, 'larger than any plausible upload');
	assert.equal(NO_CLIENT_SIZE_CEILING, Number.MAX_SAFE_INTEGER);
});

test('the picker spans every media category lesser names', () => {
	// MediaCategory is IMAGE | VIDEO | AUDIO | GIFV | DOCUMENT. The vendored
	// default offered two of those five.
	for (const [category, prefix] of [
		['image', 'image/'],
		['video', 'video/'],
		['audio', 'audio/'],
		['document', 'application/'],
	]) {
		assert.ok(
			PICKER_MEDIA_TYPES.some((type) => type.startsWith(prefix)),
			`the picker must offer something for ${category}`
		);
	}

	// And it is wider than the vendored six it replaced.
	assert.ok(PICKER_MEDIA_TYPES.length > 6);
});

test('every rejected file is named, however many there are', () => {
	// The case the old prediction existed for — a selection the gate discards
	// whole — is now simply a report with several files in it.
	const message = rejectionMessage(
		[
			{ name: 'notes.docx', type: 'application/vnd.openxmlformats' },
			{ name: 'archive.zip', type: 'application/zip' },
		],
		{ kind: 'unsupported-type', allowedTypes: PICKER_MEDIA_TYPES }
	);

	assert.ok(message);
	assert.match(message, /notes\.docx/, 'by name');
	assert.match(message, /archive\.zip/, 'every one of them');
	assert.match(message, /composer refusing rather than the instance/, 'and by whose refusal');
});

test('a full composer says so, and names the limit rather than the file', () => {
	const message = rejectionMessage([{ name: 'shot.png', type: 'image/png' }], {
		kind: 'max-attachments-reached',
		maxAttachments: 4,
	});

	assert.ok(message);
	assert.match(message, /4 attachments/, 'naming the limit');
	assert.match(message, /Remove one/, 'and what to do about it');
});

test('a size rejection blames the composer, because it could not be lesser', () => {
	// Unreachable while `MediaField` passes `NO_CLIENT_SIZE_CEILING` — which is
	// the point. If it ever fires it is a contentus configuration bug, not an
	// instance limit, and the message must not tell the poster their instance
	// refused the file.
	const message = rejectionMessage([{ name: 'clip.mkv', type: 'video/x-matroska' }], {
		kind: 'file-too-large',
		maxFileSize: 10 * 1024 * 1024,
	});

	assert.ok(message);
	assert.match(message, /composer applied a size limit of its own/);
	assert.doesNotMatch(message, /this instance (refused|rejected)/i);
});

test('the upload sets a timeout, so a stalled transfer cannot hang the UI', () => {
	// SOURCE-SHAPE, and it says so. `XMLHttpRequest.timeout` is a browser
	// property with no DOM here to set it on, and the defect was precisely
	// that `ontimeout` was installed while `timeout` was left at its default
	// of 0 — a handler that could never fire.
	const source = readFileSync(new URL('../src/lib/cms/media.ts', import.meta.url), 'utf8');

	assert.match(source, /request\.timeout\s*=\s*UPLOAD_TIMEOUT_MS/, 'the property is assigned');
	assert.match(source, /const UPLOAD_TIMEOUT_MS\s*=\s*5 \* 60 \* 1000/, 'to a finite bound');
	assert.match(source, /request\.ontimeout\s*=/, 'and the handler it enables is still there');
});

/* -------------------------------------------------------------------------
 * The wiring the pure probes above cannot reach
 * ---------------------------------------------------------------------- */

test('the composer is seeded from the seed, in both places Root reads', () => {
	// SOURCE-SHAPE, and it says so. The rules are tested directly above; what
	// no probe here can reach is whether the component hands them to the
	// vendored compound. `Root` reads `initialState.visibility` for the first
	// render and `config.defaultVisibility` for the reset it performs after a
	// resolved submit, so seeding one and not the other would send the second
	// reply of a thread at the wrong reach.
	const source = readFileSync(new URL('../src/lib/routes/Compose.svelte', import.meta.url), 'utf8');

	assert.match(source, /defaultVisibility: seed\.visibility/);
	assert.match(source, /visibility: seed\.visibility/);
	assert.match(source, /contentWarning: seed\.contentWarning/);
	assert.match(source, /contentWarningEnabled: seed\.contentWarningEnabled/);
	assert.match(source, /extras\.update\(\{ sensitive: settled\.sensitive \}\)/);

	assert.doesNotMatch(
		source,
		/defaultVisibility: '[a-z]+'/,
		'no literal reach survives; that literal was the F1 defect'
	);
});

test('the composer does not exist until its seed does', () => {
	// SOURCE-SHAPE, and it says so. The hold is what removes the window in
	// which a poster could type into a composer that has not learned its reach
	// — and what guarantees no seed can overwrite typing, because the subtree
	// that would hold the typing is not mounted yet.
	const source = readFileSync(new URL('../src/lib/routes/Compose.svelte', import.meta.url), 'utf8');

	assert.match(source, /\{:else if !seed\}/, 'an unsettled seed renders a holding state');
	assert.match(source, /\{:else if sourceUnavailable\}/, 'and an unloadable target is refused');
	assert.match(
		source,
		/\{#if session !== 'authenticated'\}/,
		'with the whole subtree behind the session gate'
	);
});

test('the rejection report is wired to the surface that shows it', () => {
	// SOURCE-SHAPE, and it says so. The message builder is tested directly above;
	// what no probe here can reach is whether `MediaField` actually hands the
	// pattern a handler and puts the result somewhere a poster sees.
	const source = readFileSync(
		new URL('../src/lib/compose/MediaField.svelte', import.meta.url),
		'utf8'
	);

	assert.match(source, /handlers=\{\{ onUpload, onReject,/, 'the callback is passed down');
	assert.match(
		source,
		/function onReject\(files: File\[\], reason: MediaRejectionReason\)/,
		'and handled with the reason the pattern reports'
	);
	assert.match(source, /\{#if rejected\}/, 'and the message reaches an alert, not a console');
	assert.match(source, /role="alert"/);
});

test('the prediction the callback replaced is gone, not kept beside it', () => {
	// THE SUNSET, ASSERTED RATHER THAN REMEMBERED — the other way round from how
	// this test read before greater-v0.13.0. It used to check that the vendored
	// early return was STILL silent, so that the day it stopped being silent this
	// failed and forced the shim out. That day came. What it guards now is that
	// the shim actually left: a prediction kept alongside an authoritative report
	// is how the two drift apart.
	const field = readFileSync(
		new URL('../src/lib/compose/MediaField.svelte', import.meta.url),
		'utf8'
	);
	const policy = readFileSync(
		new URL('../src/lib/compose/media-policy.ts', import.meta.url),
		'utf8'
	);

	for (const gone of ['notePicked', 'onchangecapture', 'ondropcapture']) {
		assert.ok(!field.includes(gone), `${gone} was part of the shim and must be gone`);
	}
	for (const gone of ['filesDroppedBeforeUpload', 'wholeSelectionDroppedMessage']) {
		assert.ok(!policy.includes(`export function ${gone}`), `${gone} must be gone`);
	}

	// And the upstream capability that retired it is really there.
	const pattern = readFileSync(
		new URL('../src/lib/patterns/MediaComposer.svelte', import.meta.url),
		'utf8'
	);
	assert.match(pattern, /onReject\?: \(files: File\[\], reason: MediaComposerRejectionReason\)/);
});

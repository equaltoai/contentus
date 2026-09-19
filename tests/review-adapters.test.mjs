import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, beforeEach, test } from 'node:test';

import { initialSchedulingOffer } from '../src/lib/review/scheduling-offer.ts';

/**
 * The act-as threading this file probes pulls `auth/session.ts` into the
 * transport's module graph, which imports SvelteKit's `$app/*` aliases and
 * uses extensionless relative imports — neither of which `node --test` can
 * resolve on its own. The loader below is the same one
 * `tests/agent-act-as.test.mjs` and `tests/auth-session.test.mjs` register,
 * and it must run BEFORE the transport is imported, which is why the imports
 * below are dynamic rather than static.
 */
const aliases = new Map([
	['$app/environment', pathToFileURL(resolve('src/facetheory/shims/app-environment.ts')).href],
	['$app/paths', pathToFileURL(resolve('src/facetheory/shims/app-paths.ts')).href],
]);

/**
 * Barrel directories the CLI substitutes as alias TARGETS and Node will not
 * resolve as modules. Mapped to the module that OWNS the one symbol the import
 * chain consumes — the pattern `tests/vendored-messaging-render.test.mjs`
 * discloses for `sanitizeHtml`: the probe drives the real code, and the barrel
 * itself is a directory no resolver can load.
 */
const barrelOwners = new Map([
	// `src/lib/components/Review/state.ts` imports only `formatDateTime` from
	// the greater utils barrel; `relativeTime.ts` owns it.
	['src/lib/greater/utils', 'src/lib/greater/utils/relativeTime.ts'],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = aliases.get(specifier);
		if (url) return { url, shortCircuit: true };

		if (
			context.parentURL?.startsWith(pathToFileURL(resolve('src')).href) &&
			specifier.startsWith('.')
		) {
			const resolved = new URL(specifier, context.parentURL);
			const owner = barrelOwners.get(relative(process.cwd(), fileURLToPath(resolved)));
			if (owner) return { url: pathToFileURL(resolve(owner)).href, shortCircuit: true };

			const candidates = resolved.pathname.endsWith('.js')
				? [resolved.pathname.slice(0, -3) + '.ts']
				: [`${resolved.pathname}.ts`];
			const candidate = candidates.find(existsSync);
			if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
		}

		return nextResolve(specifier, context);
	},
});

class MemoryStorage {
	#values = new Map();

	getItem(key) {
		return this.#values.get(String(key)) ?? null;
	}

	setItem(key, value) {
		this.#values.set(String(key), String(value));
	}

	removeItem(key) {
		this.#values.delete(String(key));
	}

	clear() {
		this.#values.clear();
	}
}

const originalGlobals = {
	window: globalThis.window,
	sessionStorage: globalThis.sessionStorage,
	fetch: globalThis.fetch,
};

globalThis.window = { location: { origin: 'https://contentus.example' } };
globalThis.sessionStorage = new MemoryStorage();

const {
	isDraftAuthor,
	loadDraftActedBy,
	loadDraftPreview,
	loadDraftReview,
	loadReviewQueue,
	publishDraft,
	scheduleDraft,
	submitDraftReview,
} = await import('../src/lib/cms/review-transport.ts');
const { actAsSelection, clearActAs, onActAsChange, selectActAs } =
	await import('../src/lib/agents/act-as.ts');

after(() => {
	globalThis.window = originalGlobals.window;
	globalThis.sessionStorage = originalGlobals.sessionStorage;
	globalThis.fetch = originalGlobals.fetch;
});

beforeEach(() => {
	sessionStorage.clear();
});

/** A signed-in auth session in the shape `readSession` accepts. */
function signIn() {
	sessionStorage.setItem(
		'contentus:auth_session',
		JSON.stringify({
			accessToken: 'tok',
			tokenType: 'Bearer',
			scope: 'read write',
			createdAt: Date.now(),
			expiresIn: 3600,
			expiresAt: Date.now() + 3600_000,
		})
	);
}

/**
 * The review ADAPTERS, driven for real.
 *
 * WHY THIS FILE EXISTS. `tests/review-round-trip.test.mjs` walks the contract
 * end to end, but every step of it calls the pure projections directly: step 4
 * hands a hand-written error string to `failureFromErrors`, and step 5 reads a
 * literal out of a stand-in's return value. Neither step executes
 * `publishDraft`. A `publishDraft` that sent the wrong document, passed the
 * wrong variables, or mis-read lesser's answer would leave that gate green —
 * which is the finding this file answers.
 *
 * WHAT IS MOCKED, AND WHERE. `globalThis.fetch`, and nothing else. Every
 * function under test here is the one the shipped face calls: the same module,
 * the same document constants, the same projections, the same error
 * classification. The stub sits at the HTTP boundary, so the request body it
 * receives is the real wire format — which is why each probe asserts the
 * document and the variables that actually arrived, rather than trusting that
 * the right constant was passed.
 *
 * WHAT IT IS STILL NOT. The stub is not lesser. It does not authorize a grant,
 * enforce the approval gate, or render Markdown; it answers with fixtures shaped
 * like lesser's contract. A green run says the adapters send the right requests
 * and read the answers correctly. The live instance round trip remains unrun and
 * is recorded as such on issue #14 and in `docs/consumption/review-contract.md`.
 */

const TOKEN = 'test-access-token';
const DRAFT_ID = 'draft-adapter-probe';

/**
 * Replace `fetch` with a GraphQL boundary that records every request.
 *
 * `respond({ operation, query, variables })` returns the envelope for one call.
 * Returning `{ errors: [...] }` exercises the failure paths, and throwing
 * exercises the transport path.
 */
async function withGraphql(respond, body) {
	const calls = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		const query = payload.query ?? '';
		const operation =
			/^\s*(?:query|mutation)\s+(\w+)/m.exec(query)?.[1] ??
			/^\s*(?:query|mutation)[^{]*\{\s*(\w+)/m.exec(query)?.[1] ??
			'';

		const call = {
			url: typeof input === 'string' ? input : String(input?.url ?? input),
			operation,
			query,
			variables: payload.variables ?? {},
			headers: init.headers ?? {},
		};
		calls.push(call);

		const envelope = respond(call);
		if (envelope instanceof Error) throw envelope;

		return new Response(JSON.stringify(envelope ?? { data: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		return { value: await body(), calls };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

const agent = {
	id: 'actor-agent-1',
	username: 'scribe',
	domain: null,
	displayName: 'Scribe',
	avatar: null,
	isAgent: true,
};

const reviewer = {
	id: 'actor-human-1',
	username: 'editor',
	domain: null,
	displayName: 'Editor',
	avatar: null,
	isAgent: false,
};

/* ---------------------------------------------------------------------------
 * publishDraft — the step the round-trip gate never executed
 * ------------------------------------------------------------------------ */

test('publishDraft sends lesser publish mutation, with the draft id and nothing else', async () => {
	const { value, calls } = await withGraphql(
		() => ({
			data: {
				publishDraft: {
					id: 'https://trenchcoat.example/articles/what-the-agent-wrote',
					slug: 'what-the-agent-wrote',
					title: 'What the agent wrote',
					publishedAt: '2026-07-31T12:10:00Z',
					canonicalUrl: 'https://trenchcoat.example/articles/what-the-agent-wrote',
				},
			},
		}),
		() => publishDraft(TOKEN, DRAFT_ID)
	);

	assert.equal(calls.length, 1, 'publishing is one request');

	const [call] = calls;
	assert.equal(call.operation, 'ContentusPublishDraft');
	assert.match(call.query, /mutation ContentusPublishDraft\(\$id: ID!\)/);
	assert.match(call.query, /publishDraft\(id: \$id\)/);
	assert.deepEqual(call.variables, { id: DRAFT_ID }, 'the mutation takes the id and only the id');

	// The document must not have grown a body selection on the way to the wire.
	assert.doesNotMatch(call.query, /\bcontent\b/);

	// Authenticated, because `publishDraft` opens with `requireAuth` in lesser.
	assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);

	// And the answer is READ, not assumed: lesser's identity, projected.
	assert.equal(value.ok, true);
	assert.equal(value.value.slug, 'what-the-agent-wrote');
	assert.equal(value.value.id, 'https://trenchcoat.example/articles/what-the-agent-wrote');
	assert.equal(value.value.publishedAt, '2026-07-31T12:10:00Z');
});

test('publishDraft maps the gate refusal through the real adapter, not a stand-in', async () => {
	// The gate step of the round trip asserted this by handing the string to
	// `failureFromErrors` directly. Here lesser's refusal travels the whole
	// path — GraphQL envelope, transport, classification — as it does in
	// production, and the pass condition is still the REFUSAL.
	const { value, calls } = await withGraphql(
		() => ({
			data: { publishDraft: null },
			errors: [
				{ message: 'generated draft requires an active approval from the instance principal' },
			],
		}),
		() => publishDraft(TOKEN, DRAFT_ID)
	);

	assert.equal(calls.length, 1);
	assert.equal(value.ok, false);
	assert.equal(value.failure.reason, 'gated', 'a gate refusal is the gate, not a broken instance');
	assert.equal(
		value.failure.message,
		'generated draft requires an active approval from the instance principal',
		'lesser wording reaches the author verbatim'
	);
});

test('publishDraft reports an unanimity refusal and an expired session apart', async () => {
	const gated = await withGraphql(
		() => ({ errors: [{ message: 'draft requires approval from every active reviewer' }] }),
		() => publishDraft(TOKEN, DRAFT_ID)
	);
	assert.equal(gated.value.failure.reason, 'gated');

	const expired = await withGraphql(
		() => ({ errors: [{ message: 'authentication required' }] }),
		() => publishDraft(TOKEN, DRAFT_ID)
	);
	assert.equal(expired.value.failure.reason, 'unauthenticated');
});

test('publishDraft treats an unreachable instance as transport, never as a publish', async () => {
	const { value } = await withGraphql(
		() => new Error('socket hang up'),
		() => publishDraft(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, false);
	assert.equal(value.failure.reason, 'transport');
});

test('publishDraft refuses to invent an article from an answer without an identity', async () => {
	// A `publishDraft` that returned a body with no `id` is not a publication the
	// UI may link to. It must not become a PublishedArticle with an empty id.
	const { value } = await withGraphql(
		() => ({ data: { publishDraft: { slug: 'somehow-no-id', title: 'x' } } }),
		() => publishDraft(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, false);
	assert.equal(value.failure.reason, 'not-found');
});

test('publishDraft is never attempted without a session', async () => {
	const { value, calls } = await withGraphql(
		() => ({ data: { publishDraft: { id: 'x' } } }),
		() => publishDraft(null, DRAFT_ID)
	);

	assert.deepEqual(calls, [], 'no unauthenticated publish may reach the instance');
	assert.equal(value.failure.reason, 'unauthenticated');
});

/* ---------------------------------------------------------------------------
 * The other write paths, through the same boundary
 * ------------------------------------------------------------------------ */

test('submitDraftReview sends the verdict mutation and replaces state from the answer', async () => {
	const { value, calls } = await withGraphql(
		({ variables }) => {
			assert.equal(variables.draftId, DRAFT_ID);
			assert.equal(variables.verdict, 'CHANGES_REQUESTED');
			assert.equal(variables.notes, 'tighten the lede');

			return {
				data: {
					submitDraftReview: {
						draftId: DRAFT_ID,
						title: 'What the agent wrote',
						status: 'DRAFT',
						contentFormat: 'MARKDOWN',
						updatedAt: '2026-07-31T12:05:00Z',
						createdAt: '2026-07-31T11:00:00Z',
						generatedBy: agent,
						reviewedBy: reviewer,
						reviewStatus: 'CHANGES_REQUESTED',
						editorNotes: 'tighten the lede',
						grant: { grantedAt: '2026-07-31T11:30:00Z', reviewer },
						verdicts: [
							{
								verdict: 'CHANGES_REQUESTED',
								notes: 'tighten the lede',
								recordedAt: '2026-07-31T12:05:00Z',
								reviewer,
							},
						],
					},
				},
			};
		},
		() =>
			submitDraftReview(TOKEN, {
				draftId: DRAFT_ID,
				verdict: 'CHANGES_REQUESTED',
				notes: '  tighten the lede  ',
			})
	);

	assert.equal(calls[0].operation, 'ContentusSubmitDraftReview');
	assert.equal(value.ok, true);
	assert.equal(value.value.reviewStatus, 'CHANGES_REQUESTED');
	assert.equal(value.value.verdicts.length, 1);
	// Recording a verdict is not publishing, and nothing in this path moved it.
	assert.equal(value.value.status, 'DRAFT');
});

test('an approval with no notes sends null rather than an empty string', async () => {
	// An empty string is a note that says nothing; lesser stores it as one.
	const { calls } = await withGraphql(
		() => ({ data: { submitDraftReview: { draftId: DRAFT_ID, updatedAt: '', verdicts: [] } } }),
		() => submitDraftReview(TOKEN, { draftId: DRAFT_ID, verdict: 'APPROVED', notes: '   ' })
	);

	assert.equal(calls[0].variables.notes, null);
});

test('scheduleDraft carries the instant, and a feature-gated instance says so', async () => {
	const at = '2026-08-01T09:00:00.000Z';

	const accepted = await withGraphql(
		({ variables }) => {
			assert.deepEqual(variables, { id: DRAFT_ID, scheduledAt: at });
			return { data: { scheduleDraft: { id: DRAFT_ID, status: 'SCHEDULED', scheduledAt: at } } };
		},
		() => scheduleDraft(TOKEN, DRAFT_ID, at)
	);
	assert.equal(accepted.value.value.status, 'SCHEDULED');

	const gated = await withGraphql(
		() => ({ errors: [{ message: 'draft scheduling is not enabled on this instance' }] }),
		() => scheduleDraft(TOKEN, DRAFT_ID, at)
	);
	assert.equal(gated.value.failure.reason, 'cms-disabled');
});

/** A full `InstanceInfo` as lesser v1.6.4 serves one, bent per case. */
const instanceInfoWith = (scheduling) => ({
	subscriptionUrl: 'wss://ws.instance.test/graphql',
	maxUploadSizeBytes: 10 * 1024 * 1024,
	maxStatusCharacters: 500,
	cmsFeatures: {
		longForm: true,
		drafts: true,
		revisions: true,
		scheduling,
		series: true,
		categories: true,
	},
});

test('a served scheduling: false starts the control unavailable — no refusal needed first', () => {
	// The capability field lesser v1.6.4 added IS the answer the feature-gate
	// refusal above used to deliver after an attempt. Served `false`: the
	// control starts unavailable, and with no control offered there is no path
	// that makes a scheduleDraft request at all.
	assert.equal(initialSchedulingOffer(instanceInfoWith(false)), false);

	// Served `true` and an instance that did not answer (pre-v1.6.4, or a
	// failed read) both keep the pre-v1.6.4 behaviour: offer, and let the
	// typed FEATURE_DISABLED refusal remain the final word — a served `true`
	// can still be stale by click time.
	assert.equal(initialSchedulingOffer(instanceInfoWith(true)), true);
	assert.equal(initialSchedulingOffer(null), true);
});

test('the publish action wires the served answer in, and the refusal still ends the offer', () => {
	// SOURCE-SHAPE, and it says so: `node --test` has no DOM to mount
	// PublishAction in, so what is asserted is the wiring itself — the control
	// starts from the instance read rather than from a hard-coded offer, and
	// the flip on a `cms-disabled` refusal survives beside it.
	const source = readFileSync('src/lib/review/PublishAction.svelte', 'utf8');

	assert.match(source, /getCachedInstanceInfo/, 'the capability is read from the instance');
	assert.match(source, /initialSchedulingOffer/, 'through the shared rule');
	assert.doesNotMatch(
		source,
		/schedulingAvailable\s*=\s*\$state\(true\)/,
		'the hard-coded initial offer is gone: a served false must start unavailable'
	);
	assert.match(
		source,
		/failure\.reason === 'cms-disabled'\) schedulingAvailable = false/,
		'the flip on refusal stays — a served true can be stale by click time'
	);
});

/**
 * A canonical preview body as lesser's renderer composes one when
 * `includeAccessUrls: true`: `buildArticleFigure` (lesser `pkg/cmsrender/
 * compose.go`) emits the `<figure>`/`<img>` pair with the minted access URL as
 * the `src`. The URL below is a SYNTACTIC placeholder shaped like the presigned
 * form lesser serves — never a real bearer artifact, which this repository does
 * not record in fixtures, logs, or documents.
 */
const FIGURE_HTML =
	'<h1>What the agent wrote</h1>' +
	'<p>Some prose the agent produced.</p>' +
	'<figure>' +
	'<img src="https://media.instance.test/editorial/access/PLACEHOLDER?signature=PLACEHOLDER" ' +
	'alt="A chart of the results" width="600" height="400">' +
	'<figcaption>Figure one — Photo: Scribe</figcaption>' +
	'</figure>';

test('loadDraftPreview opts into the media contract and carries lesser figures whole', async () => {
	const ok = await withGraphql(
		({ query, variables }) => {
			// The wire format of the opt-in: the literal argument, on this
			// document, with nothing else changed around it.
			assert.match(query, /draftPreview\(id: \$id, includeAccessUrls: true\)/);
			assert.match(query, /query ContentusDraftPreview\(\$id: ID!\)/);
			assert.doesNotMatch(query.replace(/renderedHtml/g, ''), /\bcontent\b/);
			assert.deepEqual(variables, { id: DRAFT_ID });

			return {
				data: {
					draftPreview: {
						draftId: DRAFT_ID,
						success: true,
						renderedHtml: FIGURE_HTML,
						sourceFormat: 'markdown',
						sourceBytes: 40,
						renderedBytes: FIGURE_HTML.length,
						errors: [],
					},
				},
			};
		},
		() => loadDraftPreview(TOKEN, DRAFT_ID)
	);

	assert.equal(ok.value.ok, true);
	// The bound image reaches the projection byte-for-byte as lesser authored
	// it: figure, img, minted src, alt, dimensions, figcaption. Anything less
	// is a transform, and the display contract (PreviewBody) renders whatever
	// arrives here without a second pass.
	assert.equal(ok.value.value.html, FIGURE_HTML);
	assert.match(ok.value.value.html, /<figure><img src="[^"]+" alt="A chart of the results"/);
	assert.match(
		ok.value.value.html,
		/<figcaption>Figure one — Photo: Scribe<\/figcaption><\/figure>/
	);

	const failed = await withGraphql(
		() => ({
			data: {
				draftPreview: {
					draftId: DRAFT_ID,
					success: false,
					renderedHtml: '<p>half of it</p>',
					sourceFormat: 'markdown',
					sourceBytes: 400_000,
					renderedBytes: 0,
					errors: ['draft source exceeds the 256 KiB limit'],
				},
			},
		}),
		() => loadDraftPreview(TOKEN, DRAFT_ID)
	);
	assert.equal(failed.value.value.html, null, 'partial output from a failed render is dropped');
	assert.deepEqual(failed.value.value.errors, ['draft source exceeds the 256 KiB limit']);
});

test('loadDraftPreview is never attempted without a session', async () => {
	// The media opt-in mints short-lived bearer URLs; the request that carries
	// it is authenticated or it does not happen.
	const { value, calls } = await withGraphql(
		() => ({ data: { draftPreview: { draftId: DRAFT_ID, success: true } } }),
		() => loadDraftPreview(null, DRAFT_ID)
	);

	assert.deepEqual(calls, [], 'no unauthenticated preview request may reach the instance');
	assert.equal(value.failure.reason, 'unauthenticated');
});

/* ---------------------------------------------------------------------------
 * Stale approval vs current approval — through the REAL adapters AND the
 * released Greater resolver
 *
 * The operator failure behind #112: an old `APPROVED` activity read as current
 * approval while principal approval was still outstanding. The fix is the
 * released `resolveReviewState` (greater-v0.13.7, upstream #1055/#1058),
 * which consumes lesser's own `stale`/`current` markers on the newest verdict
 * and demotes a voided approval to the `stale-approved` state. These probes
 * drive the shipped transport against fixtures shaped like lesser's contract
 * and feed its projection to the vendored resolver — no reimplementation and
 * no stand-in oracle anywhere in the chain.
 * ------------------------------------------------------------------------ */

const {
	REVIEW_STALE_APPROVAL_DETAIL,
	REVIEW_STALE_APPROVAL_DETAIL_PRINCIPAL,
	REVIEW_STALE_APPROVAL_LABEL,
	resolveReviewState,
} = await import('../src/lib/components/Review/state.ts');

/** A `draftReview` answer bent per case; the shape is lesser's v1.6.28 contract. */
const draftReviewWith = (overrides = {}) => ({
	data: {
		draftReview: {
			draftId: DRAFT_ID,
			title: 'What the agent wrote',
			status: 'DRAFT',
			contentFormat: 'MARKDOWN',
			updatedAt: '2026-08-31T12:00:00Z',
			createdAt: '2026-08-31T09:00:00Z',
			generatedBy: agent,
			reviewedBy: reviewer,
			reviewStatus: 'APPROVED',
			editorNotes: null,
			contentHash: 'sha256:current-revision',
			revision: 4,
			activeReviewerIds: [reviewer.id],
			publishEligibility: {
				eligible: false,
				blockingReasons: [
					'generated draft requires an active approval from the instance principal',
				],
				reviewersApproved: true,
				principalApprovalRequired: true,
				principalApproved: false,
			},
			grant: { grantedAt: '2026-08-31T10:00:00Z', reviewer },
			verdicts: [],
			...overrides,
		},
	},
});

test('a stale APPROVED activity is superseded, never presented as current approval', async () => {
	// The exact #112 shape: `reviewStatus` still spells the approval, but the
	// newest verdict carries lesser's void markers because the media changed
	// after it was recorded, and the principal gate is still unsatisfied.
	const { value } = await withGraphql(
		() =>
			draftReviewWith({
				verdicts: [
					{
						verdict: 'APPROVED',
						notes: null,
						contentHash: 'sha256:older-revision',
						current: false,
						stale: true,
						recordedAt: '2026-08-31T10:30:00Z',
						reviewer,
					},
				],
			}),
		() => loadDraftReview(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, true);
	const review = value.value;
	// lesser's markers survive the projection unread — the resolver consumes
	// them; nothing client-side recomputes them.
	assert.equal(review.verdicts[0].stale, true);
	assert.equal(review.verdicts[0].current, false);

	const state = resolveReviewState(review);
	assert.equal(state.tone, 'stale-approved', 'the voided approval leaves the success tone');
	assert.equal(state.label, REVIEW_STALE_APPROVAL_LABEL);
	assert.equal(state.label, 'Latest verdict: Approved (superseded)');
	assert.equal(state.stale, true);
	assert.equal(
		state.detail,
		REVIEW_STALE_APPROVAL_DETAIL_PRINCIPAL,
		'the principal gate is in force and unsatisfied, so the detail names it'
	);
	assert.equal(
		state.detail,
		'This approval no longer counts. Principal approval for the current revision is outstanding.'
	);
});

test('a void marker reading current: false alone demotes the approval just the same', () => {
	// lesser can stamp either marker; the resolver must not require both.
	const review = draftReviewWith({
		verdicts: [
			{
				verdict: 'APPROVED',
				notes: null,
				current: false,
				recordedAt: '2026-08-31T10:30:00Z',
				reviewer,
			},
		],
	}).data.draftReview;

	const state = resolveReviewState(review);
	assert.equal(state.tone, 'stale-approved');
	assert.equal(state.label, REVIEW_STALE_APPROVAL_LABEL);
});

test('a stale approval without a principal rule gets the generic explanation', () => {
	const review = draftReviewWith({
		publishEligibility: {
			eligible: false,
			blockingReasons: ['draft requires approval from every active reviewer'],
			reviewersApproved: false,
			principalApprovalRequired: false,
			principalApproved: false,
		},
		generatedBy: null,
		verdicts: [
			{
				verdict: 'APPROVED',
				notes: null,
				stale: true,
				recordedAt: '2026-08-31T10:30:00Z',
				reviewer,
			},
		],
	}).data.draftReview;

	const state = resolveReviewState(review);
	assert.equal(state.tone, 'stale-approved');
	assert.equal(state.detail, REVIEW_STALE_APPROVAL_DETAIL);
	assert.equal(
		state.detail,
		'This approval no longer counts. Approval for the current revision is outstanding.'
	);
});

test('a genuinely current approval keeps the approved representation', async () => {
	const { value } = await withGraphql(
		() =>
			draftReviewWith({
				publishEligibility: {
					eligible: true,
					blockingReasons: [],
					reviewersApproved: true,
					principalApprovalRequired: true,
					principalApproved: true,
				},
				verdicts: [
					{
						verdict: 'APPROVED',
						notes: null,
						contentHash: 'sha256:current-revision',
						current: true,
						stale: false,
						recordedAt: '2026-08-31T11:45:00Z',
						reviewer,
					},
				],
			}),
		() => loadDraftReview(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, true);
	const state = resolveReviewState(value.value);

	assert.equal(state.tone, 'approved', 'a current approval keeps the success tone');
	assert.notEqual(state.tone, 'stale-approved');
	assert.notEqual(state.label, REVIEW_STALE_APPROVAL_LABEL, 'and none of the superseded wording');
	assert.equal(state.stale, false);
	assert.equal(state.detail, undefined, 'a current approval needs no demotion explanation');
});

test('absent markers leave a recorded approval standing — staleness is consumed, never inferred', () => {
	// An older or partial projection without `stale`/`current`: the resolver
	// must not invent staleness, which would demote a real approval.
	const review = draftReviewWith({
		verdicts: [
			{
				verdict: 'APPROVED',
				notes: null,
				recordedAt: '2026-08-31T11:45:00Z',
				reviewer,
			},
		],
	}).data.draftReview;
	delete review.verdicts[0].current;
	delete review.verdicts[0].stale;

	const state = resolveReviewState(review);
	assert.equal(state.tone, 'approved');
	assert.equal(state.stale, false);
});

test('publish availability stays lesser projection, untouched by the activity state', async () => {
	// The stale badge is activity; the gate is `publishEligibility`. Neither
	// the demotion nor its absence may rewrite what lesser projected.
	const stale = await withGraphql(
		() =>
			draftReviewWith({
				verdicts: [
					{
						verdict: 'APPROVED',
						notes: null,
						stale: true,
						recordedAt: '2026-08-31T10:30:00Z',
						reviewer,
					},
				],
			}),
		() => loadDraftReview(TOKEN, DRAFT_ID)
	);

	assert.equal(stale.value.value.publishEligibility.eligible, false);
	assert.deepEqual(stale.value.value.publishEligibility.blockingReasons, [
		'generated draft requires an active approval from the instance principal',
	]);

	const resolved = resolveReviewState(stale.value.value);
	assert.equal(
		resolved.source !== 'none' && resolved.tone === 'stale-approved',
		true,
		'the badge demotes the activity...'
	);
	assert.equal(
		stale.value.value.publishEligibility.eligible,
		false,
		'...without touching lesser gate evaluation'
	);
});

test('the ownership probe answers from whether lesser resolved it', async () => {
	const owner = await withGraphql(
		() => ({ data: { draft: { id: DRAFT_ID } } }),
		() => isDraftAuthor(TOKEN, DRAFT_ID)
	);
	assert.equal(owner.value, true);

	const notOwner = await withGraphql(
		() => ({ errors: [{ message: 'draft not found' }] }),
		() => isDraftAuthor(TOKEN, DRAFT_ID)
	);
	assert.equal(notOwner.value, false);
});

/* ---------------------------------------------------------------------------
 * loadDraftActedBy — lesser's Draft.actedBy attribution carrier
 * ------------------------------------------------------------------------ */

test('loadDraftActedBy sends the actedBy document with the draft id, and maps the actor', async () => {
	const { value, calls } = await withGraphql(
		() => ({ data: { draft: { actedBy: reviewer } } }),
		() => loadDraftActedBy(TOKEN, DRAFT_ID)
	);

	assert.ok(value.ok);
	assert.deepEqual(value.value, {
		id: 'actor-human-1',
		username: 'editor',
		domain: null,
		displayName: 'Editor',
		avatar: null,
		isAgent: false,
	});
	assert.equal(calls[0].operation, 'ContentusDraftActedBy');
	assert.deepEqual(calls[0].variables, { id: DRAFT_ID });
});

test('an absent actedBy is a success with nothing to show, never a failure', async () => {
	// The normal answer for a draft nobody has written under a grant. Reading
	// it as a failure would put an error on screen for the common case; the
	// display is presence-driven, and `ok: true, value: null` is what keeps it
	// that way.
	const { value } = await withGraphql(
		() => ({ data: { draft: { actedBy: null } } }),
		() => loadDraftActedBy(TOKEN, DRAFT_ID)
	);

	assert.ok(value.ok);
	assert.equal(value.value, null);
});

test('an owner-only refusal is a failure the workspace hides, not a fabricated nobody', async () => {
	const { value } = await withGraphql(
		() => ({ errors: [{ message: 'draft is not yours', extensions: { code: 'FORBIDDEN' } }] }),
		() => loadDraftActedBy(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, false);
	assert.equal(value.failure.reason, 'forbidden');
});

/* ---------------------------------------------------------------------------
 * act-as threading — the header, and what ends a selection
 * ------------------------------------------------------------------------ */

const EMPTY_SHARED = () => ({
	data: {
		sharedDraftReviews: {
			totalCount: 0,
			pageInfo: { hasNextPage: false, endCursor: null },
			edges: [],
		},
	},
});

const EMPTY_OWN = () => ({
	data: {
		myDraftReviews: {
			totalCount: 0,
			pageInfo: { hasNextPage: false, endCursor: null },
			edges: [],
		},
	},
});

test('an act-as selection rides the header on enabled operations, and not on the own half', async () => {
	signIn();
	selectActAs('scribe');
	try {
		const { calls } = await withGraphql(
			(call) => (call.operation === 'ContentusSharedDraftReviews' ? EMPTY_SHARED() : EMPTY_OWN()),
			() => loadReviewQueue(TOKEN)
		);

		const shared = calls.find((call) => call.operation === 'ContentusSharedDraftReviews');
		const own = calls.find((call) => call.operation === 'ContentusMyDraftReviews');
		assert.equal(shared.headers['x-lesser-act-as'], 'scribe');
		// `myDraftReviews` is NOT on lesser's enabled list: owner semantics by
		// design, and the opt-out keeps the header off it rather than dressing
		// the limitation as agent behavior.
		assert.equal(own.headers['x-lesser-act-as'], undefined);
	} finally {
		clearActAs();
	}
});

test('enabled workspace reads and writes carry the header', async () => {
	signIn();
	selectActAs('scribe');
	try {
		const review = await withGraphql(
			() => ({ data: { draftReview: { draftId: DRAFT_ID } } }),
			() => loadDraftReview(TOKEN, DRAFT_ID)
		);
		assert.equal(review.calls[0].headers['x-lesser-act-as'], 'scribe');

		const publish = await withGraphql(
			() => ({
				data: {
					publishDraft: {
						id: 'article-1',
						slug: 's',
						title: 't',
						publishedAt: null,
						canonicalUrl: null,
					},
				},
			}),
			() => publishDraft(TOKEN, DRAFT_ID)
		);
		assert.equal(publish.calls[0].headers['x-lesser-act-as'], 'scribe');

		const author = await withGraphql(
			() => ({ data: { draft: { id: DRAFT_ID } } }),
			() => isDraftAuthor(TOKEN, DRAFT_ID)
		);
		assert.equal(author.calls[0].headers['x-lesser-act-as'], 'scribe');
	} finally {
		clearActAs();
	}
});

test('without a selection no header is sent on any review operation', async () => {
	signIn();
	const { calls } = await withGraphql(
		() => ({ data: { draft: { id: DRAFT_ID } } }),
		() => isDraftAuthor(TOKEN, DRAFT_ID)
	);
	assert.equal(calls[0].headers['x-lesser-act-as'], undefined);
});

test('scheduleDraft never carries the header — act-as is deliberately excluded there', async () => {
	signIn();
	selectActAs('scribe');
	try {
		const { calls } = await withGraphql(
			() => ({
				data: { scheduleDraft: { id: DRAFT_ID, status: 'SCHEDULED', scheduledAt: null } },
			}),
			() => scheduleDraft(TOKEN, DRAFT_ID, '2026-09-01T00:00:00Z')
		);
		assert.equal(calls[0].headers['x-lesser-act-as'], undefined);
	} finally {
		clearActAs();
	}
});

test('a FORBIDDEN extension on an act-as request ends the selection and names the reason', async () => {
	signIn();
	selectActAs('scribe');

	const cleared = [];
	const unsubscribe = onActAsChange((selection) => cleared.push(selection));
	try {
		const { value } = await withGraphql(
			() => ({ errors: [{ message: 'grant revoked', extensions: { code: 'FORBIDDEN' } }] }),
			() => loadDraftReview(TOKEN, DRAFT_ID)
		);

		assert.equal(value.ok, false);
		assert.equal(value.failure.reason, 'act-as-revoked');
		assert.match(value.failure.message, /scribe/);
		// Revocation mid-session is the designed case: the selection is cleared
		// and every subscribed surface is told.
		assert.equal(actAsSelection(), null);
		assert.deepEqual(cleared, [null]);
	} finally {
		unsubscribe();
		clearActAs();
	}
});

test('a FORBIDDEN without a selection is an ordinary refusal and touches nothing', async () => {
	signIn();
	const { value } = await withGraphql(
		() => ({ errors: [{ message: 'not yours', extensions: { code: 'FORBIDDEN' } }] }),
		() => loadDraftReview(TOKEN, DRAFT_ID)
	);

	assert.equal(value.ok, false);
	assert.equal(value.failure.reason, 'forbidden');
	assert.equal(actAsSelection(), null);
});

/** Where the act-as selection is stored — the key an earlier build wrote. */
const ACT_AS_KEY = 'contentus:act_as';

test('a selection stored before the control went never reaches lesser on a fresh load', async () => {
	// M2.1 (equaltoai/contentus#92) removed the control that elects a selection,
	// but a removal does not reach into a browser that already used one: the
	// selection is in `sessionStorage`, so a grantee who selected an agent
	// before the upgrade still holds it, and this transport is what would put it
	// on the wire. Clearing it when `/agents` mounts is not enough — a grantee
	// can load `/review` directly and never go there. This is that path.
	signIn();

	const session = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
	// Planted through the storage key rather than `selectActAs`, because
	// "written by a build that still had the control" is the entire scenario —
	// and bound to the live session, so the read path would otherwise honour it.
	sessionStorage.setItem(
		ACT_AS_KEY,
		JSON.stringify({
			agentUsername: 'scribe',
			sessionCreatedAt: session.createdAt,
			sessionExpiresAt: session.expiresAt,
		})
	);
	assert.deepEqual(
		actAsSelection(),
		{ agentUsername: 'scribe' },
		'the plant must be a selection this build would otherwise honour, or the assertions below prove nothing'
	);

	// A fresh `/review` document. Both review routes import `$lib/cms/review`,
	// so the transport's module graph evaluates before any surface mounts and
	// before any operation can run; the query suffix is how a probe gets that
	// second evaluation of a module this process already holds. It loads the
	// same repository source, and shares the one act-as module every instance of
	// it imports — which is why the assertions read through the selection this
	// file already imported.
	const fresh = await import('../src/lib/cms/review-transport.ts?fresh-document');

	assert.equal(actAsSelection(), null, 'loading the transport must end the stored selection');
	assert.equal(
		sessionStorage.getItem(ACT_AS_KEY),
		null,
		'and remove it, rather than leaving it stored for the next reader'
	);

	// Both act-as read sites, driven for real: the shared entry every enabled
	// operation runs through, and `loadDraftActedBy`, which reads the selection
	// on its own.
	const review = await withGraphql(
		() => ({ data: { draftReview: { draftId: DRAFT_ID } } }),
		() => fresh.loadDraftReview(TOKEN, DRAFT_ID)
	);
	assert.equal(
		review.calls[0].headers['x-lesser-act-as'],
		undefined,
		'an enabled review operation must not act as the agent an earlier build selected'
	);

	const actedBy = await withGraphql(
		() => ({ data: { draft: { id: DRAFT_ID, actedBy: null } } }),
		() => fresh.loadDraftActedBy(TOKEN, DRAFT_ID)
	);
	assert.equal(
		actedBy.calls[0].headers['x-lesser-act-as'],
		undefined,
		'and neither must the owner-only actedBy read, which reaches the selection by itself'
	);
});

/* ---------------------------------------------------------------------------
 * The queue, assembled by the shipped code
 *
 * Since lesser v1.6.4 the own half is a `myDraftReviews` connection walk:
 * every edge's node is already a full `DraftReview`, so there is no per-draft
 * `draftReview(id)` fan-out and no thin `listing-only` fallback. What remains
 * worth asserting here: a failed half must not read as an empty one, the walk
 * pages honestly within its budget, and truncation is reported rather than
 * dropped.
 * ------------------------------------------------------------------------ */

const sharedPage = (nodes, hasNextPage = false) => ({
	data: {
		sharedDraftReviews: {
			totalCount: nodes.length,
			pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null },
			edges: nodes.map((node, index) => ({ cursor: `s${index}`, node })),
		},
	},
});

const myReviewsPage = (nodes, hasNextPage = false, endCursor = null) => ({
	data: {
		myDraftReviews: {
			totalCount: nodes.length,
			pageInfo: { hasNextPage, endCursor },
			edges: nodes.map((node, index) => ({ cursor: `m${index}`, node })),
		},
	},
});

const ownReview = (id, overrides = {}) => ({
	draftId: id,
	title: 'Something my agent drafted',
	status: 'DRAFT',
	contentFormat: 'MARKDOWN',
	updatedAt: '2026-07-31T09:00:00Z',
	createdAt: '2026-07-31T08:00:00Z',
	generatedBy: agent,
	reviewedBy: null,
	reviewStatus: null,
	editorNotes: null,
	grant: null,
	verdicts: [],
	...overrides,
});

test('a failed half of the queue is unavailable, never an empty one', async () => {
	// The finding: the shared half was replaced with `[]` on failure and the
	// route then printed "No drafts are currently shared with you".
	const { value, calls } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') {
				return { errors: [{ message: 'the wombat subsystem is on fire' }] };
			}
			return myReviewsPage([]);
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(value.shared, { status: 'unavailable' });
	assert.deepEqual(value.own, { status: 'loaded', more: false }, 'the other half still answered');
	assert.deepEqual(value.entries, []);

	// The failure is reported rather than swallowed into the empty state.
	assert.equal(value.failures.length, 1);
	assert.equal(value.failures[0].message, 'the wombat subsystem is on fire');

	assert.ok(
		calls.some((call) => call.operation === 'ContentusMyDraftReviews'),
		'one half failing must not cancel the other'
	);
});

test('the surviving half is still shown when the other one fails', async () => {
	const { value } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusMyDraftReviews') {
				return { errors: [{ message: 'myDraftReviews is unwell' }] };
			}
			return sharedPage([
				{
					draftId: 'shared-1',
					title: 'What the agent wrote',
					status: 'DRAFT',
					contentFormat: 'MARKDOWN',
					updatedAt: '2026-07-31T12:00:00Z',
					createdAt: '2026-07-31T11:00:00Z',
					generatedBy: agent,
					reviewedBy: null,
					reviewStatus: null,
					editorNotes: null,
					grant: { grantedAt: '2026-07-31T11:30:00Z', reviewer },
					verdicts: [],
				},
			]);
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(value.shared, { status: 'loaded', more: false });
	assert.deepEqual(value.own, { status: 'unavailable' });
	assert.equal(value.entries.length, 1);
	assert.equal(value.entries[0].review.draftId, 'shared-1');
});

test('an own draft carries lesser review state straight from myDraftReviews', async () => {
	// The pre-v1.6.4 shape walked `myDrafts` and then asked `draftReview(id)`
	// per draft to fill in the state the listing lacked. The connection now
	// returns the full projection, so the state arrives with the listing and no
	// per-draft follow-up goes out.
	const { value, calls } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			return myReviewsPage([
				ownReview('own-reviewed', {
					reviewedBy: reviewer,
					reviewStatus: 'APPROVED',
					verdicts: [
						{
							verdict: 'APPROVED',
							notes: null,
							current: true,
							stale: false,
							recordedAt: '2026-07-31T08:45:00Z',
							reviewer,
						},
					],
				}),
			]);
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(
		calls.map((call) => call.operation),
		['ContentusSharedDraftReviews', 'ContentusMyDraftReviews'],
		'two connection queries and no per-draft fan-out'
	);

	assert.equal(value.entries.length, 1);
	const [entry] = value.entries;

	assert.equal(entry.source, 'my-agent-draft');
	assert.equal(entry.review.reviewStatus, 'APPROVED', "lesser's own state, with the listing");
	assert.equal(entry.review.verdicts.length, 1);
	assert.equal(entry.review.verdicts[0].stale, false);
	assert.equal(entry.review.verdicts[0].reviewer.username, 'editor');
});

test('the own half walks pages until lesser says there are no more', async () => {
	const { value, calls } = await withGraphql(
		({ operation, variables }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			assert.equal(operation, 'ContentusMyDraftReviews');
			if (variables.after === null) return myReviewsPage([ownReview('own-1')], true, 'page-2');
			assert.equal(variables.after, 'page-2', 'the walk follows pageInfo.endCursor');
			return myReviewsPage([ownReview('own-2')], false, null);
		},
		() => loadReviewQueue(TOKEN)
	);

	const ownCalls = calls.filter((call) => call.operation === 'ContentusMyDraftReviews');
	assert.equal(ownCalls.length, 2, 'the walk paged');

	assert.deepEqual(
		value.entries.map((entry) => entry.review.draftId),
		['own-1', 'own-2']
	);
	assert.deepEqual(value.own, { status: 'loaded', more: false });
});

test('a truncated walk reports more-to-come rather than claiming completeness', async () => {
	// The budget is three pages; lesser has more behind them. `own.more` is the
	// difference between "none of your drafts are agent-generated" and "none in
	// what was scanned" — the queue's copy hangs off it.
	const { value, calls } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			// Every page is hand-written drafts (filtered out of this half) with
			// another page always behind it.
			return myReviewsPage([ownReview('hand-written', { generatedBy: null })], true, 'next');
		},
		() => loadReviewQueue(TOKEN)
	);

	const ownCalls = calls.filter((call) => call.operation === 'ContentusMyDraftReviews');
	assert.equal(ownCalls.length, 3, 'the walk stopped at its page budget');

	assert.deepEqual(value.entries, [], 'no agent-generated drafts in what was scanned');
	assert.deepEqual(value.own, { status: 'loaded', more: true }, 'and it says so honestly');
});

test('a page failing mid-walk keeps what arrived and stays honest about the rest', async () => {
	const { value } = await withGraphql(
		({ operation, variables }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			if (variables.after === null) return myReviewsPage([ownReview('own-1')], true, 'page-2');
			return { errors: [{ message: 'the second page is unwell' }] };
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(
		value.entries.map((entry) => entry.review.draftId),
		['own-1'],
		'the first page is still shown'
	);
	assert.deepEqual(value.own, { status: 'loaded', more: true }, 'with completeness unclaimed');
});

test('drafts with no recorded generator are not in the own half at all', async () => {
	// `myDraftReviews` returns every review the viewer owns; this half of the
	// queue is only the ones an agent produced.
	const { value } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			return myReviewsPage([ownReview('hand-written', { generatedBy: null })]);
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(value.entries, []);
	assert.deepEqual(value.own, { status: 'loaded', more: false });
});

test('nothing in the queue is fetched without a session', async () => {
	const { value, calls } = await withGraphql(
		() => sharedPage([]),
		() => loadReviewQueue(null)
	);

	assert.deepEqual(calls, []);
	assert.deepEqual(value.shared, { status: 'unavailable' });
	assert.deepEqual(value.own, { status: 'unavailable' });
	assert.ok(value.failures.every((failure) => failure.reason === 'unauthenticated'));
});

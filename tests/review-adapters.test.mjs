import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	isDraftAuthor,
	loadDraftActedBy,
	loadDraftPreview,
	loadReviewQueue,
	publishDraft,
	scheduleDraft,
	submitDraftReview,
} from '../src/lib/cms/review-transport.ts';
import { initialSchedulingOffer } from '../src/lib/review/scheduling-offer.ts';

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

test('loadDraftPreview shows lesser rendered output, and nothing when it failed', async () => {
	const ok = await withGraphql(
		({ query }) => {
			assert.match(query, /draftPreview\(id: \$id\)/);
			assert.doesNotMatch(query.replace(/renderedHtml/g, ''), /\bcontent\b/);
			return {
				data: {
					draftPreview: {
						draftId: DRAFT_ID,
						success: true,
						renderedHtml: '<h1>Rendered by lesser</h1>',
						sourceFormat: 'markdown',
						sourceBytes: 40,
						renderedBytes: 26,
						errors: [],
					},
				},
			};
		},
		() => loadDraftPreview(TOKEN, DRAFT_ID)
	);
	assert.equal(ok.value.value.html, '<h1>Rendered by lesser</h1>');

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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	isDraftAuthor,
	loadDraftPreview,
	loadReviewQueue,
	publishDraft,
	scheduleDraft,
	submitDraftReview,
} from '../src/lib/cms/review-transport.ts';

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
 * The queue, assembled by the shipped code
 *
 * Two findings meet here: a failed half must not read as an empty one, and an
 * own draft whose review projection is missing must not read as an unreviewed
 * one.
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

const myDraftsPage = (nodes, hasNextPage = false) => ({
	data: {
		myDrafts: {
			totalCount: nodes.length,
			pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null },
			edges: nodes.map((node, index) => ({ cursor: `m${index}`, node })),
		},
	},
});

const ownListing = (id, overrides = {}) => ({
	id,
	title: 'Something my agent drafted',
	slug: 'something',
	status: 'DRAFT',
	contentFormat: 'MARKDOWN',
	updatedAt: '2026-07-31T09:00:00Z',
	createdAt: '2026-07-31T08:00:00Z',
	generatedBy: agent,
	reviewedBy: null,
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
			return myDraftsPage([]);
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
		calls.some((call) => call.operation === 'ContentusMyDrafts'),
		'one half failing must not cancel the other'
	);
});

test('the surviving half is still shown when the other one fails', async () => {
	const { value } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusMyDrafts') {
				return { errors: [{ message: 'myDrafts is unwell' }] };
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

test('an own draft with a recorded verdict shows the recorded activity', async () => {
	// `myDrafts` returns a listing that says a reviewer ruled and not what they
	// ruled. The queue asks `draftReview(id)` — which `DraftReviewForCaller`
	// authorizes for the OWNER — and the entry then carries lesser's own state.
	const { value, calls } = await withGraphql(
		({ operation, variables }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			if (operation === 'ContentusMyDrafts') {
				return myDraftsPage([ownListing('own-reviewed', { reviewedBy: reviewer })]);
			}

			assert.equal(operation, 'ContentusDraftReview');
			assert.equal(variables.id, 'own-reviewed');
			return {
				data: {
					draftReview: {
						draftId: 'own-reviewed',
						title: 'Something my agent drafted',
						status: 'DRAFT',
						contentFormat: 'MARKDOWN',
						updatedAt: '2026-07-31T09:00:00Z',
						createdAt: '2026-07-31T08:00:00Z',
						generatedBy: agent,
						reviewedBy: reviewer,
						reviewStatus: 'APPROVED',
						editorNotes: null,
						grant: null,
						verdicts: [
							{
								verdict: 'APPROVED',
								notes: null,
								recordedAt: '2026-07-31T08:45:00Z',
								reviewer,
							},
						],
					},
				},
			};
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.ok(
		calls.some((call) => call.operation === 'ContentusDraftReview'),
		'the queue must ask for the projection that carries review activity'
	);

	assert.equal(value.entries.length, 1);
	const [entry] = value.entries;

	assert.equal(entry.source, 'my-agent-draft');
	assert.equal(entry.projection, 'review', 'the full projection arrived');
	assert.equal(entry.review.reviewStatus, 'APPROVED', "lesser's own state, not an absence");
	assert.equal(entry.review.verdicts.length, 1);
	assert.equal(entry.review.verdicts[0].reviewer.username, 'editor');
});

test('an own draft whose review projection is missing is unknown, not unreviewed', async () => {
	const { value } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			if (operation === 'ContentusMyDrafts') {
				return myDraftsPage([ownListing('own-thin', { reviewedBy: reviewer })]);
			}
			// The projection that would have said what the verdict was does not
			// arrive. The draft is still real — the listing proved that.
			return { errors: [{ message: 'draft review not found' }] };
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.equal(value.entries.length, 1, 'the draft is still listed, not dropped');
	const [entry] = value.entries;

	assert.equal(entry.projection, 'listing-only', 'and it is marked as the thin projection');
	assert.equal(entry.review.reviewStatus, undefined, 'no review state is invented');
	assert.deepEqual(entry.review.verdicts, [], 'and no verdict history is invented');

	// The half itself loaded fine — one draft's projection failing is not a
	// failure of the query that listed it.
	assert.deepEqual(value.own, { status: 'loaded', more: false });
});

test('the queue never asks for a review projection it is not entitled to', async () => {
	// Only the viewer's OWN agent-generated drafts are enriched. A draft with no
	// recorded generator is not in this half of the queue at all, so no
	// `draftReview` goes out for it.
	const { value, calls } = await withGraphql(
		({ operation }) => {
			if (operation === 'ContentusSharedDraftReviews') return sharedPage([]);
			if (operation === 'ContentusMyDrafts') {
				return myDraftsPage([ownListing('hand-written', { generatedBy: null })]);
			}
			throw new Error('no draftReview should be sent for a draft with no generator');
		},
		() => loadReviewQueue(TOKEN)
	);

	assert.deepEqual(value.entries, []);
	assert.deepEqual(
		calls.map((call) => call.operation).filter((name) => name === 'ContentusDraftReview'),
		[]
	);
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

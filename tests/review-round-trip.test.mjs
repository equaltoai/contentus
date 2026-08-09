import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	REVIEW_DOCUMENTS,
	failureFromErrors,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toPreviewFaceArticle,
} from '../src/lib/cms/review-contract.ts';

/**
 * The M2d.5 completion-gate round trip, contentus half:
 * share → queue → draftPreview → verdict → gated publish.
 *
 * WHAT THIS IS EVIDENCE FOR, stated before the assertions so nobody has to
 * infer it. Each step below sends one of the EXACT documents the shipped face
 * sends, to a stand-in that answers in lesser's contract shapes, and feeds that
 * answer through the EXACT projections the shipped face uses. So it is evidence
 * about contentus's consumption of the contract — the documents, the shapes it
 * expects back, and the view state it derives — end to end, in order.
 *
 * WHAT IT IS NOT EVIDENCE FOR, equally plainly. The stand-in is not lesser. It
 * does not enforce the approval gate, authorize a grant, or render Markdown; it
 * replays fixtures shaped like the ones lesser's own contract tests pin. A
 * green run here says contentus asks the right questions and reads the answers
 * correctly. It says nothing about whether a real instance answers them, which
 * is what the live trenchcoat round trip is for — recorded, with its outcome,
 * in `docs/consumption/review-contract.md` and on issue #14.
 *
 * AND ONE MORE THING IT IS NOT, named because it was previously implied. The
 * steps here call the PROJECTIONS. They do not execute the adapters: step 4
 * hands its error string to `failureFromErrors` directly, and step 5 reads a
 * literal out of the stand-in's own return value, so neither one runs
 * `publishDraft`. That is deliberate — this file is about the contract shapes —
 * but it means a broken adapter cannot fail here.
 * `tests/review-adapters.test.mjs` is where the shipped `publishDraft`,
 * `submitDraftReview`, and queue assembly are driven for real, with the mock at
 * the GraphQL boundary rather than above it.
 *
 * The gate step is the one to read closely: the refusal is asserted as the
 * SUCCESS condition. A draft that publishes without approval would fail this
 * test, which is the right way round for a face whose product property is that
 * publication is gated.
 */

const DRAFT_ID = 'draft-m2d-round-trip';

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

/**
 * A stand-in for lesser that answers by operation name.
 *
 * It asserts the document it was handed is one of the face's own, which is what
 * makes each step below a claim about the shipped wire format rather than about
 * a query written for this file.
 */
function lesserStub(handlers) {
	const known = new Map(Object.entries(REVIEW_DOCUMENTS).map(([name, doc]) => [doc, name]));

	return (document, variables = {}) => {
		const name = known.get(document);
		assert.ok(name, 'the round trip must send a document the shipped face exports');

		const handler = handlers[name];
		assert.ok(handler, `the stand-in has no answer for ${name}`);
		return handler(variables);
	};
}

/* ------------------------------------------------------------------------
 * Step 1 — a draft is shared, and it reaches the queue ahead of own drafts
 * --------------------------------------------------------------------- */

test('round trip 1: a shared draft reaches the queue, above the viewer own drafts', () => {
	const ask = lesserStub({
		SHARED_DRAFT_REVIEWS_QUERY: (variables) => {
			// The queue asks for a bounded page, not for everything.
			assert.equal(variables.first, 20);
			return {
				sharedDraftReviews: {
					totalCount: 1,
					pageInfo: { hasNextPage: false, endCursor: null },
					edges: [
						{
							cursor: 'c1',
							node: {
								draftId: DRAFT_ID,
								title: 'What the agent wrote',
								excerpt: 'A standfirst.',
								contentFormat: 'MARKDOWN',
								status: 'DRAFT',
								updatedAt: '2026-07-31T12:00:00Z',
								createdAt: '2026-07-31T11:00:00Z',
								generatedBy: agent,
								reviewedBy: null,
								reviewStatus: null,
								editorNotes: null,
								// The grant is the VIEWER'S OWN invitation — this is what
								// lesser returns to the invited reviewer.
								grant: { grantedAt: '2026-07-31T11:30:00Z', reviewer },
								verdicts: [],
							},
						},
					],
				},
			};
		},
		MY_DRAFT_REVIEWS_QUERY: () => ({
			myDraftReviews: {
				totalCount: 1,
				pageInfo: { hasNextPage: false, endCursor: null },
				edges: [
					{
						cursor: 'c2',
						node: {
							draftId: 'draft-of-my-own',
							title: 'Something my agent drafted for me',
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
						},
					},
				],
			},
		}),
	});

	const shared = ask(REVIEW_DOCUMENTS.SHARED_DRAFT_REVIEWS_QUERY, {
		first: 20,
		after: null,
	}).sharedDraftReviews.edges.map((edge) => toDraftReview(edge.node));

	// `myDraftReviews` (lesser v1.6.4) returns the SAME full `DraftReview`
	// projection as the shared connection, so the own half is projected through
	// the same `toDraftReview` and carries no invented review activity.
	const own = ask(REVIEW_DOCUMENTS.MY_DRAFT_REVIEWS_QUERY, {
		first: 20,
		after: null,
	}).myDraftReviews.edges.map((edge) => toDraftReview(edge.node));

	const entries = orderQueueEntries(shared, own);

	assert.deepEqual(
		entries.map((entry) => [entry.review.draftId, entry.source]),
		[
			[DRAFT_ID, 'shared-with-me'],
			['draft-of-my-own', 'my-agent-draft'],
		],
		'a draft shared with the viewer sits above a draft the viewer owns'
	);

	// The shared entry carries the reviewer's invitation, which is what the
	// workspace reads to decide whether to offer the verdict controls.
	assert.equal(entries[0].review.grant.reviewer.username, 'editor');

	// And the own entry carries no invented review activity — lesser said there
	// is none, which is a claim only a full projection may make.
	assert.deepEqual(entries[1].review.verdicts, []);
	assert.equal(entries[1].review.reviewStatus, null);
});

/* ------------------------------------------------------------------------
 * Step 2 — the body arrives as lesser's rendered output, never as source
 * --------------------------------------------------------------------- */

test('round trip 2: the preview is lesser rendered HTML, and Markdown source never appears', () => {
	const markdownSource = '# What the agent wrote\n\nSome *prose* the agent produced.';

	const ask = lesserStub({
		DRAFT_PREVIEW_QUERY: (variables) => {
			assert.equal(variables.id, DRAFT_ID);
			return {
				draftPreview: {
					draftId: DRAFT_ID,
					success: true,
					renderedHtml: '<h1>What the agent wrote</h1>\n<p>Some <em>prose</em>…</p>',
					sourceFormat: 'markdown',
					sourceBytes: markdownSource.length,
					renderedBytes: 62,
					errors: [],
				},
			};
		},
	});

	const preview = toDraftPreview(
		ask(REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY, { id: DRAFT_ID }).draftPreview
	);
	const article = toPreviewFaceArticle(preview, { draftId: DRAFT_ID, title: 'x', updatedAt: '' });

	assert.equal(article.contentFormat, 'html', "the face hands the blog face lesser's HTML");
	assert.match(article.content, /<h1>What the agent wrote<\/h1>/);

	// The source the agent typed is nowhere in what reaches the DOM, and the
	// document that fetched this never asked for it.
	assert.doesNotMatch(article.content, /^#\s/m, 'no Markdown heading syntax reaches the reader');
	assert.doesNotMatch(REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY, /\bcontent\b/);
});

test('round trip 2b: a render failure shows lesser errors and no body at all', () => {
	const ask = lesserStub({
		DRAFT_PREVIEW_QUERY: () => ({
			draftPreview: {
				draftId: DRAFT_ID,
				success: false,
				renderedHtml: '<p>half of it</p>',
				sourceFormat: 'markdown',
				sourceBytes: 400_000,
				renderedBytes: 0,
				errors: ['draft source exceeds the 256 KiB limit'],
			},
		}),
	});

	const preview = toDraftPreview(
		ask(REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY, { id: DRAFT_ID }).draftPreview
	);

	assert.equal(preview.html, null, 'partial output from a failed render is dropped');
	assert.equal(toPreviewFaceArticle(preview, null), null, 'and it cannot become an article');
	assert.deepEqual(preview.errors, ['draft source exceeds the 256 KiB limit']);
});

/* ------------------------------------------------------------------------
 * Step 3 — a verdict is recorded, and the server's state replaces the local
 * --------------------------------------------------------------------- */

test('round trip 3: a verdict is recorded and lesser own state replaces the local copy', () => {
	const ask = lesserStub({
		SUBMIT_DRAFT_REVIEW_MUTATION: (variables) => {
			assert.equal(variables.draftId, DRAFT_ID);
			assert.equal(variables.verdict, 'APPROVED');
			// Notes are optional for an approval and are sent as null, not '' —
			// an empty string is a note that says nothing.
			assert.equal(variables.notes, null);

			return {
				submitDraftReview: {
					draftId: DRAFT_ID,
					title: 'What the agent wrote',
					contentFormat: 'MARKDOWN',
					status: 'DRAFT',
					updatedAt: '2026-07-31T12:05:00Z',
					createdAt: '2026-07-31T11:00:00Z',
					generatedBy: agent,
					reviewedBy: reviewer,
					// lesser overwrites this on EVERY submission, which is why the
					// chrome renders it as latest activity rather than as the gate.
					reviewStatus: 'APPROVED',
					editorNotes: null,
					grant: { grantedAt: '2026-07-31T11:30:00Z', reviewer },
					verdicts: [
						{
							verdict: 'APPROVED',
							notes: null,
							recordedAt: '2026-07-31T12:05:00Z',
							reviewer,
						},
					],
				},
			};
		},
	});

	const updated = toDraftReview(
		ask(REVIEW_DOCUMENTS.SUBMIT_DRAFT_REVIEW_MUTATION, {
			draftId: DRAFT_ID,
			verdict: 'APPROVED',
			notes: null,
		}).submitDraftReview
	);

	assert.equal(updated.reviewStatus, 'APPROVED');
	assert.equal(updated.reviewedBy.username, 'editor');
	assert.equal(updated.verdicts.length, 1);

	// Still a DRAFT. Recording an approval is not publishing, and nothing in
	// this path moved the draft's status.
	assert.equal(updated.status, 'DRAFT');
});

/* ------------------------------------------------------------------------
 * Step 4 — the gate. The refusal is the pass condition.
 * --------------------------------------------------------------------- */

test('round trip 4: publishing without the principal approval is refused, and says so', () => {
	// The draft records a generator, so lesser requires the instance principal's
	// approval ON TOP OF unanimous active-reviewer approval. One reviewer
	// approval is not enough, and this is lesser's own error text.
	const refusal = failureFromErrors([
		{ message: 'generated draft requires an active approval from the instance principal' },
	]);

	assert.equal(refusal.reason, 'gated', 'a gate refusal is the gate, not a broken instance');
	assert.equal(
		refusal.message,
		'generated draft requires an active approval from the instance principal',
		'lesser wording is shown verbatim — only lesser knows WHICH approval is missing'
	);
});

test('round trip 4b: an unanimity refusal is classified the same way', () => {
	const refusal = failureFromErrors([
		{ message: 'draft requires approval from every active reviewer' },
	]);
	assert.equal(refusal.reason, 'gated');
});

test('round trip 5: once lesser allows it, publish returns the article identity it assigned', () => {
	const ask = lesserStub({
		PUBLISH_DRAFT_MUTATION: (variables) => {
			assert.equal(variables.id, DRAFT_ID);
			return {
				publishDraft: {
					id: 'https://trenchcoat.example/articles/what-the-agent-wrote',
					slug: 'what-the-agent-wrote',
					title: 'What the agent wrote',
					publishedAt: '2026-07-31T12:10:00Z',
					canonicalUrl: 'https://trenchcoat.example/articles/what-the-agent-wrote',
				},
			};
		},
	});

	const article = ask(REVIEW_DOCUMENTS.PUBLISH_DRAFT_MUTATION, { id: DRAFT_ID }).publishDraft;

	// The identity is lesser's. Contentus links to the slug lesser assigned and
	// constructs none of its own — a published slug is immutable and the
	// Article ID is the thing that federates.
	assert.equal(article.slug, 'what-the-agent-wrote');
	assert.match(article.id, /^https:\/\/[^/]+\/articles\/what-the-agent-wrote$/);
});

test('round trip 5b: lesser own gate evaluation reaches the publish control unread', () => {
	// Since v1.6.4 the publish control reads `publishEligibility` — lesser's own
	// evaluation of its gate — and disables itself with lesser's blocking
	// reasons when `eligible` is false. The harness drives projections, not
	// components, so what is asserted here is the data the disabled rendering
	// consumes: the evaluation survives `toDraftReview` whole and unrewritten.
	const review = toDraftReview({
		draftId: DRAFT_ID,
		updatedAt: '2026-07-31T12:00:00Z',
		generatedBy: agent,
		verdicts: [],
		publishEligibility: {
			eligible: false,
			blockingReasons: ['generated draft requires an active approval from the instance principal'],
			reviewersApproved: true,
			principalApprovalRequired: true,
			principalApproved: false,
		},
	});

	assert.equal(review.publishEligibility.eligible, false);
	assert.deepEqual(review.publishEligibility.blockingReasons, [
		'generated draft requires an active approval from the instance principal',
	]);

	// And the gate DOCUMENT asks for the evaluation — the disabled control is
	// only as honest as the selection that feeds it.
	assert.match(REVIEW_DOCUMENTS.DRAFT_REVIEW_QUERY, /publishEligibility\s*\{/);
	assert.match(REVIEW_DOCUMENTS.DRAFT_REVIEW_QUERY, /blockingReasons/);
});

/* ------------------------------------------------------------------------
 * MCP parity — asserted where it is actually decidable from this repo
 * --------------------------------------------------------------------- */

test('MCP parity: both surfaces drive the same four lesser operations', () => {
	// lesser-body's M2b tools (`article_draft_review_submit`,
	// `article_draft_review_read`, `article_draft_review_verdict`,
	// `article_draft_publish`) are documented as calls onto the SAME Lesser CMS
	// operations this face sends. Parity is therefore a property of the
	// contract, not of two implementations agreeing by luck — and what this
	// repository can check is that contentus's half names those operations and
	// nothing else.
	//
	// The behavioural half of the parity claim needs a live instance and the
	// Body endpoint, and is recorded with its real outcome on issue #14 rather
	// than asserted here.
	const operations = Object.values(REVIEW_DOCUMENTS)
		.flatMap((document) => [...document.matchAll(/^\s*(?:query|mutation)\s+\w+[^{]*\{\s*(\w+)/gm)])
		.map((match) => match[1]);

	assert.deepEqual(
		[...new Set(operations)].sort(),
		[
			'draft',
			'draftPreview',
			'draftReview',
			'myDraftReviews',
			'publishDraft',
			'scheduleDraft',
			'sharedDraftReviews',
			'submitDraftReview',
		],
		'contentus drives exactly the review contract, with nothing invented alongside it'
	);
});

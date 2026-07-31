import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	REVIEW_DOCUMENTS,
	emptyHalfCopy,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toOwnDraftReview,
	toPreviewFaceArticle,
	toReviewActor,
	toVerdictRecord,
} from '../src/lib/cms/review-contract.ts';

/**
 * Face 2 probes (M2d).
 *
 * These load the shipped module directly — no bundler, no alias resolver — so
 * they are claims about the code that runs rather than about a copy of it.
 * That is why the documents, the projections, and the failure taxonomy were
 * split into `review-contract.ts` in the first place.
 *
 * The renderer-authority assertion is the one that matters most: it is a claim
 * over EVERY document the face sends, so a `content` field added to a query in
 * a hurry fails here rather than shipping a raw draft body to a client that has
 * spent two milestones refusing to have one.
 */

const actor = (overrides = {}) => ({
	id: 'actor-1',
	username: 'scribe',
	domain: null,
	displayName: 'Scribe',
	avatar: null,
	isAgent: true,
	...overrides,
});

/* ---------------------------------------------------------------------------
 * Renderer authority, asserted over the wire format itself
 * ------------------------------------------------------------------------ */

test('no review document asks lesser for a draft body', () => {
	for (const [name, document] of Object.entries(REVIEW_DOCUMENTS)) {
		// `renderedHtml` is the ONE body field face 2 may select: it is lesser's
		// renderer output, not stored source. Removing it from consideration
		// leaves every other body-shaped field a finding.
		const withoutPreviewField = document.replace(/renderedHtml/g, '');

		assert.doesNotMatch(
			withoutPreviewField,
			/\bcontent\b/,
			`${name} selects a content field — Draft.content is the stored source, and face 2 ` +
				'displays only draftPreview.renderedHtml'
		);
		assert.doesNotMatch(
			withoutPreviewField,
			/\bsource\b(?!Format|Bytes)/,
			`${name} selects a source field`
		);
	}
});

test('only the preview document selects renderedHtml', () => {
	const selecting = Object.entries(REVIEW_DOCUMENTS)
		.filter(([, document]) => document.includes('renderedHtml'))
		.map(([name]) => name);

	assert.deepEqual(selecting, ['DRAFT_PREVIEW_QUERY']);
});

test('the ownership probe selects an identifier and nothing else', () => {
	// It exists to learn a boolean. Selecting more would pull an unrendered
	// body into the client to answer a question that does not need one.
	const document = REVIEW_DOCUMENTS.DRAFT_OWNERSHIP_QUERY;
	assert.match(document, /draft\(id: \$id\) \{ id \}/);
	assert.doesNotMatch(document, /title|slug|status|generatedBy/);
});

test('every document names the operation lesser actually exposes', () => {
	assert.match(REVIEW_DOCUMENTS.SHARED_DRAFT_REVIEWS_QUERY, /sharedDraftReviews\(/);
	assert.match(REVIEW_DOCUMENTS.DRAFT_REVIEW_QUERY, /draftReview\(id: \$id\)/);
	assert.match(REVIEW_DOCUMENTS.MY_DRAFTS_QUERY, /myDrafts\(contentType: ARTICLE/);
	assert.match(REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY, /draftPreview\(id: \$id\)/);
	assert.match(REVIEW_DOCUMENTS.SUBMIT_DRAFT_REVIEW_MUTATION, /submitDraftReview\(draftId:/);
	assert.match(REVIEW_DOCUMENTS.PUBLISH_DRAFT_MUTATION, /publishDraft\(id: \$id\)/);
	assert.match(REVIEW_DOCUMENTS.SCHEDULE_DRAFT_MUTATION, /scheduleDraft\(id: \$id, scheduledAt:/);
});

/* ---------------------------------------------------------------------------
 * The failure taxonomy, against lesser's own error strings
 * ------------------------------------------------------------------------ */

const errorsWith = (message) => [{ message }];

test("the approval gate's refusals are classified as the gate, not as errors", () => {
	// Verbatim from lesser pkg/services/cms/draft_review.go.
	const unanimous = failureFromErrors(
		errorsWith('draft requires approval from every active reviewer')
	);
	assert.equal(unanimous.reason, 'gated');
	assert.equal(unanimous.message, 'draft requires approval from every active reviewer');

	const principal = failureFromErrors(
		errorsWith('generated draft requires an active approval from the instance principal')
	);
	assert.equal(principal.reason, 'gated');
});

test('a gated refusal keeps lesser wording verbatim', () => {
	// The reviewer needs to know WHICH approval is missing, and lesser is the
	// only party that knows. Paraphrasing would drop the information.
	const message = 'generated draft requires an active approval from the instance principal';
	assert.equal(failureFromErrors(errorsWith(message)).message, message);
});

test('self-review and revoked-grant are told apart from the gate', () => {
	assert.equal(
		failureFromErrors(errorsWith('draft owner cannot review their own draft')).reason,
		'self-review'
	);
	assert.equal(
		failureFromErrors(errorsWith('draft review grant is not active')).reason,
		'no-grant'
	);
});

test('a missing draft is not-found and an expired session is unauthenticated', () => {
	assert.equal(failureFromErrors(errorsWith('draft review not found')).reason, 'not-found');
	assert.equal(
		failureFromErrors([{ message: 'boom', extensions: { code: 'UNAUTHENTICATED' } }]).reason,
		'unauthenticated'
	);
});

test('an unrecognised error is reported plainly, never as a permission decision', () => {
	const failure = failureFromErrors(errorsWith('the wombat subsystem is on fire'));
	assert.equal(failure.reason, 'rejected');
	assert.equal(failure.message, 'the wombat subsystem is on fire');
});

/* ---------------------------------------------------------------------------
 * Projections
 * ------------------------------------------------------------------------ */

test('a DraftReview projects with its grant and verdict history', () => {
	const review = toDraftReview({
		draftId: 'draft-1',
		title: '  A title  ',
		status: 'DRAFT',
		contentFormat: 'MARKDOWN',
		updatedAt: '2026-07-31T10:00:00Z',
		reviewStatus: 'CHANGES_REQUESTED',
		editorNotes: 'tighten the lede',
		generatedBy: actor(),
		grant: { grantedAt: '2026-07-30T09:00:00Z', reviewer: actor({ id: 'r1', username: 'ed' }) },
		verdicts: [
			{
				verdict: 'CHANGES_REQUESTED',
				notes: 'tighten the lede',
				recordedAt: '2026-07-31T09:00:00Z',
				reviewer: actor({ id: 'r1', username: 'ed' }),
			},
		],
	});

	assert.equal(review.draftId, 'draft-1');
	assert.equal(review.reviewStatus, 'CHANGES_REQUESTED');
	assert.equal(review.grant.reviewer.username, 'ed');
	assert.equal(review.verdicts.length, 1);
	assert.equal(review.generatedBy.isAgent, true);
});

test('an own draft projects with no review activity INVENTED, and none implied', () => {
	// lesser's `Draft` carries no reviewStatus, editorNotes, grant, or verdict
	// history. They stay absent — nothing is fabricated — and the entry built
	// from this shape is marked `listing-only` so the absence is never read as
	// an answer. See the `listing-only` cases below.
	const review = toOwnDraftReview({
		id: 'draft-2',
		title: 'Mine',
		status: 'DRAFT',
		updatedAt: '2026-07-31T10:00:00Z',
		generatedBy: actor(),
		// lesser sets `reviewedBy` and `reviewStatus` TOGETHER on every verdict
		// (`draft_review.go`), so this listing describes a draft that HAS been
		// reviewed — and carries not one field that says what the verdict was.
		reviewedBy: actor({ id: 'r1', username: 'ed', isAgent: false }),
	});

	assert.equal(review.draftId, 'draft-2');
	assert.equal(review.reviewStatus, undefined);
	assert.equal(review.editorNotes, undefined);
	assert.equal(review.grant, undefined);
	assert.deepEqual(review.verdicts, []);

	// The projection knows a reviewer ruled on this draft and nothing about the
	// ruling. That gap is precisely why this shape may not drive a state badge.
	assert.equal(review.reviewedBy.username, 'ed');
});

test('a verdict row with an unknown verdict value is dropped, not coerced', () => {
	assert.equal(toVerdictRecord({ verdict: 'MAYBE', reviewer: actor(), recordedAt: 'x' }), null);
	assert.equal(toVerdictRecord({ verdict: 'APPROVED', reviewer: null, recordedAt: 'x' }), null);
});

test('an actor with neither id nor username is not an actor', () => {
	assert.equal(toReviewActor({ displayName: 'Ghost' }), null);
	assert.equal(toReviewActor(null), null);
	assert.equal(toReviewActor({ username: 'real' }).isAgent, false);
});

/* ---------------------------------------------------------------------------
 * The preview, and the refusal to fall back to source
 * ------------------------------------------------------------------------ */

test('a failed preview carries no HTML even when lesser returned some', () => {
	const preview = toDraftPreview({
		draftId: 'draft-3',
		success: false,
		renderedHtml: '<p>partial output</p>',
		sourceFormat: 'markdown',
		sourceBytes: 10,
		renderedBytes: 0,
		errors: ['unclosed code fence at line 40'],
	});

	assert.equal(preview.success, false);
	assert.equal(preview.html, null, 'partial output from a failed render must not survive');
	assert.deepEqual(preview.errors, ['unclosed code fence at line 40']);
});

test('a failed preview cannot become a renderable article', () => {
	const preview = toDraftPreview({
		draftId: 'draft-3',
		success: false,
		renderedHtml: '<p>partial</p>',
		errors: ['nope'],
	});
	assert.equal(toPreviewFaceArticle(preview, null), null);
});

test('a successful preview renders as html, unpublished, with the generator as author', () => {
	const preview = toDraftPreview({
		draftId: 'draft-4',
		success: true,
		renderedHtml: '<h2>Rendered by lesser</h2>',
		sourceFormat: 'markdown',
		sourceBytes: 100,
		renderedBytes: 200,
		errors: [],
	});

	const article = toPreviewFaceArticle(preview, {
		draftId: 'draft-4',
		title: 'Draft title',
		updatedAt: '',
		generatedBy: actor({ displayName: 'Scribe', username: 'scribe' }),
	});

	assert.equal(article.content, '<h2>Rendered by lesser</h2>');
	assert.equal(article.contentFormat, 'html');
	assert.equal(article.isPublished, false, 'a draft under review has not published');
	assert.equal(article.slug, '', 'a draft has no published address to claim');
	assert.equal(article.author.displayName, 'Scribe');
});

/* ---------------------------------------------------------------------------
 * Queue order
 * ------------------------------------------------------------------------ */

const stub = (draftId, extra = {}) => ({ draftId, updatedAt: '', verdicts: [], ...extra });

/** An own-draft entry, with the projection it was built from. */
const owned = (draftId, projection = 'review', extra = {}) => ({
	review: stub(draftId, { generatedBy: actor(), ...extra }),
	projection,
});

test('shared drafts come before the viewer own agent drafts', () => {
	const entries = orderQueueEntries([stub('shared-a'), stub('shared-b')], [owned('own-a')]);

	assert.deepEqual(
		entries.map((entry) => [entry.review.draftId, entry.source]),
		[
			['shared-a', 'shared-with-me'],
			['shared-b', 'shared-with-me'],
			['own-a', 'my-agent-draft'],
		]
	);
});

test('a draft that is both shared and owned appears once, on the shared side', () => {
	// The shared projection is the one carrying the grant and the verdict
	// history, so it is the one worth keeping.
	const entries = orderQueueEntries([stub('both')], [owned('both')]);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].source, 'shared-with-me');
});

test('every entry carries WHICH projection its review came from', () => {
	// The shared half is `DraftReview` by construction. The own half is whatever
	// arrived — and an entry that only got the `myDrafts` listing must say so,
	// because that shape cannot support a review-state claim either way.
	const entries = orderQueueEntries(
		[stub('shared-a')],
		[owned('own-full', 'review'), owned('own-thin', 'listing-only')]
	);

	assert.deepEqual(
		entries.map((entry) => [entry.review.draftId, entry.projection]),
		[
			['shared-a', 'review'],
			['own-full', 'review'],
			['own-thin', 'listing-only'],
		]
	);
});

test('only drafts with a recorded generator count as agent-generated', () => {
	assert.equal(isAgentGenerated(stub('x', { generatedBy: actor() })), true);
	assert.equal(isAgentGenerated(stub('x', { generatedBy: null })), false);
	assert.equal(isAgentGenerated(stub('x')), false);
});

/* ---------------------------------------------------------------------------
 * What an empty half of the queue is allowed to say
 *
 * The finding this section exists for: a half whose query FAILED was being
 * substituted with `[]`, and the template then printed "No drafts are currently
 * shared with you for review" underneath the load error. Emptiness and
 * unavailability are different states and only one of them is a claim about the
 * instance's contents.
 * ------------------------------------------------------------------------ */

test('an unavailable half never claims the instance has nothing', () => {
	for (const source of ['shared-with-me', 'my-agent-draft']) {
		const copy = emptyHalfCopy({ status: 'unavailable' }, source);

		assert.match(copy, /could not be loaded/, `${source} must name the failure`);
		assert.match(
			copy,
			/Nothing here means there are none/,
			`${source} must say the absence is not an answer`
		);

		// The definite sentences, which are true only of a loaded half.
		assert.doesNotMatch(copy, /^No drafts are currently shared/);
		assert.doesNotMatch(copy, /You have no agent-generated article drafts/);
	}
});

test('a loaded-and-complete half is allowed the definite sentence', () => {
	assert.match(
		emptyHalfCopy({ status: 'loaded', more: false }, 'shared-with-me'),
		/^No drafts are currently shared with you for review\./
	);
	assert.match(
		emptyHalfCopy({ status: 'loaded', more: false }, 'my-agent-draft'),
		/^You have no agent-generated article drafts\./
	);
});

test('a loaded half with more to come speaks only about what was scanned', () => {
	// `myDrafts` filters after it paginates, so an empty page is not an empty
	// set — and the same caution applies to a shared page that has a next one.
	for (const source of ['shared-with-me', 'my-agent-draft']) {
		const copy = emptyHalfCopy({ status: 'loaded', more: true }, source);
		assert.match(copy, /loaded so far/);
		assert.doesNotMatch(copy, /^No drafts are currently shared/);
		assert.doesNotMatch(copy, /^You have no agent-generated article drafts/);
	}
});

/* ---------------------------------------------------------------------------
 * Source-shape: the claims that are about absence
 * ------------------------------------------------------------------------ */

test('no review source imports a Markdown renderer or holds an {@html} sink', () => {
	for (const file of [
		'src/lib/cms/review.ts',
		'src/lib/cms/review-contract.ts',
		'src/lib/cms/review-transport.ts',
		'src/lib/review/verdict-offer.ts',
		'src/lib/routes/ReviewQueue.svelte',
		'src/lib/routes/ReviewWorkspace.svelte',
		'src/lib/review/PublishAction.svelte',
		'src/lib/review/VerdictPanel.svelte',
	]) {
		// Asserted on the RAW source, with no comment stripping.
		//
		// The earlier version stripped comments first, which was both weaker and
		// unnecessary. Weaker because comment stripping by regex is not comment
		// parsing: an unterminated or nested `<!--` swallows the rest of the file,
		// and everything after it stops being checked — so the probe could pass
		// while a sink sat below the gap. CodeQL flagged exactly that
		// (js/incomplete-multi-character-sanitization) and it was right.
		//
		// Unnecessary because none of these files mentions `{@html}` even in
		// prose, and the renderer check matches an IMPORT (`from '…'`) rather than
		// a bare package name, so the one file that discusses remark-parse in a
		// comment does not trip it. Nothing had to be excluded, which is the
		// cheapest way to be sure nothing was excluded by mistake.
		const source = readFileSync(file, 'utf8');

		assert.doesNotMatch(source, /\{@html\b/, `${file} contains an {@html} sink`);
		assert.doesNotMatch(
			source,
			/from\s+['"](marked|markdown-it|remark[^'"]*|shiki)['"]/,
			`${file} imports a Markdown renderer`
		);
	}
});

test('the publish path never decides the gate for itself', () => {
	const source = readFileSync('src/lib/review/PublishAction.svelte', 'utf8');

	// No approval arithmetic: the component may READ that a generator exists (to
	// say so), but it must not count verdicts or compare them to a reviewer set.
	assert.doesNotMatch(source, /verdicts\s*\.\s*(filter|length|every|some|reduce)/);
	assert.doesNotMatch(source, /activeReviewerCount/);
});

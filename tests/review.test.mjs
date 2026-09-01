import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { withSourceLock } from './helpers/source-lock.mjs';

import {
	REVIEW_DOCUMENTS,
	emptyHalfCopy,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toPreviewFaceArticle,
	toReviewActor,
	toVerdictRecord,
} from '../src/lib/cms/review-contract.ts';
import { describeVerdictOffer } from '../src/lib/review/verdict-offer.ts';

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
	assert.match(REVIEW_DOCUMENTS.MY_DRAFT_REVIEWS_QUERY, /myDraftReviews\(/);
	assert.match(REVIEW_DOCUMENTS.DRAFT_REVIEW_QUERY, /draftReview\(id: \$id\)/);
	assert.match(
		REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY,
		/draftPreview\(id: \$id, includeAccessUrls: true\)/
	);
	assert.match(REVIEW_DOCUMENTS.SUBMIT_DRAFT_REVIEW_MUTATION, /submitDraftReview\(draftId:/);
	assert.match(REVIEW_DOCUMENTS.PUBLISH_DRAFT_MUTATION, /publishDraft\(id: \$id\)/);
	assert.match(REVIEW_DOCUMENTS.SCHEDULE_DRAFT_MUTATION, /scheduleDraft\(id: \$id, scheduledAt:/);
});

test('the short-lived media opt-in rides ONLY the authenticated preview document', () => {
	// lesser v1.6.28 makes bearer URL minting opt-in per operation. Contentus
	// opts in on the one authenticated read that DISPLAYS a body, and on
	// nothing else: not on the queue projections, not on the verdict
	// submission, not on the publish mutation. A minted access URL is a
	// short-lived credential; asking for one where nothing displays it is a
	// credential waiting to be misplaced, so the opt-in is pinned to the
	// single document that needs it.
	const carrying = Object.entries(REVIEW_DOCUMENTS)
		.filter(([, document]) => document.includes('includeAccessUrls'))
		.map(([name]) => name);

	assert.deepEqual(carrying, ['DRAFT_PREVIEW_QUERY']);
	assert.match(
		REVIEW_DOCUMENTS.DRAFT_PREVIEW_QUERY,
		/draftPreview\(id: \$id, includeAccessUrls: true\)/,
		'the preview opts in with a literal true — a variable would leave the opt-in to a caller'
	);
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

test("v1.6.4's typed error codes classify ahead of any message text", () => {
	// lesser commit e93388ab7 types the CMS surface: the code is the
	// machine-readable discriminator, and the message rides along verbatim.
	const coded = (code, message = 'whatever lesser said') => [{ message, extensions: { code } }];

	const disabled = failureFromErrors(coded('FEATURE_DISABLED', 'cms drafts are disabled'));
	assert.equal(disabled.reason, 'cms-disabled');
	assert.equal(disabled.message, 'cms drafts are disabled');

	const missing = failureFromErrors(coded('NOT_FOUND'));
	assert.equal(missing.reason, 'not-found');

	const refused = failureFromErrors(coded('FORBIDDEN'));
	assert.equal(refused.reason, 'forbidden');

	const invalid = failureFromErrors(coded('VALIDATION', 'scheduled time must be in the future'));
	assert.equal(invalid.reason, 'rejected');
	assert.equal(invalid.message, 'scheduled time must be in the future');
});

test('a typed code wins over message text that would classify differently', () => {
	// The upstream classifier (`cmd/graphql/main.go`) tags "draft owner cannot
	// review their own draft" FORBIDDEN. On a v1.6.4 instance the typed answer
	// is the one rendered; the `self-review` substring branch remains for
	// pre-v1.6.4 instances, pinned by the test above.
	const failure = failureFromErrors([
		{
			message: 'draft scheduling is not enabled on this instance',
			extensions: { code: 'VALIDATION' },
		},
	]);
	assert.equal(failure.reason, 'rejected', 'the code, not the substring, decides');
	assert.equal(failure.message, 'draft scheduling is not enabled on this instance');
});

test('unmapped typed codes fall through to the substring classification', () => {
	// lesser's classifier tags the review-gate refusals INTERNAL_ERROR, which
	// this taxonomy deliberately does not map — the gate text still reaches the
	// `gated` branch, exactly as on a pre-v1.6.4 instance.
	const failure = failureFromErrors([
		{
			message: 'generated draft requires an active approval from the instance principal',
			extensions: { code: 'INTERNAL_ERROR' },
		},
	]);
	assert.equal(failure.reason, 'gated');
	assert.equal(
		failure.message,
		'generated draft requires an active approval from the instance principal'
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

test('a DraftReview projects its gate evaluation and staleness markers (v1.6.4)', () => {
	// All of these are lesser's own fields, passed through unread: the chrome
	// renders the server's evaluation and never re-derives it.
	const review = toDraftReview({
		draftId: 'draft-2',
		updatedAt: '2026-07-31T10:00:00Z',
		contentHash: 'sha256:abc',
		revision: 3,
		activeReviewerIds: ['actor-r1', 'actor-r2'],
		publishEligibility: {
			eligible: false,
			blockingReasons: ['draft requires approval from every active reviewer'],
			reviewersApproved: false,
			principalApprovalRequired: true,
			principalApproved: false,
		},
		verdicts: [
			{
				verdict: 'APPROVED',
				notes: null,
				contentHash: 'sha256:older',
				current: false,
				stale: true,
				recordedAt: '2026-07-30T09:00:00Z',
				reviewer: actor({ id: 'r1', username: 'ed', isAgent: false }),
			},
		],
	});

	assert.equal(review.contentHash, 'sha256:abc');
	assert.equal(review.revision, 3);
	assert.deepEqual(review.activeReviewerIds, ['actor-r1', 'actor-r2']);
	assert.deepEqual(review.publishEligibility, {
		eligible: false,
		blockingReasons: ['draft requires approval from every active reviewer'],
		reviewersApproved: false,
		principalApprovalRequired: true,
		principalApproved: false,
	});
	assert.equal(review.verdicts[0].contentHash, 'sha256:older');
	assert.equal(review.verdicts[0].current, false);
	assert.equal(review.verdicts[0].stale, true);
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

/** An own-draft entry, agent-generated as the queue's own half requires. */
const owned = (draftId, extra = {}) => stub(draftId, { generatedBy: actor(), ...extra });

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
	const entries = orderQueueEntries([stub('both')], [owned('both')]);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].source, 'shared-with-me');
});

test('every queue entry is a full review projection, from either half', () => {
	// Since lesser v1.6.4 both connections return `DraftReview` — the thin
	// `myDrafts` listing shape can no longer reach the queue, so there is no
	// "which projection arrived" marker left to assert.
	const entries = orderQueueEntries([stub('shared-a')], [owned('own-a')]);

	assert.equal(entries.length, 2);
	for (const entry of entries) {
		assert.equal(entry.projection, undefined, 'no projection marker exists to carry');
	}
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
	// The own half is walked with a page budget and the shared half pages, so an
	// empty result after a truncated walk is not an empty set.
	for (const source of ['shared-with-me', 'my-agent-draft']) {
		const copy = emptyHalfCopy({ status: 'loaded', more: true }, source);
		assert.match(copy, /loaded so far/);
		assert.doesNotMatch(copy, /^No drafts are currently shared/);
		assert.doesNotMatch(copy, /^You have no agent-generated article drafts/);
	}
});

/* ---------------------------------------------------------------------------
 * Whether the verdict controls are offered
 *
 * The finding this section exists for: the panel applied a local `!isAuthor`
 * gate on top of lesser's grant, which suppressed the principal-owner approval
 * path — the one lesser's publication gate requires for a generated draft the
 * principal owns.
 * ------------------------------------------------------------------------ */

const grant = { grantedAt: '2026-07-30T09:00:00Z', reviewer: actor({ username: 'principal' }) };

test('an active grant offers the verdict action even to the draft own author', () => {
	// lesser returns the owner's own grant for exactly one case: the explicit
	// principal-owner approval flow (`DraftReviewForCaller`). Offering the action
	// here is how a principal approves a principal-owned generated draft; lesser
	// re-checks `SubmitDraftReview` regardless.
	const offer = describeVerdictOffer({ grant }, true);

	assert.equal(offer.offer, true);
	assert.equal(offer.state, 'granted');
});

test('an active grant offers the verdict action to an invited reviewer', () => {
	assert.deepEqual(describeVerdictOffer({ grant }, false), { offer: true, state: 'granted' });
});

test('no grant is an honest refusal, and says which refusal it is', () => {
	// Absent a grant the action is not offered — but the reason differs, and the
	// author's explanation must name the self-grant path rather than assert a
	// blanket "you cannot review your own draft" that lesser does not enforce.
	assert.deepEqual(describeVerdictOffer({ grant: null }, true), {
		offer: false,
		state: 'no-grant-author',
	});
	assert.deepEqual(describeVerdictOffer({ grant: null }, false), {
		offer: false,
		state: 'no-grant',
	});
	assert.equal(describeVerdictOffer({}, false).offer, false);
});

test('the verdict panel takes its decision from that rule and holds no gate of its own', () => {
	const source = readFileSync('src/lib/review/VerdictPanel.svelte', 'utf8');

	assert.match(source, /describeVerdictOffer/, 'the panel must use the shared rule');

	// The regression this pins: a local authorship gate re-introduced alongside
	// the grant. `isAuthor` may still be PASSED to the rule (it chooses which
	// explanation to show); it may not be conjoined with the grant here.
	assert.doesNotMatch(
		source,
		/!isAuthor/,
		'the panel must not suppress a lesser-granted action for the author'
	);
	assert.doesNotMatch(source, /canReview/, 'the panel must not re-derive its own permission');
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
		// The workspace is one of these files and the renderer-authority probes
		// MUTATE it concurrently, so the read is locked: a fixture (a removed
		// import, a second invocation) must never answer for the shipped file.
		const source = withSourceLock(() => readFileSync(file, 'utf8'));

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

/* ---------------------------------------------------------------------------
 * The preview display sink — the one owned `{@html}`, content-bound here
 *
 * `scripts/audit-renderer-authority.mjs` admits exactly one owned sink and
 * binds its shape at build time; these probes pin the same contract from the
 * test side, against the files that run, so the two readings disagree loudly
 * if either one drifts. The display exists because the vendored fediverse
 * allowlist pass strips the lesser-authored `<figure>`/`<img>` that
 * `includeAccessUrls: true` serves (#112); lesser already rendered AND
 * sanitized these bytes, so the panel displays them without a second pass.
 * ------------------------------------------------------------------------ */

test('the preview display is one sink, bound to lesser preview output, and nothing more', () => {
	// Locked: the renderer-authority probes plant fixture sinks OVER this file
	// for the duration of an audit run, and a fixture (two `{@html}` tags, a
	// value import) must never answer for the shipped sink.
	const body = withSourceLock(() => readFileSync('src/lib/review/PreviewBody.svelte', 'utf8'));

	// Exactly one sink — the disclosure admits no second.
	assert.equal(
		[...body.matchAll(/\{@html\b/g)].length,
		1,
		'PreviewBody carries the one pinned sink and no other'
	);

	// Bound to the projection field verbatim: `toDraftPreview` nulls it unless
	// lesser reported success, so the sink can only ever display lesser's
	// rendered preview output. Anything computed from the field would be a
	// transform, which is the renderer's job, and lesser is the renderer.
	assert.match(body, /\{@html\s+preview\.html\s*\}/);

	// Type-only imports: nothing runtime-reachable stands between lesser's
	// bytes and the DOM.
	for (const match of body.matchAll(/^\s*import\s+(?!type\b)[^;]+;?/gm))
		assert.fail(`PreviewBody carries a value import: ${match[0].trim()}`);

	// No second sanitization, no rewrite, no renderer by any name.
	assert.doesNotMatch(body, /sanitizeHtml|DOMPurify|linkify|marked|remark/);
});

test('the workspace displays the preview through that sink and that sink alone', () => {
	// Locked like the sink read above: the probes mutate the workspace while
	// they audit it, and a fixture must never answer for the shipped file.
	const workspace = withSourceLock(() =>
		readFileSync('src/lib/routes/ReviewWorkspace.svelte', 'utf8')
	);

	assert.match(workspace, /import PreviewBody from '\$lib\/review\/PreviewBody\.svelte'/);
	assert.match(workspace, /<PreviewBody \{preview\} \/>/);

	// The preview no longer goes through the vendored `Article.Content`: its
	// fediverse allowlist is the pass that strips lesser's figures, and a
	// display that re-filtered trusted server output would reintroduce #112.
	assert.doesNotMatch(workspace, /ArticleContent|ArticleRoot|normalizeArticleData/);

	// And the workspace holds no sink of its own — the display component is
	// the only place the preview HTML meets the DOM.
	assert.doesNotMatch(workspace, /\{@html\b/);
});

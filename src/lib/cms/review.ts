/**
 * Face 2's consumption of lesser's shareable-draft review contract
 * (product design §5, face 2; lesser release v1.6.4).
 *
 * This module is the SESSION half, and it is deliberately thin: it reads the
 * access token out of `sessionStorage` and hands it to `cms/review-transport.ts`,
 * which performs every call. The documents themselves, the projections built
 * from the answers, and the failure taxonomy read out of lesser's errors live in
 * `cms/review-contract.ts`, which has no imports beyond types. Both are
 * re-exported here, because this module is face 2's one door onto lesser's
 * review contract.
 *
 * WHY THE SPLIT IS SHAPED THIS WAY. `$lib/auth/session` is the only aliased
 * import in the chain, and it is now confined to this file. Everything below it
 * resolves relatively, so a probe can import the transport directly, stub
 * `fetch` at the GraphQL boundary, and drive the REAL adapters —
 * `tests/review-adapters.test.mjs` does exactly that for publish, verdict, and
 * the queue. Before this split the round-trip gate could only reach the pure
 * projections, so a broken `publishDraft` stayed green.
 *
 * THREE INVARIANTS THIS FACE HOLDS.
 *
 * 1. RENDERER AUTHORITY. No document selects `Draft.content`. Not "selects it
 *    and declines to render it" — does not ask for it. The only body that
 *    reaches a reviewer is `draftPreview.renderedHtml`, which lesser produced
 *    with `cms.RenderDraftPreview` and which the vendored blog face sanitizes
 *    again on the way to the DOM. A preview that did not render is an explained
 *    failure carrying lesser's own deterministic errors, never a fallback to
 *    source.
 *
 * 2. THE GATE IS LESSER'S. `publishDraft` enforces unanimous approval across
 *    active reviewer grants, plus the instance principal's approval whenever
 *    the draft records a generator (`pkg/services/cms/draft_service.go`).
 *    Contentus never reconstructs that arithmetic: it describes the requirement
 *    with the vendored chrome's `describeApprovalRequirement`, calls the
 *    mutation, and reports what lesser answered. A refusal is displayed, never
 *    pre-empted or second-guessed.
 *
 * 3. AUTH. Every operation needs a token — each resolver opens with
 *    `requireAuth` — so all of it runs in the browser. `sessionStorage` is
 *    invisible to the SSR pass, and the render props travel on to a PUBLIC
 *    hydration endpoint, so a server-side review fetch would publish one
 *    reviewer's queue to anyone who asked for that URL. The review routes
 *    server-render their chrome and their signed-out state; the data arrives
 *    after the client has read the session.
 */

import { accessTokenOrNull } from '$lib/auth/session';
import type { DraftReviewData } from '$lib/blog-types';

import * as transport from './review-transport';
import type { ReviewQueue } from './review-contract';

export {
	DRAFT_OWNERSHIP_QUERY,
	DRAFT_PREVIEW_QUERY,
	DRAFT_REVIEW_QUERY,
	MY_DRAFT_REVIEWS_QUERY,
	PUBLISH_DRAFT_MUTATION,
	REVIEW_DOCUMENTS,
	SCHEDULE_DRAFT_MUTATION,
	SHARED_DRAFT_REVIEWS_QUERY,
	SUBMIT_DRAFT_REVIEW_MUTATION,
	emptyHalfCopy,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toPreviewFaceArticle,
	toReviewActor,
	toVerdictRecord,
} from './review-contract';
export type {
	DraftPreview,
	PreviewFaceArticle,
	QueueHalfState,
	QueueSource,
	ReviewFailure,
	ReviewFailureReason,
	ReviewQueue,
	ReviewQueueEntry,
	ReviewResult,
} from './review-contract';
export type { PublishedArticle, ScheduledDraft, VerdictSubmissionInput } from './review-transport';

/* -------------------------------------------------------------------------
 * The session-bound operations
 * ---------------------------------------------------------------------- */

export const loadReviewQueue = (): Promise<ReviewQueue> =>
	transport.loadReviewQueue(accessTokenOrNull());

export const isDraftAuthor = (id: string) => transport.isDraftAuthor(accessTokenOrNull(), id);

export const loadDraftReview = (id: string) => transport.loadDraftReview(accessTokenOrNull(), id);

export const loadDraftPreview = (id: string) => transport.loadDraftPreview(accessTokenOrNull(), id);

export const submitDraftReview = (submission: transport.VerdictSubmissionInput) =>
	transport.submitDraftReview(accessTokenOrNull(), submission);

export const publishDraft = (id: string) => transport.publishDraft(accessTokenOrNull(), id);

export const scheduleDraft = (id: string, scheduledAt: string) =>
	transport.scheduleDraft(accessTokenOrNull(), id, scheduledAt);

/**
 * A handler shaped for the vendored `Review.VerdictActions`.
 *
 * This is the adapter binding pattern `createSubmitDraftReviewHandler`
 * documents, over contentus's own transport rather than over
 * `LesserGraphQLAdapter`. The adapter is an Apollo client: instantiating one
 * here would add Apollo, `graphql`, and a cache layer to a client that posts
 * one document per action and has deliberately kept its GraphQL surface to a
 * single `fetch` (`$lib/cms/graphql`). The contract consumed is identical —
 * same mutation, same variables, same `DraftReview` back.
 *
 * It THROWS on failure, which is the component's protocol: a rejected promise
 * keeps the confirmation dialog open with the message visible so the reviewer
 * can retry, where a resolved one would close the dialog on a verdict that was
 * never recorded.
 */
export function createSubmitVerdictHandler(
	onRecorded?: (review: DraftReviewData) => void
): (submission: transport.VerdictSubmissionInput) => Promise<DraftReviewData> {
	return async (submission) => {
		const result = await submitDraftReview(submission);
		if (!result.ok) throw new Error(result.failure.message);
		onRecorded?.(result.value);
		return result.value;
	};
}

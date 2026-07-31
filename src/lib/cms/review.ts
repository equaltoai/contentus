/**
 * Face 2's consumption of lesser's shareable-draft review contract
 * (product design §5, face 2; lesser release v1.5.32).
 *
 * This module is the transport half: auth, the network calls, and the queue
 * assembly around them. The documents themselves, the projections built from
 * the answers, and the failure taxonomy read out of lesser's errors live in
 * `cms/review-contract.ts`, which has no imports beyond types so a probe can
 * load it directly. Re-exported here, because this module is face 2's one door
 * onto lesser's review contract.
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
import type { DraftReviewData, DraftReviewVerdict } from '$lib/blog-types';

import { graphqlRequest, GraphQLTransportError } from './graphql';
import {
	DRAFT_OWNERSHIP_QUERY,
	DRAFT_PREVIEW_QUERY,
	DRAFT_REVIEW_QUERY,
	MY_DRAFTS_QUERY,
	PUBLISH_DRAFT_MUTATION,
	SCHEDULE_DRAFT_MUTATION,
	SHARED_DRAFT_REVIEWS_QUERY,
	SUBMIT_DRAFT_REVIEW_MUTATION,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toOwnDraftReview,
	type DraftPreview,
	type ReviewFailure,
	type ReviewQueueEntry,
	type ReviewResult,
} from './review-contract';

export {
	DRAFT_OWNERSHIP_QUERY,
	DRAFT_PREVIEW_QUERY,
	DRAFT_REVIEW_QUERY,
	MY_DRAFTS_QUERY,
	PUBLISH_DRAFT_MUTATION,
	REVIEW_DOCUMENTS,
	SCHEDULE_DRAFT_MUTATION,
	SHARED_DRAFT_REVIEWS_QUERY,
	SUBMIT_DRAFT_REVIEW_MUTATION,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftPreview,
	toDraftReview,
	toOwnDraftReview,
	toPreviewFaceArticle,
	toReviewActor,
	toVerdictRecord,
} from './review-contract';
export type {
	DraftPreview,
	PreviewFaceArticle,
	QueueSource,
	ReviewFailure,
	ReviewFailureReason,
	ReviewQueueEntry,
	ReviewResult,
} from './review-contract';

function failureFromThrown(error: unknown): ReviewFailure {
	if (error instanceof GraphQLTransportError) {
		return {
			reason: 'transport',
			message: 'The instance did not answer. This is usually temporary — try again shortly.',
		};
	}
	return {
		reason: 'transport',
		message: error instanceof Error ? error.message : 'The request could not be sent.',
	};
}

/**
 * Run an authenticated review operation, or report why it could not run.
 *
 * The token is checked before the request rather than after a rejection: a
 * signed-out reviewer should be told to sign in, not spend a round trip
 * discovering it.
 */
async function authenticated<T>(
	document: string,
	variables: Record<string, unknown>,
	extract: (data: unknown) => T | null
): Promise<ReviewResult<T>> {
	const accessToken = accessTokenOrNull();
	if (!accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to review drafts on this instance.' },
		};
	}

	try {
		const result = await graphqlRequest<unknown>(document, variables, { accessToken });

		if (result.errors.length > 0) {
			return { ok: false, failure: failureFromErrors(result.errors) };
		}

		const value = extract(result.data);
		if (value === null) {
			return {
				ok: false,
				failure: {
					reason: 'not-found',
					message: 'The instance returned nothing for this request.',
				},
			};
		}

		return { ok: true, value };
	} catch (error) {
		return { ok: false, failure: failureFromThrown(error) };
	}
}

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/* -------------------------------------------------------------------------
 * The queue
 * ---------------------------------------------------------------------- */

export interface ReviewQueue {
	entries: ReviewQueueEntry[];
	/** Shared-with-me drafts lesser has not returned yet. */
	moreShared: boolean;
	/**
	 * Own drafts lesser has not returned yet.
	 *
	 * Load-bearing for honesty, not just for a button: `myDrafts` filters AFTER
	 * paginating (`graph/query_resolvers_cms.go`), so a page can come back with
	 * nothing while more drafts wait behind it. "No agent-generated drafts" and
	 * "none in the first N" are different claims, and the queue is not allowed
	 * to make the first when only the second is true.
	 */
	moreOwn: boolean;
	/** Non-fatal partial failures, so one empty half never hides the other. */
	failures: ReviewFailure[];
}

const QUEUE_PAGE_SIZE = 20;

/** How many `myDrafts` pages to walk looking for agent-generated drafts. */
const OWN_DRAFT_PAGE_BUDGET = 3;

interface Connection<T> {
	nodes: T[];
	hasNextPage: boolean;
	endCursor: string | null;
}

function toConnection(raw: unknown): Connection<unknown> {
	const connection = record(raw);
	const pageInfo = connection ? record(connection['pageInfo']) : null;
	const edges = Array.isArray(connection?.['edges']) ? (connection['edges'] as unknown[]) : [];

	return {
		nodes: edges.map((edge) => record(edge)?.['node']).filter((node) => node !== undefined),
		hasNextPage: pageInfo?.['hasNextPage'] === true,
		endCursor: pageInfo ? str(pageInfo['endCursor']) : null,
	};
}

async function loadSharedPage(
	after: string | null
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	return authenticated(SHARED_DRAFT_REVIEWS_QUERY, { first: QUEUE_PAGE_SIZE, after }, (data) => {
		const connection = toConnection(
			(data as { sharedDraftReviews?: unknown } | null)?.sharedDraftReviews
		);
		return {
			nodes: connection.nodes
				.map(toDraftReview)
				.filter((review): review is DraftReviewData => review !== null),
			hasNextPage: connection.hasNextPage,
			endCursor: connection.endCursor,
		};
	});
}

async function loadOwnDraftsPage(
	after: string | null
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	return authenticated(MY_DRAFTS_QUERY, { first: QUEUE_PAGE_SIZE, after }, (data) => {
		const connection = toConnection((data as { myDrafts?: unknown } | null)?.myDrafts);
		return {
			nodes: connection.nodes
				.map(toOwnDraftReview)
				.filter((review): review is DraftReviewData => review !== null),
			hasNextPage: connection.hasNextPage,
			endCursor: connection.endCursor,
		};
	});
}

/**
 * Walk `myDrafts` for agent-generated drafts, within a page budget.
 *
 * lesser filters `contentType` after paginating, and contentus filters
 * `generatedBy != null` after that, so the yield per page is not the page size
 * and a single page is a weak sample. Walking a few pages makes the queue
 * useful; the budget keeps a reviewer with a thousand drafts from waiting on
 * all of them, and whatever it did not reach is reported as `hasNextPage`
 * rather than silently dropped.
 */
async function collectOwnAgentDrafts(): Promise<ReviewResult<Connection<DraftReviewData>>> {
	const nodes: DraftReviewData[] = [];
	let cursor: string | null = null;
	let hasNextPage = false;

	for (let page = 0; page < OWN_DRAFT_PAGE_BUDGET; page += 1) {
		const result: ReviewResult<Connection<DraftReviewData>> = await loadOwnDraftsPage(cursor);
		if (!result.ok) {
			// A later page failing after earlier ones succeeded is still a partial
			// answer worth showing, with more-to-load left true so the queue does
			// not claim a completeness it does not have.
			if (nodes.length > 0) {
				return { ok: true, value: { nodes, hasNextPage: true, endCursor: cursor } };
			}
			return result;
		}

		nodes.push(...result.value.nodes.filter(isAgentGenerated));
		hasNextPage = result.value.hasNextPage;
		cursor = result.value.endCursor;

		if (!hasNextPage || !cursor) break;
	}

	return { ok: true, value: { nodes, hasNextPage, endCursor: cursor } };
}

/**
 * Build the review queue: drafts shared with the viewer first, then the
 * viewer's own agent-generated drafts.
 *
 * The two halves are loaded independently and neither can take the other down:
 * an instance that answers `sharedDraftReviews` but fails `myDrafts` shows the
 * shared queue and says what else it could not load. The ordering and
 * de-duplication rule itself lives in `orderQueueEntries`, which is pure.
 */
export async function loadReviewQueue(): Promise<ReviewQueue> {
	const failures: ReviewFailure[] = [];

	const [shared, own] = await Promise.all([loadSharedPage(null), collectOwnAgentDrafts()]);

	if (!shared.ok) failures.push(shared.failure);
	if (!own.ok) failures.push(own.failure);

	return {
		entries: orderQueueEntries(shared.ok ? shared.value.nodes : [], own.ok ? own.value.nodes : []),
		moreShared: shared.ok ? shared.value.hasNextPage : false,
		moreOwn: own.ok ? own.value.hasNextPage : false,
		failures,
	};
}

/* -------------------------------------------------------------------------
 * The workspace
 * ---------------------------------------------------------------------- */

/**
 * Whether the viewer is this draft's author.
 *
 * Never throws and never reports a failure: a probe that could not run is
 * simply "not established", and the workspace then shows the reviewer controls
 * rather than the author ones. That is the safe direction — the author controls
 * are publish and schedule, and hiding them costs a reload while wrongly
 * offering them would put a control on screen that lesser will refuse.
 */
export async function isDraftAuthor(id: string): Promise<boolean> {
	if (!id) return false;
	const result = await authenticated(DRAFT_OWNERSHIP_QUERY, { id }, (data) =>
		str(record((data as { draft?: unknown } | null)?.draft)?.['id'])
	);
	return result.ok;
}

export async function loadDraftReview(id: string): Promise<ReviewResult<DraftReviewData>> {
	if (!id) {
		return { ok: false, failure: { reason: 'not-found', message: 'No draft was requested.' } };
	}
	return authenticated(DRAFT_REVIEW_QUERY, { id }, (data) =>
		toDraftReview((data as { draftReview?: unknown } | null)?.draftReview)
	);
}

/**
 * Load the server-rendered preview for a draft.
 *
 * This is the only body contentus will ever show a reviewer. lesser authorizes
 * it through `DraftReviewForCaller`, so it resolves for the draft's author AND
 * for a reviewer holding an active grant — which is what makes a shared review
 * possible at all without ever exposing `Draft.content` to the client.
 */
export async function loadDraftPreview(id: string): Promise<ReviewResult<DraftPreview>> {
	if (!id) {
		return { ok: false, failure: { reason: 'not-found', message: 'No draft was requested.' } };
	}
	return authenticated(DRAFT_PREVIEW_QUERY, { id }, (data) =>
		toDraftPreview((data as { draftPreview?: unknown } | null)?.draftPreview)
	);
}

/* -------------------------------------------------------------------------
 * Verdicts and publication
 * ---------------------------------------------------------------------- */

/**
 * What `Review.VerdictActions` emits. Structurally identical to the adapters
 * package's `DraftReviewSubmission`, which is deliberate: the vendored
 * component's `onSubmit` wires straight through with no shim.
 */
export interface VerdictSubmissionInput {
	draftId: string;
	verdict: DraftReviewVerdict;
	notes?: string;
}

/**
 * Record a verdict.
 *
 * lesser decides whether this caller may record it and what `reviewStatus`
 * results; the updated `DraftReview` it returns is what the workspace then
 * renders. Contentus does not predict the new state and does not patch its
 * local copy — the server's answer replaces it.
 */
export async function submitDraftReview(
	submission: VerdictSubmissionInput
): Promise<ReviewResult<DraftReviewData>> {
	return authenticated(
		SUBMIT_DRAFT_REVIEW_MUTATION,
		{
			draftId: submission.draftId,
			verdict: submission.verdict,
			notes: submission.notes?.trim() ? submission.notes.trim() : null,
		},
		(data) => toDraftReview((data as { submitDraftReview?: unknown } | null)?.submitDraftReview)
	);
}

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
): (submission: VerdictSubmissionInput) => Promise<DraftReviewData> {
	return async (submission) => {
		const result = await submitDraftReview(submission);
		if (!result.ok) throw new Error(result.failure.message);
		onRecorded?.(result.value);
		return result.value;
	};
}

export interface PublishedArticle {
	id: string;
	slug: string | null;
	title: string | null;
	publishedAt: string | null;
	canonicalUrl: string | null;
}

/**
 * Publish a draft.
 *
 * The gate lives in lesser (`DraftService.PublishDraft`): unanimous approval
 * from every reviewer holding an active grant, and — for any draft that records
 * a generator — the instance principal's approval as well, cumulatively. This
 * function evaluates none of that. It calls the mutation and reports the
 * answer, which is the only way a client can be right about a rule whose inputs
 * (the active grant set, the principal's identity) it cannot see.
 */
export async function publishDraft(id: string): Promise<ReviewResult<PublishedArticle>> {
	return authenticated(PUBLISH_DRAFT_MUTATION, { id }, (data) => {
		const article = record((data as { publishDraft?: unknown } | null)?.publishDraft);
		const articleId = article ? str(article['id']) : null;
		if (!article || !articleId) return null;

		return {
			id: articleId,
			slug: str(article['slug']),
			title: str(article['title']),
			publishedAt: str(article['publishedAt']),
			canonicalUrl: str(article['canonicalUrl']),
		};
	});
}

export interface ScheduledDraft {
	id: string;
	status: string | null;
	scheduledAt: string | null;
}

/**
 * Schedule a draft for later publication.
 *
 * `scheduleDraft` sits behind `requireCMSSchedulingEnabled`, and lesser's public
 * schema exposes no capability field a client could read first — the flags live
 * on the admin-scoped `AdminInstanceConfig`. So the control is offered, and an
 * instance with scheduling off answers with the feature-gate error, which the
 * workspace renders as a product state and then stops offering. Guessing
 * instead would either hide a working feature or promise a missing one; a
 * readable capability signal is an upstream ask recorded in
 * `docs/consumption/review-contract.md`.
 *
 * Scheduling is not an approval. lesser evaluates the same gate when the
 * scheduled moment arrives.
 */
export async function scheduleDraft(
	id: string,
	scheduledAt: string
): Promise<ReviewResult<ScheduledDraft>> {
	return authenticated(SCHEDULE_DRAFT_MUTATION, { id, scheduledAt }, (data) => {
		const draft = record((data as { scheduleDraft?: unknown } | null)?.scheduleDraft);
		const draftId = draft ? str(draft['id']) : null;
		if (!draft || !draftId) return null;

		return {
			id: draftId,
			status: str(draft['status']),
			scheduledAt: str(draft['scheduledAt']),
		};
	});
}

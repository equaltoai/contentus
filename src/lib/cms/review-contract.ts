/**
 * lesser's shared-draft review contract: the documents contentus sends, the
 * projections it builds from the answers, and the failure taxonomy it reads out
 * of lesser's errors.
 *
 * Split out of `cms/review.ts` for the reason `cms/compose-inputs.ts` was split
 * out of `cms/compose.ts`: everything here decides WHAT GOES OVER THE WIRE and
 * WHAT THE CLIENT BELIEVES CAME BACK, and rules that consequential deserve
 * probes that load the shipped code directly, with no bundler and no alias
 * resolver in between. The network calls, their auth, and the queue assembly
 * stay in `cms/review.ts`; this module has no imports beyond types.
 *
 * THE INVARIANT THIS FILE CARRIES. No document below selects `Draft.content`.
 * Not "selects it and declines to render it" — does not ask for it.
 * `Draft.content` is the stored source, and the only body contentus will ever
 * show a reviewer is `draftPreview.renderedHtml`, which lesser produced with
 * its own renderer. `tests/review.test.mjs` asserts that over every exported
 * document, so a field added in a hurry fails the build rather than shipping.
 *
 * Verified against lesser release v1.5.32.
 */

import type {
	DraftReviewData,
	DraftReviewVerdict,
	ReviewActorData,
	ReviewVerdictRecordData,
} from '../blog-types';
import type { GraphQLError } from './graphql';

/* -------------------------------------------------------------------------
 * Documents
 * ---------------------------------------------------------------------- */

/**
 * The actor projection the review chrome renders.
 *
 * `avatar` and `isAgent` are lesser's own field names (`type Actor`), and
 * `isAgent` is read rather than inferred: the chrome has a first-class contract
 * field for it, so guessing from a username would be contentus inventing a
 * signal lesser already publishes.
 */
const REVIEW_ACTOR_FIELDS = `
	id
	username
	domain
	displayName
	avatar
	isAgent
`;

/**
 * `DraftReview`, in full.
 *
 * Note what is NOT here, because its absence is the contract rather than an
 * oversight: `DraftReview` carries no body field at all. lesser's review
 * projection deliberately exposes metadata and verdict history and makes
 * `draftPreview` the only path to content.
 *
 * Depth check: `sharedDraftReviews → edges → node → grant → reviewer → username`
 * is 6, inside lesser's `GRAPHQL_MAX_DEPTH` of 12 for ordinary callers.
 */
const DRAFT_REVIEW_FIELDS = `
	draftId
	title
	subtitle
	excerpt
	contentFormat
	status
	scheduledAt
	updatedAt
	createdAt
	reviewStatus
	editorNotes
	generatedBy { ${REVIEW_ACTOR_FIELDS} }
	reviewedBy { ${REVIEW_ACTOR_FIELDS} }
	grant {
		grantedAt
		reviewer { ${REVIEW_ACTOR_FIELDS} }
	}
	verdicts {
		verdict
		notes
		recordedAt
		reviewer { ${REVIEW_ACTOR_FIELDS} }
	}
`;

export const SHARED_DRAFT_REVIEWS_QUERY = `
	query ContentusSharedDraftReviews($first: Int, $after: Cursor) {
		sharedDraftReviews(first: $first, after: $after) {
			totalCount
			pageInfo { hasNextPage endCursor }
			edges {
				cursor
				node { ${DRAFT_REVIEW_FIELDS} }
			}
		}
	}
`;

export const DRAFT_REVIEW_QUERY = `
	query ContentusDraftReview($id: ID!) {
		draftReview(id: $id) { ${DRAFT_REVIEW_FIELDS} }
	}
`;

/**
 * The viewer's own drafts.
 *
 * `content` is absent by construction — see the module header. `slug` is
 * selected because the workspace shows what address a publish would claim; it
 * is displayed, never edited (a published slug is immutable, and Article
 * identity is lesser's).
 */
export const MY_DRAFTS_QUERY = `
	query ContentusMyDrafts($first: Int, $after: Cursor) {
		myDrafts(contentType: ARTICLE, first: $first, after: $after) {
			totalCount
			pageInfo { hasNextPage endCursor }
			edges {
				cursor
				node {
					id
					title
					slug
					status
					scheduledAt
					contentFormat
					updatedAt
					createdAt
					generatedBy { ${REVIEW_ACTOR_FIELDS} }
					reviewedBy { ${REVIEW_ACTOR_FIELDS} }
				}
			}
		}
	}
`;

/**
 * The ONLY preview path.
 *
 * `success`, `errors`, and the byte counters are selected together on purpose:
 * a preview that failed has to be able to say so specifically. lesser's limits
 * are 256 KiB of source and 512 KiB of rendered output, and a draft that
 * crossed one is a different problem from a draft whose Markdown did not parse.
 */
export const DRAFT_PREVIEW_QUERY = `
	query ContentusDraftPreview($id: ID!) {
		draftPreview(id: $id) {
			draftId
			success
			renderedHtml
			sourceFormat
			sourceBytes
			renderedBytes
			errors
		}
	}
`;

/**
 * Ownership probe: can the caller read this draft AS ITS AUTHOR?
 *
 * `draft(id)` resolves through `GetDraft(ctx, username, id)`, which is
 * owner-only, while `draftReview` and `draftPreview` go through
 * `DraftReviewForCaller`, which also admits an active grantee. So the answer to
 * this query is exactly the answer to "am I the author", and it comes from
 * lesser rather than from anything contentus inferred.
 *
 * `id` is the ONLY field selected, and that is the whole design of this
 * document. `Draft.content` is the stored source; asking for it to learn a
 * boolean would pull an unrendered body into the client for no reason. The
 * question here is whether the query resolves, not what it returns.
 *
 * What it decides is which CONTROLS to show — publish and schedule are the
 * author's, verdicts are an invited reviewer's. It decides nothing about
 * permission: lesser re-checks every mutation, and a stale answer here can only
 * ever produce a control that lesser then refuses, never one it wrongly allows.
 */
export const DRAFT_OWNERSHIP_QUERY = `
	query ContentusDraftOwnership($id: ID!) {
		draft(id: $id) { id }
	}
`;

export const SUBMIT_DRAFT_REVIEW_MUTATION = `
	mutation ContentusSubmitDraftReview($draftId: ID!, $verdict: DraftReviewVerdict!, $notes: String) {
		submitDraftReview(draftId: $draftId, verdict: $verdict, notes: $notes) {
			${DRAFT_REVIEW_FIELDS}
		}
	}
`;

export const PUBLISH_DRAFT_MUTATION = `
	mutation ContentusPublishDraft($id: ID!) {
		publishDraft(id: $id) {
			id
			slug
			title
			publishedAt
			canonicalUrl
		}
	}
`;

export const SCHEDULE_DRAFT_MUTATION = `
	mutation ContentusScheduleDraft($id: ID!, $scheduledAt: Time!) {
		scheduleDraft(id: $id, scheduledAt: $scheduledAt) {
			id
			status
			scheduledAt
		}
	}
`;

/** Every document this face sends, so a probe can assert over all of them. */
export const REVIEW_DOCUMENTS = {
	SHARED_DRAFT_REVIEWS_QUERY,
	DRAFT_REVIEW_QUERY,
	MY_DRAFTS_QUERY,
	DRAFT_PREVIEW_QUERY,
	DRAFT_OWNERSHIP_QUERY,
	SUBMIT_DRAFT_REVIEW_MUTATION,
	PUBLISH_DRAFT_MUTATION,
	SCHEDULE_DRAFT_MUTATION,
} as const;

/* -------------------------------------------------------------------------
 * Failure taxonomy
 * ---------------------------------------------------------------------- */

/**
 * Why a review operation did not happen.
 *
 * Three of these are not errors in the operator's sense — they are lesser's
 * rules holding, and naming them apart is what lets the UI say so:
 *
 *   - `gated` — the publish was refused because the approval rule is not
 *     satisfied. That is the review gate doing its job, and rendering it as a
 *     generic failure would make a working gate look like a broken instance.
 *   - `self-review` — the caller is the draft's owner, and an owner may not
 *     review their own draft unless they are the instance principal.
 *   - `no-grant` — the caller holds no active invitation on this draft. An
 *     invitation that was revoked lands here too, which is the point of it
 *     being revocable.
 */
export type ReviewFailureReason =
	| 'unauthenticated'
	| 'forbidden'
	| 'gated'
	| 'self-review'
	| 'no-grant'
	| 'not-found'
	| 'cms-disabled'
	| 'rejected'
	| 'transport';

export interface ReviewFailure {
	reason: ReviewFailureReason;
	message: string;
}

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; failure: ReviewFailure };

export function isAuthError(errors: readonly GraphQLError[]): boolean {
	return errors.some((error) => {
		const message = String(error.message ?? '').toLowerCase();
		const code = String(error.extensions?.['code'] ?? '').toLowerCase();
		return (
			code === 'unauthenticated' ||
			code === 'unauthorized' ||
			message.includes('authentication required') ||
			message.includes('unauthenticated') ||
			message.includes('not authenticated')
		);
	});
}

/**
 * Classify a GraphQL error set from a review operation.
 *
 * Matching on message text is not a thing to be proud of, and it is here for a
 * stated reason: lesser's CMS resolvers return bare `errors.New(...)` values
 * without an `extensions.code`, so the wire carries no machine-readable
 * discriminator to switch on. The classification is presentational only —
 * every branch shows the reviewer what lesser said, verbatim — so a miss
 * degrades to a plainer message rather than to a wrong permission decision. A
 * typed error code on the CMS surface is an upstream ask, recorded in
 * `docs/consumption/review-contract.md`.
 *
 * The strings matched are lesser's own, from `pkg/services/cms/draft_review.go`
 * and `draft_service.go`, and `tests/review.test.mjs` pins them.
 */
export function failureFromErrors(errors: readonly GraphQLError[]): ReviewFailure {
	if (isAuthError(errors)) {
		return {
			reason: 'unauthenticated',
			message: 'Your session has expired. Sign in again to continue reviewing.',
		};
	}

	const messages = errors.map((error) => String(error.message ?? '').toLowerCase());
	const first = errors[0]?.message ?? 'The instance rejected this request.';
	const says = (...needles: string[]) =>
		messages.some((message) => needles.some((needle) => message.includes(needle)));

	// Ordered most specific first. The two self/grant refusals are checked
	// BEFORE the gate, because they name a different situation entirely: the
	// gate is "this draft is not approved yet", these are "you are not the one
	// who approves it". Telling a reviewer to go and gather approvals when the
	// real answer is that their invitation was revoked sends them somewhere
	// there is nothing to do.
	if (says('cannot review their own draft')) {
		return { reason: 'self-review', message: first };
	}
	if (says('grant is not active', 'no active grant')) {
		return { reason: 'no-grant', message: first };
	}

	// The gate:
	//   "draft requires approval from every active reviewer"
	//   "generated draft requires an active approval from the instance principal"
	if (says('approv', 'principal')) {
		return { reason: 'gated', message: first };
	}
	if (says('not enabled', 'disabled', 'long-form', 'long form')) {
		return { reason: 'cms-disabled', message: first };
	}
	if (says('not found', 'no such draft', 'does not exist')) {
		return { reason: 'not-found', message: first };
	}
	if (says('forbidden', 'not permitted', 'not authorized', 'access denied')) {
		return { reason: 'forbidden', message: first };
	}

	return { reason: 'rejected', message: first };
}

/* -------------------------------------------------------------------------
 * Projections
 * ---------------------------------------------------------------------- */

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function toReviewActor(raw: unknown): ReviewActorData | null {
	const actor = record(raw);
	if (!actor) return null;

	const username = str(actor['username']);
	const id = str(actor['id']);
	if (!username && !id) return null;

	return {
		id: id ?? '',
		username: username ?? '',
		domain: str(actor['domain']),
		displayName: str(actor['displayName']),
		avatar: str(actor['avatar']),
		isAgent: actor['isAgent'] === true,
	};
}

export function toVerdictRecord(raw: unknown): ReviewVerdictRecordData | null {
	const entry = record(raw);
	if (!entry) return null;

	const reviewer = toReviewActor(entry['reviewer']);
	if (!reviewer) return null;

	const verdict = str(entry['verdict']);
	if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED') return null;

	return {
		verdict: verdict as DraftReviewVerdict,
		notes: str(entry['notes']),
		reviewer,
		recordedAt: str(entry['recordedAt']) ?? '',
	};
}

const DRAFT_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED'] as const;
type DraftStatusValue = (typeof DRAFT_STATUSES)[number];

function toDraftStatus(raw: unknown): DraftStatusValue | undefined {
	const value = str(raw);
	return value && (DRAFT_STATUSES as readonly string[]).includes(value)
		? (value as DraftStatusValue)
		: undefined;
}

function toContentFormat(raw: unknown): 'HTML' | 'MARKDOWN' | undefined {
	const value = str(raw);
	return value === 'HTML' || value === 'MARKDOWN' ? value : undefined;
}

/** A `DraftReview` node from lesser, as the vendored chrome consumes it. */
export function toDraftReview(raw: unknown): DraftReviewData | null {
	const node = record(raw);
	if (!node) return null;

	const draftId = str(node['draftId']);
	if (!draftId) return null;

	const grant = record(node['grant']);
	const grantReviewer = grant ? toReviewActor(grant['reviewer']) : null;

	const verdicts = Array.isArray(node['verdicts'])
		? node['verdicts']
				.map(toVerdictRecord)
				.filter((entry): entry is ReviewVerdictRecordData => entry !== null)
		: [];

	const status = toDraftStatus(node['status']);
	const contentFormat = toContentFormat(node['contentFormat']);

	return {
		draftId,
		title: str(node['title']),
		subtitle: str(node['subtitle']),
		excerpt: str(node['excerpt']),
		...(contentFormat ? { contentFormat } : {}),
		...(status ? { status } : {}),
		scheduledAt: str(node['scheduledAt']),
		updatedAt: str(node['updatedAt']) ?? '',
		createdAt: str(node['createdAt']) ?? '',
		generatedBy: toReviewActor(node['generatedBy']),
		reviewedBy: toReviewActor(node['reviewedBy']),
		reviewStatus: str(node['reviewStatus']),
		editorNotes: str(node['editorNotes']),
		grant:
			grantReviewer && grant
				? { reviewer: grantReviewer, grantedAt: str(grant['grantedAt']) ?? '' }
				: null,
		verdicts,
	};
}

/**
 * A `Draft` the viewer owns, projected onto the same view model.
 *
 * `DraftReviewData` is explicitly a view model rather than a generated GraphQL
 * type — "every field is optional except the identity fields, so a consumer can
 * render partial query selections" — which is what makes this projection a use
 * of the contract rather than a fabrication of one.
 *
 * THIS PROJECTION IS INCOMPLETE, AND THAT IS THE WHOLE POINT OF SAYING SO.
 * lesser's `type Draft` carries no `reviewStatus`, no `editorNotes`, no `grant`,
 * and no verdict history — only `reviewedBy` (`graph/phase1.graphql`). Those
 * fields therefore stay ABSENT here, and nothing is invented in their place.
 *
 * What absence must NOT become is a claim. The vendored `resolveReviewState`
 * turns an empty verdict history plus a missing `reviewStatus` into the definite
 * label "No review activity recorded", which is false for any own draft that a
 * reviewer has already ruled on: lesser sets `Draft.ReviewedBy` AND
 * `Draft.ReviewStatus` together on every `SubmitDraftReview`
 * (`pkg/services/cms/draft_review.go`), so this listing can carry a reviewer and
 * still show no verdicts.
 *
 * So an entry built from this projection is marked `listing-only` (see
 * {@link OwnDraft}) and the queue is not allowed to render the vendored state
 * badge for it. The queue first tries `draftReview(id)` — which
 * `DraftReviewForCaller` authorizes for the draft's owner — and only falls back
 * to this shape when that answer did not arrive.
 */
export function toOwnDraftReview(raw: unknown): DraftReviewData | null {
	const node = record(raw);
	if (!node) return null;

	const draftId = str(node['id']);
	if (!draftId) return null;

	const status = toDraftStatus(node['status']);
	const contentFormat = toContentFormat(node['contentFormat']);

	return {
		draftId,
		title: str(node['title']),
		...(contentFormat ? { contentFormat } : {}),
		...(status ? { status } : {}),
		scheduledAt: str(node['scheduledAt']),
		updatedAt: str(node['updatedAt']) ?? '',
		createdAt: str(node['createdAt']) ?? '',
		generatedBy: toReviewActor(node['generatedBy']),
		reviewedBy: toReviewActor(node['reviewedBy']),
		verdicts: [],
	};
}

/**
 * A draft preview, exactly as lesser rendered it.
 *
 * `html` is null unless lesser reported success — there is no branch in this
 * codebase that produces preview HTML any other way.
 */
export interface DraftPreview {
	draftId: string;
	success: boolean;
	html: string | null;
	sourceFormat: string;
	sourceBytes: number;
	renderedBytes: number;
	errors: string[];
}

export function toDraftPreview(raw: unknown): DraftPreview | null {
	const preview = record(raw);
	if (!preview) return null;

	const draftId = str(preview['draftId']);
	if (!draftId) return null;

	const success = preview['success'] === true;
	const html = str(preview['renderedHtml']);
	const errors = Array.isArray(preview['errors'])
		? preview['errors'].map((entry) => String(entry)).filter(Boolean)
		: [];

	return {
		draftId,
		success,
		// A failed render has nothing displayable, whatever it put in the field.
		// Carrying it forward would leave partial output one template edit away
		// from the screen.
		html: success ? html : null,
		sourceFormat: str(preview['sourceFormat']) ?? '',
		sourceBytes: typeof preview['sourceBytes'] === 'number' ? preview['sourceBytes'] : 0,
		renderedBytes: typeof preview['renderedBytes'] === 'number' ? preview['renderedBytes'] : 0,
		errors,
	};
}

export interface PreviewFaceArticle {
	id: string;
	slug: string;
	content: string;
	contentFormat: 'html';
	title: string;
	author: { id: string; displayName?: string; username?: string };
	isPublished: false;
}

/**
 * Shape a rendered preview for the vendored blog face's `Article` compound.
 *
 * `contentFormat` is `'html'` unconditionally, and that is a statement of fact
 * rather than a choice: the only value this function is ever handed is
 * `DraftPreview.renderedHtml`, which lesser produced with its own renderer.
 * There is no branch that could pass unrendered source and label it HTML —
 * `toDraftPreview` already nulled the field on any preview that did not
 * succeed, and this function refuses both a null and an unsuccessful preview.
 *
 * The author is the recorded generator when there is one. The preview panel
 * renders `Article.Content` alone, so nothing displays it; it is populated
 * because the face's view model asks for it, and populating it with the actor
 * lesser named beats populating it with a placeholder.
 */
export function toPreviewFaceArticle(
	preview: DraftPreview,
	review: DraftReviewData | null
): PreviewFaceArticle | null {
	if (!preview.success || !preview.html) return null;

	const generator = review?.generatedBy ?? null;

	return {
		id: preview.draftId,
		// A draft has no published address, and inventing one here would put a
		// slug on screen that names nothing.
		slug: '',
		content: preview.html,
		contentFormat: 'html',
		title: review?.title?.trim() || 'Untitled draft',
		author: {
			id: generator?.id ?? '',
			...(generator?.displayName ? { displayName: generator.displayName } : {}),
			...(generator?.username ? { username: generator.username } : {}),
		},
		// Never true on this surface. A draft under review has not published, and
		// the whole point of the gate is that reaching this screen is not
		// publication.
		isPublished: false,
	};
}

/* -------------------------------------------------------------------------
 * Queue assembly
 * ---------------------------------------------------------------------- */

/** Where a queue entry came from, which is also the sort order. */
export type QueueSource = 'shared-with-me' | 'my-agent-draft';

/**
 * Which of lesser's two projections an entry's `review` actually came from.
 *
 * `review` is `DraftReview` — reviewStatus, grant, and the verdict history are
 * all present, so the vendored chrome's state badge is lesser's own answer.
 *
 * `listing-only` is the `myDrafts` shape, which carries none of them. The badge
 * would report absent data as a decided absence, so an entry marked this way is
 * rendered by contentus's own chrome and says the review state is not known
 * rather than that there is none.
 */
export type EntryProjection = 'review' | 'listing-only';

export interface ReviewQueueEntry {
	review: DraftReviewData;
	source: QueueSource;
	projection: EntryProjection;
}

/** One of the viewer's own drafts, with the projection it was built from. */
export interface OwnDraft {
	review: DraftReviewData;
	projection: EntryProjection;
}

/**
 * Order and de-duplicate the two halves of the queue.
 *
 * Shared-with-me first, then the viewer's own agent-generated drafts: an agent
 * writes and a human reviews, so the things waiting on this person sit above
 * the things this person set in motion (product design §5).
 *
 * A draft that is BOTH shared with the viewer and owned by them appears once,
 * on the shared side, because that projection is the one carrying the verdict
 * history and the grant.
 *
 * Pure, and separate from the fetching, so the ordering rule can be asserted
 * without a transport.
 */
export function orderQueueEntries(
	shared: readonly DraftReviewData[],
	own: readonly OwnDraft[]
): ReviewQueueEntry[] {
	const entries: ReviewQueueEntry[] = [];
	const seen = new Set<string>();

	for (const review of shared) {
		if (seen.has(review.draftId)) continue;
		seen.add(review.draftId);
		// The shared half is `DraftReview` by construction: `sharedDraftReviews`
		// returns nothing else.
		entries.push({ review, source: 'shared-with-me', projection: 'review' });
	}

	for (const draft of own) {
		if (seen.has(draft.review.draftId)) continue;
		seen.add(draft.review.draftId);
		entries.push({
			review: draft.review,
			source: 'my-agent-draft',
			projection: draft.projection,
		});
	}

	return entries;
}

/* -------------------------------------------------------------------------
 * What a half of the queue may truthfully say
 * ---------------------------------------------------------------------- */

/**
 * Whether a half of the queue was actually answered, and how completely.
 *
 * `unavailable` is not "empty". A half whose query failed has told the client
 * NOTHING about what is in it, and substituting an empty list — which is what
 * this face used to do — turns a load error into the sentence "no drafts are
 * shared with you". Keeping the two apart is the whole reason this type exists.
 */
export type QueueHalfState = { status: 'loaded'; more: boolean } | { status: 'unavailable' };

/**
 * The line a half of the queue renders when it has no entries to show.
 *
 * Here rather than in the template because the CLAIM is the thing under test:
 * exactly one of these three sentences is true for a given state, and only the
 * first is a statement about the instance's contents.
 *
 *   - loaded, nothing more     — a real, complete, empty answer. Definite.
 *   - loaded, more to come     — nothing in what was scanned. Not a claim about
 *                                the set, because `myDrafts` filters after it
 *                                paginates and `sharedDraftReviews` pages.
 *   - unavailable              — no answer at all. The queue says so and says
 *                                nothing else; the failure itself is rendered
 *                                separately, above.
 */
export function emptyHalfCopy(half: QueueHalfState, source: QueueSource): string {
	if (half.status === 'unavailable') {
		return source === 'shared-with-me'
			? 'The drafts shared with you could not be loaded, so this instance has not said whether any are waiting for you. Nothing here means there are none.'
			: 'Your own drafts could not be loaded, so this instance has not said whether any agent-generated drafts are waiting. Nothing here means there are none.';
	}

	if (half.more) {
		return source === 'shared-with-me'
			? 'None of the drafts loaded so far are shared with you, and this instance has more to send.'
			: 'None of the drafts loaded so far were generated by an agent, and this instance has more drafts than were scanned.';
	}

	return source === 'shared-with-me'
		? 'No drafts are currently shared with you for review. A draft appears here when its author invites you through this instance or over MCP.'
		: 'You have no agent-generated article drafts. Drafts an agent writes for you appear here with their attribution, so you can see exactly what was produced on your behalf.';
}

/**
 * The assembled queue: both halves, what each of them managed to say, and the
 * failures behind any that did not.
 */
export interface ReviewQueue {
	entries: ReviewQueueEntry[];
	/** Drafts shared with the viewer — loaded (with or without more), or not. */
	shared: QueueHalfState;
	/**
	 * The viewer's own agent-generated drafts.
	 *
	 * `more` is load-bearing for honesty, not just for a button: `myDrafts`
	 * filters AFTER paginating (`graph/query_resolvers_cms.go`), so a page can
	 * come back with nothing while more drafts wait behind it. "No
	 * agent-generated drafts" and "none in the first N" are different claims.
	 */
	own: QueueHalfState;
	/** Non-fatal partial failures, so one empty half never hides the other. */
	failures: ReviewFailure[];
}

/** Only drafts an agent produced belong in the second half of the queue. */
export function isAgentGenerated(review: DraftReviewData): boolean {
	return Boolean(review.generatedBy);
}

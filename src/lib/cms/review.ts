/**
 * Face 2's consumption of lesser's shareable-draft review contract
 * (product design §5, face 2; lesser release v1.5.32).
 *
 * Every operation here exists in lesser `docs/contracts/graphql-schema.graphql`
 * at v1.5.32: the `sharedDraftReviews` / `draftReview` / `myDrafts` /
 * `draftPreview` queries and the `submitDraftReview` / `publishDraft` /
 * `scheduleDraft` mutations. Nothing is invented and nothing is derived —
 * contentus asks, renders what comes back, and lets lesser decide what it means.
 *
 * THREE INVARIANTS THIS MODULE EXISTS TO HOLD.
 *
 * 1. RENDERER AUTHORITY. `Draft.content` is the STORED SOURCE, and no query in
 *    this file selects it. Not "selects it and declines to render it" —
 *    does not ask for it. The only body that reaches a reviewer is
 *    `draftPreview.renderedHtml`, which lesser produced with `cms.RenderDraftPreview`
 *    and which the vendored blog face sanitizes again on the way to the DOM. A
 *    preview that did not render is an explained failure with lesser's own
 *    deterministic errors, never a fallback to source.
 *
 * 2. THE GATE IS LESSER'S. `publishDraft` enforces unanimous approval across
 *    active reviewer grants, plus the instance principal's approval whenever
 *    the draft records a generator (`pkg/services/cms`). Contentus never
 *    reconstructs that arithmetic: it describes the requirement with the
 *    vendored chrome's `describeApprovalRequirement`, calls the mutation, and
 *    reports what lesser answered. A refusal is displayed, never pre-empted or
 *    second-guessed.
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
import type {
	DraftReviewData,
	DraftReviewVerdict,
	ReviewActorData,
	ReviewVerdictRecordData,
} from '$lib/blog-types';

import { graphqlRequest, GraphQLTransportError, type GraphQLError } from './graphql';

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
 * `content` is absent by construction — see invariant 1 in the module header.
 * `slug` is selected because the workspace shows what address a publish would
 * claim; it is displayed, never edited (a published slug is immutable, and
 * Article identity is lesser's).
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

/* -------------------------------------------------------------------------
 * Failure shapes
 * ---------------------------------------------------------------------- */

/**
 * Why a review operation did not happen.
 *
 * `gated` is the one worth distinguishing by name. It is not an error in the
 * reviewer's sense: it is lesser declining to publish because the approval rule
 * is not satisfied, which is the review gate doing its job. Rendering it as a
 * generic failure would make a working gate look like a broken instance.
 */
export type ReviewFailureReason =
	| 'unauthenticated'
	| 'forbidden'
	| 'gated'
	| 'not-found'
	| 'cms-disabled'
	| 'feature-disabled'
	| 'rejected'
	| 'transport';

export interface ReviewFailure {
	reason: ReviewFailureReason;
	message: string;
}

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; failure: ReviewFailure };

function messagesOf(errors: GraphQLError[]): string[] {
	return errors.map((error) => String(error.message ?? '').toLowerCase());
}

function isAuthError(errors: GraphQLError[]): boolean {
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
 * every branch shows the reviewer what lesser said — so a miss degrades to a
 * plainer message rather than to a wrong permission decision. A typed error
 * code on the CMS surface is an upstream ask, recorded in
 * `docs/consumption/review-contract.md`.
 */
function failureFromErrors(errors: GraphQLError[]): ReviewFailure {
	if (isAuthError(errors)) {
		return {
			reason: 'unauthenticated',
			message: 'Your session has expired. Sign in again to continue reviewing.',
		};
	}

	const messages = messagesOf(errors);
	const first = errors[0]?.message ?? 'The instance rejected this request.';
	const says = (...needles: string[]) =>
		messages.some((message) => needles.some((needle) => message.includes(needle)));

	// The gate. lesser refuses the publish and says why; that refusal IS the
	// product behaviour face 2 exists to make legible, so it keeps its own
	// reason and lesser's own wording.
	if (says('approv', 'principal', 'reviewer')) {
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

/* -------------------------------------------------------------------------
 * Projections
 * ---------------------------------------------------------------------- */

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function toReviewActor(raw: unknown): ReviewActorData | null {
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

function toVerdictRecord(raw: unknown): ReviewVerdictRecordData | null {
	const entry = record(raw);
	if (!entry) return null;

	const reviewer = toReviewActor(entry['reviewer']);
	if (!reviewer) return null;

	const verdict = str(entry['verdict']);
	if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED') return null;

	return {
		verdict,
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
 * The fields lesser's `Draft` genuinely does not carry stay ABSENT: no
 * `reviewStatus`, no `editorNotes`, no `grant`, and an empty verdict history.
 * That is not a gap to paper over. It is what makes the chrome render "No
 * review activity recorded" for an own draft nobody has reviewed — which is
 * true, and is the neutral state the design calls for where the projection
 * lacks data.
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

/* -------------------------------------------------------------------------
 * The queue
 * ---------------------------------------------------------------------- */

/** Where a queue entry came from, which is also the sort order. */
export type QueueSource = 'shared-with-me' | 'my-agent-draft';

export interface ReviewQueueEntry {
	review: DraftReviewData;
	source: QueueSource;
}

export interface ReviewQueue {
	entries: ReviewQueueEntry[];
	/** Shared-with-me drafts lesser has not returned yet. */
	moreShared: boolean;
	/**
	 * Own drafts lesser has not returned yet.
	 *
	 * Load-bearing for honesty, not just for a button: `myDrafts` filters
	 * AFTER paginating (`graph/query_resolvers_cms.go`), so a page can come
	 * back with nothing while more drafts wait behind it. "No agent-generated
	 * drafts" and "none in the first N" are different claims, and the queue is
	 * not allowed to make the first when only the second is true.
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
 * Build the review queue: drafts shared with the viewer first, then the
 * viewer's own agent-generated drafts.
 *
 * That order is the workflow, not a preference — an agent writes, a human
 * reviews — so it is the sort rather than a filter the reviewer has to find
 * (product design §5).
 *
 * The two halves are loaded independently and neither can take the other down:
 * an instance that answers `sharedDraftReviews` but fails `myDrafts` shows the
 * shared queue and says what else it could not load. A draft that is BOTH
 * shared with the viewer and owned by them appears once, on the shared side,
 * because that projection carries the verdict history and the grant.
 */
export async function loadReviewQueue(): Promise<ReviewQueue> {
	const failures: ReviewFailure[] = [];

	const [shared, own] = await Promise.all([loadSharedPage(null), collectOwnAgentDrafts()]);

	const entries: ReviewQueueEntry[] = [];
	const seen = new Set<string>();

	let moreShared = false;
	if (shared.ok) {
		moreShared = shared.value.hasNextPage;
		for (const review of shared.value.nodes) {
			if (seen.has(review.draftId)) continue;
			seen.add(review.draftId);
			entries.push({ review, source: 'shared-with-me' });
		}
	} else {
		failures.push(shared.failure);
	}

	let moreOwn = false;
	if (own.ok) {
		moreOwn = own.value.hasNextPage;
		for (const review of own.value.nodes) {
			if (seen.has(review.draftId)) continue;
			seen.add(review.draftId);
			entries.push({ review, source: 'my-agent-draft' });
		}
	} else {
		failures.push(own.failure);
	}

	return { entries, moreShared, moreOwn, failures };
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
			// not claim completeness it does not have.
			if (nodes.length > 0)
				return { ok: true, value: { nodes, hasNextPage: true, endCursor: cursor } };
			return result;
		}

		nodes.push(...result.value.nodes.filter((review) => review.generatedBy));
		hasNextPage = result.value.hasNextPage;
		cursor = result.value.endCursor;

		if (!hasNextPage || !cursor) break;
	}

	return { ok: true, value: { nodes, hasNextPage, endCursor: cursor } };
}

/* -------------------------------------------------------------------------
 * The workspace
 * ---------------------------------------------------------------------- */

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

function toDraftPreview(raw: unknown): DraftPreview | null {
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
 * function does not evaluate any of that. It calls the mutation and reports the
 * answer, which is the only way the client can be right about a rule whose
 * inputs (the active grant set, the principal's identity) it cannot see.
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

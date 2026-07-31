/**
 * Face 2's review operations, over an EXPLICIT access token.
 *
 * Split out of `cms/review.ts` for the reason `cms/review-contract.ts` was split
 * out before it, taken one step further. The contract module holds what goes
 * over the wire and what the client believes came back, and has no imports
 * beyond types. This module holds the calls themselves — every `publishDraft`,
 * `submitDraftReview`, and queue assembly the shipped face performs — and its
 * only imports are relative, so a probe can load it directly, stub `fetch` at
 * the GraphQL boundary, and drive the REAL adapters.
 *
 * That is not a testing convenience, it is the point. The M2d gate previously
 * asserted the publish step by handing a hand-written error to
 * `failureFromErrors` and projecting a stand-in article: an adapter that sent
 * the wrong document, the wrong variables, or mis-read the answer stayed green.
 * `tests/review-adapters.test.mjs` now sends the shipped documents through these
 * functions with the transport mocked, so the adapter is what is under test.
 *
 * `cms/review.ts` remains face 2's one door onto the contract: it reads the
 * session and delegates here. The token is a PARAMETER rather than an ambient
 * lookup, which also states the auth rule in the type — none of these run
 * anonymously, because every one of lesser's resolvers opens with `requireAuth`.
 *
 * THE THREE INVARIANTS ARE UNCHANGED and are documented in `cms/review.ts`:
 * renderer authority (no document selects `Draft.content`), the gate is
 * lesser's, and every operation is authenticated and therefore client-side.
 */

import type { DraftReviewData, DraftReviewVerdict } from '../blog-types';

// Explicit `.ts` extensions: this module and everything it pulls in at runtime
// are loaded straight off disk by `node --test --experimental-strip-types`,
// and Node's ESM resolver does not guess extensions. Vite and `tsc`
// (`allowImportingTsExtensions`) both accept the explicit form.
import { graphqlRequest, GraphQLTransportError } from './graphql.ts';
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
	type OwnDraft,
	type QueueHalfState,
	type ReviewFailure,
	type ReviewQueue,
	type ReviewResult,
} from './review-contract.ts';

/** A caller's bearer token, or null when there is no session. */
export type AccessToken = string | null;

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
	accessToken: AccessToken,
	document: string,
	variables: Record<string, unknown>,
	extract: (data: unknown) => T | null
): Promise<ReviewResult<T>> {
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

const QUEUE_PAGE_SIZE = 20;

/** How many `myDrafts` pages to walk looking for agent-generated drafts. */
const OWN_DRAFT_PAGE_BUDGET = 3;

/**
 * How many own drafts have their review projection fetched at once.
 *
 * `draftReview(id)` is per draft — lesser exposes no batch review projection for
 * `myDrafts` (recorded in `docs/consumption/review-contract.md`) — so the queue
 * fans out. Bounded so a reviewer with a page of agent drafts does not open
 * twenty simultaneous requests; nothing is dropped, it is only paced.
 */
const OWN_DRAFT_ENRICH_CONCURRENCY = 4;

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
	accessToken: AccessToken,
	after: string | null
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	return authenticated(
		accessToken,
		SHARED_DRAFT_REVIEWS_QUERY,
		{ first: QUEUE_PAGE_SIZE, after },
		(data) => {
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
		}
	);
}

async function loadOwnDraftsPage(
	accessToken: AccessToken,
	after: string | null
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	return authenticated(accessToken, MY_DRAFTS_QUERY, { first: QUEUE_PAGE_SIZE, after }, (data) => {
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
 * Ask lesser for the review projection of an own draft.
 *
 * `myDrafts` returns `type Draft`, which carries no `reviewStatus`, no grant,
 * and no verdict history — only `reviewedBy`. So a draft a reviewer has already
 * ruled on comes back from the listing indistinguishable from one nobody has
 * touched, and the vendored state badge reports that absence as "No review
 * activity recorded".
 *
 * `draftReview(id)` is the projection that does carry them, and
 * `DraftReviewForCaller` authorizes it for the draft's OWNER as well as for an
 * active grantee (`pkg/services/cms/draft_review.go`), so the viewer is entitled
 * to every one of these. Asking is therefore reading the contract, not working
 * around it.
 *
 * A draft whose projection does not arrive keeps its listing shape and is
 * marked `listing-only`, and the queue renders it as an unknown review state.
 * It is never dropped: the listing already proved the draft exists.
 */
async function enrichOwnDraft(
	accessToken: AccessToken,
	listing: DraftReviewData
): Promise<OwnDraft> {
	const result = await loadDraftReview(accessToken, listing.draftId);
	if (!result.ok) return { review: listing, projection: 'listing-only' };
	return { review: result.value, projection: 'review' };
}

/** Run `task` over `items` with a bounded number in flight, preserving order. */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;

	const worker = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			out[index] = await task(items[index] as T);
		}
	};

	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
	);
	return out;
}

/**
 * Walk `myDrafts` for agent-generated drafts, within a page budget, and load the
 * review projection for each.
 *
 * lesser filters `contentType` after paginating, and contentus filters
 * `generatedBy != null` after that, so the yield per page is not the page size
 * and a single page is a weak sample. Walking a few pages makes the queue
 * useful; the budget keeps a reviewer with a thousand drafts from waiting on
 * all of them, and whatever it did not reach is reported as `hasNextPage`
 * rather than silently dropped.
 */
async function collectOwnAgentDrafts(
	accessToken: AccessToken
): Promise<ReviewResult<Connection<OwnDraft>>> {
	const listings: DraftReviewData[] = [];
	let cursor: string | null = null;
	let hasNextPage = false;
	let truncated = false;

	for (let page = 0; page < OWN_DRAFT_PAGE_BUDGET; page += 1) {
		const result: ReviewResult<Connection<DraftReviewData>> = await loadOwnDraftsPage(
			accessToken,
			cursor
		);
		if (!result.ok) {
			// A later page failing after earlier ones succeeded is still a partial
			// answer worth showing, with more-to-load left true so the queue does
			// not claim a completeness it does not have.
			if (listings.length > 0) {
				truncated = true;
				break;
			}
			return result;
		}

		listings.push(...result.value.nodes.filter(isAgentGenerated));
		hasNextPage = result.value.hasNextPage;
		cursor = result.value.endCursor;

		if (!hasNextPage || !cursor) break;
	}

	const nodes = await mapWithConcurrency(listings, OWN_DRAFT_ENRICH_CONCURRENCY, (listing) =>
		enrichOwnDraft(accessToken, listing)
	);

	return {
		ok: true,
		value: { nodes, hasNextPage: truncated || hasNextPage, endCursor: cursor },
	};
}

function halfState<T>(result: ReviewResult<Connection<T>>): QueueHalfState {
	return result.ok
		? { status: 'loaded', more: result.value.hasNextPage }
		: { status: 'unavailable' };
}

/**
 * Build the review queue: drafts shared with the viewer first, then the
 * viewer's own agent-generated drafts.
 *
 * The two halves are loaded independently and neither can take the other down:
 * an instance that answers `sharedDraftReviews` but fails `myDrafts` shows the
 * shared queue and says what else it could not load.
 *
 * A FAILED HALF IS NOT AN EMPTY HALF. It contributes no entries, but its state
 * is `unavailable` rather than a loaded-and-empty one, because the queue's copy
 * is derived from that state and "no drafts are shared with you" is a claim
 * about the instance's contents that a failed query cannot support. The
 * ordering and de-duplication rule itself lives in `orderQueueEntries`, which
 * is pure.
 */
export async function loadReviewQueue(accessToken: AccessToken): Promise<ReviewQueue> {
	const failures: ReviewFailure[] = [];

	const [shared, own] = await Promise.all([
		loadSharedPage(accessToken, null),
		collectOwnAgentDrafts(accessToken),
	]);

	if (!shared.ok) failures.push(shared.failure);
	if (!own.ok) failures.push(own.failure);

	return {
		entries: orderQueueEntries(shared.ok ? shared.value.nodes : [], own.ok ? own.value.nodes : []),
		shared: halfState(shared),
		own: halfState(own),
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
export async function isDraftAuthor(accessToken: AccessToken, id: string): Promise<boolean> {
	if (!id) return false;
	const result = await authenticated(accessToken, DRAFT_OWNERSHIP_QUERY, { id }, (data) =>
		str(record((data as { draft?: unknown } | null)?.draft)?.['id'])
	);
	return result.ok;
}

export async function loadDraftReview(
	accessToken: AccessToken,
	id: string
): Promise<ReviewResult<DraftReviewData>> {
	if (!id) {
		return { ok: false, failure: { reason: 'not-found', message: 'No draft was requested.' } };
	}
	return authenticated(accessToken, DRAFT_REVIEW_QUERY, { id }, (data) =>
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
export async function loadDraftPreview(
	accessToken: AccessToken,
	id: string
): Promise<ReviewResult<DraftPreview>> {
	if (!id) {
		return { ok: false, failure: { reason: 'not-found', message: 'No draft was requested.' } };
	}
	return authenticated(accessToken, DRAFT_PREVIEW_QUERY, { id }, (data) =>
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
	accessToken: AccessToken,
	submission: VerdictSubmissionInput
): Promise<ReviewResult<DraftReviewData>> {
	return authenticated(
		accessToken,
		SUBMIT_DRAFT_REVIEW_MUTATION,
		{
			draftId: submission.draftId,
			verdict: submission.verdict,
			notes: submission.notes?.trim() ? submission.notes.trim() : null,
		},
		(data) => toDraftReview((data as { submitDraftReview?: unknown } | null)?.submitDraftReview)
	);
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
export async function publishDraft(
	accessToken: AccessToken,
	id: string
): Promise<ReviewResult<PublishedArticle>> {
	return authenticated(accessToken, PUBLISH_DRAFT_MUTATION, { id }, (data) => {
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
	accessToken: AccessToken,
	id: string,
	scheduledAt: string
): Promise<ReviewResult<ScheduledDraft>> {
	return authenticated(accessToken, SCHEDULE_DRAFT_MUTATION, { id, scheduledAt }, (data) => {
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

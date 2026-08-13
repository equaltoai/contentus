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

import type { DraftReviewData, DraftReviewVerdict, ReviewActorData } from '../blog-types';

// The act-as context: what this transport sends as `X-Lesser-Act-As`, and what
// ends a selection when lesser says a grant is gone. Explicit `.ts` extension
// like everything else here — probe-loaded under `node --test`.
import { actAsSelection, clearActAs, hasForbiddenExtension } from '../agents/act-as.ts';

// Explicit `.ts` extensions: this module and everything it pulls in at runtime
// are loaded straight off disk by `node --test --experimental-strip-types`,
// and Node's ESM resolver does not guess extensions. Vite and `tsc`
// (`allowImportingTsExtensions`) both accept the explicit form.
import { graphqlRequest, GraphQLTransportError } from './graphql.ts';
import {
	DRAFT_ACTED_BY_QUERY,
	DRAFT_OWNERSHIP_QUERY,
	DRAFT_PREVIEW_QUERY,
	DRAFT_REVIEW_QUERY,
	MY_DRAFT_REVIEWS_QUERY,
	PUBLISH_DRAFT_MUTATION,
	SCHEDULE_DRAFT_MUTATION,
	SHARED_DRAFT_REVIEWS_QUERY,
	SUBMIT_DRAFT_REVIEW_MUTATION,
	failureFromErrors,
	isAgentGenerated,
	orderQueueEntries,
	toDraftActedBy,
	toDraftPreview,
	toDraftReview,
	type DraftPreview,
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
 *
 * ACT-AS IS THE DEFAULT, AND THE OPT-OUT IS DELIBERATE. lesser's act-as
 * contract enables the header on this face's operations — `draft`,
 * `draftPreview`, `sharedDraftReviews`, `draftReview`, `submitDraftReview`,
 * `publishDraft` — and a selection from the agents route is attached
 * automatically. The two calls that are NOT on the enabled list opt out with
 * `{ actAsEnabled: false }` and state why at the call site: the header on an
 * unlisted operation is silently ignored and the request runs owner semantics,
 * so sending it there would dress a stated limitation as agent behavior.
 *
 * A FORBIDDEN extension on a request that carried the header is lesser saying
 * the grant is gone — revocation mid-session is the designed case, re-checked
 * per request. The selection is cleared here (announced to every subscribed
 * surface) and the failure is named `act-as-revoked` so the surface can say
 * what happened rather than showing a generic refusal.
 */
async function authenticated<T>(
	accessToken: AccessToken,
	document: string,
	variables: Record<string, unknown>,
	extract: (data: unknown) => T | null,
	options: { actAsEnabled?: boolean } = {}
): Promise<ReviewResult<T>> {
	if (!accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to review drafts on this instance.' },
		};
	}

	const actAs = options.actAsEnabled === false ? null : (actAsSelection()?.agentUsername ?? null);

	try {
		const result = await graphqlRequest<unknown>(document, variables, {
			accessToken,
			...(actAs ? { actAs } : {}),
		});

		const revocation = revocationFailure(actAs, result.errors);
		if (revocation) return { ok: false, failure: revocation };

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

/**
 * Whether a response ends an active act-as selection.
 *
 * lesser answers a revoked grant with the `FORBIDDEN` error extension on an
 * HTTP 200 — never a 403, which is the REST spelling. When the request carried
 * a selection and the answer carries the extension, the selection is cleared
 * (announced to subscribed surfaces) and the failure is named `act-as-revoked`.
 * Without a selection attached, a FORBIDDEN is an ordinary refusal and nothing
 * here touches the act-as state.
 */
function revocationFailure(
	actAs: string | null,
	errors: readonly {
		message: string;
		path?: (string | number)[];
		extensions?: Record<string, unknown>;
	}[]
): ReviewFailure | null {
	if (!actAs || !hasForbiddenExtension(errors)) return null;
	clearActAs();
	return {
		reason: 'act-as-revoked',
		message: `The share grant for @${actAs} was revoked, so acting as that agent has ended.`,
	};
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

/**
 * How many `myDraftReviews` pages to walk for the own half of the queue.
 *
 * The walk exists for honesty, not for completeness: the budget keeps a
 * reviewer with a thousand drafts from waiting on all of them, and whatever
 * it did not reach is reported as `hasNextPage` rather than silently dropped.
 */
const OWN_REVIEW_PAGE_BUDGET = 3;

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

async function loadOwnReviewsPage(
	accessToken: AccessToken,
	after: string | null
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	return authenticated(
		accessToken,
		MY_DRAFT_REVIEWS_QUERY,
		{ first: QUEUE_PAGE_SIZE, after },
		(data) => {
			const connection = toConnection(
				(data as { myDraftReviews?: unknown } | null)?.myDraftReviews
			);
			return {
				nodes: connection.nodes
					.map(toDraftReview)
					.filter((review): review is DraftReviewData => review !== null),
				hasNextPage: connection.hasNextPage,
				endCursor: connection.endCursor,
			};
		},
		// `myDraftReviews` is NOT on lesser's act-as enabled list: the header
		// would be silently ignored and the request would run owner semantics.
		// That is the recorded limitation (docs/planning/agent-share-act-as-m7.md),
		// and the opt-out keeps the design from dressing it as agent behavior.
		{ actAsEnabled: false }
	);
}

/**
 * Walk `myDraftReviews` for the viewer's agent-generated drafts, within a page
 * budget.
 *
 * lesser v1.6.4 added `myDraftReviews` — "review assignments created by the
 * authenticated draft owner" — returning the SAME full `DraftReview`
 * projection as `sharedDraftReviews`. This closes the recorded upstream ask
 * for a batch review projection of own drafts: before it, the queue walked
 * `myDrafts` (a listing with no `reviewStatus`, no grant, and no verdict
 * history) and fanned out one `draftReview(id)` per draft, with a
 * `listing-only` fallback for any projection that did not arrive. The fan-out,
 * the fallback, and the `listing-only` marker are all gone — each edge's node
 * already IS the full review, so one connection answers the whole half.
 *
 * The budget and the truncation honesty are unchanged: whatever the walk did
 * not reach is reported as `hasNextPage`, so the queue never claims a
 * completeness it does not have.
 */
async function collectOwnAgentDrafts(
	accessToken: AccessToken
): Promise<ReviewResult<Connection<DraftReviewData>>> {
	const nodes: DraftReviewData[] = [];
	let cursor: string | null = null;
	let hasNextPage = false;
	let truncated = false;

	for (let page = 0; page < OWN_REVIEW_PAGE_BUDGET; page += 1) {
		const result = await loadOwnReviewsPage(accessToken, cursor);
		if (!result.ok) {
			// A later page failing after earlier ones succeeded is still a partial
			// answer worth showing, with more-to-load left true so the queue does
			// not claim a completeness it does not have.
			if (nodes.length > 0) {
				truncated = true;
				break;
			}
			return result;
		}

		nodes.push(...result.value.nodes.filter(isAgentGenerated));
		hasNextPage = result.value.hasNextPage;
		cursor = result.value.endCursor;

		if (!hasNextPage || !cursor) break;
	}

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
 * an instance that answers `sharedDraftReviews` but fails `myDraftReviews`
 * shows the shared queue and says what else it could not load.
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

/**
 * Who last wrote this draft on its author's behalf, from lesser's
 * `Draft.actedBy`.
 *
 * A success with a null value is the normal answer — no act-as write has
 * happened — and must not be confused with a failed read. A failed read
 * (an owner-only `draft(id)` refused for a non-owner, for instance) is
 * returned as a failure; the caller treats both the same way on screen:
 * nothing to show, presence-driven.
 */
export async function loadDraftActedBy(
	accessToken: AccessToken,
	id: string
): Promise<ReviewResult<ReviewActorData | null>> {
	if (!id) {
		return { ok: false, failure: { reason: 'not-found', message: 'No draft was requested.' } };
	}
	if (!accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to review drafts on this instance.' },
		};
	}

	// `draft` IS on lesser's act-as enabled list: under a selection the read is
	// agent-scoped, which is exactly when an owner-only field like `actedBy`
	// becomes visible to the grantee acting as the agent.
	const actAs = actAsSelection()?.agentUsername ?? null;

	try {
		const result = await graphqlRequest<unknown>(
			DRAFT_ACTED_BY_QUERY,
			{ id },
			{ accessToken, ...(actAs ? { actAs } : {}) }
		);

		const revocation = revocationFailure(actAs, result.errors);
		if (revocation) return { ok: false, failure: revocation };

		if (result.errors.length > 0) {
			return { ok: false, failure: failureFromErrors(result.errors) };
		}

		return {
			ok: true,
			value: toDraftActedBy((result.data as { draft?: unknown } | null)?.draft),
		};
	} catch (error) {
		return { ok: false, failure: failureFromThrown(error) };
	}
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
 * `scheduleDraft` sits behind `requireCMSSchedulingEnabled`. lesser v1.6.4
 * answers the capability ask this comment used to record:
 * `InstanceInfo.cmsFeatures.scheduling` is served on the public `instance`
 * field, and `PublishAction.svelte` reads it (via `$lib/instance/info`) so an
 * instance with scheduling off never offers the control and this mutation is
 * never attempted. What the served flag does NOT do is retire the refusal
 * path: a served `true` can be stale by click time, so the typed
 * FEATURE_DISABLED error an attempt can still come back with remains the
 * final word, and the workspace stops offering the control for the rest of
 * the session when it arrives — a refusal is an answer, and repeating a
 * question lesser has already declined is not useful.
 *
 * Scheduling is not an approval. lesser evaluates the same gate when the
 * scheduled moment arrives.
 */
export async function scheduleDraft(
	accessToken: AccessToken,
	id: string,
	scheduledAt: string
): Promise<ReviewResult<ScheduledDraft>> {
	return authenticated(
		accessToken,
		SCHEDULE_DRAFT_MUTATION,
		{ id, scheduledAt },
		(data) => {
			const draft = record((data as { scheduleDraft?: unknown } | null)?.scheduleDraft);
			const draftId = draft ? str(draft['id']) : null;
			if (!draft || !draftId) return null;

			return {
				id: draftId,
				status: str(draft['status']),
				scheduledAt: str(draft['scheduledAt']),
			};
		},
		// `scheduleDraft` is deliberately NOT act-as-enabled upstream: a
		// scheduler-driven publish cannot carry honest caller attribution. No
		// act-as threading reaches it, per the planning doc.
		{ actAsEnabled: false }
	);
}

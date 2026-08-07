/**
 * The network half of face 4: every call contentus makes against lesser's
 * timeline surface, and nothing else.
 *
 * Split from `contract.ts` the way `cms/review-transport.ts` is split from
 * `cms/review-contract.ts`, and for the same payoff: the token is a parameter
 * here rather than a `sessionStorage` read, so `tests/timeline-adapters.test.mjs`
 * can stub `fetch` at the GraphQL boundary and drive the REAL adapters. A
 * probe that can only reach the pure projections leaves a broken fetch green.
 *
 * No function here throws. Each returns a result carrying either a page or a
 * reason, because every caller is a screen and every screen needs something to
 * render. `GraphQLTransportError` — the instance being unreachable — is caught
 * and becomes `unavailable`, which is what it looks like to a reader.
 */

import { graphqlRequest } from '../cms/graphql.ts';
import {
	ACTOR_QUERY,
	TIMELINE_QUERY,
	classifyTimelineFailure,
	readRequiresAuth,
	toAccount,
	toTimelinePage,
	type ContentusTimelineType,
	type TimelineFailure,
	type TimelinePage,
} from './contract.ts';
import type { Account } from '../types.ts';

/** How many objects a page asks for. lesser's own default is 20. */
export const TIMELINE_PAGE_SIZE = 20;

export interface TimelineRequest {
	type: ContentusTimelineType;
	/** Required for ACTOR; lesser rejects the read without it. */
	actorId?: string | null;
	after?: string | null;
	first?: number;
	mediaOnly?: boolean;
	excludeAgents?: boolean;
	accessToken?: string | null;
	endpoint?: string | null;
	signal?: AbortSignal;
}

/**
 * A page, or a reason there is none.
 *
 * `partial` is the half that was missing and is the reason this is not a bare
 * boolean-plus-page. GraphQL answers a request that half-failed with BOTH data
 * and errors, and lesser's timeline document selects nullable fields —
 * `boostedObject` above all — so a field that failed comes back as `null`
 * alongside an error explaining it. Reporting that as `ok` with no marker makes
 * a failed field indistinguishable from a genuinely absent one: a post whose
 * boost could not be resolved renders as a post that was never a boost. The
 * objects are still worth showing, so they are shown — and the screen is told
 * that something under them is missing rather than being left to assert
 * completeness it does not have.
 *
 * It carries no server text. lesser's timeline errors are plain `errors.New`
 * values with no extension code (routed upstream), so the message is a raw
 * internal string and the only honest thing a client can say from it is THAT
 * something failed.
 */
export type TimelineResult =
	{ ok: true; page: TimelinePage; partial: boolean } | { ok: false; failure: TimelineFailure };

/**
 * Read one page of a timeline.
 *
 * Refuses BEFORE the wire when the type needs a token and none was supplied.
 * That is not an optimisation: lesser would answer `authentication required`,
 * and the round trip would turn a state contentus can name with certainty into
 * one it has to parse out of an error string.
 *
 * ACTOR without an `actorId` is refused for the same class of reason — lesser
 * returns `actorID is required`, and `unsupported` said locally is the same
 * answer without the trip.
 */
export async function fetchTimelinePage(request: TimelineRequest): Promise<TimelineResult> {
	const viewerAuthenticated = Boolean(request.accessToken);

	if (readRequiresAuth(request.type) && !viewerAuthenticated) {
		return { ok: false, failure: 'auth-required' };
	}
	if (request.type === 'ACTOR' && !request.actorId) {
		return { ok: false, failure: 'unsupported' };
	}

	try {
		const result = await graphqlRequest<{ timeline?: unknown }>(
			TIMELINE_QUERY,
			{
				type: request.type,
				first: request.first ?? TIMELINE_PAGE_SIZE,
				after: request.after ?? null,
				actorId: request.actorId ?? null,
				mediaOnly: request.mediaOnly ?? false,
				excludeAgents: request.excludeAgents ?? false,
			},
			{
				endpoint: request.endpoint ?? null,
				accessToken: request.accessToken ?? null,
				...(request.signal ? { signal: request.signal } : {}),
			}
		);

		// A partial failure that still carried a connection is rendered as the data
		// it carried — losing eight of twenty objects is not the same event as
		// losing the timeline, and reporting the whole read as failed would be the
		// false-empty M2d settled against. Only a MISSING connection is fatal.
		//
		// But the errors are NOT discarded with the decision to render. They are
		// carried as `partial`, because a nullable field that failed comes back
		// looking exactly like a nullable field that was legitimately null, and only
		// the errors tell the two apart. Keeping the objects and dropping the errors
		// would turn "we could not read this post's boost" into "this post is not a
		// boost" — a claim the client would be making up.
		const failure = classifyTimelineFailure(result.errors);
		if (failure && !result.data?.timeline) return { ok: false, failure };
		if (!result.data?.timeline) return { ok: false, failure: 'unavailable' };

		return {
			ok: true,
			page: toTimelinePage(result.data.timeline, { viewerAuthenticated }),
			partial: result.errors.length > 0,
		};
	} catch {
		// Loaders are render boundaries. A malformed envelope or projection must
		// become the same designed unavailable state as a failed request, never a
		// FaceTheory 500 page.
		return { ok: false, failure: 'unavailable' };
	}
}

export type ActorResult =
	{ ok: true; actor: Account; partial: boolean } | { ok: false; failure: TimelineFailure };

/**
 * Load a profile header.
 *
 * `actor(username:)` is on lesser's anonymous public-read list, so this runs
 * unauthenticated on the SSR pass and again with the token in the browser. A
 * null actor with no errors is `not-found` — the instance answered and does not
 * know the name — which is a different screen from "the instance did not answer".
 */
export async function fetchActor(
	username: string,
	options: { accessToken?: string | null; endpoint?: string | null; signal?: AbortSignal } = {}
): Promise<ActorResult> {
	if (!username.trim()) return { ok: false, failure: 'not-found' };

	try {
		const result = await graphqlRequest<{ actor?: unknown }>(
			ACTOR_QUERY,
			{ username },
			{
				endpoint: options.endpoint ?? null,
				accessToken: options.accessToken ?? null,
				...(options.signal ? { signal: options.signal } : {}),
			}
		);

		const actor = toAccount(result.data?.actor);
		// Same rule as the timeline read: an actor that resolved alongside errors
		// is shown, and the fact that part of it did not resolve travels with it.
		if (actor) return { ok: true, actor, partial: result.errors.length > 0 };

		return { ok: false, failure: classifyTimelineFailure(result.errors) ?? 'not-found' };
	} catch {
		return { ok: false, failure: 'unavailable' };
	}
}

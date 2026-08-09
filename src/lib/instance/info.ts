/**
 * The instance's own statement about itself: `query { instance }`.
 *
 * WHY THIS MODULE EXISTS. Until lesser v1.6.4 the subscription endpoint had no
 * contract-served value at all, and contentus derived the socket host by
 * prefixing `ws.` onto the served origin — reading a topology convention, not
 * a value the instance stated (`timelines/subscription.ts` carried the
 * derivation, filed upstream, confined so there was one place to delete).
 * lesser v1.6.4 (commit 789e18bdb) answered the ask: `InstanceInfo` now serves
 * `subscriptionUrl` ("GraphQL subscription endpoint using the
 * graphql-transport-ws protocol") alongside `maxUploadSizeBytes`,
 * `maxStatusCharacters` and `cmsFeatures`, on the public root field
 * `instance: InstanceInfo!`. This module reads them; the derivation is gone.
 *
 * `InstanceInfo.streamingUrl` is still NOT the field for the socket, and never
 * was: lesser resolves it to `r.Config.BaseURL()`, the instance's HTTP origin,
 * where Mastodon's `urls.streaming_api` is the WebSocket URL. The M4 header in
 * `timelines/subscription.ts` names that trap; it is repeated here because this
 * is now the module a reader will reach first.
 *
 * ANONYMOUS, ALWAYS. `instance` is anonymous-safe by design, and no caller here
 * attaches a token — including the server pass, which reads this for the CSP
 * `connect-src` of the socket routes. Not sending a credential is stronger than
 * being careful with one: a pass that never holds the token cannot leak it,
 * which is the same rule the messaging surface's server pass follows for the
 * whole DM surface.
 *
 * FAIL-CLOSED EVERYWHERE. Every field selected is non-null in the schema, so a
 * partial answer is not data to make do with — it is the instance disagreeing
 * with the contract it publishes, and `toInstanceInfo` returns null for it.
 * Every caller degrades on null: realtime reports unavailable, the CSP addition
 * is omitted. A fabricated fallback would produce failures a reader cannot act
 * on; an honest "unavailable" they can.
 */

import { graphqlRequest } from '../cms/graphql.ts';

/**
 * The whole read, in one anonymous query.
 *
 * Named `ContentusInstanceInfo` so the request log a probe (or an operator)
 * reads says who is asking and why.
 */
export const INSTANCE_INFO_QUERY = `query ContentusInstanceInfo {
	instance {
		subscriptionUrl
		maxUploadSizeBytes
		maxStatusCharacters
		cmsFeatures {
			longForm
			drafts
			revisions
			scheduling
			series
			categories
		}
	}
}`;

/**
 * The fields contentus consumes, as `InstanceInfo` serves them at v1.6.4.
 *
 * This is deliberately a SUBSET of the type: `domain`, `userCount` and friends
 * exist, and not selecting them is what keeps an anonymous public read small.
 */
export interface InstanceInfo {
	/** GraphQL subscription endpoint, graphql-transport-ws protocol. */
	subscriptionUrl: string;
	maxUploadSizeBytes: number;
	maxStatusCharacters: number;
	cmsFeatures: {
		longForm: boolean;
		drafts: boolean;
		revisions: boolean;
		scheduling: boolean;
		series: boolean;
		categories: boolean;
	};
}

/**
 * Normalize the raw answer, or return null.
 *
 * Null is the answer for ANY deviation: a missing field, a wrong type, a
 * non-object. All selected fields are non-null in the schema, so a partial
 * answer is a contract violation rather than data — and the honest rendering
 * of a contract violation is "unknown", not a best guess at the parts that
 * happened to parse.
 */
export function toInstanceInfo(data: unknown): InstanceInfo | null {
	if (typeof data !== 'object' || data === null) return null;
	const instance = (data as { instance?: unknown }).instance;
	if (typeof instance !== 'object' || instance === null) return null;

	const raw = instance as Record<string, unknown>;
	if (typeof raw.subscriptionUrl !== 'string' || raw.subscriptionUrl.length === 0) return null;
	if (!isInteger(raw.maxUploadSizeBytes)) return null;
	if (!isInteger(raw.maxStatusCharacters)) return null;

	const features = raw.cmsFeatures;
	if (typeof features !== 'object' || features === null) return null;
	const rawFeatures = features as Record<string, unknown>;
	for (const key of ['longForm', 'drafts', 'revisions', 'scheduling', 'series', 'categories']) {
		if (typeof rawFeatures[key] !== 'boolean') return null;
	}

	return {
		subscriptionUrl: raw.subscriptionUrl,
		maxUploadSizeBytes: raw.maxUploadSizeBytes as number,
		maxStatusCharacters: raw.maxStatusCharacters as number,
		cmsFeatures: {
			longForm: rawFeatures.longForm as boolean,
			drafts: rawFeatures.drafts as boolean,
			revisions: rawFeatures.revisions as boolean,
			scheduling: rawFeatures.scheduling as boolean,
			series: rawFeatures.series as boolean,
			categories: rawFeatures.categories as boolean,
		},
	};
}

/** GraphQL `Int` arrives as a JSON number; anything else is off-contract. */
function isInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Read the instance info once, anonymously, or return null.
 *
 * NEVER THROWS. A transport failure, a GraphQL error set, and an answer that
 * does not normalize are all the same thing to a caller — the instance did not
 * say — so they are all null. No token is attached even when one is reachable:
 * `instance` is a public field and needs none, and a request that carries no
 * credential cannot leak one. `endpoint` is the SSR case (an absolute URL);
 * the browser omits it and rides the relative path, exactly as
 * `timelines/transport.ts` does.
 */
export async function fetchInstanceInfo(
	options: { endpoint?: string | null } = {}
): Promise<InstanceInfo | null> {
	let result;
	try {
		result = await graphqlRequest<{ instance?: unknown }>(INSTANCE_INFO_QUERY, {}, {
			endpoint: options.endpoint ?? null,
		});
	} catch {
		return null;
	}
	// Errors WITH data are still a refusal here: every field is non-null, so an
	// errored answer cannot be complete, and "complete" is the only thing this
	// module vouches for.
	if (result.errors.length > 0) return null;
	return toInstanceInfo(result.data);
}

/**
 * A memoized `fetchInstanceInfo`, so a page load asks at most once.
 *
 * The FACTORY is what probes drive — a fresh cache per test, which a module
 * global cannot offer. The in-flight promise is shared, not only the resolved
 * value: two callers racing the first read get one request, not two.
 */
export function createCachedInstanceInfo(): () => Promise<InstanceInfo | null> {
	let pending: Promise<InstanceInfo | null> | null = null;
	return () => {
		pending ??= fetchInstanceInfo();
		return pending;
	};
}

/**
 * The browser's cache: one read per page load, held in module state.
 *
 * Deliberately NOT sessionStorage. Instance info is public, cacheable, and
 * cheap to re-ask, and a persisted copy would outlive the very events it would
 * be worth re-asking after (an instance move, an upgrade). A page load is the
 * right lifetime: the timelines feed and the messaging binding share the one
 * read, and the next navigation asks again.
 */
export const getCachedInstanceInfo = createCachedInstanceInfo();

/**
 * The server cache's lifetime. Short on purpose — see below.
 */
export const SERVER_INSTANCE_INFO_TTL_MS = 60_000;

/**
 * A TTL cache of `fetchInstanceInfo`, keyed by endpoint, for the SSR pass.
 *
 * WHY A CACHE AT ALL. Every render of a socket route needs this for its CSP
 * `connect-src`, and per-request fetching would add an instance round trip to
 * every timeline and messages paint — and on an UNREACHABLE instance, would add
 * the network timeout to every one of them. So failures are cached too: a dead
 * instance costs one slow render per TTL, not one per render.
 *
 * WHY 60 SECONDS AND NOT LONGER. The value being cached steers a security
 * header and a socket. A stale `subscriptionUrl` after an instance move
 * degrades realtime HONESTLY — the browser's CSP fails the socket closed and
 * the liveness surface reports unavailable, which is a state with copy and an
 * affordance, not a silent gap — but a long TTL would stretch that degradation
 * out for no reader benefit. Sixty seconds bounds how wrong the policy can be
 * while still absorbing a render burst.
 */
export function createServerInstanceInfoCache(options?: {
	ttlMs?: number;
	/** Injectable clock, so probes drive expiry instead of sleeping. */
	now?: () => number;
}): (endpoint: string) => Promise<InstanceInfo | null> {
	const ttlMs = options?.ttlMs ?? SERVER_INSTANCE_INFO_TTL_MS;
	const now = options?.now ?? (() => Date.now());
	const entries = new Map<string, { fetchedAt: number; pending: Promise<InstanceInfo | null> }>();

	return (endpoint: string) => {
		const cached = entries.get(endpoint);
		if (cached && now() - cached.fetchedAt < ttlMs) return cached.pending;

		const pending = fetchInstanceInfo({ endpoint });
		entries.set(endpoint, { fetchedAt: now(), pending });
		return pending;
	};
}

/** The server's cache: one per SSR host process. */
export const getServerInstanceInfo = createServerInstanceInfoCache();

/**
 * The `connect-src` value for a served `subscriptionUrl`: its ORIGIN.
 *
 * CSP is an origin list and `subscriptionUrl` is a full URL, so the path is
 * dropped (`scheme://host[:port]` is what the directive permits). Anything
 * that is not a parseable `ws:`/`wss:` URL is the same as no answer: lesser
 * publishing a malformed or non-socket value is off-contract, and permitting
 * the origin of `javascript:` or `data:` in a security header is not a
 * degradation, it is a widening. `new URL` reports those schemes' origin as
 * the string "null", which is exactly how a missing check here would ship.
 */
export function subscriptionConnectOrigin(
	subscriptionUrl: string | null | undefined
): string | null {
	if (!subscriptionUrl) return null;
	let url: URL;
	try {
		url = new URL(subscriptionUrl);
	} catch {
		return null;
	}
	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
	return url.origin;
}

/**
 * Origin derivation.
 *
 * Contentus hard-codes no domain anywhere. Every absolute URL it needs —
 * GraphQL, OAuth, canonical article identity — derives from the request the
 * instance actually served (product design §3, §8). On the server that is the
 * forwarded Host header; in the browser it is `window.location.origin`.
 *
 * This is what makes one codebase installable into many instances: expanding
 * past the dev instance is a configuration event, not a code change.
 */

/** Same-origin GraphQL endpoint. Relative by design — no origin required. */
export const GRAPHQL_PATH = '/api/graphql';

type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

function firstHeader(headers: HeaderBag | undefined, name: string): string | null {
	if (!headers) return null;
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0]?.trim() || null;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the public origin for a server-rendered request.
 *
 * Returns `null` rather than guessing when no host is present: a fabricated
 * origin would produce wrong canonical URLs and wrong OG tags, which is worse
 * than omitting them.
 */
export function resolveRequestOrigin(headers: HeaderBag | undefined): string | null {
	const forwardedHost = firstHeader(headers, 'x-forwarded-host');
	const host = forwardedHost ?? firstHeader(headers, 'host');
	if (!host) return null;

	// Reject anything that is not a bare host[:port]; a header carrying a path,
	// scheme, or whitespace is spoofed or malformed and must not reach a URL.
	if (!/^[A-Za-z0-9.\-_]+(:\d+)?$/.test(host)) return null;

	const forwardedProto = firstHeader(headers, 'x-forwarded-proto');
	const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : 'https';

	return `${proto}://${host}`;
}

/** Resolve the origin in the browser. */
export function resolveBrowserOrigin(): string | null {
	if (typeof window === 'undefined') return null;
	return window.location.origin || null;
}

/**
 * Absolute GraphQL endpoint for server-side fetches.
 *
 * The browser uses the relative `GRAPHQL_PATH` (same-origin by construction);
 * only SSR needs an absolute URL because `fetch` on the server has no document
 * base.
 */
export function graphqlEndpointForOrigin(origin: string | null): string | null {
	return origin ? `${origin}${GRAPHQL_PATH}` : null;
}

/**
 * Canonical Article identity, per lesser's CMS contract:
 * `https://<domain>/articles/<slug>`.
 *
 * This is lesser's identity contract, not a contentus route — it is the value
 * that federates. The contentus reading surface for the same article lives at
 * `/l/articles/<slug>`; the two are deliberately different and contentus never
 * rewrites the former.
 */
export function canonicalArticleUrl(origin: string | null, slug: string): string | null {
	if (!origin || !slug) return null;
	return `${origin}/articles/${encodeURIComponent(slug)}`;
}

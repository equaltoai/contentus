/**
 * Origin derivation.
 *
 * Contentus hard-codes no domain anywhere. Every absolute URL it needs —
 * GraphQL, OAuth, canonical article identity — derives from the request the
 * instance actually served (product design §3, §8). On the server that is a
 * TRUSTED forwarded host; in the browser it is `window.location.origin`.
 *
 * This is what makes one codebase installable into many instances: expanding
 * past the dev instance is a configuration event, not a code change.
 *
 * HEADER PRECEDENCE, and why it is not negotiable.
 *
 *   1. `x-lesser-forwarded-host` — lesser's CloudFront frontend function sets
 *      this from the verified viewer Host before the request leaves the edge
 *      (lesser `infra/cdk/stacks/lesser_api_stack.go` →
 *      `newClientFrontendRewriteFunction`). A viewer cannot forge it: whatever
 *      they send is overwritten.
 *   2. `host` — at the edge this is the origin's own domain, not viewer input.
 *
 * That is the same order lesser's own SSR host resolves (lesser
 * `infra/cdk/assets/client_ssr_host/index.mjs` → `publicOrigin`), and the two
 * must not disagree: the SSR host is what invokes this handler, so a different
 * answer here would mean contentus advertising a different origin than the
 * instance hosting it.
 *
 * `x-forwarded-host` and `x-forwarded-proto` are deliberately NOT consulted.
 * CloudFront forwards viewer headers to `/l/*` verbatim, so an anonymous
 * request can set either to anything it likes. This module feeds
 * `graphqlEndpointForOrigin`, which is the URL the SERVER fetches — trusting a
 * viewer-controlled header there is an SSRF primitive, and trusting it for the
 * canonical URL is OG/canonical poisoning. A viewer-controlled header never
 * steers a server-side fetch or a canonical URL.
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
 * Normalize a forwarded host to a bare `host[:port]`, or null.
 *
 * Mirrors `sanitizeHost` in lesser's SSR host asset: take the first
 * comma-separated value, bound the length, lower-case the result. Anything
 * carrying a path, scheme, credential, or whitespace is spoofed or malformed
 * and must not reach a URL.
 */
function sanitizeHost(value: string | null): string | null {
	const first = (value ?? '').split(',')[0]?.trim() ?? '';
	if (!first || first.length > 253) return null;
	if (!/^[A-Za-z0-9.\-_]+(:\d+)?$/.test(first)) return null;
	return first.toLowerCase();
}

/**
 * Resolve the public origin for a server-rendered request.
 *
 * Returns `null` rather than guessing when no trusted host is present: a
 * fabricated origin would produce wrong canonical URLs, wrong OG tags, and a
 * server-side fetch aimed somewhere nobody chose — all worse than omitting
 * them. A trusted header that arrives malformed also fails closed rather than
 * falling through to the next one; a spoofed-looking value is a signal, not a
 * reason to keep looking.
 */
export function resolveRequestOrigin(headers: HeaderBag | undefined): string | null {
	const host = sanitizeHost(
		firstHeader(headers, 'x-lesser-forwarded-host') ?? firstHeader(headers, 'host')
	);
	if (!host) return null;

	// Edge-injected alongside the host, and likewise not viewer-forgeable.
	const forwardedProto = firstHeader(headers, 'x-lesser-forwarded-proto')?.toLowerCase() ?? null;
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

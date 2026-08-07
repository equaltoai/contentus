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
 * THE TRUSTED HOST, and why there is exactly one.
 *
 * `x-lesser-forwarded-host` is the only header this module consults. lesser's
 * CloudFront frontend function sets it from the verified viewer Host before the
 * request leaves the edge, unconditionally, on every request (lesser
 * `infra/cdk/stacks/lesser_api_stack.go` → `newClientFrontendRewriteFunction`).
 * A viewer cannot forge it: whatever they send is overwritten.
 *
 * When it is absent this fails closed and returns null. NOTHING is substituted —
 * not `host`, not `x-forwarded-host`, not `forwarded`. `host` is the origin's
 * own domain only for a request that genuinely arrived through the edge; a
 * request reaching this handler any other way carries whatever Host its caller
 * chose. This module feeds `graphqlEndpointForOrigin`, which is the URL the
 * SERVER fetches, so a caller-chosen value there is an SSRF primitive, and the
 * same value lands in `og:url` and the canonical link as identity poisoning.
 * Neither is worth a fallback whose only job is to guess.
 *
 * This is deliberately NARROWER than lesser's own SSR host, whose `publicOrigin`
 * (lesser `infra/cdk/assets/client_ssr_host/index.mjs`) falls back through
 * `host` to the baked `LESSER_STAGE_DOMAIN`. That value only renders links on
 * the "client not installed yet" placeholder — the one response that exists
 * precisely because contentus is NOT loaded — and never steers a fetch. Ours
 * does, so ours stops earlier. On an installed instance both read the same
 * edge-injected header and agree.
 *
 * Nothing local depends on the absent fallback: `vite dev` serves the client SPA
 * (`appType: 'spa'`) and never loads the server entry that calls this, and the
 * local audits drive the built handler through `scripts/render-routes.mjs`,
 * which injects `x-lesser-forwarded-host` exactly as the edge does.
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
 * Returns `null` rather than guessing when the trusted host is absent or
 * malformed: a fabricated origin would produce wrong canonical URLs, wrong OG
 * tags, and a server-side fetch aimed somewhere nobody chose — all worse than
 * omitting them. Every caller already handles a null origin by degrading, so
 * failing closed costs a page its absolute URLs, not its existence.
 */
export function resolveRequestOrigin(headers: HeaderBag | undefined): string | null {
	const host = sanitizeHost(firstHeader(headers, 'x-lesser-forwarded-host'));
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

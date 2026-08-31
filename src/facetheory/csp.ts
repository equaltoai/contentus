/**
 * The strict-CSP directive extensions contentus applies per route.
 *
 * FaceTheory's canonical strict policy (`buildStrictCspHeader`) is the single
 * builder for every served header; this module only ever supplies the bounded
 * `directives` extension object it accepts. Nothing here constructs a policy,
 * loosens `script-src`/`style-src`, or adds an `unsafe-*` token.
 */

/**
 * The ONE route that displays lesser-minted media, and therefore the ONE route
 * whose `img-src` may name an off-origin HTTPS source.
 *
 * WHY THE REVIEW WORKSPACE IS SPECIAL. `draftPreview(id:, includeAccessUrls:
 * true)` (the authenticated preview read, lesser v1.6.28) mints a five-minute
 * presigned storage URL per access (`IssueEditorialAccess`) and composes it
 * into the `<figure><img src=…>` lesser rendered — the bound image behind
 * #112. The URL host is the S3 regional endpoint by construction: it is
 * instance-specific (bucket) and region-specific, so no fixed origin can be
 * predicted at build time, and the origin CSP is authoritative on `/l` routes
 * (lesser-host's CloudFront fallback for the client install carries
 * `img-src 'self' data: https:` with `Override:false` — it never loosens what
 * the origin sends, and it does not govern here).
 *
 * So the narrowest source the runtime permits is the `https:` scheme-source:
 * `img-src` only, this route only, scripts/styles untouched. It matches the
 * scheme lesser's own client delivery already falls back to, and it is what
 * makes the presigned fetch actually load in the reviewer's browser.
 *
 * THE FIVE-MINUTE TTL IS HANDLED BY NOT HANDLING IT. The URL is minted inside
 * the preview HTML lesser returns, and the browser requests the image eagerly
 * on a fresh preview load; a reviewer who reloads obtains a fresh preview (and
 * a fresh URL) from the same authenticated document. Contentus never persists,
 * caches, or re-serves the minted URL, and never moves access minting earlier
 * than lesser's own read — both would extend the lifetime of a short-lived
 * credential beyond what the issuer intended.
 */
export const REVIEW_WORKSPACE_PAGE_KEY = 'review-workspace';

export const REVIEW_WORKSPACE_IMG_SRC_EXTENSION = ['https:'] as const;

/**
 * The strict-CSP `directives` extension for a resolved route key, or null when
 * the route gets none.
 *
 * Pure and synchronous so the header path stays testable without a build: the
 * route-level wiring in `entry-server.ts` calls this with the resolved page
 * key and hands the result to FaceTheory's real `buildStrictCspHeader`.
 */
export function cspDirectivesForPage(
	pageKey: string
): { directives: { 'img-src': readonly string[] } } | null {
	if (pageKey === REVIEW_WORKSPACE_PAGE_KEY) {
		return { directives: { 'img-src': REVIEW_WORKSPACE_IMG_SRC_EXTENSION } };
	}
	return null;
}

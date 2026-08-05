/**
 * OAuth scopes contentus requests.
 *
 * `read write follow push` is the set named in the product design (§3) and all
 * four are canonical in lesser's public scope catalog
 * (`pkg/auth/scopes_policy.go` → `canonicalOAuthScopes`). Requesting an
 * uncatalogued scope fails registration with `invalid_client_metadata`.
 */
export const DEFAULT_OAUTH_SCOPE = 'read write follow push';

/**
 * lesser's optional public-client classification. An omitted class receives
 * ordinary non-CLI treatment, but contentus sends `web` explicitly so the
 * browser-client intent is self-documenting at the registration boundary.
 */
export const CLIENT_CLASS = 'web';

/** Human-facing client name shown on lesser's authorization screen. */
export const CLIENT_NAME = 'Contentus';

export function normalizeScopeValue(scope: string): string {
	return scope
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.sort()
		.join(' ');
}

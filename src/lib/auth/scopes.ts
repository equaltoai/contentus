/**
 * OAuth scopes contentus requests.
 *
 * `read write follow push` is the set named in the product design (§3) and all
 * four are canonical in lesser's public scope catalog
 * (`pkg/auth/scopes_policy.go` → `canonicalOAuthScopes`). Requesting an
 * uncatalogued scope fails registration with `invalid_client_metadata`.
 */
export const DEFAULT_OAUTH_SCOPE = 'read write follow push';

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

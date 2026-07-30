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
 * lesser's client classification. `web` and `cli` are the two values public
 * dynamic registration accepts.
 *
 * `web` is load-bearing, not cosmetic: lesser caps GraphQL query depth at 3 for
 * agent and CLI-class tokens (`cmd/graphql/main.go`), and a depth of 3 cannot
 * express a Relay connection query — `articles → edges → node → field` is
 * already depth 4. Registering as `cli` would silently break every paginated
 * read the moment a user signed in.
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

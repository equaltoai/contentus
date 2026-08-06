/**
 * Contentus's OAuth *inputs* to the transplanted simulacrum session core.
 *
 * THIS MODULE IS CONFIGURATION, NOT PROTOCOL. Everything here is a value that
 * `./session` reads; nothing here decides how that module speaks to lesser.
 * The product design (§3) permits exactly three contentus-specific differences
 * from the proven simulacrum flow — the client name, the callback path, and the
 * requested scopes — and two of the three live in this file. The third is
 * `${base}/auth/callback`, which `./session` derives the way sim does.
 *
 * `CLIENT_CLASS` USED TO LIVE HERE AND IS GONE ON PURPOSE. Sending
 * `client_class=web` at registration was contentus's own addition; simulacrum
 * has never sent it, and lesser's `normalizeOAuthClientClass` gives an omitted
 * class ordinary non-CLI treatment (`cmd/api/handlers/apps.go`, ref e710ffb3).
 * A parameter no proven client sends is a parameter whose failure modes no
 * proven client has exercised.
 *
 * `normalizeScopeValue` also used to live here. It moved into `./session`,
 * where simulacrum keeps it, because it is part of the core's cache-bucket
 * decision rather than a value contentus supplies.
 */

/**
 * The scope set every ordinary contentus surface signs in with.
 *
 * All four are canonical in lesser's public scope catalog
 * (`pkg/auth/scopes_policy.go` → `canonicalOAuthScopes`); an uncatalogued scope
 * fails registration with `invalid_client_metadata`.
 */
export const DEFAULT_OAUTH_SCOPE = 'read write follow push';

/**
 * The narrower set the drones face asks for — `push` buys nothing on a surface
 * that creates and lists drones, and least privilege is why this is a separate
 * constant rather than a second spelling of the default.
 *
 * It is exported so that `./session` and the drones face name the SAME string.
 * The core refuses to start a flow for a scope it does not know (simulacrum's
 * `scopeToCacheBucket` behaviour), so a literal drifting apart from this
 * constant would be a sign-in that throws, not a silent divergence.
 */
export const DRONE_OAUTH_SCOPE = 'read write follow';

/** Human-facing client name shown on lesser's authorization screen. */
export const CLIENT_NAME = 'Contentus';

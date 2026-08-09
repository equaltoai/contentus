import { browser } from '$app/environment';
import { base } from '$app/paths';

import { createPkcePair, generateRandomString } from './pkce';
import { CLIENT_NAME, DEFAULT_OAUTH_SCOPE, DRONE_OAUTH_SCOPE } from './scopes';
import { notifySessionChange } from './session-events';

/**
 * OAuth Authorization Code + PKCE against lesser's auth surface.
 *
 * THIS FILE IS A TRANSPLANT, NOT A DESIGN. Its protocol core is simulacrum's
 * `src/lib/auth/session.ts` at ref 6cec1b607e48c6efc18dcd6995dbbcc2a4a5fcea,
 * which is the working authority for this flow against lesser. The product
 * design has said so since the foundation document — §3: "Copy sim's
 * `src/lib/auth/session.ts` + `pkce.ts` pattern unchanged" — and the previous
 * contentus implementation did not, which is what broke sign-in. Read sim
 * first; treat any difference from it as a defect in THIS file until the
 * deviation list below justifies it.
 *
 * WHAT WAS RIPPED OUT, AND WHY IT MATTERED
 *
 *   1. `client_class=web` at registration. Sim never sends it. Removed.
 *   2. Refusing a registration response that carries `client_secret`. This was
 *      contentus's own invention and it aborted EVERY sign-in, because lesser's
 *      `CreateOAuthClientGeneric` generates a secret for every client it stores
 *      and `createOAuthClientAndRespond` copies it into the response — even for
 *      the public shape, with `Confidential=false` and
 *      `token_endpoint_auth_method=none` (lesser ref e710ffb3,
 *      `pkg/storage/repositories/oauth_helpers.go:137`,
 *      `cmd/api/handlers/apps.go`). Sim reads `client_id` and
 *      `token_endpoint_auth_method` out of that response and nothing else, and
 *      so does this file.
 *
 *      WHAT THAT BUYS, AND WHAT IT DOES NOT — stated precisely, because the
 *      earlier wording here ("the secret is never seen") claimed a property no
 *      browser client can hold. `response.json()` decodes the whole body, so
 *      the returned secret IS transiently present in that decoded object on the
 *      page's heap, observable to anything instrumenting the runtime. What is
 *      proven is bounded, and it is the part that governs the client's
 *      behaviour: the secret is never SELECTED into the client model, never
 *      persisted to either storage, never retransmitted on any request, never
 *      logged, and never placed into a redirect.
 *      `parseRegistrationResponse` names what IS selected, and
 *      `tests/auth-session.test.mjs` proves those five negatives by sweeping a
 *      whole sign-in — every stored value, every request body and header, every
 *      redirect, and every console call — rather than by reading this comment.
 *   3. Refusing a returned `token_endpoint_auth_method` other than `none` at
 *      REGISTRATION time. Sim refuses it at the CACHE boundary instead. This
 *      file now refuses at BOTH, because the cache boundary alone cannot cover
 *      FIRST use: the client `registerOAuthClient` returns goes straight to the
 *      authorization redirect without passing the cache reader, so a
 *      `client_secret_*` client would be redirected against once before
 *      anything discarded it. Refusing here happens before the cache write and
 *      before the redirect; the cache-boundary discard stays for every later
 *      read. A deliberate deviation from sim, added under adversarial review of
 *      PR #76 — and a LOCAL one: the registration REQUEST is unchanged.
 *   4. Modelling the stored auth method as optional-when-omitted. Sim stores
 *      `data.token_endpoint_auth_method ?? 'none'`, and lesser's
 *      `normalizeOAuthTokenEndpointAuthMethod` returns a non-empty method for
 *      every successful registration, so the field is always present in
 *      practice and the default is unreachable against a conformant instance.
 *      Absent still reads as the `none` this client asked for; anything else
 *      that is not exactly `none` is now a refusal rather than a stored value.
 *   5. Sorting the scope string before putting it on the wire. Sim sends the
 *      scope as written; normalization is for bucket comparison only.
 *
 * THE PUBLIC-CLIENT INVARIANT, kept the three ways sim keeps it plus one: at
 * registration contentus always ASKS for `token_endpoint_auth_method=none`; the
 * token request carries no client authentication of any kind; a cached client
 * whose method is not `none` is discarded rather than reused; and a fresh
 * registration whose stated method is not `none` never becomes a client at all.
 *
 * DELIBERATE DIFFERENCES FROM SIM, all local and none of them on the wire:
 *
 *   - No `VITE_PUBLIC_OAUTH_CLIENT_ID` escape hatch. Contentus has no config
 *     injection from lesser (product design §3), so a build-time client_id
 *     override would be a new configuration surface, not a ported one.
 *   - No `resource` parameter. Sim carries one for its remote-MCP lane;
 *     contentus is an ordinary browser app and the product design says it never
 *     sends one during app authorization or token exchange.
 *   - `clearSession` empties every sessionStorage key this module writes, not
 *     just three, and announces itself through `./session-events`. Sim's store
 *     subscription is what tells its surfaces; contentus has no store, so the
 *     announcement is the adapter that replaces it. Both are local-only.
 *   - A token response without a usable `created_at`/`expires_in` is refused.
 *     Sim multiplies whatever arrived, and `undefined * 1000` is `NaN`, which
 *     makes `Date.now() >= expiresAt` false forever — a session that never
 *     expires. Both fields are non-`omitempty` on lesser's `OAuthTokenResponse`
 *     (`cmd/api/models/oauth.go:72`), so refusing cannot fire against a
 *     conformant instance, and failing closed beats inventing a lifetime.
 *   - That refusal reads the numbers the SESSION CARRIES, not the numbers the
 *     response stated. Checking the two stated seconds and multiplying them
 *     afterwards checks the wrong values twice over: `1e308` is finite and
 *     `1e308 * 1000` is `Infinity`, which `JSON.stringify` writes as `null`; and
 *     a `created_at` of `0` is finite, exact, and already expired. Both were
 *     `ok: true` reported for a session `readSession` throws away on the next
 *     read. `createdAt` and `expiresAt` are now computed and checked BEFORE
 *     anything is stored, announced, or returned. Added under adversarial review
 *     of PR #76.
 *   - An `access_token` that is missing, empty, or blank is refused the same
 *     way, and a missing or blank `token_type` is normalized to the `Bearer`
 *     this flow requested. `completeLogin` must never answer `ok: true` for a
 *     session `readSession` turns around and rejects, so both ends check the
 *     same three properties. Sim's predicate was a bare truthiness test.
 *   - lesser's `refresh_token` is not read. Sim models and stores it; contentus
 *     has no refresh or rotation lifecycle that consumes one, and lesser's
 *     refresh token outlives the access token by days. Storing a
 *     bearer-equivalent credential that nothing spends, cleans up, or revokes
 *     only widens what a transient same-origin compromise carries away.
 *     Removed under adversarial review of PR #76; if contentus ever refreshes,
 *     the field returns WITH the lifecycle that consumes and clears it, not
 *     ahead of it.
 *   - `returnTo` must be an app-relative path. Sim hands its value to
 *     SvelteKit's `goto`; contentus hands it to `window.location.replace`,
 *     which would follow an absolute URL.
 *
 * Invariants this file exists to keep:
 *
 *   - There is NO client-local authentication. Contentus never sees a
 *     password; the user authenticates against lesser's `auth-ui` at `/auth/*`
 *     and contentus only ever handles the resulting authorization code.
 *   - Tokens live in `sessionStorage`, never in cookies and never in
 *     `localStorage`. They die with the tab.
 *   - Every URL is same-origin and relative. No instance domain appears here.
 */

type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

const PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD: TokenEndpointAuthMethod = 'none';

/**
 * Which registered client a scope set is cached under.
 *
 * Sim's buckets are `default` and `admin`; contentus's are `default` and
 * `drone`. The MECHANISM is sim's — one cached public client per scope set, the
 * bucket recorded in `sessionStorage` at `startLogin` and read back at the
 * callback so the exchange re-derives the same client. The TABLE is contentus's
 * configuration, and it is closed: a scope that is not in it cannot start a
 * flow.
 */
type OAuthClientCacheBucket = 'default' | 'drone';

const OAUTH_CLIENT_BUCKET_SCOPES: Record<OAuthClientCacheBucket, string> = {
	default: DEFAULT_OAUTH_SCOPE,
	drone: DRONE_OAUTH_SCOPE,
};

interface StoredOAuthClient {
	clientId: string;
	redirectUri: string;
	createdAt: number;
	tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

/**
 * The session contentus keeps, which is sim's minus the refresh token.
 *
 * There is no `refreshToken` here and there is no code that would spend one.
 * lesser issues a refresh token good for seven days beside a one-hour access
 * token; modelling it would put a longer-lived bearer-equivalent credential in
 * `sessionStorage` for a client that has no refresh call, no rotation, and no
 * revocation path. The field comes back when the lifecycle that consumes it
 * does — see the header.
 */
export interface AuthSession {
	accessToken: string;
	tokenType: string;
	scope?: string;
	createdAt: number;
	expiresIn: number;
	expiresAt: number;
}

const STORAGE_KEYS = {
	session: 'contentus:auth_session',
	oauthClientDefault: 'contentus:oauth_client_default',
	oauthClientDrone: 'contentus:oauth_client_drone',
	oauthClientBucket: 'contentus:oauth_client_bucket',
	oauthClientNotAfter: 'contentus:oauth_client_not_after',
	oauthState: 'contentus:oauth_state',
	oauthVerifier: 'contentus:oauth_verifier',
	oauthReturnTo: 'contentus:oauth_return_to',
} as const;

/**
 * Every key this module writes to `sessionStorage`, which is every key it
 * writes that is not the public client cache. `clearSession` empties all of
 * them; listing them here is what keeps that promise true when a key is added.
 */
const SESSION_STORAGE_KEYS: readonly string[] = [
	STORAGE_KEYS.session,
	STORAGE_KEYS.oauthClientBucket,
	STORAGE_KEYS.oauthClientNotAfter,
	STORAGE_KEYS.oauthState,
	STORAGE_KEYS.oauthVerifier,
	STORAGE_KEYS.oauthReturnTo,
];

/**
 * The single-bucket key the pre-transplant implementation cached under. It is
 * dropped rather than migrated: re-registering a public client costs one
 * request, and a key nothing reads is litter that outlives the reader.
 */
const LEGACY_OAUTH_CLIENT_KEY = 'contentus:oauth_client';

// ---------------------------------------------------------------------------
// Scope buckets
// ---------------------------------------------------------------------------

function normalizeScopeValue(scope: string): string {
	return scope
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.sort()
		.join(' ');
}

function scopeToCacheBucket(scope?: string): OAuthClientCacheBucket | null {
	const normalizedScope = normalizeScopeValue(scope ?? DEFAULT_OAUTH_SCOPE);
	for (const [bucket, bucketScope] of Object.entries(OAUTH_CLIENT_BUCKET_SCOPES)) {
		if (normalizeScopeValue(bucketScope) === normalizedScope) {
			return bucket as OAuthClientCacheBucket;
		}
	}
	return null;
}

function isOAuthClientCacheBucket(value: unknown): value is OAuthClientCacheBucket {
	return (
		typeof value === 'string' &&
		Object.prototype.hasOwnProperty.call(OAUTH_CLIENT_BUCKET_SCOPES, value)
	);
}

function oauthClientStorageKey(bucket: OAuthClientCacheBucket): string {
	return bucket === 'drone' ? STORAGE_KEYS.oauthClientDrone : STORAGE_KEYS.oauthClientDefault;
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

	if (typeof globalThis.atob === 'function') {
		return globalThis.atob(padded);
	}

	throw new Error('Base64 decoding is not available in this environment');
}

/**
 * The scopes lesser actually granted, read out of the access token it issued.
 *
 * This is sim's `scopeFromAccessToken`. It reads a token this client already
 * holds, for a UI decision only — the drones face asks `hasWriteScope` before
 * offering to load anything — and never as an authorization decision, which
 * belongs to the instance that signed it. The token endpoint's `scope` field is
 * optional on lesser's response model (`cmd/api/models/oauth.go:77`), so
 * without this the face would read `undefined` and refuse a session that has
 * write.
 */
function scopeFromAccessToken(accessToken: string): string | null {
	const parts = accessToken.split('.');
	if (parts.length < 2) return null;

	try {
		const payload = JSON.parse(decodeBase64Url(parts[1])) as unknown;
		if (!payload || typeof payload !== 'object') return null;

		const scopesValue = (payload as { scopes?: unknown }).scopes;
		if (Array.isArray(scopesValue) && scopesValue.every((entry) => typeof entry === 'string')) {
			return scopesValue.join(' ');
		}

		const scopeValue = (payload as { scope?: unknown }).scope;
		if (typeof scopeValue === 'string' && scopeValue.trim()) {
			return scopeValue.trim();
		}

		return null;
	} catch {
		return null;
	}
}

function normalizeAuthSession(session: AuthSession): AuthSession {
	const derivedScope = scopeFromAccessToken(session.accessToken);
	if (!derivedScope || derivedScope === session.scope) return session;
	return { ...session, scope: derivedScope };
}

export function readSession(): AuthSession | null {
	if (!browser) return null;

	const raw = sessionStorage.getItem(STORAGE_KEYS.session);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as AuthSession;
		// THE SAME THREE PROPERTIES `completeLogin` REFUSES TO SUCCEED WITHOUT,
		// checked here as well and spelled the same way on purpose. A session this
		// reader rejects must never be one the callback reported as a sign-in, and
		// the way that stays true is that neither end is the only one checking.
		if (typeof parsed?.accessToken !== 'string' || !parsed.accessToken.trim()) return null;
		if (typeof parsed?.tokenType !== 'string' || !parsed.tokenType.trim()) return null;
		if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return null;
		if (Date.now() >= parsed.expiresAt) {
			sessionStorage.removeItem(STORAGE_KEYS.session);
			return null;
		}
		return normalizeAuthSession(parsed);
	} catch {
		sessionStorage.removeItem(STORAGE_KEYS.session);
		return null;
	}
}

function writeSession(session: AuthSession): void {
	if (!browser) return;
	sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(normalizeAuthSession(session)));
	// Announced AFTER the write, so a subscriber that reads the session in
	// response finds the new one rather than the one it is replacing.
	notifySessionChange('signed-in');
}

/**
 * End the session.
 *
 * The keys go first and the announcement second, in that order for the same
 * reason: a subscriber tearing down on `signed-out` must not be able to read a
 * token that is on its way out. The announcement is not optional politeness —
 * emptying storage does nothing to a page that already read it, and the
 * messages face holds an authorized socket that only this signal closes. It is
 * this app's stand-in for sim's `authSession` store subscription.
 */
export function clearSession(): void {
	if (!browser) return;
	for (const key of SESSION_STORAGE_KEYS) {
		sessionStorage.removeItem(key);
	}
	notifySessionChange('signed-out');
}

export function isAuthenticated(): boolean {
	return readSession() !== null;
}

/** Bearer token for GraphQL, or null when anonymous. */
export function accessTokenOrNull(): string | null {
	return readSession()?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Public client registration
// ---------------------------------------------------------------------------

function getRedirectUri(): string {
	if (!browser) throw new Error('OAuth redirect_uri is only available in the browser');
	return `${window.location.origin}${base}/auth/callback`;
}

/**
 * Bind the cached client to the OAuth state with a salted digest, so the raw
 * `client_id` is never written to storage and a client rotated by another tab
 * mid-flow is detected at callback rather than silently exchanged.
 */
async function digestOAuthClientBinding(state: string, clientId: string): Promise<string> {
	if (!browser || !globalThis.crypto?.subtle) {
		throw new Error('OAuth client binding requires Web Crypto');
	}
	const encoded = new TextEncoder().encode(`contentus.oauth-client.v1:${state}:${clientId}`);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

function createOAuthState(stateNonce: string, clientBinding: string): string {
	return `${stateNonce}.${clientBinding}`;
}

function parseOAuthState(state: string): { stateNonce: string; clientBinding: string } | null {
	const separatorIndex = state.indexOf('.');
	if (separatorIndex <= 0 || separatorIndex === state.length - 1) return null;

	return {
		stateNonce: state.slice(0, separatorIndex),
		clientBinding: state.slice(separatorIndex + 1),
	};
}

/**
 * What a registration response is allowed to become.
 *
 * `unreadable` is "this is not a registration response" — a non-object, or no
 * usable `client_id`. `not-public` is "this is a registration response for a
 * client this browser cannot be": it states a `token_endpoint_auth_method` that
 * is anything other than `none`, so using it would mean presenting client
 * authentication contentus has none of. The two are separate outcomes because
 * they are separate messages to the person signing in, and because only one of
 * them is a statement about the instance's answer rather than about its shape.
 */
type RegistrationProjection =
	| { outcome: 'public-client'; clientId: string }
	| { outcome: 'not-public' }
	| { outcome: 'unreadable' };

const NOT_A_PUBLIC_CLIENT =
	'The instance did not register Contentus as a public client. Please sign in again.';

/**
 * The two fields contentus reads out of lesser's registration response, and the
 * one thing it will not accept.
 *
 * THE OMISSION IS STILL THE POINT. lesser returned a `client_secret` for a
 * public client until v1.6.4 (`0ede06f50`, which stopped minting secrets for
 * public clients) — a defect that was simply not this client's business, and
 * whose fix changed nothing here because the field was never read. Naming
 * what IS selected here, in one place, is what keeps "the secret is ignored"
 * a property of the code's shape: nothing downstream is handed an object the
 * secret survives into. What that does NOT claim is that the field never
 * existed — `registerOAuthClient` holds the whole decoded body for the length
 * of this call, and no client-side projection can unmake that. See the header
 * for the five negatives that ARE proven.
 *
 * `client_id` is read as DATA. `token_endpoint_auth_method` is read as a GATE:
 * absent is sim's `?? 'none'` — unreachable against a conformant lesser, kept
 * because the value it defaults to is the one this client requested — exactly
 * `none` passes, and every other value, string or not, is `not-public`. The
 * caller refuses it before caching and before redirecting, which is the first
 * use sim's cache-boundary discard cannot cover.
 */
function parseRegistrationResponse(data: unknown): RegistrationProjection {
	if (!data || typeof data !== 'object') return { outcome: 'unreadable' };

	const clientId = (data as { client_id?: unknown }).client_id;
	if (typeof clientId !== 'string' || !clientId.trim()) return { outcome: 'unreadable' };

	const authMethod = (data as { token_endpoint_auth_method?: unknown }).token_endpoint_auth_method;
	if (authMethod !== undefined && authMethod !== PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD) {
		return { outcome: 'not-public' };
	}

	return { outcome: 'public-client', clientId };
}

function registrationErrorMessage(data: unknown, status: number): string {
	if (data && typeof data === 'object') {
		for (const key of ['error_description', 'error'] as const) {
			const candidate = (data as Record<string, unknown>)[key];
			if (typeof candidate === 'string' && candidate.trim()) return candidate;
		}
	}
	return `OAuth app registration failed (${status})`;
}

async function registerOAuthClient(
	redirectUri: string,
	scope: string,
	cacheBucket: OAuthClientCacheBucket | null
): Promise<StoredOAuthClient> {
	const body = new URLSearchParams({
		client_name: CLIENT_NAME,
		redirect_uris: redirectUri,
		scopes: scope,
		token_endpoint_auth_method: PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD,
		website: window.location.origin,
	});

	const response = await fetch('/api/v1/apps', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});

	const data = (await response.json().catch(() => null)) as unknown;
	const registration: RegistrationProjection = response.ok
		? parseRegistrationResponse(data)
		: { outcome: 'unreadable' };

	// ORDER IS THE CONTROL. Both refusals are `throw`, and they are here — above
	// the cache write, and therefore above `startLogin`'s redirect, which never
	// runs for a call that threw. A registration that is not a public client
	// leaves no cached client behind and sends nobody to the authorization
	// server. The refusal message names the outcome and not the value lesser
	// stated, so an instance cannot choose the text this app shows.
	if (registration.outcome === 'not-public') throw new Error(NOT_A_PUBLIC_CLIENT);
	if (registration.outcome !== 'public-client') {
		throw new Error(registrationErrorMessage(data, response.status));
	}

	const client: StoredOAuthClient = {
		clientId: registration.clientId,
		redirectUri,
		createdAt: Date.now(),
		// Not a value carried from the response: past the gate above, the only
		// method a registration can produce is the one this client asked for.
		tokenEndpointAuthMethod: PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD,
	};

	if (cacheBucket) {
		localStorage.setItem(oauthClientStorageKey(cacheBucket), JSON.stringify(client));
	}
	return client;
}

function readOAuthClientFromStorage(
	redirectUri: string,
	cacheBucket: OAuthClientCacheBucket
): StoredOAuthClient | null {
	if (!browser) return null;

	const storageKey = oauthClientStorageKey(cacheBucket);
	const raw = localStorage.getItem(storageKey);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as Partial<
			StoredOAuthClient & { clientSecret?: unknown; tokenEndpointAuthMethod?: unknown }
		>;
		if (typeof parsed?.clientId !== 'string' || !parsed.clientId.trim()) return null;
		if (parsed.redirectUri !== redirectUri) return null;

		// Two discards, and they are the cache half of the public-client
		// invariant: a cache that ever held a secret is not trusted to be public
		// now, and a client whose token endpoint wants authentication is not one
		// this app can present credentials for.
		if (Object.prototype.hasOwnProperty.call(parsed, 'clientSecret')) {
			localStorage.removeItem(storageKey);
			return null;
		}
		if (parsed.tokenEndpointAuthMethod !== PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD) {
			localStorage.removeItem(storageKey);
			return null;
		}

		return {
			clientId: parsed.clientId,
			redirectUri: parsed.redirectUri,
			createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
			tokenEndpointAuthMethod: PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD,
		};
	} catch {
		localStorage.removeItem(storageKey);
		return null;
	}
}

async function ensureOAuthClient(redirectUri: string, scope: string): Promise<StoredOAuthClient> {
	if (!browser) throw new Error('OAuth client config is only available in the browser');

	localStorage.removeItem(LEGACY_OAUTH_CLIENT_KEY);

	const cacheBucket = scopeToCacheBucket(scope);
	if (cacheBucket) {
		const storedClient = readOAuthClientFromStorage(redirectUri, cacheBucket);
		if (storedClient) return storedClient;
	}

	return registerOAuthClient(redirectUri, scope, cacheBucket);
}

// ---------------------------------------------------------------------------
// Authorization Code + PKCE
// ---------------------------------------------------------------------------

export async function startLogin(
	options: { scope?: string; returnTo?: string } = {}
): Promise<void> {
	if (!browser) return;

	const scope = options.scope ?? DEFAULT_OAUTH_SCOPE;
	const clientBucket = scopeToCacheBucket(scope);
	if (!clientBucket) {
		throw new Error('Unsupported OAuth scope for Contentus sign-in.');
	}

	const redirectUri = getRedirectUri();
	const client = await ensureOAuthClient(redirectUri, scope);

	const stateNonce = generateRandomString(16);
	const state = createOAuthState(
		stateNonce,
		await digestOAuthClientBinding(stateNonce, client.clientId)
	);
	const { codeVerifier, codeChallenge } = await createPkcePair();

	sessionStorage.setItem(STORAGE_KEYS.oauthState, stateNonce);
	sessionStorage.setItem(STORAGE_KEYS.oauthClientBucket, clientBucket);
	// A non-secret local time bound for the public client cache. If another tab
	// rotates the cached client after this PKCE request starts, fail closed
	// instead of exchanging the code with the wrong client_id. The client
	// identifier binding travels in OAuth state as a state-salted SHA-256
	// fingerprint so the raw client_id is never written to storage.
	sessionStorage.setItem(STORAGE_KEYS.oauthClientNotAfter, String(Date.now()));
	sessionStorage.setItem(STORAGE_KEYS.oauthVerifier, codeVerifier);
	sessionStorage.setItem(
		STORAGE_KEYS.oauthReturnTo,
		options.returnTo ??
			`${window.location.pathname}${window.location.search}${window.location.hash ?? ''}`
	);

	const params = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	});

	// lesser's auth-ui owns the credential surface. Contentus hands off and
	// never renders a password field of its own.
	window.location.assign(`/auth/login?${params.toString()}`);
}

export type CallbackResult = { ok: true; returnTo: string } | { ok: false; error: string };

/** Only ever an app-relative path — storage must not become an open redirect. */
function safeReturnTo(value: string | null): string {
	if (!value) return `${base}/`;
	return value.startsWith('/') && !value.startsWith('//') ? value : `${base}/`;
}

const UNUSABLE_TOKEN_LIFETIME =
	'The instance did not state a usable token lifetime. Please sign in again.';

const ALREADY_EXPIRED_TOKEN =
	'The instance issued a token that had already expired. Please sign in again.';

/**
 * A millisecond instant this session can be stored as and read back as itself.
 *
 * `Number.isSafeInteger` is the whole boundary, and each of the three things it
 * says is load-bearing here:
 *
 *   - FINITE, because `JSON.stringify` writes `Infinity` as `null` and
 *     `readSession` rejects a non-numeric `expiresAt`. This is the overflow a
 *     check on the STATED seconds cannot see: both operands can be finite and
 *     the product not be.
 *   - INTEGRAL, because the value is a millisecond timestamp whose only use is
 *     `Date.now() >= expiresAt`. Rounding a fractional instant to make it fit
 *     would be this client inventing an expiry the instance did not state, which
 *     is the thing the refusal exists to avoid.
 *   - WITHIN ±(2^53 − 1), because past that, milliseconds stop being distinct:
 *     neighbouring instants collapse onto one double and the comparison stops
 *     being about time. lesser's real values sit around 1.78e12 ms, eleven
 *     orders of magnitude inside the bound.
 *
 * What this does NOT do is cap a lifetime. An instance that says a token lives
 * for ten thousand years has stated something absurd and storable, and
 * shortening it would be inventing the lifetime this file refuses to invent.
 */
function isStorableInstant(milliseconds: number): boolean {
	return Number.isSafeInteger(milliseconds);
}

export async function completeLogin(searchParams: URLSearchParams): Promise<CallbackResult> {
	if (!browser) return { ok: false, error: 'OAuth callback must run in the browser' };

	const oauthError = searchParams.get('error');
	if (oauthError) {
		return { ok: false, error: searchParams.get('error_description') ?? oauthError };
	}

	const code = searchParams.get('code');
	const state = searchParams.get('state');
	if (!code) return { ok: false, error: 'Missing authorization code.' };
	if (!state) return { ok: false, error: 'Missing OAuth state.' };

	const expectedState = sessionStorage.getItem(STORAGE_KEYS.oauthState);
	const clientBucket = sessionStorage.getItem(STORAGE_KEYS.oauthClientBucket);
	const clientNotAfter = Number(sessionStorage.getItem(STORAGE_KEYS.oauthClientNotAfter));
	const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.oauthVerifier);
	const parsedState = parseOAuthState(state);

	if (!parsedState || !expectedState || parsedState.stateNonce !== expectedState) {
		return { ok: false, error: 'OAuth state mismatch. Please sign in again.' };
	}
	if (!codeVerifier) {
		return { ok: false, error: 'Missing PKCE verifier. Please sign in again.' };
	}
	if (!isOAuthClientCacheBucket(clientBucket)) {
		return { ok: false, error: 'Missing OAuth client bucket. Please sign in again.' };
	}

	const redirectUri = getRedirectUri();
	const client = await ensureOAuthClient(redirectUri, OAUTH_CLIENT_BUCKET_SCOPES[clientBucket]);

	if (Number.isFinite(clientNotAfter) && client.createdAt > clientNotAfter) {
		return { ok: false, error: 'OAuth client changed before callback. Please sign in again.' };
	}
	if (
		(await digestOAuthClientBinding(parsedState.stateNonce, client.clientId)) !==
		parsedState.clientBinding
	) {
		return { ok: false, error: 'OAuth client identifier mismatch. Please sign in again.' };
	}

	// A public client authenticates with the PKCE verifier and nothing else. No
	// secret is sent here because none was ever kept — see the header.
	const tokenResponse = await fetch('/oauth/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: client.clientId,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});

	// The fields this client reads out of lesser's `OAuthTokenResponse`.
	// `refresh_token` is deliberately absent from this projection and from
	// `AuthSession`: lesser sends one, contentus has nothing that spends it, and
	// a seven-day credential kept for no purpose is only ever a wider blast
	// radius. It is ignored the way the registration `client_secret` is ignored.
	const tokenJson = (await tokenResponse.json().catch(() => null)) as {
		access_token?: unknown;
		token_type?: unknown;
		scope?: unknown;
		created_at?: unknown;
		expires_in?: unknown;
		error?: unknown;
		error_description?: unknown;
	} | null;

	// A BLANK TOKEN IS NOT A TOKEN. A 200 carrying `access_token: ""` used to
	// pass this predicate, get stored, and return `ok: true` — and then
	// `readSession` rejected the session the caller had just been told it had.
	// A parser at a trust boundary does not get to disagree with the reader.
	// `!tokenJson` is redundant with the blank check — a null body cannot carry a
	// usable token — and it is written anyway so the compiler, not a reader's
	// confidence, is what says the fields below are on an object that exists.
	const accessToken = typeof tokenJson?.access_token === 'string' ? tokenJson.access_token : '';
	if (!tokenResponse.ok || !tokenJson || !accessToken.trim()) {
		for (const key of ['error_description', 'error'] as const) {
			const candidate = tokenJson?.[key];
			if (typeof candidate === 'string' && candidate.trim()) {
				return { ok: false, error: candidate };
			}
		}
		return { ok: false, error: `Token exchange failed (${tokenResponse.status}).` };
	}

	const createdAtSeconds = tokenJson.created_at;
	const expiresInSeconds = tokenJson.expires_in;
	if (
		typeof createdAtSeconds !== 'number' ||
		!Number.isFinite(createdAtSeconds) ||
		typeof expiresInSeconds !== 'number' ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0
	) {
		return { ok: false, error: UNUSABLE_TOKEN_LIFETIME };
	}

	// COMPUTED HERE, AND CHECKED HERE, BECAUSE THESE ARE THE NUMBERS THE SESSION
	// CARRIES. The check above reads what the response SAID; these two are what
	// gets written, announced, and reported as a sign-in, and passing the first
	// check does not make it past the second. `created_at: 1e308` is finite and
	// `1e308 * 1000` is `Infinity`; `JSON.stringify` writes that as `null`, so the
	// session `readSession` finds a moment later has no `expiresAt` at all.
	const createdAt = createdAtSeconds * 1000;
	const expiresAt = createdAt + expiresInSeconds * 1000;
	if (!isStorableInstant(createdAt) || !isStorableInstant(expiresAt)) {
		return { ok: false, error: UNUSABLE_TOKEN_LIFETIME };
	}

	// AND THE LIFETIME HAS TO STILL BE RUNNING. `readSession` deletes a session
	// whose `expiresAt` has passed, so an instant that is finite, exact, and in
	// the past — `created_at: 0` is all three — is a sign-in the reader discards
	// the first time it is asked for it. This is the same agreement as every
	// other check on this path and not a new policy: what the callback reports,
	// the reader can find. A user whose clock disagrees with the instance now
	// gets a stated reason instead of a sign-in that silently un-happens.
	if (Date.now() >= expiresAt) {
		return { ok: false, error: ALREADY_EXPIRED_TOKEN };
	}

	// Missing, blank, or not a string all normalize to the one type this flow
	// asked for. Normalizing rather than refusing is the choice the header
	// records; what is NOT allowed is storing a blank, because `readSession`
	// rejects that and the callback would have claimed a session that is gone.
	const statedTokenType =
		typeof tokenJson.token_type === 'string' ? tokenJson.token_type.trim() : '';

	writeSession({
		// Stored as lesser issued it. The blank check above is a gate, not a
		// rewrite: a credential is not this client's to reshape.
		accessToken,
		tokenType: statedTokenType || 'Bearer',
		...(typeof tokenJson.scope === 'string' ? { scope: tokenJson.scope } : {}),
		createdAt,
		expiresIn: expiresInSeconds,
		expiresAt,
	});

	const returnTo = safeReturnTo(sessionStorage.getItem(STORAGE_KEYS.oauthReturnTo));
	sessionStorage.removeItem(STORAGE_KEYS.oauthState);
	sessionStorage.removeItem(STORAGE_KEYS.oauthClientBucket);
	sessionStorage.removeItem(STORAGE_KEYS.oauthClientNotAfter);
	sessionStorage.removeItem(STORAGE_KEYS.oauthVerifier);
	sessionStorage.removeItem(STORAGE_KEYS.oauthReturnTo);

	return { ok: true, returnTo };
}

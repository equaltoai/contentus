import { browser } from '$app/environment';
import { base } from '$app/paths';

import { createPkcePair, generateRandomString } from './pkce';
import { CLIENT_CLASS, CLIENT_NAME, DEFAULT_OAUTH_SCOPE, normalizeScopeValue } from './scopes';
import { notifySessionChange } from './session-events';

/**
 * OAuth Authorization Code + PKCE against lesser's auth surface.
 *
 * Adapted from the proven simulacrum session module. Contentus differs in one
 * deliberate way: it registers through RFC 7591 dynamic registration at
 * `/oauth/register` (JSON) rather than the Mastodon-compatible
 * `/api/v1/apps` form endpoint, per product design §3 and issue #6.
 *
 * Invariants this file exists to keep:
 *
 *   - There is NO client-local authentication. Contentus never sees a
 *     password; the user authenticates against lesser's `auth-ui` at `/auth/*`
 *     and contentus only ever handles the resulting authorization code.
 *   - Tokens live in `sessionStorage`, never in cookies and never in
 *     `localStorage`. They die with the tab.
 *   - The client is public: `token_endpoint_auth_method: "none"`, no client
 *     secret is requested, stored, or accepted.
 *   - Every URL is same-origin and relative. No instance domain appears here.
 */

type TokenEndpointAuthMethod = 'none';

const PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD: TokenEndpointAuthMethod = 'none';

interface StoredOAuthClient {
	clientId: string;
	redirectUri: string;
	createdAt: number;
}

export interface AuthSession {
	accessToken: string;
	tokenType: string;
	scope?: string;
	createdAt: number;
	expiresAt: number;
}

const STORAGE_KEYS = {
	session: 'contentus:auth_session',
	oauthClient: 'contentus:oauth_client',
	oauthState: 'contentus:oauth_state',
	oauthVerifier: 'contentus:oauth_verifier',
	oauthReturnTo: 'contentus:oauth_return_to',
	oauthClientNotAfter: 'contentus:oauth_client_not_after',
} as const;

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export function readSession(): AuthSession | null {
	if (!browser) return null;

	const raw = sessionStorage.getItem(STORAGE_KEYS.session);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as AuthSession;
		if (!parsed?.accessToken || !parsed?.tokenType || !parsed?.expiresAt) return null;
		if (Date.now() >= parsed.expiresAt) {
			sessionStorage.removeItem(STORAGE_KEYS.session);
			return null;
		}
		return parsed;
	} catch {
		sessionStorage.removeItem(STORAGE_KEYS.session);
		return null;
	}
}

function writeSession(session: AuthSession): void {
	if (!browser) return;
	sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
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
 * messages face holds an authorized socket that only this signal closes.
 */
export function clearSession(): void {
	if (!browser) return;
	for (const key of Object.values(STORAGE_KEYS)) {
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
// Dynamic client registration (RFC 7591)
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
async function digestClientBinding(state: string, clientId: string): Promise<string> {
	if (!browser || !globalThis.crypto?.subtle) {
		throw new Error('OAuth client binding requires Web Crypto');
	}
	const encoded = new TextEncoder().encode(`contentus.oauth-client.v1:${state}:${clientId}`);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

async function registerOAuthClient(redirectUri: string, scope: string): Promise<StoredOAuthClient> {
	// Only fields present in lesser's registration model are sent: the handler
	// decodes with DisallowUnknownFields, so an extra key fails the request.
	const body = {
		client_name: CLIENT_NAME,
		redirect_uris: [redirectUri],
		scope,
		grant_types: ['authorization_code'],
		response_types: ['code'],
		token_endpoint_auth_method: PUBLIC_TOKEN_ENDPOINT_AUTH_METHOD,
		application_type: 'web',
		client_uri: window.location.origin,
		client_class: CLIENT_CLASS,
	};

	const response = await fetch('/oauth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const data = (await response.json().catch(() => null)) as {
		client_id?: string;
		client_secret?: string;
		error_description?: string;
		error?: string;
	} | null;

	if (!response.ok || !data?.client_id) {
		throw new Error(
			data?.error_description ??
				data?.error ??
				`OAuth client registration failed (${response.status})`
		);
	}

	// A public client must never be issued a secret. If the instance returns
	// one, the registration was not the public flow we asked for — fail closed
	// rather than proceed with credentials we would have to store.
	if (data.client_secret) {
		throw new Error(
			'Refusing a confidential OAuth client: contentus registers as a public client.'
		);
	}

	const client: StoredOAuthClient = {
		clientId: data.client_id,
		redirectUri,
		createdAt: Date.now(),
	};
	localStorage.setItem(STORAGE_KEYS.oauthClient, JSON.stringify(client));
	return client;
}

function readCachedClient(redirectUri: string): StoredOAuthClient | null {
	if (!browser) return null;

	const raw = localStorage.getItem(STORAGE_KEYS.oauthClient);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as Partial<StoredOAuthClient> & { clientSecret?: unknown };
		if (!parsed?.clientId || parsed.redirectUri !== redirectUri) return null;
		if (parsed.clientSecret) {
			localStorage.removeItem(STORAGE_KEYS.oauthClient);
			return null;
		}
		return {
			clientId: parsed.clientId,
			redirectUri: parsed.redirectUri,
			createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
		};
	} catch {
		localStorage.removeItem(STORAGE_KEYS.oauthClient);
		return null;
	}
}

async function ensureOAuthClient(redirectUri: string, scope: string): Promise<StoredOAuthClient> {
	return readCachedClient(redirectUri) ?? (await registerOAuthClient(redirectUri, scope));
}

// ---------------------------------------------------------------------------
// Authorization Code + PKCE
// ---------------------------------------------------------------------------

export async function startLogin(
	options: { scope?: string; returnTo?: string } = {}
): Promise<void> {
	if (!browser) return;

	const scope = normalizeScopeValue(options.scope ?? DEFAULT_OAUTH_SCOPE);
	const redirectUri = getRedirectUri();
	const client = await ensureOAuthClient(redirectUri, scope);

	const stateNonce = generateRandomString(16);
	const state = `${stateNonce}.${await digestClientBinding(stateNonce, client.clientId)}`;
	const { codeVerifier, codeChallenge } = await createPkcePair();

	sessionStorage.setItem(STORAGE_KEYS.oauthState, stateNonce);
	sessionStorage.setItem(STORAGE_KEYS.oauthVerifier, codeVerifier);
	sessionStorage.setItem(STORAGE_KEYS.oauthClientNotAfter, String(Date.now()));
	sessionStorage.setItem(
		STORAGE_KEYS.oauthReturnTo,
		options.returnTo ?? `${window.location.pathname}${window.location.search}`
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
	const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.oauthVerifier);
	const clientNotAfter = Number(sessionStorage.getItem(STORAGE_KEYS.oauthClientNotAfter));

	const separator = state.indexOf('.');
	if (separator <= 0 || separator === state.length - 1) {
		return { ok: false, error: 'Malformed OAuth state.' };
	}
	const stateNonce = state.slice(0, separator);
	const stateBinding = state.slice(separator + 1);

	if (!expectedState || stateNonce !== expectedState) {
		return { ok: false, error: 'OAuth state mismatch. Please sign in again.' };
	}
	if (!codeVerifier) {
		return { ok: false, error: 'Missing PKCE verifier. Please sign in again.' };
	}

	const redirectUri = getRedirectUri();
	const client = await ensureOAuthClient(redirectUri, DEFAULT_OAUTH_SCOPE);

	if (Number.isFinite(clientNotAfter) && client.createdAt > clientNotAfter) {
		return { ok: false, error: 'OAuth client changed mid-flow. Please sign in again.' };
	}
	if ((await digestClientBinding(stateNonce, client.clientId)) !== stateBinding) {
		return { ok: false, error: 'OAuth client mismatch. Please sign in again.' };
	}

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

	const tokenJson = (await tokenResponse.json().catch(() => null)) as {
		access_token?: string;
		token_type?: string;
		scope?: string;
		created_at?: number;
		expires_in?: number;
		error?: string;
		error_description?: string;
	} | null;

	if (!tokenResponse.ok || !tokenJson?.access_token) {
		return {
			ok: false,
			error:
				tokenJson?.error_description ??
				tokenJson?.error ??
				`Token exchange failed (${tokenResponse.status}).`,
		};
	}

	const createdAt = (tokenJson.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
	const expiresIn = tokenJson.expires_in ?? 0;

	writeSession({
		accessToken: tokenJson.access_token,
		tokenType: tokenJson.token_type ?? 'Bearer',
		...(tokenJson.scope ? { scope: tokenJson.scope } : {}),
		createdAt,
		// A token with no stated lifetime is treated as short-lived rather than
		// eternal; re-authenticating is cheap, a stale token is not.
		expiresAt: expiresIn > 0 ? createdAt + expiresIn * 1000 : createdAt + 60 * 60 * 1000,
	});

	const returnTo = sessionStorage.getItem(STORAGE_KEYS.oauthReturnTo) ?? `${base}/`;
	sessionStorage.removeItem(STORAGE_KEYS.oauthState);
	sessionStorage.removeItem(STORAGE_KEYS.oauthVerifier);
	sessionStorage.removeItem(STORAGE_KEYS.oauthClientNotAfter);
	sessionStorage.removeItem(STORAGE_KEYS.oauthReturnTo);

	// Only ever return to an app-relative path — an attacker-supplied absolute
	// URL in storage must not become an open redirect.
	return {
		ok: true,
		returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : `${base}/`,
	};
}

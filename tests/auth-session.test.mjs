/**
 * Characterization tests for the transplanted simulacrum OAuth core.
 *
 * WHAT THESE TESTS ARE CHARACTERIZING. The fixtures below are not invented
 * shapes. `lesserRegistrationResponse()` is the JSON
 * `models.AppRegistrationResponse` serializes for a public app registration at
 * lesser ref e710ffb31a983b2ad993845dca7d3263b81de100
 * (`cmd/api/models/mastodon.go:69`, populated by
 * `createOAuthClientAndRespond` in `cmd/api/handlers/apps.go`), INCLUDING the
 * `client_secret` that `CreateOAuthClientGeneric`
 * (`pkg/storage/repositories/oauth_helpers.go:137`) generates for every client
 * it stores — public or not. `lesserTokenResponse()` is
 * `models.OAuthTokenResponse` (`cmd/api/models/oauth.go:72`).
 *
 * The previous version of this file asserted contentus's own invented policy:
 * that a response carrying `client_secret` must be REFUSED. That policy aborted
 * every sign-in against a real lesser instance. The rule the transplant
 * restores is simulacrum's: accept the response, read `client_id` and
 * `token_endpoint_auth_method` out of it, and never look at the secret again.
 * `noSecretAnywhere` is the test that this is true by inspection of every byte
 * the client stored and every byte it sent, rather than by reading the source.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, beforeEach, test } from 'node:test';

const aliases = new Map([
	['$app/environment', pathToFileURL(resolve('src/facetheory/shims/app-environment.ts')).href],
	['$app/paths', pathToFileURL(resolve('src/facetheory/shims/app-paths.ts')).href],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = aliases.get(specifier);
		if (url) return { url, shortCircuit: true };

		if (
			context.parentURL?.startsWith(pathToFileURL(resolve('src')).href) &&
			specifier.startsWith('.')
		) {
			const resolved = new URL(specifier, context.parentURL);
			const candidates = resolved.pathname.endsWith('.js')
				? [resolved.pathname.slice(0, -3) + '.ts']
				: [`${resolved.pathname}.ts`];
			const candidate = candidates.find(existsSync);
			if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
		}

		return nextResolve(specifier, context);
	},
});

class MemoryStorage {
	#values = new Map();

	getItem(key) {
		return this.#values.get(String(key)) ?? null;
	}

	setItem(key, value) {
		this.#values.set(String(key), String(value));
	}

	removeItem(key) {
		this.#values.delete(String(key));
	}

	clear() {
		this.#values.clear();
	}

	/** Every stored value, for the sweeps that prove an absence. */
	entries() {
		return [...this.#values.entries()];
	}
}

const originalGlobals = {
	window: globalThis.window,
	localStorage: globalThis.localStorage,
	sessionStorage: globalThis.sessionStorage,
	fetch: globalThis.fetch,
};

const assigned = [];
globalThis.window = {
	location: {
		origin: 'https://contentus.example',
		pathname: '/l/timelines',
		search: '?tab=home',
		hash: '',
		assign(value) {
			assigned.push(String(value));
		},
	},
};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const { completeLogin, startLogin, clearSession, readSession, isAuthenticated } =
	await import('../src/lib/auth/session.ts');
const { DEFAULT_OAUTH_SCOPE, DRONE_OAUTH_SCOPE } = await import('../src/lib/auth/scopes.ts');

const REDIRECT_URI = 'https://contentus.example/l/auth/callback';
const CLIENT_SECRET = 'lesser-generated-secret-that-must-never-be-kept';

/** The requests made in the current test, in order. */
let requests = [];

beforeEach(() => {
	assigned.length = 0;
	requests = [];
	localStorage.clear();
	sessionStorage.clear();
});

after(() => {
	globalThis.window = originalGlobals.window;
	globalThis.localStorage = originalGlobals.localStorage;
	globalThis.sessionStorage = originalGlobals.sessionStorage;
	globalThis.fetch = originalGlobals.fetch;
});

function response(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * lesser's real public-app registration response, secret and all.
 *
 * `client_secret` is present because lesser puts it there: the storage layer
 * generates one for every client and the handler copies `client.ClientSecret`
 * into the response with only `omitempty` guarding it. `Confidential` is false
 * and `token_endpoint_auth_method` is `none` in the same response — which is
 * exactly why refusing on the secret was refusing a PUBLIC client.
 */
function lesserRegistrationResponse(overrides = {}) {
	return {
		id: 'contentus-public',
		name: 'Contentus',
		website: 'https://contentus.example',
		redirect_uri: REDIRECT_URI,
		client_id: 'contentus-public',
		client_secret: CLIENT_SECRET,
		vapid_key: 'BFakeVapidPublicKey',
		grant_types: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_method: 'none',
		...overrides,
	};
}

function lesserTokenResponse(overrides = {}) {
	return {
		access_token: 'lesser-access-token',
		token_type: 'Bearer',
		expires_in: 7200,
		refresh_token: 'lesser-refresh-token',
		scope: 'read write follow push',
		created_at: 1_780_000_000,
		...overrides,
	};
}

/** Serve registration and token from the real lesser shapes, recording both. */
function serveLesser({ registration = {}, token = {}, tokenStatus = 200 } = {}) {
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		if (String(url) === '/api/v1/apps') {
			return response(lesserRegistrationResponse(registration));
		}
		if (String(url) === '/oauth/token') {
			return response(lesserTokenResponse(token), tokenStatus);
		}
		throw new Error(`unexpected request: ${url}`);
	};
}

function bodyEntries(init) {
	return [...init.body.entries()];
}

function authorizeUrl() {
	assert.ok(assigned.length > 0, 'expected an authorization redirect');
	return new URL(assigned[0], window.location.origin);
}

/** Drive a whole sign-in, returning the callback result. */
async function signIn(options = {}) {
	await startLogin(options);
	const authorize = authorizeUrl();
	return completeLogin(
		new URLSearchParams({
			code: 'authorization-code',
			state: authorize.searchParams.get('state'),
		})
	);
}

/**
 * Every path in a parsed structure whose KEY names a secret.
 *
 * KEYS, NOT SERIALIZED TEXT. The first version of this probe tested the stored
 * JSON with `/client_?[Ss]ecret/` and reported a finding against
 * `{"tokenEndpointAuthMethod":"client_secret_post"}` — where `client_secret_post`
 * is the NAME of an auth method, a value this client is supposed to be able to
 * store and reject on. A probe that cannot tell a field called `clientSecret`
 * from a value that mentions one is not evidence about either. The first test
 * below regresses this reading in both directions before anything relies on it.
 */
function secretBearingKeys(value, path = []) {
	if (Array.isArray(value)) {
		return value.flatMap((entry, index) => secretBearingKeys(entry, [...path, index]));
	}
	if (!value || typeof value !== 'object') return [];

	const found = [];
	for (const [key, entry] of Object.entries(value)) {
		if (/secret/i.test(key)) found.push([...path, key].join('.'));
		found.push(...secretBearingKeys(entry, [...path, key]));
	}
	return found;
}

/**
 * The absence assertion this whole file exists for: the secret lesser handed
 * back is in no storage value and in no request the client sent.
 */
function noSecretAnywhere() {
	for (const [store, name] of [
		[localStorage, 'localStorage'],
		[sessionStorage, 'sessionStorage'],
	]) {
		for (const [key, value] of store.entries()) {
			assert.ok(
				!value.includes(CLIENT_SECRET),
				`${name}[${key}] retained the client secret: ${value}`
			);

			let parsed;
			try {
				parsed = JSON.parse(value);
			} catch {
				continue;
			}
			assert.deepEqual(
				secretBearingKeys(parsed),
				[],
				`${name}[${key}] retained a secret-bearing field: ${value}`
			);
		}
	}

	for (const { url, init } of requests) {
		const body = init.body ? [...init.body.entries()] : [];
		for (const [key, value] of body) {
			assert.ok(!value.includes(CLIENT_SECRET), `${url} sent the client secret in ${key}`);
			assert.notEqual(key, 'client_secret', `${url} sent a client_secret parameter`);
		}
		assert.ok(
			!JSON.stringify(init.headers ?? {}).includes(CLIENT_SECRET),
			`${url} sent the client secret in a header`
		);
	}

	for (const redirect of assigned) {
		assert.ok(!redirect.includes(CLIENT_SECRET), `authorization redirect leaked the secret`);
	}
}

// ---------------------------------------------------------------------------
// The probe, before it is used as evidence
// ---------------------------------------------------------------------------

test('the secret probe bites on a planted secret and not on an auth-method name', () => {
	// Bites: the two spellings a stored client could carry one under, at depth.
	assert.deepEqual(secretBearingKeys({ clientSecret: 'x' }), ['clientSecret']);
	assert.deepEqual(secretBearingKeys({ client_secret: 'x' }), ['client_secret']);
	assert.deepEqual(secretBearingKeys({ a: { b: { clientSecret: 'x' } } }), ['a.b.clientSecret']);
	assert.deepEqual(secretBearingKeys({ list: [{ client_secret: 'x' }] }), ['list.0.client_secret']);

	// Does not bite: `client_secret_post` is the NAME of an auth method this
	// client stores in order to refuse it, and `none` is the one it keeps.
	assert.deepEqual(secretBearingKeys({ tokenEndpointAuthMethod: 'client_secret_post' }), []);
	assert.deepEqual(
		secretBearingKeys({
			clientId: 'c',
			redirectUri: REDIRECT_URI,
			createdAt: 1,
			tokenEndpointAuthMethod: 'none',
		}),
		[]
	);
});

// ---------------------------------------------------------------------------
// The defect this milestone exists to close
// ---------------------------------------------------------------------------

test("lesser's real registration response is accepted even though it carries client_secret", async () => {
	serveLesser();

	await startLogin();

	const registration = requests.find(({ url }) => url === '/api/v1/apps');
	assert.ok(registration, 'registration must be attempted');
	assert.equal(assigned.length, 1, 'authorization must proceed, not abort on the secret');

	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client_default'));
	assert.equal(cached.clientId, 'contentus-public');
	assert.equal(cached.tokenEndpointAuthMethod, 'none');
	assert.deepEqual(Object.keys(cached).sort(), [
		'clientId',
		'createdAt',
		'redirectUri',
		'tokenEndpointAuthMethod',
	]);

	noSecretAnywhere();
});

test('a full sign-in never stores or transmits the returned client_secret', async () => {
	serveLesser();

	const result = await signIn({ returnTo: '/l/agents' });
	assert.deepEqual(result, { ok: true, returnTo: '/l/agents' });

	const token = requests.find(({ url }) => url === '/oauth/token');
	assert.ok(token, 'the callback must exchange the code');
	assert.deepEqual(
		bodyEntries(token.init)
			.map(([key]) => key)
			.sort(),
		['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']
	);
	assert.deepEqual(token.init.headers, { 'content-type': 'application/x-www-form-urlencoded' });

	noSecretAnywhere();
});

// ---------------------------------------------------------------------------
// Registration request shape
// ---------------------------------------------------------------------------

test("registration sends exactly simulacrum's five public-app fields, and no client_class", async () => {
	serveLesser();

	await startLogin();

	const registration = requests.find(({ url }) => url === '/api/v1/apps');
	assert.equal(registration.init.method, 'POST');
	assert.deepEqual(registration.init.headers, {
		'content-type': 'application/x-www-form-urlencoded',
	});
	assert.deepEqual(bodyEntries(registration.init), [
		['client_name', 'Contentus'],
		['redirect_uris', REDIRECT_URI],
		['scopes', 'read write follow push'],
		['token_endpoint_auth_method', 'none'],
		['website', 'https://contentus.example'],
	]);
	assert.ok(!requests.some(({ url }) => url === '/oauth/register'));
});

test('the scope goes on the wire as written, not reordered', async () => {
	serveLesser();

	await startLogin({ scope: DRONE_OAUTH_SCOPE });

	const registration = requests.find(({ url }) => url === '/api/v1/apps');
	assert.equal(registration.init.body.get('scopes'), 'read write follow');
	assert.equal(authorizeUrl().searchParams.get('scope'), 'read write follow');
});

test('authorization is Authorization Code + PKCE S256 with no MCP resource', async () => {
	serveLesser();

	await signIn();

	const authorize = authorizeUrl();
	assert.equal(authorize.pathname, '/auth/login');
	assert.equal(authorize.searchParams.get('response_type'), 'code');
	assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
	assert.ok(authorize.searchParams.get('code_challenge').length > 0);
	assert.equal(authorize.searchParams.has('resource'), false);
	assert.equal(authorize.searchParams.has('client_secret'), false);

	const token = requests.find(({ url }) => url === '/oauth/token');
	assert.equal(token.init.body.has('resource'), false);
	assert.equal(token.init.body.get('code_verifier').length > 0, true);
});

test('registration rejects empty and null client ids before authorization', async () => {
	for (const clientId of ['', null, 42]) {
		localStorage.clear();
		assigned.length = 0;
		globalThis.fetch = async () => response(lesserRegistrationResponse({ client_id: clientId }));

		await assert.rejects(() => startLogin(), /OAuth app registration failed \(200\)/);
		assert.equal(localStorage.getItem('contentus:oauth_client_default'), null);
		assert.equal(assigned.length, 0);
	}
});

test("registration surfaces lesser's error field when error_description is absent", async () => {
	globalThis.fetch = async () => response({ error: 'redirect_uris must be absolute' }, 422);

	await assert.rejects(() => startLogin(), /redirect_uris must be absolute/);
});

// ---------------------------------------------------------------------------
// The public-client invariant, kept at the cache boundary the way sim keeps it
// ---------------------------------------------------------------------------

test('a cached clientSecret is discarded and replaced with a public client', async () => {
	localStorage.setItem(
		'contentus:oauth_client_default',
		JSON.stringify({
			clientId: 'confidential-client',
			clientSecret: 'must-not-survive',
			redirectUri: REDIRECT_URI,
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'none',
		})
	);
	serveLesser({ registration: { client_id: 'replacement-client' } });

	await startLogin();

	assert.equal(requests.filter(({ url }) => url === '/api/v1/apps').length, 1);
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client_default'));
	assert.equal(cached.clientId, 'replacement-client');
	assert.equal('clientSecret' in cached, false);
});

test('a cached non-public auth method is discarded and re-registered', async () => {
	localStorage.setItem(
		'contentus:oauth_client_default',
		JSON.stringify({
			clientId: 'confidential-client',
			redirectUri: REDIRECT_URI,
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'client_secret_post',
		})
	);
	serveLesser({ registration: { client_id: 'replacement-client' } });

	await startLogin();

	assert.equal(requests.filter(({ url }) => url === '/api/v1/apps').length, 1);
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client_default'));
	assert.equal(cached.clientId, 'replacement-client');
	assert.equal(cached.tokenEndpointAuthMethod, 'none');
});

test('a cache written for another redirect_uri is not reused', async () => {
	localStorage.setItem(
		'contentus:oauth_client_default',
		JSON.stringify({
			clientId: 'other-origin-client',
			redirectUri: 'https://elsewhere.example/l/auth/callback',
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'none',
		})
	);
	serveLesser({ registration: { client_id: 'replacement-client' } });

	await startLogin();

	assert.equal(authorizeUrl().searchParams.get('client_id'), 'replacement-client');
});

test('a non-public auth method in the response is not cached for reuse', async () => {
	serveLesser({ registration: { token_endpoint_auth_method: 'client_secret_post' } });

	await startLogin();
	assert.equal(assigned.length, 1, 'simulacrum does not abort registration on this');

	// The invariant lands here instead: the client is never reused from cache.
	assigned.length = 0;
	await startLogin();
	assert.equal(
		requests.filter(({ url }) => url === '/api/v1/apps').length,
		2,
		'a non-public cached client must be discarded, forcing re-registration'
	);
	noSecretAnywhere();
});

test('a valid public cache is reused without a second registration', async () => {
	serveLesser();

	await startLogin();
	assigned.length = 0;
	await startLogin();

	assert.equal(requests.filter(({ url }) => url === '/api/v1/apps').length, 1);
	assert.equal(authorizeUrl().searchParams.get('client_id'), 'contentus-public');
});

test('the pre-transplant single-bucket cache key is dropped, not migrated', async () => {
	localStorage.setItem(
		'contentus:oauth_client',
		JSON.stringify({
			clientId: 'legacy-client',
			redirectUri: REDIRECT_URI,
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'none',
		})
	);
	serveLesser();

	await startLogin();

	assert.equal(localStorage.getItem('contentus:oauth_client'), null);
	assert.equal(authorizeUrl().searchParams.get('client_id'), 'contentus-public');
});

// ---------------------------------------------------------------------------
// Scope buckets
// ---------------------------------------------------------------------------

test('each scope set caches its own public client and never borrows the other', async () => {
	let issued = 0;
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		issued += 1;
		return response(lesserRegistrationResponse({ client_id: `client-${issued}` }));
	};

	await startLogin({ scope: DEFAULT_OAUTH_SCOPE });
	const defaultClient = authorizeUrl().searchParams.get('client_id');

	assigned.length = 0;
	await startLogin({ scope: DRONE_OAUTH_SCOPE });
	const droneClient = authorizeUrl().searchParams.get('client_id');

	assert.notEqual(defaultClient, droneClient);
	assert.equal(
		JSON.parse(localStorage.getItem('contentus:oauth_client_default')).clientId,
		defaultClient
	);
	assert.equal(
		JSON.parse(localStorage.getItem('contentus:oauth_client_drone')).clientId,
		droneClient
	);
});

test('a scope set contentus does not know cannot start a flow', async () => {
	serveLesser();

	await assert.rejects(
		() => startLogin({ scope: 'read write follow push admin' }),
		/Unsupported OAuth scope for Contentus sign-in\./
	);
	assert.equal(requests.length, 0, 'no client is registered for an unknown scope');
	assert.equal(assigned.length, 0);
});

test('a scope spelled in another order still resolves to its bucket', async () => {
	serveLesser();

	await startLogin({ scope: 'push follow write read' });

	assert.equal(assigned.length, 1);
	assert.equal(requests.filter(({ url }) => url === '/api/v1/apps').length, 1);
});

test('the callback re-derives the client from the bucket the flow started in', async () => {
	let issued = 0;
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		if (String(url) === '/api/v1/apps') {
			issued += 1;
			return response(lesserRegistrationResponse({ client_id: `client-${issued}` }));
		}
		return response(lesserTokenResponse());
	};

	// A default-scope client already exists, so a drone flow that fell back to
	// the default bucket at callback would exchange with the wrong client_id.
	await startLogin({ scope: DEFAULT_OAUTH_SCOPE });
	assigned.length = 0;

	const result = await signIn({ scope: DRONE_OAUTH_SCOPE });
	assert.equal(result.ok, true);

	const token = requests.find(({ url }) => url === '/oauth/token');
	assert.equal(token.init.body.get('client_id'), 'client-2');
});

test('a callback with no recorded bucket is refused', async () => {
	serveLesser();
	await startLogin();
	const state = authorizeUrl().searchParams.get('state');
	sessionStorage.removeItem('contentus:oauth_client_bucket');

	assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c', state })), {
		ok: false,
		error: 'Missing OAuth client bucket. Please sign in again.',
	});
});

test('a callback with a forged bucket value is refused', async () => {
	serveLesser();
	await startLogin();
	const state = authorizeUrl().searchParams.get('state');
	sessionStorage.setItem('contentus:oauth_client_bucket', 'constructor');

	assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c', state })), {
		ok: false,
		error: 'Missing OAuth client bucket. Please sign in again.',
	});
});

// ---------------------------------------------------------------------------
// Callback verification
// ---------------------------------------------------------------------------

test('the callback refuses a mismatched, malformed, or missing state', async () => {
	serveLesser();
	await startLogin();
	const state = authorizeUrl().searchParams.get('state');

	assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c' })), {
		ok: false,
		error: 'Missing OAuth state.',
	});
	assert.deepEqual(await completeLogin(new URLSearchParams({ state })), {
		ok: false,
		error: 'Missing authorization code.',
	});
	for (const forged of ['not-the-state.binding', '.binding', 'nonce.', 'nodot']) {
		assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c', state: forged })), {
			ok: false,
			error: 'OAuth state mismatch. Please sign in again.',
		});
	}
	assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
});

test('the callback refuses a state whose client binding does not match', async () => {
	serveLesser();
	await startLogin();
	const nonce = sessionStorage.getItem('contentus:oauth_state');

	assert.deepEqual(
		await completeLogin(new URLSearchParams({ code: 'c', state: `${nonce}.sha256:deadbeef` })),
		{ ok: false, error: 'OAuth client identifier mismatch. Please sign in again.' }
	);
	assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
});

test('a client rotated after the flow started is refused rather than exchanged', async () => {
	serveLesser();
	await startLogin();
	const state = authorizeUrl().searchParams.get('state');

	// Another tab replaced the cached client with a newer registration.
	localStorage.setItem(
		'contentus:oauth_client_default',
		JSON.stringify({
			clientId: 'rotated-client',
			redirectUri: REDIRECT_URI,
			createdAt: Date.now() + 60_000,
			tokenEndpointAuthMethod: 'none',
		})
	);

	assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c', state })), {
		ok: false,
		error: 'OAuth client changed before callback. Please sign in again.',
	});
	assert.equal(
		requests.some(({ url }) => url === '/oauth/token'),
		false
	);
});

test('the callback refuses a missing PKCE verifier', async () => {
	serveLesser();
	await startLogin();
	const state = authorizeUrl().searchParams.get('state');
	sessionStorage.removeItem('contentus:oauth_verifier');

	assert.deepEqual(await completeLogin(new URLSearchParams({ code: 'c', state })), {
		ok: false,
		error: 'Missing PKCE verifier. Please sign in again.',
	});
});

test("the callback surfaces the authorization server's error without exchanging", async () => {
	serveLesser();

	assert.deepEqual(
		await completeLogin(
			new URLSearchParams({ error: 'access_denied', error_description: 'User said no' })
		),
		{ ok: false, error: 'User said no' }
	);
	assert.equal(requests.length, 0);
});

test('a failed token exchange stores nothing and reports lesser’s message', async () => {
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		if (String(url) === '/api/v1/apps') return response(lesserRegistrationResponse());
		return response({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
	};

	const result = await signIn();
	assert.deepEqual(result, { ok: false, error: 'PKCE verification failed' });
	assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
	assert.equal(isAuthenticated(), false);
});

// ---------------------------------------------------------------------------
// Session, expiry, and return path
// ---------------------------------------------------------------------------

test('the session is written to sessionStorage only, with lesser’s stated lifetime', async () => {
	serveLesser();

	await signIn();

	assert.equal(localStorage.getItem('contentus:auth_session'), null);
	const stored = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
	assert.equal(stored.accessToken, 'lesser-access-token');
	assert.equal(stored.tokenType, 'Bearer');
	assert.equal(stored.refreshToken, 'lesser-refresh-token');
	assert.equal(stored.expiresIn, 7200);
	assert.equal(stored.createdAt, 1_780_000_000 * 1000);
	assert.equal(stored.expiresAt, 1_780_000_000 * 1000 + 7200 * 1000);

	// That timestamp is in the past, so the session is already expired and the
	// expiry check is what proves the arithmetic is load-bearing.
	assert.equal(readSession(), null);
	assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
});

test('a live session is readable and reports its granted scope', async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

	await signIn();

	const session = readSession();
	assert.equal(session.accessToken, 'lesser-access-token');
	assert.equal(session.scope, 'read write follow push');
	assert.equal(isAuthenticated(), true);
});

test('a token response with no usable lifetime is refused, never treated as eternal', async () => {
	for (const token of [
		{ created_at: undefined },
		{ expires_in: undefined },
		{ expires_in: 0 },
		{ expires_in: -1 },
		{ expires_in: 'soon' },
		{ created_at: 'now' },
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token });

		const result = await signIn();
		assert.deepEqual(result, {
			ok: false,
			error: 'The instance did not state a usable token lifetime. Please sign in again.',
		});
		assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
		assert.equal(isAuthenticated(), false);
	}
});

test('the granted scope is recovered from the access token when the response omits it', async () => {
	const payload = Buffer.from(JSON.stringify({ scopes: ['read', 'write', 'follow'] }))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	serveLesser({
		token: {
			scope: undefined,
			access_token: `header.${payload}.signature`,
			created_at: Math.floor(Date.now() / 1000),
		},
	});

	await signIn();

	assert.equal(readSession().scope, 'read write follow');
});

test('an opaque access token leaves the stated scope alone', async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

	await signIn();

	assert.equal(readSession().scope, 'read write follow push');
});

test('returnTo defaults to the page the flow started on', async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

	const result = await signIn();

	assert.deepEqual(result, { ok: true, returnTo: '/l/timelines?tab=home' });
});

test('an absolute or protocol-relative returnTo cannot become an open redirect', async () => {
	for (const hostile of [
		'https://evil.example/steal',
		'//evil.example/steal',
		'javascript:alert(1)',
		'\\\\evil.example',
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

		await startLogin();
		const state = authorizeUrl().searchParams.get('state');
		sessionStorage.setItem('contentus:oauth_return_to', hostile);

		const result = await completeLogin(new URLSearchParams({ code: 'c', state }));
		assert.deepEqual(result, { ok: true, returnTo: '/l/' }, `returnTo ${hostile} must not survive`);
	}
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test('sign-out empties every sessionStorage key this module writes', async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

	await startLogin();
	// Mid-flow keys are live at this point; complete the flow so the session is too.
	const state = authorizeUrl().searchParams.get('state');
	await completeLogin(new URLSearchParams({ code: 'c', state }));
	sessionStorage.setItem('contentus:oauth_state', 'left-over-nonce');
	sessionStorage.setItem('contentus:oauth_verifier', 'left-over-verifier');
	sessionStorage.setItem('contentus:oauth_client_bucket', 'default');
	sessionStorage.setItem('contentus:oauth_client_not_after', '1');
	sessionStorage.setItem('contentus:oauth_return_to', '/l/messages');

	clearSession();

	assert.deepEqual(sessionStorage.entries(), [], 'no session key may survive sign-out');
	assert.equal(isAuthenticated(), false);
});

test('sign-out keeps the public client registration, which is not a credential', async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });
	await signIn();

	clearSession();

	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client_default'));
	assert.equal(cached.clientId, 'contentus-public');
	assert.equal('clientSecret' in cached, false);
	noSecretAnywhere();
});

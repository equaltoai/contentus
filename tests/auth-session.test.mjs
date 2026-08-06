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
 * restores is simulacrum's: accept the response and select `client_id` out of
 * it, reading `token_endpoint_auth_method` only to decide whether there is a
 * usable public client at all.
 *
 * WHAT `noSecretAnywhere` PROVES, AND WHAT IT CANNOT. `registerOAuthClient`
 * decodes the whole response body, so the returned secret is transiently
 * present in that object while the call runs, and no probe run from inside the
 * same process can show otherwise. What this sweep does prove — by inspecting
 * every byte the client stored, every byte it sent, every redirect it issued,
 * and every console call it made, rather than by reading the source — is the
 * bounded set that governs behaviour: the secret is never selected into the
 * stored client model, never persisted, never retransmitted, never logged, and
 * never placed into a redirect. `noRefreshTokenAnywhere` proves the same five
 * for the seven-day refresh token lesser issues beside the access token, which
 * contentus does not model, store, or spend.
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

/**
 * Every console call made while a flow runs.
 *
 * "Never logged" was a claim about the source until this existed. The wrappers
 * still forward to the real console, so a leak that happens also shows up in
 * the test output that reports it.
 */
let consoleCalls = [];
const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'trace', 'warn'];
const originalConsole = Object.fromEntries(
	CONSOLE_METHODS.map((method) => [method, console[method]])
);
for (const method of CONSOLE_METHODS) {
	const original = originalConsole[method].bind(console);
	console[method] = (...args) => {
		consoleCalls.push(args);
		original(...args);
	};
}

/** One readable line per console call, for the sweeps. */
function consoleText(args) {
	return args
		.map((arg) => {
			if (typeof arg === 'string') return arg;
			try {
				return JSON.stringify(arg) ?? String(arg);
			} catch {
				return String(arg);
			}
		})
		.join(' ');
}

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

const { accessTokenOrNull, completeLogin, startLogin, clearSession, readSession, isAuthenticated } =
	await import('../src/lib/auth/session.ts');
const { DEFAULT_OAUTH_SCOPE, DRONE_OAUTH_SCOPE } = await import('../src/lib/auth/scopes.ts');

const REDIRECT_URI = 'https://contentus.example/l/auth/callback';
const CLIENT_SECRET = 'lesser-generated-secret-that-must-never-be-kept';
const REFRESH_TOKEN = 'lesser-refresh-token-good-for-seven-days';

/** The requests made in the current test, in order. */
let requests = [];

beforeEach(() => {
	assigned.length = 0;
	requests = [];
	consoleCalls = [];
	localStorage.clear();
	sessionStorage.clear();
});

after(() => {
	globalThis.window = originalGlobals.window;
	globalThis.localStorage = originalGlobals.localStorage;
	globalThis.sessionStorage = originalGlobals.sessionStorage;
	globalThis.fetch = originalGlobals.fetch;
	for (const method of CONSOLE_METHODS) console[method] = originalConsole[method];
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

/**
 * `models.OAuthTokenResponse` as lesser issues it, INCLUDING a live `created_at`.
 *
 * That field used to be the literal `1_780_000_000`, and the literal was the
 * fixture's own defect: a real instance stamps a token with the second it minted
 * it, so a pinned past constant made the DEFAULT fixture an already-expired
 * token. Every test that wanted a session it could actually read had to override
 * `created_at` to get a conformant response, and `completeLogin` reported
 * `ok: true` for the ones that did not. A fixture that only characterizes lesser
 * when the caller corrects it is not characterizing lesser.
 */
function lesserTokenResponse(overrides = {}) {
	return {
		access_token: 'lesser-access-token',
		token_type: 'Bearer',
		expires_in: 7200,
		refresh_token: REFRESH_TOKEN,
		scope: 'read write follow push',
		created_at: Math.floor(Date.now() / 1000),
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
function keysMatching(pattern) {
	return function walk(value, path = []) {
		if (Array.isArray(value)) {
			return value.flatMap((entry, index) => walk(entry, [...path, index]));
		}
		if (!value || typeof value !== 'object') return [];

		const found = [];
		for (const [key, entry] of Object.entries(value)) {
			if (pattern.test(key)) found.push([...path, key].join('.'));
			found.push(...walk(entry, [...path, key]));
		}
		return found;
	};
}

const secretBearingKeys = keysMatching(/secret/i);

/**
 * The same reading for the credential contentus refuses to model at all.
 *
 * `refreshToken` and `refresh_token` are the two spellings a stored session
 * could carry one under. Nothing this module writes has a key that matches,
 * which is the point: the probe is only evidence because it would fire.
 */
const refreshBearingKeys = keysMatching(/refresh/i);

/**
 * The five bounded negatives, swept for one credential value.
 *
 * NOT PERSISTED, NOT RETRANSMITTED, NOT LOGGED, NOT REDIRECTED, and — where a
 * key name gives it away — NOT SELECTED into a stored model. The one property
 * deliberately NOT claimed is that the value never existed in memory: both
 * credentials arrive inside a decoded response body, and a probe running in the
 * same process cannot prove an absence there. These five are what the client
 * controls, so these five are what is asserted.
 */
function liveChannels() {
	return {
		stores: [
			[localStorage, 'localStorage'],
			[sessionStorage, 'sessionStorage'],
		],
		requests,
		redirects: assigned,
		logs: consoleCalls,
	};
}

function credentialAbsentEverywhere(
	credential,
	label,
	{ keyProbe, channels = liveChannels() } = {}
) {
	for (const [store, name] of channels.stores) {
		for (const [key, value] of store.entries()) {
			assert.ok(!value.includes(credential), `${name}[${key}] retained the ${label}: ${value}`);

			if (!keyProbe) continue;
			let parsed;
			try {
				parsed = JSON.parse(value);
			} catch {
				continue;
			}
			assert.deepEqual(
				keyProbe(parsed),
				[],
				`${name}[${key}] retained a ${label}-bearing field: ${value}`
			);
		}
	}

	for (const { url, init } of channels.requests) {
		const body = init.body ? [...init.body.entries()] : [];
		for (const [key, value] of body) {
			assert.ok(!value.includes(credential), `${url} sent the ${label} in ${key}`);
		}
		assert.ok(
			!JSON.stringify(init.headers ?? {}).includes(credential),
			`${url} sent the ${label} in a header`
		);
	}

	for (const redirect of channels.redirects) {
		assert.ok(!redirect.includes(credential), `authorization redirect leaked the ${label}`);
	}

	for (const args of channels.logs) {
		assert.ok(!consoleText(args).includes(credential), `a console call carried the ${label}`);
	}
}

/**
 * The absence assertion this whole file exists for: the secret lesser handed
 * back reaches no storage value, no request, no redirect, and no log line.
 */
function noSecretAnywhere(channels = liveChannels()) {
	credentialAbsentEverywhere(CLIENT_SECRET, 'client secret', {
		keyProbe: secretBearingKeys,
		channels,
	});

	for (const { url, init } of channels.requests) {
		for (const [key] of init.body ? [...init.body.entries()] : []) {
			assert.notEqual(key, 'client_secret', `${url} sent a client_secret parameter`);
		}
	}
}

/**
 * The same five for lesser's refresh token, which contentus does not model.
 *
 * The access token is a one-hour credential this client needs. The refresh
 * token is a seven-day one it has no call for, so the only correct amount to
 * keep is none — and "none" is a sweep, not a comment.
 */
function noRefreshTokenAnywhere(channels = liveChannels()) {
	credentialAbsentEverywhere(REFRESH_TOKEN, 'refresh token', {
		keyProbe: refreshBearingKeys,
		channels,
	});
}

/**
 * A channel set carrying one planted value, for bite-checking the reading.
 *
 * NOTHING HERE TOUCHES REAL STORAGE, and that is the point rather than a
 * convenience. Writing a credential into `sessionStorage` to prove a sweep can
 * see it creates, inside the probe, the exact clear-text-storage shape the
 * sweep exists to forbid — a true finding about the test, raised by CodeQL
 * (`js/clear-text-storage-of-sensitive-data`) against the first version of this
 * file. The store here is a plain object with an `entries()` method, so the
 * planted value is data the reading walks, never something written anywhere.
 * The live channels are proven separately, with a value that is not a
 * credential.
 */
function plantedChannels({ store, request, redirect, log } = {}) {
	return {
		stores: store === undefined ? [] : [[{ entries: () => [['planted', store]] }, 'plantedStore']],
		requests:
			request === undefined
				? []
				: [{ url: '/oauth/token', init: { body: new URLSearchParams({ x: request }) } }],
		redirects: redirect === undefined ? [] : [`/auth/login?leak=${redirect}`],
		logs: log === undefined ? [] : [['registered client', log]],
	};
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

	// The refresh reading, both directions, against the exact shape this module
	// writes — which is the shape that must keep reading clean.
	assert.deepEqual(refreshBearingKeys({ refreshToken: 'x' }), ['refreshToken']);
	assert.deepEqual(refreshBearingKeys({ refresh_token: 'x' }), ['refresh_token']);
	assert.deepEqual(refreshBearingKeys({ a: [{ refreshToken: 'x' }] }), ['a.0.refreshToken']);
	assert.deepEqual(
		refreshBearingKeys({
			accessToken: 'a',
			tokenType: 'Bearer',
			scope: 'read',
			createdAt: 1,
			expiresIn: 2,
			expiresAt: 3,
		}),
		[]
	);
});

test('the sweeps bite on a planted store, request, redirect, and log line', () => {
	// THE READING, against channels carrying one planted value each. A sweep that
	// cannot fail is not evidence that anything passed it.
	assert.throws(
		() => noSecretAnywhere(plantedChannels({ store: CLIENT_SECRET })),
		/retained the client secret/
	);
	assert.throws(
		() => noSecretAnywhere(plantedChannels({ store: JSON.stringify({ clientSecret: 'x' }) })),
		/retained a client secret-bearing field/
	);
	assert.throws(
		() => noSecretAnywhere(plantedChannels({ request: CLIENT_SECRET })),
		/sent the client secret in x/
	);
	assert.throws(
		() => noSecretAnywhere(plantedChannels({ redirect: CLIENT_SECRET })),
		/redirect leaked the client secret/
	);
	assert.throws(
		() => noSecretAnywhere(plantedChannels({ log: { client_secret: CLIENT_SECRET } })),
		/console call carried the client secret/
	);
	assert.throws(
		() =>
			noRefreshTokenAnywhere(
				plantedChannels({ store: JSON.stringify({ refreshToken: REFRESH_TOKEN }) })
			),
		/retained the refresh token/
	);
	assert.throws(
		() => noRefreshTokenAnywhere(plantedChannels({ request: REFRESH_TOKEN })),
		/sent the refresh token in x/
	);

	// And with nothing planted, silent.
	noSecretAnywhere(plantedChannels());
	noSecretAnywhere();
	noRefreshTokenAnywhere();
});

test('the sweeps read the live channels, not a stand-in for them', () => {
	// THE WIRING, which the injected channels above deliberately do not prove.
	// The planted value is a MARKER, not a credential: a probe that writes a
	// secret into `sessionStorage` to make a point has built the clear-text
	// storage its own sweep exists to forbid.
	const MARKER = 'planted-marker-value-which-is-not-a-credential';
	const plants = [
		[
			'localStorage',
			() => localStorage.setItem('planted', MARKER),
			/localStorage\[planted\] retained the marker/,
		],
		[
			'sessionStorage',
			() => sessionStorage.setItem('planted', MARKER),
			/sessionStorage\[planted\] retained the marker/,
		],
		[
			'request',
			() =>
				requests.push({ url: '/api/v1/apps', init: { body: new URLSearchParams({ x: MARKER }) } }),
			/sent the marker in x/,
		],
		['redirect', () => assigned.push(`/auth/login?x=${MARKER}`), /redirect leaked the marker/],
		['console', () => consoleCalls.push([MARKER]), /console call carried the marker/],
	];

	for (const [channel, plant, expected] of plants) {
		localStorage.clear();
		sessionStorage.clear();
		requests.length = 0;
		assigned.length = 0;
		consoleCalls.length = 0;

		credentialAbsentEverywhere(MARKER, 'marker');
		plant();
		assert.throws(
			() => credentialAbsentEverywhere(MARKER, 'marker'),
			expected,
			`the live ${channel} channel must be one the sweep reads`
		);
	}
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

test('a non-public auth method in the response is refused before the redirect and before the cache', async () => {
	// FIRST USE IS THE GAP THE CACHE BOUNDARY CANNOT COVER. The client returned
	// by registration goes straight to the authorization redirect; only a LATER
	// sign-in would meet the cache reader that discards it. So this is checked
	// where it happens: nothing cached, nobody redirected, nothing thrown away.
	for (const authMethod of [
		'client_secret_post',
		'client_secret_basic',
		'private_key_jwt',
		'NONE',
		' none',
		'',
		42,
		null,
		{},
	]) {
		localStorage.clear();
		sessionStorage.clear();
		assigned.length = 0;
		requests = [];
		serveLesser({ registration: { token_endpoint_auth_method: authMethod } });

		await assert.rejects(
			() => startLogin(),
			/The instance did not register Contentus as a public client\./,
			`token_endpoint_auth_method ${JSON.stringify(authMethod)} must not become a client`
		);

		assert.equal(assigned.length, 0, 'no authorization redirect may be issued');
		assert.deepEqual(localStorage.entries(), [], 'no client may be cached');
		assert.equal(requests.filter(({ url }) => url === '/oauth/token').length, 0);
		noSecretAnywhere();
	}
});

test('an omitted auth method still reads as the none this client asked for', async () => {
	// Sim's `?? 'none'`, kept. Unreachable against a conformant lesser, which
	// states a method for every registration — but the value it falls back to is
	// the one the request asked for, so absence is not a refusal.
	const served = JSON.parse(
		JSON.stringify(lesserRegistrationResponse({ token_endpoint_auth_method: undefined }))
	);
	assert.equal(
		'token_endpoint_auth_method' in served,
		false,
		'this fixture must actually omit the field, or the case under test is not the absent one'
	);
	serveLesser({ registration: { token_endpoint_auth_method: undefined } });

	await startLogin();

	assert.equal(assigned.length, 1);
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client_default'));
	assert.equal(cached.tokenEndpointAuthMethod, 'none');
});

test('a non-public cached client is still discarded on read, and re-registration is refused', async () => {
	// The cache-boundary half of the invariant, which did not move. A client
	// cached by an older build is discarded on read; the re-registration that
	// follows meets the registration-time gate, so the flow ends refused rather
	// than redirecting against a client it cannot authenticate.
	localStorage.setItem(
		'contentus:oauth_client_default',
		JSON.stringify({
			clientId: 'confidential-client',
			redirectUri: REDIRECT_URI,
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'client_secret_post',
		})
	);
	serveLesser({ registration: { token_endpoint_auth_method: 'client_secret_post' } });

	await assert.rejects(() => startLogin(), /did not register Contentus as a public client/);

	assert.equal(requests.filter(({ url }) => url === '/api/v1/apps').length, 1);
	assert.equal(localStorage.getItem('contentus:oauth_client_default'), null);
	assert.equal(assigned.length, 0);
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
	// The arithmetic pinned exactly, against a `created_at` this test states
	// rather than one the fixture happens to hold. The previous version pinned it
	// to a past constant and then asserted `readSession() === null` — which is to
	// say it asserted the callback/reader disagreement as though it were the
	// design. It is the defect; the last assertion here is its replacement.
	const createdAtSeconds = Math.floor(Date.now() / 1000);
	serveLesser({ token: { created_at: createdAtSeconds } });

	await signIn();

	assert.equal(localStorage.getItem('contentus:auth_session'), null);
	const stored = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
	assert.equal(stored.accessToken, 'lesser-access-token');
	assert.equal(stored.tokenType, 'Bearer');
	assert.equal(stored.expiresIn, 7200);
	assert.equal(stored.createdAt, createdAtSeconds * 1000);
	assert.equal(stored.expiresAt, createdAtSeconds * 1000 + 7200 * 1000);

	assert.notEqual(readSession(), null, 'the stored session must survive its own reader');
});

test("lesser's seven-day refresh token is neither modelled nor stored", async () => {
	serveLesser({ token: { created_at: Math.floor(Date.now() / 1000) } });

	const result = await signIn();
	assert.equal(result.ok, true, 'the refresh token is ignored, not refused');

	// The stored session's whole shape, so a field cannot reappear unnoticed.
	const stored = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
	assert.deepEqual(Object.keys(stored).sort(), [
		'accessToken',
		'createdAt',
		'expiresAt',
		'expiresIn',
		'scope',
		'tokenType',
	]);
	assert.equal('refreshToken' in stored, false);

	// And the value itself is in nothing the client kept, sent, showed, or said.
	noRefreshTokenAnywhere();

	// Including anything the session reader hands downstream: `accessTokenOrNull`
	// is the only credential this app exposes to its GraphQL layer.
	assert.deepEqual(refreshBearingKeys(readSession()), []);
	assert.equal(accessTokenOrNull(), 'lesser-access-token');
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

test('a lifetime that survives the stated-value check but not the arithmetic is refused', async () => {
	// EVERY `created_at` AND `expires_in` BELOW IS A FINITE NUMBER, so the check
	// on the stated values passes all of them. What fails is the pair of instants
	// the session would actually carry. `1e308` is finite and `1e308 * 1000` is
	// `Infinity`, which `JSON.stringify` writes as `null` — and the session
	// `readSession` goes looking for a moment later has no `expiresAt` at all.
	// A parser at a trust boundary has to check the numbers it is about to store,
	// not the numbers it was handed.
	for (const token of [
		{ created_at: Number.MAX_VALUE }, // × 1000 overflows to Infinity
		{ created_at: -Number.MAX_VALUE }, // and so does the negative end
		{ expires_in: Number.MAX_VALUE }, // a storable createdAt plus an overflow
		{ created_at: 1e305, expires_in: 1e305 }, // both ends at once
		{ created_at: Number.MAX_SAFE_INTEGER }, // finite, and 1000× past exact
		{ created_at: 1e13 }, // finite, integral, 1e16 ms — past exact
		{ expires_in: 1e13 }, // the same overrun reached through the lifetime
		{ created_at: 1_780_000_000.0004 }, // a fractional millisecond instant
		{ expires_in: 0.0004 }, // and a fractional millisecond lifetime
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token });

		const result = await signIn();
		assert.deepEqual(
			result,
			{
				ok: false,
				error: 'The instance did not state a usable token lifetime. Please sign in again.',
			},
			`token ${JSON.stringify(token)} must not become a session`
		);
		assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
		assert.equal(readSession(), null);
		assert.equal(isAuthenticated(), false);
	}
});

test('a token whose stated lifetime has already elapsed is refused, not stored', async () => {
	// Finite, integral, exactly storable — and gone. `readSession` deletes a
	// session whose `expiresAt` has passed, so reporting `ok: true` for one of
	// these is the callback claiming a sign-in the reader discards on the very
	// next read.
	for (const token of [
		{ created_at: 0 }, // the epoch
		{ created_at: -1_000_000 }, // before it
		{ created_at: 1_780_000_000 }, // the constant this fixture used to pin
		{ created_at: Math.floor(Date.now() / 1000) - 7200 - 60 }, // expired a minute ago
		{ expires_in: Number.MIN_VALUE }, // a lifetime too small to reach the next ms
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token });

		const result = await signIn();
		assert.deepEqual(
			result,
			{
				ok: false,
				error: 'The instance issued a token that had already expired. Please sign in again.',
			},
			`token ${JSON.stringify(token)} must not be reported as a sign-in`
		);
		assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
		assert.equal(readSession(), null);
		assert.equal(isAuthenticated(), false);
	}
});

test('an extreme but exactly storable future lifetime is accepted, not swept up', async () => {
	// The other direction, because a refusal that fires on everything large is
	// not a boundary — it is a blanket, and it would refuse conformant instances
	// on the day their clock runs ahead. These sit inside the exact millisecond
	// range and are accepted, stored, and readable.
	for (const createdAtSeconds of [
		Math.floor(Date.now() / 1000), // what lesser actually sends
		4_000_000_000, // year 2096
		8_000_000_000_000, // 8e15 ms — just inside 2^53 − 1
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token: { created_at: createdAtSeconds } });

		const result = await signIn();
		assert.equal(result.ok, true, `created_at ${createdAtSeconds} must still sign in`);

		const stored = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
		assert.equal(stored.createdAt, createdAtSeconds * 1000);
		assert.equal(stored.expiresAt, createdAtSeconds * 1000 + 7200 * 1000);
		assert.notEqual(readSession(), null, 'the stored session must survive its own reader');
		assert.equal(isAuthenticated(), true);
	}
});

test('an empty or blank access_token is refused, never reported as a sign-in', async () => {
	// A 200 with a blank token used to pass the parser, get written, and return
	// ok: true — and then `readSession` threw the session away. The callback does
	// not get to disagree with the reader about whether a sign-in happened.
	for (const accessToken of ['', '   ', '\t\n', undefined, null, 42]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({
			token: { access_token: accessToken, created_at: Math.floor(Date.now() / 1000) },
		});

		const result = await signIn();
		assert.deepEqual(
			result,
			{ ok: false, error: 'Token exchange failed (200).' },
			`access_token ${JSON.stringify(accessToken)} must not be a sign-in`
		);
		assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
		assert.equal(readSession(), null);
		assert.equal(isAuthenticated(), false);
		assert.equal(accessTokenOrNull(), null);
	}
});

test('a missing or blank token_type is normalized to Bearer, never stored blank', async () => {
	// The other half of the same split brain: `readSession` requires a non-blank
	// token type, so storing one it rejects would report a session that is gone.
	for (const tokenType of [undefined, '', '   ', null, 42]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token: { token_type: tokenType, created_at: Math.floor(Date.now() / 1000) } });

		const result = await signIn();
		assert.equal(result.ok, true, `token_type ${JSON.stringify(tokenType)} must not fail sign-in`);

		const stored = JSON.parse(sessionStorage.getItem('contentus:auth_session'));
		assert.equal(stored.tokenType, 'Bearer');
		assert.notEqual(readSession(), null, 'the stored session must survive its own reader');
		assert.equal(isAuthenticated(), true);
	}
});

test('completeLogin never reports success for a session readSession rejects', async () => {
	// The invariant behind both cases above, asserted as one property over every
	// malformed token response this file knows how to serve. Whatever the parser
	// decides, the two ends agree: a reported sign-in is a readable session.
	//
	// THE SECOND BLOCK IS THE POINT OF THE PROPERTY. Those values are all finite
	// numbers, which is what the individual field checks ask about — and a
	// property that only enumerates values already known to be refused proves
	// nothing about the ones nobody thought of. Two of them are accepted; the
	// assertion does not care which, only that acceptance and readability never
	// come apart.
	for (const token of [
		{},
		{ access_token: '' },
		{ access_token: '   ' },
		{ access_token: undefined },
		{ token_type: '' },
		{ token_type: undefined },
		{ token_type: null },
		{ scope: undefined },
		{ created_at: undefined },
		{ expires_in: undefined },
		{ expires_in: 0 },
		{ expires_in: -1 },
		{ expires_in: 'soon' },
		{ created_at: 'now' },

		// Finite, and computed into something the session cannot carry.
		{ created_at: Number.MAX_VALUE },
		{ created_at: -Number.MAX_VALUE },
		{ expires_in: Number.MAX_VALUE },
		{ created_at: 1e305, expires_in: 1e305 },
		{ created_at: Number.MAX_SAFE_INTEGER },
		{ created_at: 1e13 },
		{ expires_in: 1e13 },
		{ created_at: 1_780_000_000.0004 },
		{ expires_in: 0.0004 },

		// Finite, exactly storable, and already spent.
		{ created_at: 0 },
		{ created_at: -1_000_000 },
		{ created_at: 1_780_000_000 },
		{ created_at: Math.floor(Date.now() / 1000) - 7200 - 60 },
		{ expires_in: Number.MIN_VALUE },

		// Finite, exactly storable, and still running — the accepted side.
		{ created_at: 4_000_000_000 },
		{ created_at: 8_000_000_000_000 },
	]) {
		sessionStorage.clear();
		localStorage.clear();
		assigned.length = 0;
		serveLesser({ token: { created_at: Math.floor(Date.now() / 1000), ...token } });

		const result = await signIn();
		const session = readSession();

		assert.equal(
			result.ok === true && session === null,
			false,
			`token ${JSON.stringify(token)}: completeLogin said ${JSON.stringify(result)} for a session readSession rejects`
		);
		if (result.ok === false) {
			assert.equal(sessionStorage.getItem('contentus:auth_session'), null);
			assert.equal(isAuthenticated(), false);
		}
	}
});

test('readSession rejects a stored session whose credential fields are unusable', () => {
	// The reader's half of the agreement, checked against values `completeLogin`
	// can no longer produce — because a reader that only holds when the writer
	// behaves is not a check, and this storage is writable by anything on the
	// origin.
	const live = {
		accessToken: 'lesser-access-token',
		tokenType: 'Bearer',
		createdAt: Date.now(),
		expiresIn: 3600,
		expiresAt: Date.now() + 3_600_000,
	};
	sessionStorage.setItem('contentus:auth_session', JSON.stringify(live));
	assert.notEqual(readSession(), null, 'the control case must be readable, or nothing below bites');

	for (const broken of [
		{ accessToken: '' },
		{ accessToken: '   ' },
		{ accessToken: 42 },
		{ accessToken: undefined },
		{ tokenType: '' },
		{ tokenType: '  ' },
		{ tokenType: null },
		{ expiresAt: undefined },
		{ expiresAt: 'later' },
		{ expiresAt: Number.NaN },
	]) {
		sessionStorage.setItem('contentus:auth_session', JSON.stringify({ ...live, ...broken }));
		assert.equal(
			readSession(),
			null,
			`a stored session with ${JSON.stringify(broken)} must not be readable`
		);
		assert.equal(isAuthenticated(), false);
		assert.equal(accessTokenOrNull(), null);
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

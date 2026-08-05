import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';

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
		assign(value) {
			assigned.push(String(value));
		},
	},
};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const { completeLogin, startLogin } = await import('../src/lib/auth/session.ts');

beforeEach(() => {
	assigned.length = 0;
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

test("sign-in registers through /api/v1/apps with exactly lesser's public app fields", async () => {
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		return response({ client_id: 'contentus-public', token_endpoint_auth_method: 'none' });
	};

	await startLogin();

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, '/api/v1/apps');
	assert.equal(requests[0].init.method, 'POST');
	assert.deepEqual(requests[0].init.headers, {
		'content-type': 'application/x-www-form-urlencoded',
	});
	assert.deepEqual(
		[...requests[0].init.body.entries()],
		[
			['client_name', 'Contentus'],
			['redirect_uris', 'https://contentus.example/l/auth/callback'],
			['scopes', 'follow push read write'],
			['client_class', 'web'],
			['token_endpoint_auth_method', 'none'],
			['website', 'https://contentus.example'],
		]
	);
	assert.ok(!requests.some(({ url }) => url === '/oauth/register'));

	const authorize = new URL(assigned[0], window.location.origin);
	assert.equal(authorize.pathname, '/auth/login');
	assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(authorize.searchParams.has('resource'), false);
});

test('a cached clientSecret is discarded and replaced with a public client', async () => {
	localStorage.setItem(
		'contentus:oauth_client',
		JSON.stringify({
			clientId: 'confidential-client',
			clientSecret: 'must-not-survive',
			redirectUri: 'https://contentus.example/l/auth/callback',
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'none',
		})
	);

	let registrations = 0;
	globalThis.fetch = async (url) => {
		assert.equal(String(url), '/api/v1/apps');
		registrations += 1;
		return response({ client_id: 'replacement-client', token_endpoint_auth_method: 'none' });
	};

	await startLogin();

	assert.equal(registrations, 1);
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client'));
	assert.equal(cached.clientId, 'replacement-client');
	assert.equal('clientSecret' in cached, false);
});

test('registration refuses a response that carries a client secret', async () => {
	globalThis.fetch = async () =>
		response({
			client_id: 'confidential-client',
			client_secret: 'must-not-be-accepted',
			token_endpoint_auth_method: 'client_secret_post',
		});

	await assert.rejects(
		() => startLogin(),
		/Refusing a confidential OAuth client: contentus registers as a public client\./
	);
	assert.equal(localStorage.getItem('contentus:oauth_client'), null);
	assert.equal(assigned.length, 0);
});

test('registration rejects empty and null client ids before authorization', async () => {
	for (const clientId of ['', null]) {
		globalThis.fetch = async () =>
			response({ client_id: clientId, token_endpoint_auth_method: 'none' });

		await assert.rejects(() => startLogin(), /OAuth app registration failed \(200\)/);
	}

	assert.equal(localStorage.getItem('contentus:oauth_client'), null);
	assert.equal(assigned.length, 0);
});

test("an omitted auth-method response uses lesser's default without fabricating a cache claim", async () => {
	let registrations = 0;
	globalThis.fetch = async () => {
		registrations += 1;
		return response({ client_id: 'default-public-client' });
	};

	await startLogin();
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client'));
	assert.equal(cached.clientId, 'default-public-client');
	assert.equal('tokenEndpointAuthMethod' in cached, false);

	await startLogin();
	assert.equal(registrations, 1, 'the honest default-shaped cache remains reusable');
});

test('a returned non-public auth method is refused rather than normalized to none', async () => {
	globalThis.fetch = async () =>
		response({
			client_id: 'confidential-client',
			token_endpoint_auth_method: 'client_secret_post',
		});

	await assert.rejects(
		() => startLogin(),
		/Refusing an OAuth client whose token endpoint requires authentication\./
	);
	assert.equal(localStorage.getItem('contentus:oauth_client'), null);
});

test('a cached non-public auth method is discarded and re-registered', async () => {
	localStorage.setItem(
		'contentus:oauth_client',
		JSON.stringify({
			clientId: 'confidential-client',
			redirectUri: 'https://contentus.example/l/auth/callback',
			createdAt: Date.now(),
			tokenEndpointAuthMethod: 'client_secret_post',
		})
	);

	let registrations = 0;
	globalThis.fetch = async () => {
		registrations += 1;
		return response({ client_id: 'replacement-client', token_endpoint_auth_method: 'none' });
	};

	await startLogin();

	assert.equal(registrations, 1);
	const cached = JSON.parse(localStorage.getItem('contentus:oauth_client'));
	assert.equal(cached.clientId, 'replacement-client');
	assert.equal(cached.tokenEndpointAuthMethod, 'none');
});

test('registration surfaces lesser's error field when error_description is absent', async () => {
	globalThis.fetch = async () => response({ error: 'redirect_uris must be absolute' }, 422);

	await assert.rejects(() => startLogin(), /redirect_uris must be absolute/);
});

test('authorize and token requests never carry an MCP resource parameter', async () => {
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		if (url === '/api/v1/apps') {
			return response({ client_id: 'contentus-public', token_endpoint_auth_method: 'none' });
		}
		if (url === '/oauth/token') {
			return response({
				access_token: 'access-token',
				token_type: 'Bearer',
				expires_in: 3600,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	};

	await startLogin({ returnTo: '/l/agents' });
	const authorize = new URL(assigned[0], window.location.origin);
	assert.equal(authorize.searchParams.has('resource'), false);

	const result = await completeLogin(
		new URLSearchParams({ code: 'authorization-code', state: authorize.searchParams.get('state') })
	);
	assert.deepEqual(result, { ok: true, returnTo: '/l/agents' });

	const token = requests.find(({ url }) => url === '/oauth/token');
	assert.ok(token, 'the callback must exchange the code');
	assert.equal(token.init.headers['content-type'], 'application/x-www-form-urlencoded');
	assert.equal(token.init.body.get('client_id'), 'contentus-public');
	assert.equal(token.init.body.get('code_verifier')?.length > 0, true);
	assert.equal(token.init.body.has('resource'), false);
});

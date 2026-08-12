/**
 * Act-as context (`src/lib/agents/act-as.ts`) driven directly.
 *
 * WHAT THIS FILE IS EVIDENCE FOR: the selection lifecycle — storage, the
 * session binding, the sign-out clearing, and the two forbidden spellings that
 * end a selection. WHAT IT IS NOT: nothing here contacts lesser; the FORBIDDEN
 * fixtures are shapes, not authorizations, and whether a real instance refuses
 * a real revoked grant is the live install verification's job
 * (`docs/planning/agent-share-act-as-m7.md`, rollout).
 *
 * The loader shim below is the same one `tests/auth-session.test.mjs` uses:
 * act-as.ts imports `auth/session.ts` at runtime, which imports `$app/*`
 * aliases `node --test` cannot resolve, and whose own relative imports are
 * extensionless — the hook rewrites both.
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
}

const originalGlobals = {
	window: globalThis.window,
	sessionStorage: globalThis.sessionStorage,
	fetch: globalThis.fetch,
};

globalThis.window = { location: { origin: 'https://contentus.example' } };
globalThis.sessionStorage = new MemoryStorage();

const {
	actAsCandidates,
	actAsChangeListenerCount,
	actAsSelection,
	clearActAs,
	hasForbiddenExtension,
	isForbiddenShareError,
	onActAsChange,
	selectActAs,
} = await import('../src/lib/agents/act-as.ts');
const { notifySessionChange } = await import('../src/lib/auth/session-events.ts');
const { ShareClientError } = await import('../src/lib/agents/share-client.ts');

const AUTH_SESSION_KEY = 'contentus:auth_session';
const ACT_AS_KEY = 'contentus:act_as';

/** A signed-in auth session, lifetime running from now. */
function writeSession(overrides = {}) {
	const now = Date.now();
	const session = {
		accessToken: 'tok',
		tokenType: 'Bearer',
		scope: 'read write',
		createdAt: now,
		expiresIn: 3600,
		expiresAt: now + 3600_000,
		...overrides,
	};
	sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
	return session;
}

/** A recording act-as listener; unsubscribes itself. */
function recorder() {
	const calls = [];
	const unsubscribe = onActAsChange((selection) => calls.push(selection));
	return { calls, unsubscribe };
}

beforeEach(() => {
	sessionStorage.clear();
});

after(() => {
	globalThis.window = originalGlobals.window;
	globalThis.sessionStorage = originalGlobals.sessionStorage;
	globalThis.fetch = originalGlobals.fetch;
});

const GRANT = (overrides = {}) => ({
	active: true,
	agent_username: 'scribe',
	granted_at: '2026-08-12T00:00:00Z',
	granted_by: 'owner',
	grantee_username: 'editor',
	revoked_at: null,
	revoked_by: undefined,
	...overrides,
});

test('selectActAs stores the selection bound to the session, and it reads back', () => {
	const session = writeSession();
	const { calls, unsubscribe } = recorder();
	try {
		const selection = selectActAs('scribe');
		assert.deepEqual(selection, { agentUsername: 'scribe' });
		assert.deepEqual(actAsSelection(), { agentUsername: 'scribe' });

		const stored = JSON.parse(sessionStorage.getItem(ACT_AS_KEY));
		assert.equal(stored.agentUsername, 'scribe');
		assert.equal(stored.sessionCreatedAt, session.createdAt);
		assert.equal(stored.sessionExpiresAt, session.expiresAt);

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { agentUsername: 'scribe' });
	} finally {
		unsubscribe();
	}
});

test('selectActAs without a session stores nothing and selects nothing', () => {
	const { calls, unsubscribe } = recorder();
	try {
		assert.equal(selectActAs('scribe'), null);
		assert.equal(actAsSelection(), null);
		assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
		assert.equal(calls.length, 0);
	} finally {
		unsubscribe();
	}
});

test('a blank or missing username is refused', () => {
	writeSession();
	assert.equal(selectActAs(''), null);
	assert.equal(selectActAs('   '), null);
	assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
});

test('with no storage at all — the server pass — nothing is selected or announced', () => {
	writeSession();
	selectActAs('scribe');

	const { calls, unsubscribe } = recorder();
	try {
		const storage = globalThis.sessionStorage;
		delete globalThis.sessionStorage;
		try {
			assert.equal(actAsSelection(), null);
			assert.equal(selectActAs('bard'), null);
			clearActAs();
			assert.equal(calls.length, 0);
		} finally {
			globalThis.sessionStorage = storage;
		}
		// The stored selection under the removed storage was never touched, so
		// the real one survives the server-pass detour.
		assert.deepEqual(actAsSelection(), { agentUsername: 'scribe' });
	} finally {
		unsubscribe();
	}
});

test('a selection bound to a previous sign-in does not survive it', () => {
	writeSession();
	selectActAs('scribe');
	assert.deepEqual(actAsSelection(), { agentUsername: 'scribe' });

	// Same tab, new reader: a different session with a different lifetime.
	writeSession({ createdAt: Date.now() + 42 });
	assert.equal(actAsSelection(), null);
	// And the stale value is dropped, not merely ignored.
	assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
});

test('a selection bound to an expired session does not survive it', () => {
	writeSession();
	selectActAs('scribe');

	writeSession({ expiresAt: Date.now() - 1 });
	assert.equal(actAsSelection(), null);
	assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
});

test('a corrupted stored value is dropped rather than served', () => {
	writeSession();
	sessionStorage.setItem(ACT_AS_KEY, '{not json');
	assert.equal(actAsSelection(), null);
	assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);

	sessionStorage.setItem(ACT_AS_KEY, JSON.stringify({ agentUsername: 'scribe' }));
	assert.equal(actAsSelection(), null);
	assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
});

test('clearActAs removes the selection and announces null; a second clear is silent', () => {
	writeSession();
	selectActAs('scribe');

	const { calls, unsubscribe } = recorder();
	try {
		clearActAs();
		assert.equal(actAsSelection(), null);
		assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
		assert.equal(calls.length, 1);
		assert.equal(calls[0], null);

		clearActAs();
		assert.equal(calls.length, 1);
	} finally {
		unsubscribe();
	}
});

test('a signed-out announcement clears the selection', () => {
	writeSession();
	selectActAs('scribe');

	const { calls, unsubscribe } = recorder();
	try {
		notifySessionChange('signed-out');
		assert.equal(actAsSelection(), null);
		assert.equal(sessionStorage.getItem(ACT_AS_KEY), null);
		assert.equal(calls.length, 1);
		assert.equal(calls[0], null);
	} finally {
		unsubscribe();
	}
});

test('re-selecting the same agent announces nothing; changing the agent announces the change', () => {
	writeSession();
	selectActAs('scribe');

	const { calls, unsubscribe } = recorder();
	try {
		selectActAs('scribe');
		assert.equal(calls.length, 0);

		selectActAs('bard');
		assert.deepEqual(actAsSelection(), { agentUsername: 'bard' });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { agentUsername: 'bard' });
	} finally {
		unsubscribe();
	}
});

test('onActAsChange unsubscribes, and one failing listener does not stop the next', () => {
	writeSession();

	const seen = [];
	const unsubscribe = onActAsChange((selection) => seen.push(selection));
	const failing = onActAsChange(() => {
		throw new Error('teardown path');
	});
	try {
		selectActAs('scribe');
		assert.equal(seen.length, 1);

		unsubscribe();
		clearActAs();
		assert.equal(seen.length, 1);
		assert.equal(actAsChangeListenerCount(), 1);
	} finally {
		unsubscribe();
		failing();
	}
	assert.equal(actAsChangeListenerCount(), 0);
});

test('hasForbiddenExtension matches lesser FORBIDDEN extension, and nothing else', () => {
	const forbidden = [{ message: 'grant revoked', extensions: { code: 'FORBIDDEN' } }];
	assert.equal(hasForbiddenExtension(forbidden), true);
	// It is the act-as spelling exactly: HTTP 200, errors array, extension code.
	assert.equal(
		hasForbiddenExtension([
			{ message: 'ok', path: ['draft'], extensions: { code: 'OK' } },
			forbidden[0],
		]),
		true
	);

	assert.equal(
		hasForbiddenExtension([{ message: 'nope', extensions: { code: 'UNAUTHENTICATED' } }]),
		false
	);
	assert.equal(hasForbiddenExtension([{ message: 'no extensions' }]), false);
	assert.equal(hasForbiddenExtension([{ message: 'forbidden', extensions: {} }]), false);
	assert.equal(hasForbiddenExtension([]), false);
	assert.equal(hasForbiddenExtension([null, 'forbidden', 403]), false);
});

test('isForbiddenShareError matches a 403 ShareClientError, and nothing else', () => {
	assert.equal(isForbiddenShareError(new ShareClientError('gone', 403)), true);
	assert.equal(isForbiddenShareError(new ShareClientError('missing route', 404)), false);
	assert.equal(isForbiddenShareError(new ShareClientError('no lesser at all')), false);
	assert.equal(isForbiddenShareError(new TypeError('fetch failed')), false);
	assert.equal(isForbiddenShareError({ status: 403 }), false);
	assert.equal(isForbiddenShareError(null), false);
});

test('actAsCandidates keeps only active grants, as lesser served them', () => {
	const grants = [
		GRANT({ agent_username: 'scribe' }),
		GRANT({ agent_username: 'archived', active: false }),
		GRANT({ agent_username: 'bard' }),
	];
	assert.deepEqual(actAsCandidates(grants), ['scribe', 'bard']);
	assert.deepEqual(actAsCandidates([]), []);
});

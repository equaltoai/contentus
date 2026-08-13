import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ShareClientError,
	grantShare,
	listShareGrants,
	listSharedWithMe,
	revokeShare,
} from '../src/lib/agents/share-client.ts';

/**
 * Share-grant client against a stubbed fetch. WHAT THIS IS EVIDENCE FOR: the
 * wire contentus produces — method, path, auth header — and the way it reads
 * lesser's answers (grants array, typed grant, status-carrying errors). WHAT
 * IT IS NOT: the stub does not authorize anything; a 200 here says nothing
 * about what a real instance would permit. That is the live install
 * verification's job.
 */

const GRANT = {
	active: true,
	agent_username: 'scribe',
	granted_at: '2026-08-12T00:00:00Z',
	granted_by: 'owner',
	grantee_username: 'editor',
	revoked_at: null,
	revoked_by: null,
};

function stubFetch(handler) {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		calls.push({
			url: String(input),
			method: init.method ?? 'GET',
			headers: new Headers(init.headers),
		});
		return handler(input, init);
	};
	return {
		calls,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const token = { accessToken: 'tok' };

test('listShareGrants GETs the owner grant list and returns the grants array', async () => {
	const stub = stubFetch(() => jsonResponse({ grants: [GRANT] }));
	try {
		const grants = await listShareGrants('scribe', token);
		assert.deepEqual(grants, [GRANT]);
		assert.equal(stub.calls[0].method, 'GET');
		assert.equal(stub.calls[0].url, '/api/v1/agents/scribe/share');
		assert.equal(stub.calls[0].headers.get('authorization'), 'Bearer tok');
	} finally {
		stub.restore();
	}
});

test('grantShare PUTs and revokeShare DELETEs the grantee path, encoding both segments', async () => {
	const stub = stubFetch(() => jsonResponse(GRANT));
	try {
		await grantShare('scribe', 'ed itor', token);
		await revokeShare('scribe', 'ed itor', token);
		assert.equal(stub.calls[0].method, 'PUT');
		assert.equal(stub.calls[0].url, '/api/v1/agents/scribe/share/ed%20itor');
		assert.equal(stub.calls[1].method, 'DELETE');
		assert.equal(stub.calls[1].url, '/api/v1/agents/scribe/share/ed%20itor');
	} finally {
		stub.restore();
	}
});

test('listSharedWithMe GETs the shared-with-me route', async () => {
	const stub = stubFetch(() => jsonResponse({ grants: [] }));
	try {
		const grants = await listSharedWithMe(token);
		assert.deepEqual(grants, []);
		assert.equal(stub.calls[0].url, '/api/v1/agents/shared-with-me');
	} finally {
		stub.restore();
	}
});

test('an SSR endpoint base is prepended; the browser stays relative', async () => {
	const stub = stubFetch(() => jsonResponse({ grants: [] }));
	try {
		await listSharedWithMe({ ...token, endpoint: 'https://instance.example' });
		assert.equal(stub.calls[0].url, 'https://instance.example/api/v1/agents/shared-with-me');
	} finally {
		stub.restore();
	}
});

test('non-2xx surfaces a status-carrying error, including lesser error detail', async () => {
	const stub = stubFetch(() => jsonResponse({ error: 'agent not found' }, 404));
	try {
		await assert.rejects(listShareGrants('ghost', token), (error) => {
			assert.ok(error instanceof ShareClientError);
			assert.equal(error.status, 404);
			assert.match(error.message, /404/);
			assert.match(error.message, /agent not found/);
			return true;
		});
	} finally {
		stub.restore();
	}
});

test('a non-JSON error body still surfaces the status, which is the honest signal', async () => {
	const stub = stubFetch(() => new Response('<html>not found</html>', { status: 404 }));
	try {
		await assert.rejects(listSharedWithMe(token), (error) => {
			assert.ok(error instanceof ShareClientError);
			assert.equal(error.status, 404);
			return true;
		});
	} finally {
		stub.restore();
	}
});

test('transport failure carries no status', async () => {
	const stub = stubFetch(() => {
		throw new TypeError('fetch failed');
	});
	try {
		await assert.rejects(listSharedWithMe(token), (error) => {
			assert.ok(error instanceof ShareClientError);
			assert.equal(error.status, null);
			return true;
		});
	} finally {
		stub.restore();
	}
});

test('a 200 whose body is not a grant list is an error, not a render-time crash', async () => {
	// Defense-in-depth, not a claim about a conforming lesser: `grants` is
	// required in the OpenAPI. The guard exists so a malformed answer lands in
	// the panels' `unavailable` state instead of past it as a `TypeError` on
	// `response.grants.length`.
	const stub = stubFetch(() => jsonResponse({ ok: true }));
	try {
		await assert.rejects(listSharedWithMe(token), (error) => {
			assert.ok(error instanceof ShareClientError);
			assert.match(error.message, /not a grant list/);
			return true;
		});
		await assert.rejects(listShareGrants('scribe', token), (error) => {
			assert.ok(error instanceof ShareClientError);
			assert.match(error.message, /not a grant list/);
			return true;
		});
	} finally {
		stub.restore();
	}
});

test('a grants field that is not an array is refused the same way', async () => {
	const stub = stubFetch(() => jsonResponse({ grants: 'all of them' }));
	try {
		await assert.rejects(listSharedWithMe(token), ShareClientError);
		await assert.rejects(listShareGrants('scribe', token), ShareClientError);
	} finally {
		stub.restore();
	}
});

test('a grants array whose elements are not grant objects is refused', async () => {
	// The container check alone would admit this; the consumers read fields off
	// each element immediately (`grant.active`, `grant.grantee_username`), so
	// `[null]` is the same crash one level down.
	for (const grants of [[null], ['scribe'], [null, GRANT]]) {
		const stub = stubFetch(() => jsonResponse({ grants }));
		try {
			await assert.rejects(listSharedWithMe(token), (error) => {
				assert.ok(error instanceof ShareClientError);
				assert.match(error.message, /not a grant list/);
				return true;
			});
			await assert.rejects(listShareGrants('scribe', token), ShareClientError);
		} finally {
			stub.restore();
		}
	}
});

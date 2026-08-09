/**
 * The instance-info read, probed.
 *
 * `src/lib/instance/info.ts` is where the socket URL comes from now: lesser
 * v1.6.4 (commit 789e18bdb) serves `InstanceInfo.subscriptionUrl`, and the
 * derivation this replaced (`ws.` prefixed onto the request origin) is
 * deleted. The claims worth pinning:
 *
 *   - the query is valid against the pinned schema — it also rides the
 *     inventory gate (`tests/graphql-documents.test.mjs`), this is the local
 *     assertion;
 *   - normalization is FAIL-CLOSED: every selected field is non-null in the
 *     schema, so a partial answer is a contract violation, not data;
 *   - the fetch never throws and never carries a credential — the server pass
 *     reads this for a security header, and a pass holding no token cannot
 *     leak one;
 *   - the two caches behave as documented: one read per page load in the
 *     browser, TTL-bounded on the server, failures cached too.
 *
 * The network is stubbed at `fetch`, the same split the messaging probes use;
 * the server cache's clock is injected rather than slept on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSchema, parse, specifiedRules, validate } from 'graphql';

import { loadPinnedSchema } from '../scripts/lib/graphql-inventory.mjs';
import {
	INSTANCE_INFO_QUERY,
	createCachedInstanceInfo,
	createServerInstanceInfoCache,
	fetchInstanceInfo,
	subscriptionConnectOrigin,
	toInstanceInfo,
} from '../src/lib/instance/info.ts';

/** A full, valid `instance` answer, as lesser v1.6.4 serves one. */
function instancePayload(overrides = {}) {
	return {
		subscriptionUrl: 'wss://ws.social.example.test/graphql',
		maxUploadSizeBytes: 10485760,
		maxStatusCharacters: 5000,
		cmsFeatures: {
			longForm: true,
			drafts: true,
			revisions: true,
			scheduling: false,
			series: true,
			categories: true,
		},
		...overrides,
	};
}

/**
 * Run `body` with `fetch` stubbed, returning what it produced plus every
 * request it made — with the `authorization` header RECORDED, so "no
 * credential" is an observation rather than an assumption.
 */
async function withStubbedFetch(respond, body) {
	const requests = [];
	const original = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		requests.push({
			url: typeof input === 'string' ? input : String(input),
			operation: /query\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
		});

		const envelope = (await respond(requests.at(-1))) ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: envelope.httpStatus ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		return { value: await body(), requests };
	} finally {
		globalThis.fetch = original;
	}
}

/* ---------------------------------------------------------------------------
 * The query validates against the pinned schema
 * ------------------------------------------------------------------------ */

test('the instance-info query validates against the pinned lesser schema', () => {
	// The inventory gate asserts this across every document; pinned here too so
	// a schema bump that drops `subscriptionUrl` fails in the file that reads
	// it, not only in the sweep.
	const schema = buildSchema(loadPinnedSchema().sdl);
	assert.deepEqual(
		validate(schema, parse(INSTANCE_INFO_QUERY), specifiedRules).map((error) => error.message),
		[]
	);
});

/* ---------------------------------------------------------------------------
 * toInstanceInfo is fail-closed
 * ------------------------------------------------------------------------ */

test('a full, correctly-typed answer normalizes', () => {
	assert.deepEqual(toInstanceInfo({ instance: instancePayload() }), {
		subscriptionUrl: 'wss://ws.social.example.test/graphql',
		maxUploadSizeBytes: 10485760,
		maxStatusCharacters: 5000,
		cmsFeatures: {
			longForm: true,
			drafts: true,
			revisions: true,
			scheduling: false,
			series: true,
			categories: true,
		},
	});
});

test('any missing or wrong-typed field is a contract violation, not data', () => {
	// Every selected field is non-null in the schema, so a partial answer is the
	// instance disagreeing with the contract it publishes. null is the honest
	// rendering of that; a best guess at the surviving fields is not.
	const cases = {
		'no data at all': null,
		'no instance field': {},
		'instance is not an object': { instance: 'nope' },
		'missing subscriptionUrl': { instance: instancePayload({ subscriptionUrl: undefined }) },
		'empty subscriptionUrl': { instance: instancePayload({ subscriptionUrl: '' }) },
		'null subscriptionUrl': { instance: instancePayload({ subscriptionUrl: null }) },
		'numeric subscriptionUrl': { instance: instancePayload({ subscriptionUrl: 42 }) },
		'missing maxUploadSizeBytes': { instance: instancePayload({ maxUploadSizeBytes: undefined }) },
		'string maxUploadSizeBytes': { instance: instancePayload({ maxUploadSizeBytes: '10MB' }) },
		'float maxStatusCharacters': { instance: instancePayload({ maxStatusCharacters: 5000.5 }) },
		'missing cmsFeatures': { instance: instancePayload({ cmsFeatures: undefined }) },
		'null cmsFeatures': { instance: instancePayload({ cmsFeatures: null }) },
		'a feature that is not boolean': {
			instance: instancePayload({
				cmsFeatures: { ...instancePayload().cmsFeatures, scheduling: 'yes' },
			}),
		},
		'a feature missing outright': {
			instance: instancePayload({
				cmsFeatures: {
					longForm: true,
					drafts: true,
					revisions: true,
					series: true,
					categories: true,
				},
			}),
		},
	};

	for (const [name, input] of Object.entries(cases)) {
		assert.equal(toInstanceInfo(input), null, name);
	}
});

/* ---------------------------------------------------------------------------
 * fetchInstanceInfo never throws and never carries a credential
 * ------------------------------------------------------------------------ */

test('a transport failure is null, not a throw', async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error('network down');
	};
	try {
		assert.equal(await fetchInstanceInfo(), null);
	} finally {
		globalThis.fetch = original;
	}
});

test('a non-GraphQL HTTP answer is null, not a throw', async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response('<html>502</html>', { status: 502 });
	try {
		assert.equal(await fetchInstanceInfo(), null);
	} finally {
		globalThis.fetch = original;
	}
});

test('a GraphQL error set is null, even with data beside it', async () => {
	const { value } = await withStubbedFetch(
		() => ({
			data: { instance: instancePayload() },
			errors: [{ message: 'subscriptionUrl failed' }],
		}),
		() => fetchInstanceInfo()
	);
	// An errored answer cannot be complete — every field is non-null — and
	// complete is the only thing this module vouches for.
	assert.equal(value, null);
});

test('partial data is null, exactly as toInstanceInfo says', async () => {
	const { value } = await withStubbedFetch(
		() => ({ data: { instance: { subscriptionUrl: 'wss://ws.x.invalid' } } }),
		() => fetchInstanceInfo()
	);
	assert.equal(value, null);
});

test('a valid answer is returned, from a request that is anonymous and variable-free', async () => {
	const { value, requests } = await withStubbedFetch(
		() => ({ data: { instance: instancePayload() } }),
		() => fetchInstanceInfo({ endpoint: 'https://social.example.test/api/graphql' })
	);

	assert.deepEqual(value?.subscriptionUrl, 'wss://ws.social.example.test/graphql');
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, 'https://social.example.test/api/graphql');
	assert.equal(requests[0].operation, 'ContentusInstanceInfo');
	assert.deepEqual(requests[0].variables, {}, 'the read names nothing and parameterizes nothing');
	assert.equal(
		requests[0].authorization ?? null,
		null,
		'`instance` is a public field — a pass that carries no credential cannot leak one'
	);
});

/* ---------------------------------------------------------------------------
 * The browser cache: one read per page load
 * ------------------------------------------------------------------------ */

test('the page-load cache shares the in-flight read and the resolved value', async () => {
	const cached = createCachedInstanceInfo();

	const { requests } = await withStubbedFetch(
		() => ({ data: { instance: instancePayload() } }),
		async () => {
			// Racing the first read: two callers, one request.
			const [first, second] = await Promise.all([cached(), cached()]);
			assert.equal(first?.subscriptionUrl, 'wss://ws.social.example.test/graphql');
			assert.equal(second?.subscriptionUrl, 'wss://ws.social.example.test/graphql');

			// And after resolution: the answer is held, not re-asked.
			const third = await cached();
			assert.equal(third?.subscriptionUrl, 'wss://ws.social.example.test/graphql');
		}
	);

	assert.equal(requests.length, 1, 'a page load asks at most once');
});

/* ---------------------------------------------------------------------------
 * The server cache: TTL-bounded, failures cached too
 * ------------------------------------------------------------------------ */

test('the server cache reuses within the TTL and refetches after it', async () => {
	let now = 1_000;
	const cached = createServerInstanceInfoCache({ ttlMs: 60_000, now: () => now });
	let fetches = 0;

	await withStubbedFetch(
		() => {
			fetches += 1;
			return { data: { instance: instancePayload() } };
		},
		async () => {
			const endpoint = 'https://social.example.test/api/graphql';
			await cached(endpoint);

			now += 59_999; // still inside the TTL
			await cached(endpoint);
			assert.equal(fetches, 1, 'within the TTL the answer is reused');

			now += 2; // past it
			await cached(endpoint);
			assert.equal(fetches, 2, 'past the TTL the instance is asked again');
		}
	);
});

test('the server cache keys by endpoint, and caches failures as hard as successes', async () => {
	let now = 0;
	const cached = createServerInstanceInfoCache({ ttlMs: 60_000, now: () => now });
	let fetches = 0;

	await withStubbedFetch(
		({ url }) => {
			fetches += 1;
			return url.includes('dead') ? { httpStatus: 503 } : { data: { instance: instancePayload() } };
		},
		async () => {
			// A dead instance costs one failed read per TTL, not one per render —
			// without this every SSR paint of a socket route would wait out a
			// network timeout.
			assert.equal(await cached('https://dead.invalid/api/graphql'), null);
			assert.equal(await cached('https://dead.invalid/api/graphql'), null);
			assert.equal(fetches, 1, 'the failure is cached within the TTL');

			// A different endpoint is a different entry.
			await cached('https://social.example.test/api/graphql');
			assert.equal(fetches, 2);

			// And the dead one recovers on its own once the TTL lapses.
			now += 60_001;
			assert.equal(await cached('https://dead.invalid/api/graphql'), null);
			assert.equal(fetches, 3, 'a cached failure expires on schedule like any other entry');
		}
	);
});

/* ---------------------------------------------------------------------------
 * subscriptionConnectOrigin: CSP is an origin list
 * ------------------------------------------------------------------------ */

test('the connect-src value is the origin of the served URL, never the whole URL', () => {
	assert.equal(
		subscriptionConnectOrigin('wss://ws.social.example.test/graphql'),
		'wss://ws.social.example.test',
		'the path is dropped: connect-src permits an origin, not a URL'
	);
	assert.equal(
		subscriptionConnectOrigin('ws://localhost:8085/socket'),
		'ws://localhost:8085',
		'a non-TLS dev socket keeps its port'
	);
});

test('a malformed or non-socket served value is the same as absent', () => {
	// Fail-closed at the security header: lesser publishing junk must not widen
	// the policy. `new URL` reports the origin of `javascript:`/`data:` as the
	// string "null" — permitting THAT is how an unchecked version of this ships.
	for (const bad of [
		null,
		undefined,
		'',
		'not a url',
		'://missing-scheme',
		'https://social.example.test/api/graphql',
		'javascript:alert(1)',
	]) {
		assert.equal(subscriptionConnectOrigin(bad), null, `${JSON.stringify(bad)} must add nothing`);
	}
});

/**
 * Face 4's transport probes.
 *
 * These drive the SHIPPED adapters in `src/lib/timelines/transport.ts` against a
 * stubbed `fetch`, so the assertions cover the whole path a screen actually
 * takes: variables onto the wire, lesser's envelope back, failure classified,
 * page projected. `tests/timeline-contract.test.mjs` covers the pure
 * projections; this file exists because M2d proved a probe that can only reach
 * those leaves a broken fetch green.
 *
 * What goes ONTO the wire is asserted as carefully as what comes back. A token
 * attached to an anonymous read, or an authenticated read that forgot one, is
 * invisible in the rendered output and visible only here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchActor, fetchTimelinePage } from '../src/lib/timelines/transport.ts';

/** Run `body` with `fetch` stubbed, returning what it produced and every request it made. */
async function withStubbedFetch(respond, body) {
	const requests = [];
	const original = globalThis.fetch;

	globalThis.fetch = async (url, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		requests.push({
			url: String(url),
			query: payload.query ?? '',
			variables: payload.variables ?? {},
			authorization: init.headers?.authorization ?? null,
		});

		const envelope = respond(payload) ?? { data: null };
		if (envelope instanceof Error) throw envelope;

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

function connection(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
	return {
		data: {
			timeline: {
				edges: nodes.map((node, index) => ({ cursor: `c${index}`, node })),
				pageInfo,
			},
		},
	};
}

function object(overrides = {}) {
	return {
		id: 'obj-1',
		content: '<p>Hello</p>',
		visibility: 'PUBLIC',
		sensitive: false,
		createdAt: '2026-07-01T10:00:00Z',
		updatedAt: '2026-07-01T10:00:00Z',
		repliesCount: 0,
		likesCount: 0,
		sharesCount: 0,
		viewerFavourited: false,
		viewerBookmarked: false,
		viewerPinned: false,
		boosted: false,
		actor: { id: 'actor-1', username: 'ada', domain: null, displayName: 'Ada' },
		attachments: [],
		tags: [],
		mentions: [],
		...overrides,
	};
}

/* ---------------------------------------------------------------------------
 * Anonymous safety — what reaches the wire, and what does not
 * ------------------------------------------------------------------------ */

test('an anonymous LOCAL read sends no Authorization header at all', async () => {
	const { value, requests } = await withStubbedFetch(
		() => connection([object()]),
		() => fetchTimelinePage({ type: 'LOCAL' })
	);

	assert.equal(value.ok, true);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].authorization, null, 'an anonymous read must carry no bearer token');
	assert.equal(requests[0].variables.type, 'LOCAL');
	assert.equal(value.page.items[0].favourited, undefined, 'and therefore no viewer state');
});

test('PUBLIC and ACTOR also read anonymously; ACTOR carries its actorId', async () => {
	const federated = await withStubbedFetch(
		() => connection([object()]),
		() => fetchTimelinePage({ type: 'PUBLIC' })
	);
	assert.equal(federated.value.ok, true);
	assert.equal(federated.requests[0].variables.type, 'PUBLIC');

	const profile = await withStubbedFetch(
		() => connection([object()]),
		() => fetchTimelinePage({ type: 'ACTOR', actorId: 'actor-1' })
	);
	assert.equal(profile.value.ok, true);
	assert.equal(profile.requests[0].variables.actorId, 'actor-1');
});

test('an anonymous HOME read never reaches the wire', async () => {
	// lesser would answer `authentication required`. Spending the round trip
	// turns a state the client knows for certain into one it has to parse out
	// of an error string.
	const { value, requests } = await withStubbedFetch(
		() => {
			throw new Error('fetch must not be called');
		},
		() => fetchTimelinePage({ type: 'HOME' })
	);

	assert.deepEqual(value, { ok: false, failure: 'auth-required' });
	assert.equal(requests.length, 0);
});

test('ACTOR without an actorId never reaches the wire either', async () => {
	const { value, requests } = await withStubbedFetch(
		() => connection([]),
		() => fetchTimelinePage({ type: 'ACTOR' })
	);
	assert.deepEqual(value, { ok: false, failure: 'unsupported' });
	assert.equal(requests.length, 0);
});

test('an authenticated HOME read sends the bearer token and keeps viewer state', async () => {
	const { value, requests } = await withStubbedFetch(
		() => connection([object({ viewerFavourited: true })]),
		() => fetchTimelinePage({ type: 'HOME', accessToken: 'token-abc' })
	);

	assert.equal(requests[0].authorization, 'Bearer token-abc');
	assert.equal(value.ok, true);
	assert.equal(value.page.items[0].favourited, true);
});

/* ---------------------------------------------------------------------------
 * Pagination
 * ------------------------------------------------------------------------ */

test('a second page forwards the previous endCursor as `after`', async () => {
	const first = await withStubbedFetch(
		() => connection([object()], { hasNextPage: true, endCursor: 'cursor-20' }),
		() => fetchTimelinePage({ type: 'LOCAL' })
	);
	assert.equal(first.value.page.endCursor, 'cursor-20');
	assert.equal(first.requests[0].variables.after, null, 'the first page sends no cursor');

	const second = await withStubbedFetch(
		() => connection([object({ id: 'obj-2' })], { hasNextPage: false, endCursor: 'cursor-40' }),
		() => fetchTimelinePage({ type: 'LOCAL', after: first.value.page.endCursor })
	);
	assert.equal(second.requests[0].variables.after, 'cursor-20');
	assert.equal(second.value.page.hasNextPage, false);
});

test('excludeAgents and mediaOnly reach lesser rather than being applied here', async () => {
	// Timeline filtering is lesser's semantics. Filtering client-side would
	// silently disagree with the cursor lesser computed.
	const { requests } = await withStubbedFetch(
		() => connection([object()]),
		() => fetchTimelinePage({ type: 'LOCAL', excludeAgents: true, mediaOnly: true })
	);
	assert.equal(requests[0].variables.excludeAgents, true);
	assert.equal(requests[0].variables.mediaOnly, true);
});

/* ---------------------------------------------------------------------------
 * Honest states — the M2d rule, at the transport boundary
 * ------------------------------------------------------------------------ */

test('a partial failure that still carried objects renders the objects, not a false empty', async () => {
	const { value } = await withStubbedFetch(
		() => ({
			data: {
				timeline: {
					edges: [{ cursor: 'c0', node: object() }],
					pageInfo: { hasNextPage: false, endCursor: 'c0' },
				},
			},
			errors: [{ message: 'moderationScore unavailable' }],
		}),
		() => fetchTimelinePage({ type: 'LOCAL' })
	);

	assert.equal(value.ok, true, 'losing a field is not losing the timeline');
	assert.equal(value.page.items.length, 1);
});

test('errors with NO connection are classified, and never shown as an empty timeline', async () => {
	const denied = await withStubbedFetch(
		() => ({ data: null, errors: [{ message: 'authentication required for this timeline type' }] }),
		() => fetchTimelinePage({ type: 'LOCAL' })
	);
	assert.deepEqual(denied.value, { ok: false, failure: 'auth-required' });

	const broken = await withStubbedFetch(
		() => ({ data: null, errors: [{ message: 'internal server error' }] }),
		() => fetchTimelinePage({ type: 'PUBLIC' })
	);
	assert.deepEqual(broken.value, { ok: false, failure: 'unavailable' });
});

test('an unreachable instance becomes `unavailable`, not an exception', async () => {
	const { value } = await withStubbedFetch(
		() => new TypeError('network unreachable'),
		() => fetchTimelinePage({ type: 'PUBLIC' })
	);
	assert.deepEqual(value, { ok: false, failure: 'unavailable' });
});

test('a genuinely empty timeline is ok:true with no items — a different screen from a failure', async () => {
	const { value } = await withStubbedFetch(
		() => connection([]),
		() => fetchTimelinePage({ type: 'LOCAL' })
	);
	assert.equal(value.ok, true);
	assert.equal(value.page.items.length, 0);
	assert.equal(value.page.hasNextPage, false);
});

/* ---------------------------------------------------------------------------
 * Actor
 * ------------------------------------------------------------------------ */

test('a profile header loads anonymously and projects lesser’s actor', async () => {
	const { value, requests } = await withStubbedFetch(
		() => ({
			data: {
				actor: {
					id: 'actor-9',
					username: 'grace',
					domain: 'remote.test',
					displayName: 'Grace',
					summary: 'Compiler',
					avatar: 'https://example.test/g.png',
					followers: 3,
					following: 1,
					statusesCount: 9,
					bot: false,
					locked: false,
					createdAt: '2026-01-01T00:00:00Z',
					isAgent: false,
				},
			},
		}),
		() => fetchActor('grace')
	);

	assert.equal(requests[0].authorization, null);
	assert.equal(requests[0].variables.username, 'grace');
	assert.equal(value.ok, true);
	assert.equal(value.actor.acct, 'grace@remote.test');
	assert.equal(value.actor.followersCount, 3);
});

test('an unknown username is `not-found`, and an unreachable instance is not', async () => {
	const missing = await withStubbedFetch(
		() => ({ data: { actor: null } }),
		() => fetchActor('nobody')
	);
	assert.deepEqual(missing.value, { ok: false, failure: 'not-found' });

	const down = await withStubbedFetch(
		() => new TypeError('network unreachable'),
		() => fetchActor('grace')
	);
	assert.deepEqual(down.value, { ok: false, failure: 'unavailable' });

	const blank = await withStubbedFetch(
		() => {
			throw new Error('fetch must not be called');
		},
		() => fetchActor('   ')
	);
	assert.deepEqual(blank.value, { ok: false, failure: 'not-found' });
	assert.equal(blank.requests.length, 0);
});

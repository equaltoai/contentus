/**
 * The activity read, driven through the SHIPPED transport (M2.4,
 * equaltoai/contentus#95).
 *
 * `fetch` is stubbed at the boundary and everything above it is the real
 * module: the real document, the real `graphqlRequest`, the real fold. That is
 * the point rather than a convenience — a client that sent the wrong document,
 * asked anonymously, or read a refusal as an empty log would stay green against
 * a hand-built fixture handed to `driverLedger`.
 *
 * The claims worth pinning here are the ones the contract inspection turned up:
 * the request is authenticated, it is GraphQL rather than the REST sibling, it
 * does not select `totalCount` (which lesser computes as the page size), and a
 * refusal is raised rather than folded into "nobody has driven this agent".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	AGENT_ACTIVITY_QUERY,
	ActivityClientError,
	loadAgentDrivers,
} from '../src/lib/agents/activity-client.ts';

/** Stub `fetch`, run, restore; returns the calls the module made. */
async function withFetch(responder, run) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		return responder(calls.length);
	};
	try {
		return { result: await run(), calls };
	} finally {
		globalThis.fetch = original;
	}
}

const ok = (payload) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});

function edge(overrides = {}) {
	return {
		node: {
			eventId: 'evt-1',
			agentUsername: 'scribe',
			action: 'agent.status.create',
			targetId: null,
			metadataJson: JSON.stringify({ delegated_by: '@ada' }),
			timestamp: '2026-08-10T12:00:00Z',
			...overrides,
		},
	};
}

const connection = (edges, hasNextPage = false) =>
	ok({ data: { agentActivity: { edges, pageInfo: { hasNextPage } } } });

/* -------------------------------------------------------------------------
 * What goes on the wire
 * ---------------------------------------------------------------------- */

test('the read is one authenticated GraphQL POST carrying the shipped document', async () => {
	const { result, calls } = await withFetch(
		() => connection([edge()]),
		() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].body.query, AGENT_ACTIVITY_QUERY);
	assert.equal(calls[0].body.variables.username, 'scribe');
	assert.equal(calls[0].init.headers.authorization, 'Bearer token-1');
	assert.equal(result.drivers[0].label, '@ada');
});

test('the document asks for the metadata this milestone exists for', () => {
	// The driving human leaves the instance only in the audit row's metadata.
	assert.ok(AGENT_ACTIVITY_QUERY.includes('metadataJson'));
	assert.ok(AGENT_ACTIVITY_QUERY.includes('hasNextPage'));
});

test('the document does not select totalCount', () => {
	// lesser assigns totalCount `len(edges)` — the size of the page it just
	// built, not a total. Selecting it would put a number in reach that means
	// something other than what its name says.
	assert.ok(!AGENT_ACTIVITY_QUERY.includes('totalCount'));
});

test('no act-as header is attached', async () => {
	// This is an owner reading their own agent's log. The act-as path was
	// removed from this client in M2.1 and nothing here reintroduces it.
	const { calls } = await withFetch(
		() => connection([edge()]),
		() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
	);
	assert.ok(!('x-lesser-act-as' in calls[0].init.headers));
});

/* -------------------------------------------------------------------------
 * A refusal is not an empty log
 * ---------------------------------------------------------------------- */

test('a GraphQL refusal is raised, carrying the instance message', async () => {
	await assert.rejects(
		() =>
			withFetch(
				() => ok({ errors: [{ message: 'not authorized to view agent activity' }] }),
				() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
			),
		(error) => {
			assert.ok(error instanceof ActivityClientError);
			assert.equal(error.message, 'not authorized to view agent activity');
			assert.equal(error.transport, false);
			return true;
		}
	);
});

test('a transport failure is raised and marked as one', async () => {
	await assert.rejects(
		() =>
			withFetch(
				() => new Response('<html>proxy error</html>', { status: 502 }),
				() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
			),
		(error) => {
			assert.ok(error instanceof ActivityClientError);
			assert.equal(error.transport, true);
			return true;
		}
	);
});

test('a thrown fetch is raised rather than becoming a driverless answer', async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new TypeError('network down');
	};
	try {
		await assert.rejects(
			() => loadAgentDrivers('scribe', { accessToken: 'token-1' }),
			ActivityClientError
		);
	} finally {
		globalThis.fetch = original;
	}
});

/* -------------------------------------------------------------------------
 * A malformed 200 lands in unavailable, never on screen
 * ---------------------------------------------------------------------- */

test('a 200 with no connection is raised', async () => {
	await assert.rejects(
		() =>
			withFetch(
				() => ok({ data: { agentActivity: null } }),
				() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
			),
		ActivityClientError
	);
});

test('a 200 whose edges are not a list is raised', async () => {
	await assert.rejects(
		() =>
			withFetch(
				() => ok({ data: { agentActivity: { edges: 'nope', pageInfo: {} } } }),
				() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
			),
		ActivityClientError
	);
});

test('one malformed edge costs that entry, not the whole screen', async () => {
	const { result } = await withFetch(
		() => connection([edge(), null, { node: null }, edge({ eventId: 'evt-2' })]),
		() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
	);
	assert.equal(result.actions.length, 2);
	assert.equal(result.drivers[0].actions, 2);
});

/* -------------------------------------------------------------------------
 * The boundary of one read reaches the ledger
 * ---------------------------------------------------------------------- */

test("lesser's hasNextPage becomes the ledger's more", async () => {
	const { result } = await withFetch(
		() => connection([edge()], true),
		() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
	);
	assert.equal(result.more, true);
});

test('an empty log is an empty ledger rather than a failure', async () => {
	const { result } = await withFetch(
		() => connection([]),
		() => loadAgentDrivers('scribe', { accessToken: 'token-1' })
	);
	assert.equal(result.actions.length, 0);
	assert.equal(result.drivers.length, 0);
	assert.equal(result.more, false);
});

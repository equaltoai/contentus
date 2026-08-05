import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DRONE_WORKFLOW_QUERY,
	fetchDroneRoster,
	hasWriteScope,
	toDroneWorkflowStatus,
} from '../src/lib/drones/contract.ts';
import {
	AUDIT_HEADERS,
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

function agent(overrides = {}) {
	return {
		id: 'https://example.invalid/users/scout',
		username: 'scout',
		displayName: 'Scout',
		bio: 'Research drone',
		agentType: 'RESEARCHER',
		agentVersion: '1.0.0',
		verified: false,
		verifiedAt: null,
		quarantineStatus: 'quarantined',
		quarantineStart: '2026-08-05T00:00:00Z',
		quarantineEnd: '2026-08-12T00:00:00Z',
		quarantineActive: true,
		createdAt: '2026-08-05T00:00:00Z',
		activityCount: 0,
		agentOwner: '@ada',
		delegatedScopes: ['read', 'write', 'follow'],
		agentCapabilities: null,
		mcpAccess: null,
		...overrides,
	};
}

async function withFetch(responder, run) {
	const original = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		const body = JSON.parse(String(init.body ?? '{}'));
		requests.push({ url: String(url), init, body });
		return new Response(JSON.stringify(await responder(body)), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	try {
		return { value: await run(), requests };
	} finally {
		globalThis.fetch = original;
	}
}

test('the roster is myAgents, with optional workflow status for each returned drone', async () => {
	const { value, requests } = await withFetch(
		({ query, variables }) => {
			if (query.includes('ContentusMyAgents')) return { data: { myAgents: [agent()] } };
			if (query.includes('ContentusDroneWorkflow')) {
				assert.deepEqual(variables, { username: 'scout' });
				return {
					data: {
						droneWorkflow: {
							username: 'scout',
							currentPhase: 'DRONE',
							currentState: 'UNSOULED',
							identitySemantics: {
								identityLabel: 'Drone',
								lifecycleState: 'drone',
								soulBindingState: 'UNBOUND',
							},
						},
					},
				};
			}
			assert.fail(`unexpected operation: ${query}`);
		},
		() => fetchDroneRoster({ accessToken: 'owner-token' })
	);

	assert.equal(value.ok, true);
	assert.equal(value.drones.length, 1);
	assert.equal(value.drones[0].agent.username, 'scout');
	assert.equal(value.drones[0].workflow.currentState, 'UNSOULED');
	assert.equal(value.drones[0].workflowUnavailable, false);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.init.headers.authorization, 'Bearer owner-token');
	}
});

test('a failed optional workflow read never erases the myAgents roster', async () => {
	const { value } = await withFetch(
		({ query }) => {
			if (query.includes('ContentusMyAgents')) return { data: { myAgents: [agent()] } };
			return { data: { droneWorkflow: null }, errors: [{ message: 'workflow unavailable' }] };
		},
		() => fetchDroneRoster({ accessToken: 'owner-token' })
	);

	assert.equal(value.ok, true);
	assert.equal(value.drones.length, 1);
	assert.equal(value.drones[0].workflow, null);
	assert.equal(value.drones[0].workflowUnavailable, true);
});

test('the workflow projection uses lesser state verbatim', () => {
	assert.match(DRONE_WORKFLOW_QUERY, /droneWorkflow\(username: \$username\)/);
	assert.deepEqual(
		toDroneWorkflowStatus({
			username: 'scout',
			currentPhase: 'GRADUATING',
			currentState: 'REVIEW',
			identitySemantics: {
				identityLabel: 'Graduating drone',
				lifecycleState: 'graduating',
				soulBindingState: 'PENDING',
			},
		}),
		{
			username: 'scout',
			currentPhase: 'GRADUATING',
			currentState: 'REVIEW',
			identityLabel: 'Graduating drone',
			lifecycleState: 'graduating',
			soulBindingState: 'PENDING',
		}
	);
});

test('the route requires the broad write scope', () => {
	assert.equal(hasWriteScope('read write follow'), true);
	assert.equal(hasWriteScope('read write:accounts follow'), false);
	assert.equal(hasWriteScope('read follow'), false);
});

test('the /drones server render reads no owned data', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		() => assert.fail('the drones server pass must not make a GraphQL request'),
		() => renderRoute(handler, route('drones'))
	);

	assert.equal(requests.length, 0);
	assert.equal(value.status, 200);
	assert.match(value.html, /Sign in to manage drones/);
	assert.ok(!value.html.includes('scout'));
	assert.equal(value.headers['cache-control'], 'no-store');
	assert.equal(value.headers['x-robots-tag'], 'noindex, nofollow');
});

test('an inbound credential is never forwarded or serialized by /drones SSR', async () => {
	const handler = await loadHandler();
	const marker = 'server-must-not-read-this-token';
	const { value, requests } = await withStubbedGraphql(
		() => assert.fail('an inbound credential must not make /drones fetch'),
		() =>
			renderRoute(handler, {
				...route('drones'),
				headers: { ...AUDIT_HEADERS, authorization: `Bearer ${marker}` },
			})
	);

	assert.equal(requests.length, 0);
	assert.ok(!value.html.includes(marker));
});

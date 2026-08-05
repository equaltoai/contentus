import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile } from 'svelte/compiler';

import { sourceIdentifiers } from '../scripts/lib/module-imports.mjs';
import {
	DRONE_WORKFLOW_QUERY,
	delegateToDrone,
	fetchDroneRegistrationPolicy,
	fetchDroneRoster,
	hasWriteScope,
	toDroneWorkflowStatus,
	validateDroneCreation,
} from '../src/lib/drones/contract.ts';
import {
	AUDIT_HEADERS,
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

const PERSISTENCE_SINKS = new Set(['localStorage', 'pushState', 'sessionStorage', 'setItem']);

function persistenceSinks(file, source) {
	const executable = compile(source, { filename: file, generate: 'client' }).js.code;
	return sourceIdentifiers(executable)
		.filter((name) => PERSISTENCE_SINKS.has(name))
		.toSorted();
}

function assertNoPersistenceSinks(file, source) {
	assert.deepEqual(persistenceSinks(file, source), [], `${file} contains a persistence sink`);
}

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

test('valid creation details become the exact delegateToAgent input', () => {
	const validation = validateDroneCreation({
		username: ' scout_1 ',
		displayName: ' Scout ',
		bio: ' Finds primary sources. ',
		agentType: 'RESEARCHER',
		scopes: ['read', 'write', 'follow', 'read'],
	});

	assert.equal(validation.ok, true);
	assert.deepEqual(validation.input, {
		agentUsername: 'scout_1',
		displayName: 'Scout',
		bio: 'Finds primary sources.',
		scopes: ['read', 'write', 'follow'],
		agentType: 'RESEARCHER',
		agentVersion: '1.0.0',
		version: '1.0.0',
	});
});

test('creation validation mirrors lesser username and UTF-8 byte limits', () => {
	const validation = validateDroneCreation({
		username: '@not-an-agent',
		displayName: 'é'.repeat(16),
		bio: 'é'.repeat(251),
		agentType: 'ASSISTANT',
		scopes: [],
	});

	assert.equal(validation.ok, false);
	assert.deepEqual(Object.keys(validation.errors).sort(), [
		'bio',
		'displayName',
		'scopes',
		'username',
	]);
	assert.equal(validation.input, null);
});

test('delegateToAgent returns a one-time credential bundle without changing it', async () => {
	const input = validateDroneCreation({
		username: 'scout',
		displayName: 'Scout',
		bio: '',
		agentType: 'ASSISTANT',
		scopes: ['read', 'write', 'follow'],
	}).input;
	const { value, requests } = await withFetch(
		({ query }) => {
			assert.match(query, /delegateToAgent\(input: \$input\)/);
			return {
				data: {
					delegateToAgent: {
						agent: { username: 'scout', displayName: 'Scout' },
						accessToken: 'access-secret',
						refreshToken: 'refresh-secret',
						tokenType: 'Bearer',
						scope: 'read write follow',
						createdAt: '2026-08-05T12:00:00Z',
						expiresIn: 3600,
					},
				},
			};
		},
		() => delegateToDrone({ accessToken: 'owner-token' }, input)
	);

	assert.equal(value.ok, true);
	assert.equal(value.credentials.accessToken, 'access-secret');
	assert.equal(value.credentials.refreshToken, 'refresh-secret');
	assert.deepEqual(requests[0].body.variables, { input });
	assert.equal(requests[0].init.headers.authorization, 'Bearer owner-token');
});

test('registration-disabled errors become the designed policy state', async () => {
	const input = validateDroneCreation({
		username: 'scout',
		displayName: 'Scout',
		bio: '',
		agentType: 'ASSISTANT',
		scopes: ['read'],
	}).input;
	const { value } = await withFetch(
		() => ({ errors: [{ message: 'agent registration is disabled by instance policy' }] }),
		() => delegateToDrone({ accessToken: 'owner-token' }, input)
	);

	assert.deepEqual(value, {
		ok: false,
		failure: {
			reason: 'policy-disabled',
			message: 'This instance does not currently allow new drone registration.',
		},
	});
});

test('admin-readable policy disables the form, while an unreadable policy stays unknown', async () => {
	const disabled = await withFetch(
		() => ({
			data: { adminAgentPolicy: { allowAgents: true, allowAgentRegistration: false } },
		}),
		() => fetchDroneRegistrationPolicy({ accessToken: 'admin-token' })
	);
	assert.equal(disabled.value, 'disabled');

	const unreadable = await withFetch(
		() => ({ errors: [{ message: 'not authorized to view agent policy' }] }),
		() => fetchDroneRegistrationPolicy({ accessToken: 'writer-token' })
	);
	assert.equal(unreadable.value, 'unknown');
});

test('the /drones/new server render never contains credentials or private GraphQL data', async () => {
	const handler = await loadHandler();
	const marker = 'credential-must-never-reach-ssr';
	const { value, requests } = await withStubbedGraphql(
		() => assert.fail('the creation server pass must not make a GraphQL request'),
		() =>
			renderRoute(handler, {
				...route('drone-new'),
				headers: { ...AUDIT_HEADERS, authorization: `Bearer ${marker}` },
			})
	);

	assert.equal(requests.length, 0);
	assert.equal(value.status, 200);
	assert.match(value.html, /Sign in to create a drone/);
	assert.ok(!value.html.includes(marker));
	assert.ok(!value.html.includes('accessToken'));
	assert.equal(value.headers['cache-control'], 'no-store');
	assert.equal(value.headers['x-robots-tag'], 'noindex, nofollow');
});

test('the client renders policy-disabled and one-time credential states without persistence', () => {
	const flow = readFileSync('src/lib/drones/DroneCreationFlow.svelte', 'utf8');
	const policy = readFileSync('src/lib/drones/DronePolicyDisabled.svelte', 'utf8');
	const credentials = readFileSync('src/lib/drones/DroneCredentials.svelte', 'utf8');

	assert.match(flow, /policy === 'disabled'/);
	assert.match(flow, /<DronePolicyDisabled/);
	assert.match(policy, /This instance is not accepting new drones/);
	assert.match(policy, /href=\{href\('\/drones'\)\}/);
	assert.match(credentials, /only time Contentus will show the OAuth tokens/);
	assert.match(credentials, /dismiss permanently/);
	assertNoPersistenceSinks('DroneCreationFlow.svelte', flow);
	assertNoPersistenceSinks('DroneCredentials.svelte', credentials);
	assert.match(flow, /credentials = null/);
	assert.match(flow, /scope\.holds\(stamp\)/);
});

test('the persistence check sees a live sink between HTML-comment-shaped strings', () => {
	const fixture = `<script>
		const opener = '<!--';
		sessionStorage.setItem('drone_tokens', 'must-be-detected');
		const closer = '-->';
	</script>`;

	assert.throws(
		() => assertNoPersistenceSinks('PersistenceFixture.svelte', fixture),
		/sessionStorage.*setItem/s
	);
});

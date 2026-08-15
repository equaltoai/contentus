import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSchema, parse, validate } from 'graphql';

import {
	main,
	plan,
	readOptions,
	redactingAll,
	VIEWER_IDENTITY_QUERY,
} from '../scripts/probe-share-flow.mjs';

/**
 * THE END-TO-END SHARE FLOW PROBE'S OWN CONTRACT.
 *
 * The probe walks a flow whose two middle steps WRITE to a real instance, and
 * whose whole value is that it reports what it actually established rather than
 * what it attempted. Both of those are properties that only a test can hold it
 * to: a live run against a healthy instance exercises the happy path, which is
 * the one path that is green whether or not the claims are honest.
 *
 * NO REAL CREDENTIAL APPEARS IN THIS FILE. The three tokens are MARKERS — strings
 * whose only job is to be recognisable in output and in a request. Planting a real
 * secret to prove it is hidden builds exactly what the secret sweep forbids, and
 * proves less, because a marker can be asserted on directly.
 *
 * THE FAKE INSTANCE IS STATEFUL. The share list it serves changes when the probe
 * writes to it, so the happy path is a coherent sequence rather than a row of
 * fixtures that agree with each other. A static fake would pass a probe that
 * granted and never revoked.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const OWNER_MARKER = 'contentus-owner-marker-not-a-credential-0000';
const GRANTEE_MARKER = 'contentus-grantee-marker-not-a-credential-1111';
const MCP_MARKER = 'contentus-mcp-marker-not-a-credential-2222';

const BASE = 'https://instance.invalid';
const AGENT = 'scribe';
const GRANTEE = 'ada';
const MCP_URL = 'https://api.instance.invalid/mcp/scribe';

const ARGS = ['--base', BASE, '--agent', AGENT, '--grantee', GRANTEE, '--execute'];

const ENV = {
	CONTENTUS_OWNER_TOKEN: OWNER_MARKER,
	CONTENTUS_GRANTEE_TOKEN: GRANTEE_MARKER,
};

const ENV_WITH_MCP = { ...ENV, CONTENTUS_GRANTEE_MCP_TOKEN: MCP_MARKER };

/** Collects everything the probe writes, so assertions read what a human would. */
function collector() {
	const chunks = [];
	return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

const json = (body, status = 200, headers = {}) => ({
	status,
	ok: status < 400,
	headers: { get: (name) => headers[name.toLowerCase()] ?? null },
	text: async () => JSON.stringify(body),
});

/**
 * A lesser whose share list really changes when the probe writes to it.
 *
 * `overrides` replaces one behaviour by name; everything else stays healthy, so
 * each case says only what it is about. Requests are logged so a test can assert
 * on what was sent — including, for the abort cases, that nothing was.
 */
function instance(overrides = {}) {
	const state = {
		grants: [],
		revokedMcp: false,
		log: [],
		...(overrides.state ?? {}),
	};

	const answer = {
		viewerOwner: () => json({ data: { viewer: { id: 'actor-owner', username: 'owner' } } }),
		viewerGrantee: () => json({ data: { viewer: { id: 'actor-grantee', username: GRANTEE } } }),
		shareList: () => json({ grants: state.grants }),
		sharedWithMe: () =>
			json({ grants: state.grants.filter((grant) => grant.grantee_username === GRANTEE) }),
		grant: () => {
			const existing = state.grants.find((entry) => entry.grantee_username === GRANTEE);
			const created = {
				agent_username: AGENT,
				grantee_username: GRANTEE,
				active: true,
				granted_at: '2026-08-14T12:00:00Z',
				granted_by: 'owner',
			};
			if (existing) Object.assign(existing, created);
			else state.grants.push(created);
			return json(created);
		},
		revoke: () => {
			const existing = state.grants.find((entry) => entry.grantee_username === GRANTEE);
			if (existing) {
				existing.active = false;
				existing.revoked_at = '2026-08-14T12:30:00Z';
				existing.revoked_by = 'owner';
			}
			state.revokedMcp = true;
			return json({ ...existing, active: false });
		},
		mcpAccess: () =>
			json({
				data: {
					agent: {
						mcpAccess: {
							mcpURL: MCP_URL,
							protectedResourceURL:
								'https://api.instance.invalid/.well-known/oauth-protected-resource/mcp/scribe',
							authorizationServerURL: 'https://instance.invalid',
							registrationURL: 'https://instance.invalid/oauth/register',
							scopes: ['read', 'write'],
							guidance: null,
						},
					},
				},
			}),
		discovery: () => json({ name: 'lesser', tools: [{ name: 'post_status' }] }),
		protectedResource: () =>
			json({
				resource: MCP_URL,
				authorization_servers: ['https://instance.invalid'],
				scopes_supported: ['read', 'write'],
			}),
		mcpAnonymous: () =>
			json({ error: { message: 'authentication required' } }, 401, {
				'www-authenticate': `Bearer resource_metadata="${MCP_URL}"`,
			}),
		mcpAuthorized: () =>
			state.revokedMcp
				? json({ error: { message: 'access revoked' } }, 401)
				: json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'post_status' }] } }),
		activity: () =>
			json({
				data: {
					agentActivity: {
						edges: [
							{
								node: {
									eventId: 'evt-1',
									agentUsername: AGENT,
									action: 'agent.status.create',
									targetId: 'status-1',
									metadataJson: JSON.stringify({ delegated_by: `@${GRANTEE}` }),
									timestamp: '2026-08-14T12:15:00Z',
								},
							},
						],
						pageInfo: { hasNextPage: false },
					},
				},
			}),
		...overrides,
	};

	const fetchImpl = async (url, init = {}) => {
		const method = init.method ?? 'GET';
		const target = new URL(url);
		const auth = init.headers?.authorization ?? null;
		state.log.push({ method, url, auth, body: init.body ?? null });

		if (target.pathname === '/api/graphql') {
			const body = JSON.parse(init.body);
			const operation = body.query.match(/\b(query|mutation)\s+(\w+)/)?.[2] ?? null;
			if (operation === 'ContentusShareFlowViewerIdentity') {
				return auth === `Bearer ${OWNER_MARKER}`
					? answer.viewerOwner(body)
					: answer.viewerGrantee(body);
			}
			if (operation === 'ContentusAgentMcpAccess') return answer.mcpAccess(body);
			if (operation === 'ContentusAgentActivity') return answer.activity(body);
			throw new Error(`the harness does not know the operation ${operation}`);
		}

		if (target.pathname.startsWith('/api/v1/agents')) {
			const path = target.pathname.slice('/api/v1/agents'.length);
			if (path === '/shared-with-me') return answer.sharedWithMe();
			if (method === 'GET' && path === `/${AGENT}/share`) return answer.shareList();
			if (method === 'PUT') return answer.grant();
			if (method === 'DELETE') return answer.revoke();
			throw new Error(`the harness does not know ${method} ${path}`);
		}

		if (target.pathname === '/.well-known/mcp.json') return answer.discovery();
		if (target.pathname.startsWith('/.well-known/oauth-protected-resource'))
			return answer.protectedResource();
		if (url === MCP_URL) return auth ? answer.mcpAuthorized() : answer.mcpAnonymous();

		throw new Error(`the harness does not know ${method} ${url}`);
	};

	return { fetchImpl, state };
}

const run = (args, env, overrides, out) =>
	main(args, { fetchImpl: instance(overrides).fetchImpl, env, write: out.write });

/* =========================================================================
 * It sends nothing unless it is told to
 * ====================================================================== */

test('a dry run makes no request at all', async () => {
	// The default has to be inert: two of this flow's steps WRITE, so a probe
	// that ran on invocation would mutate an instance's access grants because
	// somebody was reading the help.
	const out = collector();
	const status = await main(['--base', BASE, '--agent', AGENT, '--grantee', GRANTEE], {
		fetchImpl: () => {
			throw new Error('a dry run must not send anything');
		},
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /DRY RUN — nothing is sent/);
	assert.match(out.text(), /PUT \/api\/v1\/agents\/scribe\/share\/ada/);
	assert.match(out.text(), /DELETE \/api\/v1\/agents\/scribe\/share\/ada/);
});

test('the dry run names every step and says which it would not prove', async () => {
	const out = collector();
	await main(['--base', BASE, '--agent', AGENT, '--grantee', GRANTEE], {
		fetchImpl: () => {
			throw new Error('a dry run must not send anything');
		},
		env: ENV,
		write: out.write,
	});

	const steps = plan({ agent: AGENT, grantee: GRANTEE, granteeMcpToken: null, attribution: true });
	for (const step of steps) {
		assert.ok(out.text().includes(step.what), `the plan omitted "${step.what}"`);
	}
	// Without an MCP credential the drive and the fail-closed check are the
	// operator's; the dry run must say so before the operator plans the session.
	assert.match(out.text(), /4 would be left to the operator's own record/);
	assert.match(out.text(), /Set CONTENTUS_GRANTEE_MCP_TOKEN/);
});

test('supplying an MCP credential moves two steps from ATTEST to CHECK', () => {
	const without = plan({
		agent: AGENT,
		grantee: GRANTEE,
		granteeMcpToken: null,
		attribution: true,
	});
	const with_ = plan({
		agent: AGENT,
		grantee: GRANTEE,
		granteeMcpToken: MCP_MARKER,
		attribution: true,
	});

	const attested = (steps) => steps.filter((step) => step.kind === 'attest').map((step) => step.id);
	assert.deepEqual(attested(without), ['mint', 'drive', 'recorded-action', 'fail-closed']);
	assert.deepEqual(attested(with_), ['mint', 'recorded-action']);
});

/* =========================================================================
 * It refuses to revoke access nobody asked it to remove
 * ====================================================================== */

test('a grantee who already holds access aborts the run BEFORE anything is written', async () => {
	// The flow ends by revoking, which is only safe because the grant is the one
	// this run created. A standing grant would be destroyed by a probe somebody
	// ran to check a milestone.
	const out = collector();
	const fake = instance({
		state: {
			grants: [{ agent_username: AGENT, grantee_username: GRANTEE, active: true }],
		},
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] preflight/);
	assert.match(out.text(), /ALREADY holds active access/);
	assert.match(out.text(), /Nothing was written/);

	const writes = fake.state.log.filter(
		(entry) => entry.method === 'PUT' || entry.method === 'DELETE'
	);
	assert.deepEqual(writes, [], 'the abort must happen before any write');
});

test('an unclassified share entry aborts too, rather than guessing the grantee holds nothing', async () => {
	// `accessLedger` files an entry with no `active` boolean under neither list.
	// Reading that as "the grantee holds no access" would put the guarantee above
	// on a guess about the one entry that could be theirs.
	const out = collector();
	const fake = instance({
		state: { grants: [{ agent_username: AGENT, grantee_username: 'someone' }] },
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /without marking them active or revoked/);
	assert.deepEqual(
		fake.state.log.filter((entry) => entry.method === 'PUT'),
		[]
	);
});

test('two credentials for one account abort before writing', async () => {
	const out = collector();
	const fake = instance({
		viewerGrantee: () => json({ data: { viewer: { id: 'actor-owner', username: 'owner' } } }),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /same account/);
	assert.deepEqual(
		fake.state.log.filter((entry) => entry.method === 'PUT'),
		[]
	);
});

test('a grantee credential belonging to someone else aborts before writing', async () => {
	// Otherwise the run grants access to @ada and checks @someone-else's view,
	// and every later step is about a different pair of accounts than the grant.
	const out = collector();
	const fake = instance({
		viewerGrantee: () => json({ data: { viewer: { id: 'actor-other', username: 'other' } } }),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /belongs to @other, not the --grantee @ada/);
	assert.deepEqual(
		fake.state.log.filter((entry) => entry.method === 'PUT'),
		[]
	);
});

/* =========================================================================
 * The happy path — so every red above is not vacuous
 * ====================================================================== */

test('the whole flow passes against a healthy instance, and says what it did not prove', async () => {
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 0, out.text());
	for (const id of [
		'owner-identity',
		'grantee-identity',
		'preflight',
		'share',
		'owner-sees-grant',
		'grantee-sees-agent',
		'grantee-reads-endpoint',
		'discovery',
		'protected-resource',
		'mcp-refuses-anonymous',
		'attribution',
		'revoke',
		'owner-sees-revocation',
		'grantee-loses-agent',
	]) {
		assert.match(
			out.text(),
			new RegExp(`\\[PASS\\] ${id}\\b`),
			`${id} did not pass:\n${out.text()}`
		);
	}

	// The steps this process did NOT check are counted apart and named, because
	// an omitted gate reads as a passed gate to anyone skimming a report.
	assert.match(out.text(), /14\/14 checked steps passed/);
	assert.match(out.text(), /4 steps THIS RUN DID NOT PROVE/);
	assert.match(out.text(), /mints an MCP credential/);

	// And the grant it created is gone.
	assert.equal(fake.state.grants[0].active, false);
});

test('with an MCP credential the drive and the fail-closed check are really checked', async () => {
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, {
		fetchImpl: fake.fetchImpl,
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /\[PASS\] drive/);
	assert.match(out.text(), /\[PASS\] fail-closed/);
	assert.match(out.text(), /16\/16 checked steps passed/);
	assert.match(out.text(), /2 steps THIS RUN DID NOT PROVE/);
});

test('the drive is read-only: initialize and tools/list, nothing else', async () => {
	// A probe that called a mutating tool would change an instance to prove a
	// session, which is a cost nobody asked it to impose.
	const fake = instance();
	await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	const methods = fake.state.log
		.filter((entry) => entry.url === MCP_URL)
		.map((entry) => JSON.parse(entry.body).method);
	assert.deepEqual(methods, ['initialize', 'initialize', 'tools/list', 'tools/list']);
});

test('the only writes the probe ever sends are the two share routes', async () => {
	const fake = instance();
	await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	const writes = fake.state.log
		.filter((entry) => entry.method !== 'GET' && new URL(entry.url).pathname.startsWith('/api/v1/'))
		.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`);
	assert.deepEqual(writes, [
		'PUT /api/v1/agents/scribe/share/ada',
		'DELETE /api/v1/agents/scribe/share/ada',
	]);
});

test('every GraphQL document the probe sends is a query, never a mutation', async () => {
	// The writes on this flow are lesser's REST management plane by design. A
	// mutation reaching the CMS data plane would be a state change nobody asked
	// for, and the property is checked over the DOCUMENTS actually sent rather
	// than over the file's prose.
	const fake = instance();
	await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	const documents = fake.state.log
		.filter((entry) => new URL(entry.url).pathname === '/api/graphql')
		.map((entry) => JSON.parse(entry.body).query);
	assert.ok(documents.length >= 4, 'the probe must have sent its documents');
	for (const document of [...documents, VIEWER_IDENTITY_QUERY]) {
		for (const definition of parse(document).definitions) {
			assert.equal(definition.operation, 'query');
		}
	}
});

/* =========================================================================
 * Every step bites
 * ====================================================================== */

test('a rejected owner credential fails before the flow starts', async () => {
	const out = collector();
	const fake = instance({
		viewerOwner: () => json({ errors: [{ message: 'authentication required' }] }, 401),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] owner-identity/);
	assert.equal(fake.state.log.length, 1, 'nothing may be read after the identity check fails');
});

test('a token treated as anonymous — 200 with a null viewer — also fails', async () => {
	// lesser's auth surface may hand an invalid bearer to the anonymous path
	// rather than refusing it, which is the shape a naive ok-check misses.
	const out = collector();
	const status = await run(ARGS, ENV, { viewerOwner: () => json({ data: { viewer: null } }) }, out);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] owner-identity/);
});

test('a refused share fails the run and leaves nothing behind', async () => {
	const out = collector();
	const fake = instance({ grant: () => json({ error: 'forbidden' }, 403) });
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] share — HTTP 403/);
	assert.deepEqual(fake.state.grants, []);
});

test('a grant lesser accepts but does not return as active fails', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{ grant: () => json({ agent_username: AGENT, grantee_username: GRANTEE, active: false }) },
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /did not return it as active/);
});

test('a grantee who cannot see the shared agent fails the run', async () => {
	const out = collector();
	const status = await run(ARGS, ENV, { sharedWithMe: () => json({ grants: [] }) }, out);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] grantee-sees-agent/);
});

test('an instance publishing no MCP endpoint fails, and says it is a served answer', async () => {
	// `mcpURL: ''` is lesser STATING it publishes nothing here, which is a
	// different sentence from a read that failed. The probe must not collapse them.
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{
			mcpAccess: () =>
				json({ data: { agent: { mcpAccess: { mcpURL: '', protectedResourceURL: '' } } } }),
		},
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /publishes no MCP endpoint/);
	assert.match(out.text(), /served answer, not a transport failure/);
});

test('a protected-resource document naming no authorization server fails', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{ protectedResource: () => json({ resource: MCP_URL, authorization_servers: [] }) },
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /nowhere to authorize/);
});

test('an MCP endpoint that answers an ANONYMOUS initialize fails the whole run', async () => {
	// The negative control. Without it a green run proves the endpoint answers,
	// not that it gates — and "the grantee could connect" would mean nothing.
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{ mcpAnonymous: () => json({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) },
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] mcp-refuses-anonymous/);
	assert.match(out.text(), /not gated and the whole flow proves nothing/);
});

test('a 500 from the anonymous initialize is not read as a refusal', async () => {
	// Only 401 and 403 are lesser declining to serve an unauthenticated caller.
	// An instance that is merely broken must not be certified as gated.
	const out = collector();
	const status = await run(ARGS, ENV, { mcpAnonymous: () => json({ error: 'boom' }, 500) }, out);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] mcp-refuses-anonymous/);
});

test('a revocation that leaves the grant active fails', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{ revoke: () => json({ agent_username: AGENT, grantee_username: GRANTEE, active: true }) },
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /did not return the grant as inactive/);
});

test('a grantee still holding the agent after revocation fails', async () => {
	const out = collector();
	// The revocation itself is left to the real, state-mutating fake, so the
	// owner's side really does go through. Only the grantee's list lies.
	const status = await run(
		ARGS,
		ENV,
		{
			sharedWithMe: () =>
				json({ grants: [{ agent_username: AGENT, grantee_username: GRANTEE, active: true }] }),
		},
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] grantee-loses-agent/);
});

test('an MCP credential that still works after revocation fails the run', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV_WITH_MCP,
		{ mcpAuthorized: () => json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) },
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] fail-closed/);
	assert.match(out.text(), /access outlived the grant/);
});

/* =========================================================================
 * Attribution is matched on identity, not on spelling
 * ====================================================================== */

test('the grantee is found whether lesser wrote @Ada or ada', async () => {
	// lesser writes the same human as `@Ada` on a delegated-token row and `ada`
	// on an act-as-only row. A probe comparing strings would miss half the
	// evidence, which is why the match goes through the app's own reader.
	for (const metadata of [
		{ delegated_by: `@${GRANTEE}` },
		{ acted_by: GRANTEE },
		{ delegated_by: '@Ada' },
		{ acted_by: 'ADA' },
	]) {
		const out = collector();
		const status = await run(
			ARGS,
			ENV,
			{
				activity: () =>
					json({
						data: {
							agentActivity: {
								edges: [
									{
										node: {
											eventId: 'evt-1',
											agentUsername: AGENT,
											action: 'agent.status.create',
											targetId: null,
											metadataJson: JSON.stringify(metadata),
											timestamp: '2026-08-14T12:15:00Z',
										},
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					}),
			},
			out
		);
		assert.equal(status, 0, `${JSON.stringify(metadata)} was not matched:\n${out.text()}`);
		assert.match(out.text(), /\[PASS\] attribution/);
	}
});

test('an activity log naming somebody else fails, and says what it is waiting for', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{
			activity: () =>
				json({
					data: {
						agentActivity: {
							edges: [
								{
									node: {
										eventId: 'evt-1',
										agentUsername: AGENT,
										action: 'agent.status.create',
										targetId: null,
										metadataJson: JSON.stringify({ delegated_by: '@someone-else' }),
										timestamp: '2026-08-14T12:15:00Z',
									},
								},
							],
							pageInfo: { hasNextPage: false },
						},
					},
				}),
		},
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] attribution/);
	assert.match(out.text(), /probe's own drive is read-only and writes no row/);
});

test('an empty activity log fails rather than reading as nobody drove it', async () => {
	const out = collector();
	const status = await run(
		ARGS,
		ENV,
		{
			activity: () =>
				json({ data: { agentActivity: { edges: [], pageInfo: { hasNextPage: false } } } }),
		},
		out
	);
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] attribution/);
});

test('--no-attribution passes but names the claim the run gave up', async () => {
	// The opt-out is allowed and it is VISIBLE. A weaker run that printed the
	// same summary as a full one would be the omission reading as a pass.
	const out = collector();
	const status = await main([...ARGS, '--no-attribution'], {
		fetchImpl: instance({ activity: () => json({ data: { agentActivity: { edges: [] } } }) })
			.fetchImpl,
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(
		out.text(),
		/--no-attribution — the grantee was NOT checked against the activity log/
	);
	assert.ok(!/\[PASS\] attribution/.test(out.text()), 'a skipped step must not print as a pass');
});

/* =========================================================================
 * A failed run never leaves a grant behind
 * ====================================================================== */

test('a failure after the share still revokes the grant the run created', async () => {
	// Otherwise a red run is also an access leak, and the operator has to know to
	// go and clean up after a probe they ran to check a milestone.
	const out = collector();
	const fake = instance({ mcpAccess: () => json({ errors: [{ message: 'nope' }] }, 422) });
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /CLEANUP — revoking the grant this run created/);
	assert.equal(fake.state.grants[0].active, false, 'the grant must not survive a failed run');
});

test('a cleanup that itself fails says the access may still stand', async () => {
	const out = collector();
	const fake = instance({
		mcpAccess: () => json({ errors: [{ message: 'nope' }] }, 422),
		revoke: () => json({ error: 'gone' }, 500),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /MAY STILL HOLD ACCESS/);
	assert.match(out.text(), /Revoke it by hand/);
});

test('a probe that throws mid-flow is a failure, not a clean tally', async () => {
	// A body that fails while being READ throws past the transport helpers'
	// own try, which is the path the outer catch exists for. It must still be a
	// non-zero run AND must still clean up the grant.
	const out = collector();
	const fake = instance({
		mcpAccess: () => ({
			status: 200,
			ok: true,
			headers: { get: () => null },
			text: async () => {
				throw new Error('the connection died mid-body');
			},
		}),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] run — the probe threw/);
	assert.equal(fake.state.grants[0].active, false);
});

/* =========================================================================
 * The credentials never leave
 * ====================================================================== */

test('a hostile instance echoing any of the three tokens cannot get it into the output', async () => {
	for (const marker of [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]) {
		const out = collector();
		await main(ARGS, {
			fetchImpl: instance({
				viewerOwner: () => json({ errors: [{ message: `bearer ${marker} was rejected` }] }, 401),
			}).fetchImpl,
			env: ENV_WITH_MCP,
			write: out.write,
		});
		assert.ok(!out.text().includes(marker), `${marker} reached the output:\n${out.text()}`);
		assert.match(out.text(), /«redacted»/);
	}
});

test('a token reflected in data, an exception or a non-JSON body is redacted too', async () => {
	for (const hostile of [
		() =>
			instance({
				shareList: () => json({ grants: [], note: OWNER_MARKER }),
			}).fetchImpl,
		() => async () => {
			throw new Error(`connect failed while sending ${GRANTEE_MARKER}`);
		},
		() => async () => ({
			status: 200,
			ok: true,
			headers: { get: () => null },
			text: async () => `not json ${MCP_MARKER}`,
		}),
	]) {
		const out = collector();
		await main(ARGS, { fetchImpl: hostile(), env: ENV_WITH_MCP, write: out.write });
		for (const marker of [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]) {
			assert.ok(!out.text().includes(marker), `${marker} reached the output:\n${out.text()}`);
		}
	}
});

test('tokens go in bearer headers and appear in no URL and no request body', async () => {
	const fake = instance();
	await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	for (const entry of fake.state.log) {
		for (const marker of [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]) {
			assert.ok(!entry.url.includes(marker), 'a URL lands in logs and proxies');
			assert.ok(!String(entry.body ?? '').includes(marker), 'a body is echoed by error paths');
		}
	}
	// And each credential really is the one used for its own steps.
	const shareGet = fake.state.log.find((e) => e.method === 'PUT');
	assert.equal(shareGet.auth, `Bearer ${OWNER_MARKER}`);
	const sharedWithMe = fake.state.log.find((e) => e.url.endsWith('/shared-with-me'));
	assert.equal(sharedWithMe.auth, `Bearer ${GRANTEE_MARKER}`);
	const drive = fake.state.log.find((e) => e.url === MCP_URL && e.auth);
	assert.equal(drive.auth, `Bearer ${MCP_MARKER}`);
});

test('the anonymous negative control really is anonymous', async () => {
	// If it carried a bearer it would prove nothing about an unauthenticated
	// caller, and the control would be certifying the gate it was meant to test.
	const fake = instance();
	await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	const first = fake.state.log.find((entry) => entry.url === MCP_URL);
	assert.equal(first.auth, null, 'the control must send no credential');
});

test('the redactor knows every token and refuses to be a formality', () => {
	const chunks = [];
	const say = redactingAll((text) => chunks.push(text), [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]);
	say(`raw ${OWNER_MARKER}`);
	say(`encoded ${encodeURIComponent(GRANTEE_MARKER)}`);
	say(`base64 ${Buffer.from(MCP_MARKER).toString('base64')}`);
	const text = chunks.join('\n');
	for (const marker of [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]) {
		assert.ok(!text.includes(marker));
	}
	assert.equal(text.match(/«redacted»/g).length, 3);

	// With nothing to redact nothing is mangled, and a null in the list is not a
	// secret. Bound to a name rather than called as `redactingAll(…)(…)`: the
	// call-of-a-call is a shape CON-5's closure walk cannot follow, and the honest
	// repair is to stop writing code it cannot read rather than to disclose past
	// it — a disclosure is a count of what a reading missed, not a licence to add
	// to the count.
	const plain = [];
	const plainly = redactingAll((text) => plain.push(text), [null, undefined, '']);
	plainly('untouched output');
	assert.deepEqual(plain, ['untouched output']);
});

/* =========================================================================
 * Input handling
 * ====================================================================== */

test('a non-https base is refused before a credential could leave over plaintext', async () => {
	for (const argv of [
		['--base', 'http://instance.invalid', '--agent', AGENT, '--grantee', GRANTEE, '--execute'],
		['--base', 'not-a-url', '--agent', AGENT, '--grantee', GRANTEE, '--execute'],
		['--agent', AGENT, '--grantee', GRANTEE, '--execute'],
	]) {
		const out = collector();
		const status = await main(argv, {
			fetchImpl: () => {
				throw new Error('no request may be made');
			},
			env: ENV_WITH_MCP,
			write: out.write,
		});
		assert.equal(status, 1, out.text());
		assert.ok(!out.text().includes(OWNER_MARKER));
	}
});

test('--execute without both credentials is refused, and says which is missing', () => {
	const options = readOptions(ARGS, { CONTENTUS_OWNER_TOKEN: OWNER_MARKER });
	assert.ok(options.problems.some((problem) => /CONTENTUS_GRANTEE_TOKEN/.test(problem)));
	assert.ok(!options.problems.some((problem) => /CONTENTUS_OWNER_TOKEN/.test(problem)));
});

test('a dry run needs no credential at all', () => {
	const options = readOptions(['--base', BASE, '--agent', AGENT, '--grantee', GRANTEE], {});
	assert.deepEqual(options.problems, []);
});

test('a missing agent or grantee is named rather than defaulted', () => {
	const options = readOptions(['--base', BASE], {});
	assert.ok(options.problems.some((problem) => /--agent/.test(problem)));
	assert.ok(options.problems.some((problem) => /--grantee/.test(problem)));
});

/* =========================================================================
 * The probe's own document is one lesser accepts
 * ====================================================================== */

test('the viewer identity document validates against the pinned lesser schema', () => {
	// The anti-drift control, and stronger than importing would be: importing
	// proves two files in this repository agree, validating proves lesser would
	// accept it. The app's own documents are covered by `validate:graphql`.
	const schema = buildSchema(
		readFileSync(join(REPO, 'contracts/lesser/graphql-schema.graphql'), 'utf8')
	);
	assert.deepEqual(
		validate(schema, parse(VIEWER_IDENTITY_QUERY)).map((error) => error.message),
		[]
	);

	// The paired red: the schema adjudicates, not the parser.
	const regressed = VIEWER_IDENTITY_QUERY.replace('username', 'userName');
	assert.notEqual(regressed, VIEWER_IDENTITY_QUERY);
	const errors = validate(schema, parse(regressed));
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /Cannot query field "userName" on type "Actor"/);
});

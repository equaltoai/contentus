import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSchema, parse, validate } from 'graphql';

import {
	createdGrant,
	expectedHost,
	grantToRevoke,
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
const MCP_HOST = 'api.instance.invalid';
const MCP_URL = `https://${MCP_HOST}/mcp/scribe`;

const GRANTED_AT = '2026-08-14T12:00:00Z';

const ARGS = ['--base', BASE, '--agent', AGENT, '--grantee', GRANTEE, '--execute'];

/**
 * The same run, with the MCP host the operator expects named.
 *
 * A run carrying `CONTENTUS_GRANTEE_MCP_TOKEN` REFUSES TO START without a host
 * decision, so every case below that supplies the MCP credential supplies one
 * too. That is the point rather than an inconvenience: the flag is what stops a
 * grantee's bearer travelling to whatever host a response happened to name.
 */
const ARGS_MCP = [...ARGS, '--mcp-host', MCP_HOST];

const ENV = {
	CONTENTUS_OWNER_TOKEN: OWNER_MARKER,
	CONTENTUS_GRANTEE_TOKEN: GRANTEE_MARKER,
};

const ENV_WITH_MCP = { ...ENV, CONTENTUS_GRANTEE_MCP_TOKEN: MCP_MARKER };

/** The share row a healthy instance holds after this run's own PUT. */
const OWN_GRANT = {
	agent_username: AGENT,
	grantee_username: GRANTEE,
	active: true,
	granted_at: GRANTED_AT,
	granted_by: 'owner',
};

/** The identity the probe captures from that row, as `createdGrant` returns it. */
const OWN_IDENTITY = {
	agent: AGENT,
	grantee: GRANTEE,
	grantedAt: GRANTED_AT,
	grantedBy: 'owner',
};

const ledgerOf = (...current) => ({ current, revoked: [], unreadable: [] });

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
			const created = { ...OWN_GRANT };
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
	assert.match(out.text(), /5 would be left to the operator's own record/);
	assert.match(out.text(), /Set CONTENTUS_GRANTEE_MCP_TOKEN/);
	assert.match(out.text(), /--mcp-host <host> would move the published-endpoint check/);
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
		mcpHost: MCP_HOST,
	});

	const attested = (steps) => steps.filter((step) => step.kind === 'attest').map((step) => step.id);
	assert.deepEqual(attested(without), [
		'mcp-host-verified',
		'mint',
		'drive',
		'recorded-action',
		'fail-closed',
	]);
	assert.deepEqual(attested(with_), ['mint', 'recorded-action']);
});

test('naming the expected MCP host moves the published-endpoint check from ATTEST to CHECK', () => {
	// An unnamed host is not a verified host, and the plan has to say which of the
	// two this run is doing before the operator decides to hand it a credential.
	const shared = { agent: AGENT, grantee: GRANTEE, granteeMcpToken: null, attribution: true };
	const unnamed = plan(shared).find((step) => step.id === 'mcp-host-verified');
	const named = plan({ ...shared, mcpHost: MCP_HOST }).find(
		(step) => step.id === 'mcp-host-verified'
	);

	assert.equal(unnamed.kind, 'attest');
	assert.match(unnamed.what, /NO EXPECTED MCP HOST NAMED/);
	assert.equal(named.kind, 'checked');
	assert.ok(named.what.includes(MCP_HOST));
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
 * ...and the preflight is not what makes that true
 *
 * The preflight is a READ, and between it and the DELETE at the end of the run
 * sit a dozen requests. An owner or admin in another window can grant that same
 * account access inside that window, at which point the preflight is a statement
 * about the past and the revocation lands on a grant somebody meant to stand
 * (codex review 4942154730 on equaltoai/contentus#102). What actually protects
 * that grant is the IDENTITY of the row this run wrote, re-checked against a
 * fresh read immediately before the delete — so these cases move the instance
 * UNDER the probe, which is the only way a check-to-write window is visible at
 * all.
 * ====================================================================== */

/**
 * A fake whose share list changes at the read the probe takes before revoking.
 *
 * The reads of `GET /{agent}/share` are, in order: the preflight, the owner's
 * view of the new grant, the re-read before the revocation, and the owner's view
 * of the revocation. Taking over from the THIRD puts a concurrent write exactly
 * inside the window.
 *
 * IT TAKES OVER RATHER THAN FLICKERING. A one-read injection is not a concurrent
 * grant, it is a glitch — and a probe that refused the revocation and then let a
 * CLEANUP revoke on the next, healthy read would pass a test written that way
 * while doing the exact thing the check exists to prevent. Injected reads bypass
 * the fake's log on purpose, so an assertion about what was SENT reads only the
 * probe's own traffic.
 */
function racing(fake, grantsFromNowOn, at = 3) {
	let reads = 0;
	return async (url, init = {}) => {
		const target = new URL(url);
		if ((init.method ?? 'GET') === 'GET' && target.pathname === `/api/v1/agents/${AGENT}/share`) {
			reads += 1;
			if (reads >= at) return json({ grants: grantsFromNowOn });
		}
		return fake.fetchImpl(url, init);
	};
}

const deletes = (fake) => fake.state.log.filter((entry) => entry.method === 'DELETE');

test('a grant re-granted by somebody else inside the window is NOT revoked', async () => {
	// THE MUTATION THIS SECTION EXISTS FOR. lesser stores one row per grantee and
	// re-grants it in place, so a concurrent grant does not appear as a second row
	// — it appears as the same row carrying somebody else's stamp. A probe that
	// revoked "the grant for this grantee" would take that access away.
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, {
		fetchImpl: racing(fake, [
			{ ...OWN_GRANT, granted_at: '2026-08-14T12:20:00Z', granted_by: 'someone-else' },
		]),
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] revoke-target/);
	assert.match(out.text(), /re-granted since/);
	assert.match(out.text(), /will NOT revoke it/);
	assert.deepEqual(deletes(fake), [], 'the concurrent grant must survive the run');

	// And the operator is told, in the cleanup that runs after the failure, that
	// the access this run created may still be standing — because it is.
	assert.match(out.text(), /\[CLEANUP REFUSED\]/);
	assert.match(out.text(), /revoke by hand/i);
});

test('a grant that vanished inside the window is not replaced by a blind DELETE', async () => {
	// Somebody else revoked it while this run was in flight. There is nothing of
	// this run's left to remove, and a DELETE now would be aimed at whatever has
	// taken its place.
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, { fetchImpl: racing(fake, []), env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] revoke-target/);
	assert.match(out.text(), /no longer in @scribe's current-access list/);
	assert.deepEqual(deletes(fake), []);
});

test('an entry the instance did not classify stops the revocation, not just the preflight', async () => {
	// The same reasoning the preflight already applies, applied at the moment it
	// actually decides a delete: an entry lesser did not mark could be this run's
	// row, and "which one is mine" cannot be established by guessing.
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, {
		fetchImpl: racing(fake, [{ agent_username: AGENT, grantee_username: GRANTEE }]),
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] revoke-target/);
	assert.match(out.text(), /without marking them active or revoked/);
	assert.deepEqual(deletes(fake), []);
});

test('two active rows for one grantee are not guessed between', async () => {
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, {
		fetchImpl: racing(fake, [OWN_GRANT, { ...OWN_GRANT, granted_by: 'someone-else' }]),
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /2 active grants for @ada/);
	assert.deepEqual(deletes(fake), []);
});

test('a share list that cannot be re-read stops the revocation', async () => {
	// "I could not check" is not "it is fine". Without the re-read there is no
	// basis for the delete at all.
	const out = collector();
	const fake = instance();
	let reads = 0;
	const status = await main(ARGS, {
		fetchImpl: async (url, init = {}) => {
			const target = new URL(url);
			if ((init.method ?? 'GET') === 'GET' && target.pathname === `/api/v1/agents/${AGENT}/share`) {
				reads += 1;
				if (reads >= 3) return json({ error: 'gateway' }, 502);
			}
			return fake.fetchImpl(url, init);
		},
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /could not be re-read before revoking/);
	assert.deepEqual(deletes(fake), []);
});

test('the cleanup after a failure goes through the same check, not around it', async () => {
	// The cleanup is the path that runs when everything else has already gone
	// wrong, which makes it the one most likely to be written as an unconditional
	// DELETE — and the one where that would do the most damage.
	const out = collector();
	// The flow dies at the MCP read, so the CLEANUP's re-read is the third one —
	// there is no `revoke-target` step on this path, only the cleanup's own check.
	const fake = instance({ mcpAccess: () => json({ errors: [{ message: 'nope' }] }, 422) });
	const status = await main(ARGS, {
		fetchImpl: racing(fake, [{ ...OWN_GRANT, granted_by: 'someone-else' }]),
		env: ENV,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[CLEANUP REFUSED\]/);
	assert.match(out.text(), /re-granted since/);
	assert.match(out.text(), /MAY\s+STILL HOLD ACCESS/);
	assert.deepEqual(deletes(fake), [], 'the cleanup must not delete a grant it cannot identify');
});

test("a PUT answering with somebody else's grant aborts before the flow continues", async () => {
	// The window's other half: a grant landing between the preflight and this run's
	// own PUT is answered by lesser as an existing row, carrying the granter who
	// really made it. That row is a standing grant this run adopted, not one it
	// created, and it has to survive.
	const out = collector();
	const fake = instance({
		grant: () => json({ ...OWN_GRANT, granted_by: 'someone-else' }),
	});
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] grant-identity/);
	assert.match(out.text(), /records @someone-else as the granter/);
	assert.match(out.text(), /NOT remove somebody else/);
	assert.deepEqual(deletes(fake), []);
	assert.match(out.text(), /\[CLEANUP REFUSED\]/);
});

test('a grant returned without its identifying stamp is not one this run can revoke', async () => {
	for (const partial of [
		{ ...OWN_GRANT, granted_at: undefined },
		{ ...OWN_GRANT, granted_by: '' },
	]) {
		const out = collector();
		const fake = instance({ grant: () => json(partial) });
		const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

		assert.equal(status, 1, out.text());
		assert.match(out.text(), /without the granted_at\/granted_by stamp that identifies it/);
		assert.deepEqual(deletes(fake), [], 'nothing may be deleted on an unidentifiable row');
	}
});

test('a PUT answering about a different account or a different agent aborts', async () => {
	for (const wrong of [
		{ ...OWN_GRANT, grantee_username: 'mallory' },
		{ ...OWN_GRANT, agent_username: 'other-agent' },
	]) {
		const out = collector();
		const fake = instance({ grant: () => json(wrong) });
		const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

		assert.equal(status, 1, out.text());
		assert.match(out.text(), /\[FAIL\] grant-identity/);
		assert.deepEqual(deletes(fake), []);
	}
});

test('the identity readers say yes to the row this run wrote — and only to it', () => {
	// The paired green. A rule that refused everything would pass every red above
	// while making the probe useless, so each refusal is checked against the case
	// it must still admit.
	assert.deepEqual(createdGrant(OWN_GRANT, { agent: AGENT, grantee: GRANTEE, owner: ['owner'] }), {
		ok: true,
		identity: OWN_IDENTITY,
	});
	// lesser may write `granted_by` as the id rather than the username, so both
	// spellings the viewer read supplied are accepted — and nothing else is.
	assert.equal(
		createdGrant(
			{ ...OWN_GRANT, granted_by: 'actor-owner' },
			{ agent: AGENT, grantee: GRANTEE, owner: ['owner', 'actor-owner'] }
		).ok,
		true
	);
	assert.equal(
		createdGrant(
			{ ...OWN_GRANT, granted_by: 'actor-owner' },
			{ agent: AGENT, grantee: GRANTEE, owner: ['owner', 'actor-grantee'] }
		).ok,
		false
	);
	// Case is the instance's business, not a difference in identity.
	assert.equal(
		createdGrant(
			{ ...OWN_GRANT, grantee_username: 'Ada', granted_by: 'Owner' },
			{ agent: AGENT, grantee: GRANTEE, owner: ['owner'] }
		).ok,
		true
	);

	assert.deepEqual(grantToRevoke(ledgerOf(OWN_GRANT), OWN_IDENTITY), { ok: true });
	// A different timestamp on the same row is a different grant.
	assert.equal(
		grantToRevoke(ledgerOf({ ...OWN_GRANT, granted_at: '2026-08-14T12:20:00Z' }), OWN_IDENTITY).ok,
		false
	);
	// And a row for a DIFFERENT grantee is not this run's, however active it is.
	assert.equal(
		grantToRevoke(ledgerOf({ ...OWN_GRANT, grantee_username: 'mallory' }), OWN_IDENTITY).ok,
		false
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
		'grant-identity',
		'grantee-sees-agent',
		'grantee-reads-endpoint',
		'discovery',
		'protected-resource',
		'mcp-refuses-anonymous',
		'attribution',
		'revoke-target',
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
	assert.match(out.text(), /16\/16 checked steps passed/);
	assert.match(out.text(), /5 steps THIS RUN DID NOT PROVE/);
	assert.match(out.text(), /mints an MCP credential/);

	// And the grant it created is gone.
	assert.equal(fake.state.grants[0].active, false);
});

test('with an MCP credential the drive and the fail-closed check are really checked', async () => {
	const out = collector();
	const fake = instance();
	const status = await main(ARGS_MCP, {
		fetchImpl: fake.fetchImpl,
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /\[PASS\] drive/);
	assert.match(out.text(), /\[PASS\] fail-closed/);
	assert.match(out.text(), /\[PASS\] mcp-host-verified/);
	assert.match(out.text(), /19\/19 checked steps passed/);
	assert.match(out.text(), /2 steps THIS RUN DID NOT PROVE/);
});

test('the drive is read-only: initialize and tools/list, nothing else', async () => {
	// A probe that called a mutating tool would change an instance to prove a
	// session, which is a cost nobody asked it to impose.
	const fake = instance();
	await main(ARGS_MCP, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

	const methods = fake.state.log
		.filter((entry) => entry.url === MCP_URL)
		.map((entry) => JSON.parse(entry.body).method);
	assert.deepEqual(methods, ['initialize', 'initialize', 'tools/list', 'tools/list']);
});

test('the only writes the probe ever sends are the two share routes', async () => {
	const fake = instance();
	await main(ARGS_MCP, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

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
	await main(ARGS_MCP, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

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
		ARGS_MCP,
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
		await main(ARGS_MCP, {
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
		await main(ARGS_MCP, { fetchImpl: hostile(), env: ENV_WITH_MCP, write: out.write });
		for (const marker of [OWNER_MARKER, GRANTEE_MARKER, MCP_MARKER]) {
			assert.ok(!out.text().includes(marker), `${marker} reached the output:\n${out.text()}`);
		}
	}
});

test('tokens go in bearer headers and appear in no URL and no request body', async () => {
	const fake = instance();
	await main(ARGS_MCP, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

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
	await main(ARGS_MCP, { fetchImpl: fake.fetchImpl, env: ENV_WITH_MCP, write: () => {} });

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
 * The MCP credential goes to a host the operator named
 *
 * `mcpAccess.mcpURL` is a value THE SERVER PUBLISHES and
 * `CONTENTUS_GRANTEE_MCP_TOKEN` is a bearer for the grantee's account. Sending
 * the second to the first because the first arrived in a response is trusting a
 * host on the word of the party that named it (codex review 4942154730 on
 * equaltoai/contentus#102) — so the decision is the operator's, made before the
 * run starts, and checked before the first byte reaches that origin.
 * ====================================================================== */

test('an MCP credential with no host decision refuses to START, having sent nothing', async () => {
	// The strongest form of "the token does not leave": the run does not begin.
	const out = collector();
	const status = await main(ARGS, {
		fetchImpl: () => {
			throw new Error('nothing may be sent before the host decision is made');
		},
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /would send the grantee bearer to the MCP host THIS INSTANCE PUBLISHES/);
	assert.match(out.text(), /--mcp-host <host>/);
	assert.match(out.text(), /--i-trust-the-published-host/);
	assert.ok(!out.text().includes(MCP_MARKER));
});

test('a published host that is not the one named gets NOTHING — credential least of all', async () => {
	// THE EXFILTRATION MUTATION. A compromised or misconfigured instance publishes
	// an mcpURL of its choosing; the probe must refuse it before a request, not
	// after a handshake.
	const out = collector();
	const fake = instance();
	const status = await main([...ARGS, '--mcp-host', 'mcp.somewhere-else.invalid'], {
		fetchImpl: fake.fetchImpl,
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] mcp-host-verified/);
	assert.match(out.text(), /publishes its MCP endpoint on api\.instance\.invalid/);
	assert.match(out.text(), /NOTHING was sent to it/);

	// Not one request reached the published host — not the discovery documents,
	// not the negative control, and above all not the drive.
	const reached = fake.state.log.filter((entry) => new URL(entry.url).host === MCP_HOST);
	assert.deepEqual(reached, [], 'the unexpected host received a request');
	for (const entry of fake.state.log) {
		assert.notEqual(entry.auth, `Bearer ${MCP_MARKER}`, 'the grantee bearer left the process');
	}

	// And the grant this run created is still cleaned up.
	assert.equal(fake.state.grants[0].active, false);
});

test('--i-trust-the-published-host sends it, says so loudly, and counts it unproven', async () => {
	// The escape hatch has to work — an operator on an instance whose host they
	// cannot know in advance still needs the drive checked — and has to be
	// impossible to take without noticing.
	const out = collector();
	const fake = instance();
	const status = await main([...ARGS, '--i-trust-the-published-host'], {
		fetchImpl: fake.fetchImpl,
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /!! --i-trust-the-published-host/);
	assert.match(out.text(), /a host THIS INSTANCE PUBLISHED and nobody verified/);
	assert.match(out.text(), /Re-run\s+with --mcp-host api\.instance\.invalid to pin it/);
	assert.match(out.text(), /\[ATTEST\] mcp-host-verified/);
	assert.match(out.text(), /\[PASS\] drive/);
	// One more ATTEST than the named-host run: the host itself.
	assert.match(out.text(), /18\/18 checked steps passed/);
	assert.match(out.text(), /3 steps THIS RUN DID NOT PROVE/);

	const drive = fake.state.log.find((entry) => entry.url === MCP_URL && entry.auth);
	assert.equal(drive.auth, `Bearer ${MCP_MARKER}`, 'the hatch must actually open');
});

test('naming the host and trusting whatever is published are contradictory', () => {
	// Letting the hatch win would be an escape hatch silently overriding a stated
	// expectation, which is the fail-open the pair exists to prevent.
	const options = readOptions([...ARGS_MCP, '--i-trust-the-published-host'], ENV_WITH_MCP);
	assert.ok(options.problems.some((problem) => /contradictory/.test(problem)));
});

test('--mcp-host takes a host, and says so rather than trimming a URL into one', () => {
	// Accepting `https://api.example/mcp/scribe` and comparing only its host would
	// discard the path the operator typed while reporting a match.
	assert.equal(expectedHost('api.example.com'), 'api.example.com');
	assert.equal(expectedHost('https://API.Example.com'), 'api.example.com');
	assert.equal(expectedHost('api.example.com:8443'), 'api.example.com:8443');
	assert.equal(expectedHost('https://api.example.com/mcp/scribe'), null);
	assert.equal(expectedHost('https://api.example.com/?a=b'), null);
	assert.equal(expectedHost('  '), null);
	assert.equal(expectedHost(null), null);

	const options = readOptions([...ARGS, '--mcp-host', MCP_URL], ENV_WITH_MCP);
	assert.ok(options.problems.some((problem) => /is not a host/.test(problem)));
});

test('without an MCP credential no host decision is needed, and the run still says so', async () => {
	// Nothing of the grantee's can be lost to the published host on this path, so
	// the run proceeds — but "nobody verified it" is still a claim it did not
	// establish, and it is counted with the rest of them.
	const out = collector();
	const fake = instance();
	const status = await main(ARGS, { fetchImpl: fake.fetchImpl, env: ENV, write: out.write });

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /\[ATTEST\] mcp-host-verified/);
	assert.match(out.text(), /no expected host was named/);
	assert.ok(!out.text().includes('!! --i-trust-the-published-host'), 'no credential, no warning');
});

test('naming the right host checks it, before anything is sent to it', async () => {
	// The paired green: every red above would also be produced by a probe that
	// simply never talked to the endpoint.
	const out = collector();
	const fake = instance();
	const status = await main(ARGS_MCP, {
		fetchImpl: fake.fetchImpl,
		env: ENV_WITH_MCP,
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /\[PASS\] mcp-host-verified — api\.instance\.invalid/);
	assert.ok(
		fake.state.log.some((entry) => entry.url === MCP_URL && entry.auth === `Bearer ${MCP_MARKER}`),
		'a verified host must still be reached'
	);
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

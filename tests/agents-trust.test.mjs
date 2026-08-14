import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parse } from 'svelte/compiler';

import { liveScript, sourceIdentifiers } from '../scripts/lib/module-imports.mjs';
// THE GATE'S OWN SCANNER, imported rather than reproduced: a second copy of the
// comment stripper is how the copy keeps passing after the original is fixed.
import { stripComments } from '../scripts/lib/strip-comments.mjs';
import { MODULE_SOURCE, trackedSource } from './helpers/tracked-source.mjs';

import {
	AGENT_DETAIL_QUERY,
	AGENT_MCP_ACCESS_QUERY,
	fetchAgent,
	fetchAgentMcpAccess,
	fetchMyAgents,
	MY_AGENTS_QUERY,
} from '../src/lib/agents/contract.ts';
import { notifySessionChange, sessionGeneration } from '../src/lib/auth/session-events.ts';
import { createSessionScope } from '../src/lib/auth/session-scope.ts';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

function agentNode(overrides = {}) {
	return {
		id: 'https://example.invalid/users/weatherbot',
		username: 'weatherbot',
		displayName: 'Weather Bot',
		bio: null,
		agentType: 'CURATOR',
		agentVersion: '1.4.0',
		verified: false,
		verifiedAt: null,
		quarantineStatus: null,
		quarantineStart: null,
		quarantineEnd: null,
		quarantineActive: false,
		createdAt: '2026-01-01T00:00:00Z',
		activityCount: 12,
		// The detail route's server pass is anonymous, and lesser v1.6.4 states
		// the redaction in the answer (commit 7aad73d5a) — so the shape lesser
		// serves this surface carries the boolean set to false.
		viewerCanSeePrivateFields: false,
		agentCapabilities: {
			canPost: true,
			canReply: true,
			canBoost: false,
			canFollow: true,
			canDM: false,
			maxPostsPerHour: 12,
			requiresApproval: true,
			restrictedDomains: [],
		},
		mcpAccess: null,
		...overrides,
	};
}

async function renderDetail(node) {
	const handler = await loadHandler();
	return withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusAgent' ? { data: { agent: node } } : { data: null },
		() => renderRoute(handler, route('agent-detail'))
	);
}

/* -------------------------------------------------------------------------
 * Capabilities
 * ---------------------------------------------------------------------- */

test('every capability renders, granted or not', async () => {
	// An agent that CANNOT DM is a different thing from one whose DM permission
	// is unknown. A list showing only what was permitted makes the two identical.
	const { value } = await renderDetail(agentNode());

	assert.ok(value.html.includes('Post'), 'a granted capability is shown');
	assert.ok(value.html.includes('No boost'), 'and a withheld one is shown as withheld');
	assert.ok(value.html.includes('No dm'), 'including DM');

	// Each carries an accessible sentence naming its subject, not just a word.
	assert.ok(value.html.includes('@weatherbot may not send direct messages.'));
	assert.ok(value.html.includes('@weatherbot may post.'));
});

test('the rate limit is rendered as the number lesser gave, zero included', async () => {
	const { value } = await renderDetail(
		agentNode({ agentCapabilities: { ...agentNode().agentCapabilities, maxPostsPerHour: 0 } })
	);

	// Zero is a real value — an agent rate-limited to silence — not "unset".
	assert.ok(value.html.includes('Posts per hour'));
	assert.ok(/Posts per hour<\/dt>[\s\S]{0,80}>0</.test(value.html), 'zero must be shown');
});

test('requiresApproval reads as the review gate, not as a limitation', async () => {
	const { value } = await renderDetail(agentNode());

	// An agent whose output a human sees before the network does is the property
	// the review gate exists to create. Describing it as a restriction would
	// invert the product's own position on it.
	assert.ok(value.html.includes('Output is reviewed before it publishes'));
});

test('an agent with no capabilities recorded shows no capability section', async () => {
	// Rather than eight "No" badges, which would assert lesser had denied
	// everything when in fact it said nothing.
	const { value } = await renderDetail(agentNode({ agentCapabilities: null }));

	assert.ok(!value.html.includes('Posts per hour'));
	assert.ok(!value.html.includes('may not send direct messages'));
});

/* -------------------------------------------------------------------------
 * Trust, stated rather than judged
 * ---------------------------------------------------------------------- */

test('an unverified agent is not called untrustworthy', async () => {
	const { value } = await renderDetail(agentNode({ verified: false }));

	// The absence of a claim, stated as an absence.
	assert.ok(value.html.includes('This instance has not verified this agent'));
	for (const word of ['untrusted', 'Untrusted', 'suspicious', 'unsafe']) {
		assert.ok(!value.html.includes(word), `"${word}" is a judgement lesser did not make`);
	}
});

test('an active quarantine outranks a verification badge', async () => {
	// lesser can verify an agent and later quarantine it. Leading with the
	// verified badge would bury a live restriction under a stale endorsement.
	const { value } = await renderDetail(
		agentNode({
			verified: true,
			verifiedAt: '2026-02-01T00:00:00Z',
			quarantineStatus: 'RATE_ABUSE',
			quarantineActive: true,
			quarantineStart: '2026-07-01T00:00:00Z',
			quarantineEnd: '2026-09-01T00:00:00Z',
		})
	);

	assert.ok(value.html.includes('RATE_ABUSE'));
	assert.ok(value.html.includes('This instance is restricting this agent right now'));
	assert.ok(value.html.includes('2026-07-01'), 'the window lesser recorded is shown');
	assert.ok(value.html.includes('2026-09-01'));

	assert.ok(
		value.html.indexOf('RATE_ABUSE') < value.html.indexOf('Verified'),
		'the live restriction must come before the endorsement'
	);
});

test('an expired quarantine is reported, not erased', async () => {
	// lesser keeps the record and reports the window. Hiding it would flatter the
	// agent; claiming it is live would misreport the instance.
	const { value } = await renderDetail(
		agentNode({
			quarantineStatus: 'RESOLVED',
			quarantineActive: false,
			quarantineStart: '2026-03-01T00:00:00Z',
			quarantineEnd: '2026-04-01T00:00:00Z',
		})
	);

	assert.ok(value.html.includes('RESOLVED'));
	assert.ok(value.html.includes('not currently active'));
	assert.ok(!value.html.includes('This instance is restricting this agent right now'));
});

test('quarantineActive is never recomputed from the timestamps', () => {
	// lesser computes it against its own clock (`QuarantineSummaryAt`). A client
	// comparing dates would disagree with the instance across a skew, and the
	// instance is the one that enforces the restriction.
	const source = readFileSync(join(repoRoot, 'src/lib/agents/AgentTrustDetail.svelte'), 'utf8');
	const badge = readFileSync(join(repoRoot, 'src/lib/agents/AgentTrustBadge.svelte'), 'utf8');

	for (const [name, content] of [
		['AgentTrustDetail', source],
		['AgentTrustBadge', badge],
	]) {
		assert.ok(!content.includes('Date.now()'), `${name} must not consult a local clock`);
		assert.ok(!content.includes('new Date('), `${name} must not parse the quarantine window`);
	}
});

/* -------------------------------------------------------------------------
 * The auth split
 * ---------------------------------------------------------------------- */

test('myAgents is never fetched on the server pass', async () => {
	// These props are serialized into the PUBLIC hydration endpoint. A
	// server-side `myAgents` read would put one operator's agent inventory —
	// including the owner fields lesser redacts from everyone else — behind a URL
	// anyone could request.
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusAgents'
				? { data: { agents: { totalCount: 0, pageInfo: {}, edges: [] } } }
				: { data: null },
		() => renderRoute(handler, route('agents'))
	);

	assert.deepEqual(
		requests.filter((r) => r.operation === 'ContentusMyAgents'),
		[]
	);
	assert.ok(!value.html.includes('Agents you own'), 'and nothing of it is in the paint');
	// The public roster is unaffected: it is a separate anonymous read.
	assert.equal(requests.filter((r) => r.operation === 'ContentusAgents').length, 1);
});

test('the detail read is one document, with lesser deciding what each viewer sees', () => {
	// lesser v1.6.4 admits anonymous `agent` reads (commit 1df0358b8) and
	// redacts the private fields rather than erroring on them (commit
	// 7aad73d5a), so the anonymous/owner document split is gone: every viewer
	// gets the same selection, and `viewerCanSeePrivateFields` in the answer
	// says which case they are in.
	assert.match(AGENT_DETAIL_QUERY, /query ContentusAgent\(/);
	assert.match(AGENT_DETAIL_QUERY, /agentOwner/);
	assert.match(AGENT_DETAIL_QUERY, /delegatedScopes/);
	assert.match(AGENT_DETAIL_QUERY, /viewerCanSeePrivateFields/);
});

test('fetchAgent reads ownership from the served boolean, not from the token', async () => {
	// The inference this replaces: "we sent a token and `agentOwner` came back
	// non-null". A token says what was ASKED; redacted values say nothing at
	// all. lesser now answers the question directly, and the answer — not the
	// request — decides what the view shows.
	const seen = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		seen.push({
			operation: /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			authorization: new Headers(init.headers).get('authorization'),
		});
		return new Response(
			JSON.stringify({
				data: {
					// A NON-OWNER WITH A TOKEN: lesser redacts and says so. The
					// token must not turn the blanks into an owner view.
					agent: agentNode({
						agentOwner: null,
						delegatedScopes: [],
						viewerCanSeePrivateFields: false,
					}),
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	};

	try {
		const asNonOwner = await fetchAgent({ accessToken: 'token-bob' }, 'weatherbot');
		assert.equal(asNonOwner.ok, true);
		assert.equal(asNonOwner.agent.owner, null);
		assert.equal(asNonOwner.agent.redaction.viewerIsOwner, false);

		// Anonymous gets the same document: one read, lesser decides visibility.
		const anonymous = await fetchAgent({}, 'weatherbot');
		assert.equal(anonymous.ok, true);
		assert.deepEqual(
			seen.map((r) => r.operation),
			['ContentusAgent', 'ContentusAgent']
		);
		assert.equal(seen[0].authorization, 'Bearer token-bob');
		assert.equal(seen[1].authorization, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

/* -------------------------------------------------------------------------
 * The MCP access bundle a grant conveys (M2.2, equaltoai/contentus#93)
 * ---------------------------------------------------------------------- */

/** lesser's bundle for `weatherbot`, shaped as `BuildPublicMCPAccessBundle` fills it. */
const BUNDLE = {
	mcpURL: 'https://api.example.invalid/mcp/weatherbot',
	protectedResourceURL:
		'https://api.example.invalid/.well-known/oauth-protected-resource/mcp/weatherbot',
	authorizationServerURL: 'https://example.invalid/.well-known/oauth-authorization-server',
	registrationURL: 'https://example.invalid/oauth/register',
	scopes: ['read', 'write', 'follow', 'push'],
	guidance: ['Start from the actor-scoped MCP URL.'],
};

/** The empty bundle lesser returns when it cannot name a base URL or an actor. */
const EMPTY_BUNDLE = {
	mcpURL: '',
	protectedResourceURL: '',
	authorizationServerURL: '',
	registrationURL: '',
	scopes: ['read'],
	guidance: ['Start from the actor-scoped MCP URL.'],
};

/** Drive one `fetchAgentMcpAccess` against a stubbed transport. */
async function readAccess(answer, { accessToken } = {}) {
	const seen = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		seen.push({
			query: payload.query ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
		});
		return new Response(JSON.stringify(answer), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		return {
			seen,
			result: await fetchAgentMcpAccess(accessToken ? { accessToken } : {}, 'weatherbot'),
		};
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test('the access read asks for lesser’s bundle and for none of the private fields', () => {
	// NARROWER THAN THE DETAIL READ, ON PURPOSE. This document is sent by the
	// grantee's list about somebody else's agent, so it must not carry an
	// ownership selection: every field asked for is a field a later panel can
	// start rendering without anyone deciding it should.
	assert.match(AGENT_MCP_ACCESS_QUERY, /query ContentusAgentMcpAccess\(/);
	for (const field of [
		'mcpURL',
		'protectedResourceURL',
		'authorizationServerURL',
		'registrationURL',
		'scopes',
		'guidance',
	]) {
		assert.match(AGENT_MCP_ACCESS_QUERY, new RegExp(`\\b${field}\\b`), `${field} is asked for`);
	}

	for (const field of ['agentOwner', 'delegatedScopes', 'viewerCanSeePrivateFields']) {
		assert.doesNotMatch(
			AGENT_MCP_ACCESS_QUERY,
			new RegExp(`\\b${field}\\b`),
			`${field} is lesser's redacted half and this read makes no ownership claim`
		);
	}
});

test('the connect endpoint is lesser’s string, carried through untouched', async () => {
	// The whole point of consuming `Agent.mcpAccess` rather than building the URL:
	// lesser canonicalises MCP onto `api.<domain>` while the authorization server
	// stays on the apex, and only the instance knows that. Anything this client
	// reconstructed would be a second copy of `pkg/auth/mcp_access.go`.
	const { seen, result } = await readAccess(
		{ data: { agent: { mcpAccess: BUNDLE } } },
		{ accessToken: 'token-bob' }
	);

	assert.equal(result.ok, true);
	assert.deepEqual(result.access, BUNDLE);
	assert.deepEqual(seen[0].variables, { username: 'weatherbot' });
	assert.equal(seen[0].authorization, 'Bearer token-bob', 'the caller’s token is forwarded');
});

test('an instance that publishes no endpoint for the agent says so, and it is not a failure', async () => {
	// `{ ok: true, access: <nulls> }` and `{ ok: false }` are different sentences.
	// Collapsing them would report a served "there is no MCP surface for this
	// agent" as a read that broke, and the grantee would retry forever.
	const { result } = await readAccess({ data: { agent: { mcpAccess: EMPTY_BUNDLE } } });

	assert.equal(result.ok, true);
	assert.equal(result.access.mcpURL, null);
	assert.equal(result.access.protectedResourceURL, null);
	assert.deepEqual(result.access.guidance, EMPTY_BUNDLE.guidance, 'lesser’s guidance survives');
});

test('an agent the instance will not resolve is a failure, not an empty bundle', async () => {
	const missing = await readAccess({ data: { agent: null } });
	assert.equal(missing.result.ok, false);
	assert.equal(missing.result.failure.reason, 'not-found');

	const disabled = await readAccess({
		data: { agent: null },
		errors: [{ message: 'agents are disabled by instance policy' }],
	});
	assert.equal(disabled.result.ok, false);
	assert.equal(disabled.result.failure.reason, 'agents-disabled');
});

test('the owned view asks for the private fields and lesser’s visibility statement', () => {
	// `myAgents` is answered AS the owner, so `agentOwner` and
	// `delegatedScopes` come back real rather than redacted — and
	// `viewerCanSeePrivateFields` comes back true, which is the statement the
	// view model reads before showing them.
	assert.match(MY_AGENTS_QUERY, /agentOwner/);
	assert.match(MY_AGENTS_QUERY, /delegatedScopes/);
	assert.match(MY_AGENTS_QUERY, /viewerCanSeePrivateFields/);
});

test('the owned view is gated on a session, not on the roster failing', () => {
	const source = readFileSync(join(repoRoot, 'src/lib/agents/MyAgents.svelte'), 'utf8');

	// It renders only for an authenticated session, and `onMount` is what makes
	// it client-only — the server never runs it.
	assert.match(source, /isAuthenticated\(\)/);
	assert.match(source, /onMount/);
	assert.match(source, /session === 'authenticated'/);
});

/* -------------------------------------------------------------------------
 * The inventory ends with the session
 * ---------------------------------------------------------------------- */

/**
 * `fetchMyAgents` against a stubbed `fetch`, with the response held open.
 *
 * The same shape `tests/messaging-session.test.mjs` uses on the inbox: the real
 * transport, the real contract module, and a gate the probe releases by hand —
 * which is what makes an answer that arrives AFTER a sign-out reproducible
 * rather than described.
 */
function heldRead({ token = 'token-ada' } = {}) {
	const requests = [];
	const gates = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		requests.push({
			operation: /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			authorization: new Headers(init.headers).get('authorization'),
			signal: init.signal ?? null,
		});
		const body = await new Promise((resolve) => gates.push(resolve));
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	return {
		requests,
		gates,
		token,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One owned agent, in the shape `myAgents` answers for its owner. */
const OWNED = {
	id: 'https://example.invalid/users/weatherbot',
	username: 'weatherbot',
	displayName: 'Weather Bot',
	agentType: 'CURATOR',
	verified: true,
	quarantineActive: false,
	activityCount: 3,
	agentOwner: 'https://example.invalid/users/ada',
	delegatedScopes: ['read', 'write'],
	viewerCanSeePrivateFields: true,
};

test('an owned-agent read that lands after sign-out publishes nothing', async () => {
	// THE DEFECT THIS CLOSES. `myAgents` is answered AS THE OWNER, so its nodes
	// carry `agentOwner` and `delegatedScopes` — the fields lesser redacts from
	// everyone else. A read dispatched under Ada's session and resolved after she
	// signed out would paint her inventory into whatever session is on screen.
	//
	// Driven through the REAL scope the component holds and the REAL sign-out
	// announcement, because the abort alone does not close this: a response
	// already parsed is not un-parsed by aborting the fetch behind it.
	const probe = heldRead();
	const scope = createSessionScope(sessionGeneration);
	const published = [];

	try {
		const controller = new AbortController();
		const stamp = scope.stamp();
		const inFlight = fetchMyAgents({
			accessToken: probe.token,
			signal: controller.signal,
		}).then((result) => {
			// Exactly the predicate `MyAgents.svelte` applies before it assigns.
			if (!scope.holds(stamp)) return 'dropped';
			published.push(result);
			return 'published';
		});

		await settle();
		assert.equal(probe.requests.length, 1, 'the owned read is in flight');
		assert.equal(probe.requests[0].operation, 'ContentusMyAgents');
		assert.equal(probe.requests[0].authorization, `Bearer ${probe.token}`);

		// The reader signs out mid-flight. The component cancels and ends its scope;
		// `clearSession` announces it, which is what advances the generation.
		controller.abort();
		scope.end();
		notifySessionChange('signed-out');

		assert.equal(probe.requests[0].signal?.aborted, true, 'the request itself is cancelled');

		// …and the answer arrives anyway, which is the whole point.
		probe.gates[0]({ data: { myAgents: [OWNED] } });

		assert.equal(await inFlight, 'dropped');
		assert.deepEqual(published, [], 'no owner-only field reaches the screen after the sign-out');
	} finally {
		probe.restore();
	}
});

test('a sign-in after the sign-out does not resurrect the previous reader’s stamp', async () => {
	// The other half of the race: Ada signs out, Bob signs in, and Ada's read
	// finally lands. Only Bob's own read, stamped after his sign-in, may publish.
	const scope = createSessionScope(sessionGeneration);
	const ada = scope.stamp();

	notifySessionChange('signed-out');
	scope.end();
	notifySessionChange('signed-in');
	const bob = scope.stamp();

	assert.equal(scope.holds(ada), false, 'the previous reader’s read is dead in both generations');
	assert.equal(scope.holds(bob), true, 'and the new reader’s own read is the one that may paint');
});

/** Every node in a Svelte/ESTree tree, depth first. */
function* walkAst(node) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) yield* walkAst(item);
		return;
	}
	yield node;
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc') continue;
		yield* walkAst(value);
	}
}

/** Whether the parsed program calls `name(...)` anywhere. */
function callsFn(ast, name) {
	for (const node of walkAst(ast)) {
		if (node.type !== 'CallExpression') continue;
		const callee = node.callee;
		if (callee?.type === 'Identifier' && callee.name === name) return true;
		if (callee?.type === 'MemberExpression' && callee.property?.name === name) return true;
	}
	return false;
}

/**
 * The three client-only panels on the agents route, each carrying private
 * session-scoped subject matter and each required to end with the session.
 *
 * The fields listed are what `closeSession` must empty on each panel — the
 * assertion below reads each body, and each entry is a field the panel would
 * otherwise still be holding one sign-in away from the next reader's screen.
 */
const SESSION_SCOPED_PANELS = [
	{
		file: 'MyAgents.svelte',
		subject: 'the owned roster',
		emptied: [/session = 'anonymous'/, /agents = \[\]/, /failure = null/, /loading = false/],
	},
	{
		file: 'AgentSharingPanel.svelte',
		subject: 'the owner share grants',
		emptied: [
			/session = 'anonymous'/,
			/grants = \[\]/,
			/grantee = ''/,
			/actionInFlight = false/,
			/actionError = null/,
		],
	},
	{
		// The act-as selection this panel used to mirror in a `selected` field
		// went with the control in M2.1 (equaltoai/contentus#92), so there is no
		// third field to empty here any more. The selection itself is not merely
		// emptied on sign-out — it is cleared at mount; see the act-as probes
		// below.
		file: 'AgentSharedWithMePanel.svelte',
		subject: 'the shared-with-me grants',
		// `access` joined the list in M2.2 (equaltoai/contentus#93). The MCP
		// endpoints in it are public — but WHICH agents were shared with this
		// reader is not, and a populated map is that private fact keyed by agent
		// username, one sign-in away from the next reader's screen.
		emptied: [/session = 'anonymous'/, /grants = \[\]/, /access = \{\}/],
	},
];

test('the owned view tracks the session rather than snapshotting it at mount', () => {
	// STRUCTURAL, and labelled as one: the repo has no DOM harness, so this reads
	// each component's parsed instance script rather than mounting it. What the
	// probes above prove about the guard, this proves is actually wired into the
	// components that need it — all three of the route's session-scoped panels,
	// not only the first one this check was written for.
	for (const panel of SESSION_SCOPED_PANELS) {
		const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents', panel.file), 'utf8'), {
			modern: true,
		});

		assert.ok(
			callsFn(ast.instance, 'onSessionChange'),
			`${panel.file} must hear the sign-out; emptying sessionStorage does nothing to a mounted panel (${panel.subject})`
		);
		assert.ok(
			callsFn(ast.instance, 'createSessionScope'),
			'and stamp its reads against the session'
		);
		assert.ok(callsFn(ast.instance, 'stamp'), 'stamped at dispatch');
		assert.ok(callsFn(ast.instance, 'holds'), 'and checked before anything is published');
		assert.ok(
			callsFn(ast.instance, 'abort'),
			'the in-flight read is cancelled, not merely ignored'
		);
		assert.ok(callsFn(ast.instance, 'end'), 'and the scope ends with the session');
	}
});

test('the sign-out path empties the panel rather than only hiding it', () => {
	for (const panel of SESSION_SCOPED_PANELS) {
		const source = readFileSync(join(repoRoot, 'src/lib/agents', panel.file), 'utf8');
		const close = source.slice(source.indexOf('function closeSession'));
		const body = close.slice(0, close.indexOf('\n\t}'));

		// Hiding a panel behind `session === 'anonymous'` while its fields stay
		// populated would leave one reader's private inventory one sign-in away
		// from the next reader's screen. Each entry is asserted because each is a
		// field the panel would otherwise still be holding.
		for (const emptied of panel.emptied) {
			assert.match(
				body,
				emptied,
				`${panel.file} must empty ${emptied} on sign-out (${panel.subject})`
			);
		}
	}
});

/** Every template node with its ancestor chain, from a parsed markup root. */
function* walkTemplate(node, ancestors = []) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) yield* walkTemplate(item, ancestors);
		return;
	}
	yield { node, ancestors };
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc' || key === 'start' || key === 'end') continue;
		yield* walkTemplate(value, [...ancestors, node]);
	}
}

/** Whether an `{#if}` block tests exactly `agent.owner` — lesser's served statement. */
function isOwnershipGate(node) {
	return (
		node.type === 'IfBlock' &&
		node.test?.type === 'MemberExpression' &&
		node.test.object?.name === 'agent' &&
		node.test.property?.name === 'owner'
	);
}

test("share management mounts only behind lesser's ownership statement", () => {
	// STRUCTURAL, like the session probes above: the mount gate is one line whose
	// removal is silent — a later rework of the `{#each}` that drops the
	// `{#if agent.owner}` returns the defect the gate fixed, and every other
	// check stays green. So the gate itself is the assertion.
	const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents/MyAgents.svelte'), 'utf8'), {
		modern: true,
	});

	const mounts = [];
	for (const { node, ancestors } of walkTemplate(ast.fragment)) {
		if (node.type !== 'Component' || node.name !== 'AgentSharingPanel') continue;
		mounts.push(ancestors.some(isOwnershipGate));
	}

	assert.ok(mounts.length > 0, 'MyAgents must mount a sharing panel at all');
	assert.ok(
		mounts.every(Boolean),
		"and only behind {#if agent.owner} — lesser's served statement, never list membership"
	);
});

/* -------------------------------------------------------------------------
 * The act-as selection control, held gone (M2.1, equaltoai/contentus#92)
 *
 * Sharing an agent grants a person ACCESS to it. Act-as is ATTRIBUTION —
 * lesser recording which grantee drove an agent action — and the M7 tree
 * confused the two by shipping a button that let a person elect to drive the
 * agent from inside the web CMS. The button is gone; everything that carries
 * the attribution stays. These two probes are what hold that line, and they
 * hold it from opposite ends: the first says no surface can START acting as an
 * agent, the second says a selection made before the removal ENDS.
 *
 * WHAT THEY DO NOT CLAIM. The first reads a NAME, so it holds against the
 * control returning through the module's own writer — the only writer that
 * exists — and not against a future surface that reimplements the storage
 * write by hand. That is the honest bound of a name reading, and the reason
 * the write path stays in one module worth naming.
 * ---------------------------------------------------------------------- */

/**
 * The act-as selection writer. Every surface reaches the selection through
 * this name, which is what makes its absence checkable.
 */
const SELECTION_WRITER = 'selectActAs';

/** The module that defines it — the one file expected to name it. */
const SELECTION_MODULE = 'src/lib/agents/act-as.ts';

test('no surface in the app elects an act-as selection', () => {
	// PARSED, not grepped, and compiled for the CLIENT: `liveScript` hands back
	// the JavaScript a component actually executes, so a call written in a
	// markup event handler is in the reading and a name written in a comment or
	// a string is not. Repository-wide over tracked source, because "the panel
	// that used to have the button" is the file a reviewer checks and any other
	// file is where the control would come back unnoticed.
	const named = [];

	for (const path of trackedSource(repoRoot, 'src', MODULE_SOURCE)) {
		const file = relative(repoRoot, path);
		if (file === SELECTION_MODULE) continue;

		const live = liveScript(file, readFileSync(path, 'utf8'));
		if (sourceIdentifiers(live).includes(SELECTION_WRITER)) named.push(file);
	}

	assert.deepEqual(
		named,
		[],
		`${SELECTION_WRITER} is the act-as selection writer and no surface may call it: a person electing to act as an agent in the web CMS is the one thing sharing was never meant to grant (equaltoai/contentus#92)`
	);
});

test('the shared-with-me panel ends a selection made before the control went', () => {
	// The stop button went with the start button, so whoever held a selection
	// when this shipped would otherwise keep acting as the agent with nothing
	// left to end it. This panel is where that ends, and WHERE IN THE MOUNT
	// matters: after the read it would not run when the share plane 404s or
	// fails, and behind a condition it would not run at all. So the assertion is
	// the position, not merely the presence.
	const ast = parse(
		readFileSync(join(repoRoot, 'src/lib/agents/AgentSharedWithMePanel.svelte'), 'utf8'),
		{ modern: true }
	);

	let mounted = null;
	for (const node of walkAst(ast.instance)) {
		if (node.type !== 'CallExpression') continue;
		if (node.callee?.type !== 'Identifier' || node.callee.name !== 'onMount') continue;
		mounted = node.arguments?.[0] ?? null;
	}

	assert.ok(mounted, 'the panel must mount at all');

	const first = mounted.body?.body?.[0];
	assert.equal(
		first?.type,
		'ExpressionStatement',
		'the first thing the mount does must be a call, not a declaration or a branch'
	);
	assert.equal(
		first.expression?.type === 'CallExpression' && first.expression.callee?.name,
		'clearActAs',
		'and that call must be clearActAs() — unconditional, and before the grants are read'
	);
});

/* -------------------------------------------------------------------------
 * What a grant conveys, and where the grantee connects
 * (M2.2, equaltoai/contentus#93)
 *
 * Two obligations, and they are not the same obligation. The first is that the
 * ENDPOINT IS LESSER'S: `BuildPublicMCPAccessBundle` (lesser
 * `pkg/auth/mcp_access.go`) canonicalises MCP onto `api.<domain>` while the
 * authorization server stays on the apex, and only the instance knows that, so
 * a client that assembled the URL would be a second copy of that file — right
 * until an instance is deployed whose shape it guessed wrong. The second is
 * that the SCREENS SAY SO: an owner deciding to share, and a grantee reading
 * what they were given, are the two people who must not come away believing a
 * grant conveys the act-as control the CMS deliberately no longer offers.
 * ---------------------------------------------------------------------- */

/**
 * Every string a component's client-side JavaScript carries as DATA.
 *
 * Module specifiers are excluded, and that exclusion is a statement rather than
 * a convenience: `import … from './mcp'` names a file in this directory, and a
 * reading that counted it would report the panel for importing the very module
 * whose job is to keep it from building a URL. Nothing else is excluded, so a
 * specifier-shaped string used as a value is still in the reading — the skip is
 * keyed on the node's POSITION in the import, not on how it looks.
 */
function scriptStrings(file) {
	const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents', file), 'utf8'), {
		modern: true,
	});

	// One parse, so node identity is usable here; a set keyed across two parses
	// would silently never match.
	const specifiers = new Set();
	for (const node of walkAst(ast.instance)) {
		if (
			node.type === 'ImportDeclaration' ||
			node.type === 'ImportExpression' ||
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration'
		) {
			if (node.source) specifiers.add(node.source);
		}
	}

	const strings = [];
	for (const node of walkAst(ast.instance)) {
		if (specifiers.has(node)) continue;
		if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
		else if (node.type === 'TemplateElement') strings.push(node.value?.cooked ?? node.value?.raw);
	}
	return strings.filter((value) => typeof value === 'string');
}

test('the grantee’s panel reads the connect endpoint and assembles no part of it', () => {
	// PARSED, not grepped: the panel's prose discusses `api.<domain>` and
	// `/mcp/<actor>` at length precisely because it must not build them, so a
	// text search over this file matches the documentation and proves nothing.
	// String LITERALS in the instance script are the material a URL would have to
	// be assembled from.
	for (const value of scriptStrings('AgentSharedWithMePanel.svelte')) {
		for (const fragment of ['http', '/mcp', 'api.', '.well-known', 'oauth']) {
			assert.ok(
				!value.toLowerCase().includes(fragment),
				`the panel carries the string ${JSON.stringify(value)}: the MCP endpoint is lesser's to state and this client's to display, never to build from ${JSON.stringify(fragment)} (lesser pkg/auth/mcp_access.go)`
			);
		}
	}

	// And the positive half, because "no URL literals" is also true of a panel
	// that shows no endpoint at all: the value must arrive through lesser's read
	// and be classified by the one function that refuses to substitute for it.
	const named = sourceIdentifiers(
		liveScript(
			'AgentSharedWithMePanel.svelte',
			readFileSync(join(repoRoot, 'src/lib/agents/AgentSharedWithMePanel.svelte'), 'utf8')
		)
	);
	assert.ok(named.includes('fetchAgentMcpAccess'), 'the endpoint comes from lesser’s bundle');
	assert.ok(named.includes('sharedMcpAccess'), 'and is classified without being added to');
	assert.ok(
		!named.includes('location'),
		'never from the page origin, which is the app host and a different one'
	);
});

/**
 * The rendered copy of a panel: its markup with comments removed.
 *
 * STRIPPED FIRST, and that is not cosmetic. Both panels' header comments
 * explain at length what act-as was and why the control went, so an assertion
 * that a panel does not PROMISE acting as the agent would match the explanation
 * and pass on every possible source — including one that had put the promise
 * back in the lede.
 */
function panelCopy(file) {
	return stripComments(readFileSync(join(repoRoot, 'src/lib/agents', file), 'utf8'));
}

test('both share panels state that a grant conveys MCP access', () => {
	// The owner's panel is where the decision to share is made; the grantee's is
	// where what they hold is read. Each must say it on its own — a reader sees
	// one of these screens, not both.
	for (const file of ['AgentSharingPanel.svelte', 'AgentSharedWithMePanel.svelte']) {
		const copy = panelCopy(file);
		assert.match(copy, /MCP/, `${file} must name the thing a grant conveys`);
		assert.match(
			copy,
			/sign(s)? in as (yourself|themselves)/i,
			`${file} must say the grantee signs in as themselves — the property that makes this access rather than impersonation`
		);
	}
});

test('neither share panel offers acting as the agent inside the CMS', () => {
	// The M2.1 removal was of a CONTROL; this is the copy half of the same line.
	// An owner who reads "grant the ability to act as @agent" believes they
	// handed over the thing the CMS no longer offers, and no probe over the
	// component tree catches a sentence.
	for (const file of ['AgentSharingPanel.svelte', 'AgentSharedWithMePanel.svelte']) {
		const copy = panelCopy(file);
		assert.doesNotMatch(
			copy,
			/(ability|able|permission|lets? (you|them)) to act as/i,
			`${file} must not describe a grant as conveying the ability to act as the agent (equaltoai/contentus#92, #93)`
		);
	}
});

/* -------------------------------------------------------------------------
 * The owner's view of who holds access (M2.3, equaltoai/contentus#94)
 *
 * The DATA has been arriving since M7: `GET /api/v1/agents/{username}/share`
 * is lesser's owner/admin view and it has always carried `granted_by`,
 * `revoked_at` and `revoked_by`. What the owner could SEE was a grantee, a
 * grant date, and a pill on some rows — so the two questions this milestone
 * exists to answer, who gave this account access and who took it away, were
 * answered in the payload and nowhere on the screen. These probes hold the
 * display, the split, and the sentence that keeps the revoked list from
 * claiming to be an event log.
 *
 * The unit behaviour underneath them — the split itself, and a stamp that
 * drops rather than fills a clause lesser did not serve — is
 * `tests/agent-share-view.test.mjs`, where it can be called instead of read.
 * ---------------------------------------------------------------------- */

/** The owner panel's parsed tree, the one subject of the probes below. */
function sharingPanelAst() {
	return parse(readFileSync(join(repoRoot, 'src/lib/agents/AgentSharingPanel.svelte'), 'utf8'), {
		modern: true,
	});
}

/** Every `a.b` the template reads off `object`, as `b` names. */
function templateReads(fragment, object) {
	const read = new Set();
	for (const { node } of walkTemplate(fragment)) {
		if (node.type !== 'MemberExpression') continue;
		if (node.object?.type !== 'Identifier' || node.object.name !== object) continue;
		if (node.property?.type === 'Identifier') read.add(node.property.name);
	}
	return read;
}

test('the owner view shows who granted access and who took it away', () => {
	// STRUCTURAL, and pointed at the fields rather than at words on the screen:
	// the copy around them can be rewritten freely, but a rework that drops a
	// stamp puts the payload's answer back out of the owner's reach silently —
	// every other probe here, and every unit test of the classifier, stays
	// green while the screen stops naming the actor.
	const read = templateReads(sharingPanelAst().fragment, 'grant');

	for (const field of ['granted_at', 'granted_by', 'revoked_at', 'revoked_by']) {
		assert.ok(
			read.has(field),
			`the panel must render grant.${field} — the owner view exists to answer who granted access and who revoked it (equaltoai/contentus#94)`
		);
	}
});

test('current access and revoked access are rendered from separate lists', () => {
	// The M7 panel rendered one `{#each grants}` and distinguished the halves
	// with a pill, which put an account that HAS access and an account that had
	// it taken away on adjacent identical rows. The assertion is the split at
	// its source: the template iterates the classifier's sides, never the raw
	// answer, so a row's side is lesser's `active` boolean and not a reader's
	// scan of a badge.
	const each = [];
	for (const { node } of walkTemplate(sharingPanelAst().fragment)) {
		if (node.type !== 'EachBlock') continue;
		const expression = node.expression;
		if (expression?.type === 'Identifier') each.push(expression.name);
		else if (
			expression?.type === 'MemberExpression' &&
			expression.object?.type === 'Identifier' &&
			expression.property?.type === 'Identifier'
		)
			each.push(`${expression.object.name}.${expression.property.name}`);
	}

	assert.ok(each.includes('ledger.current'), 'the panel must list who holds access now');
	assert.ok(each.includes('ledger.revoked'), 'and list revoked access separately');
	assert.ok(
		!each.includes('grants'),
		'and never iterate the unsplit answer, which is how the two became one list of rows'
	);
});

test('neither grant list is keyed on a value lesser could repeat', () => {
	// Svelte throws `each_key_duplicate` on a repeated key, in production as
	// well as in development. `grantee_username` is unique per lesser's storage
	// — one row per (agent, grantee) — but this panel's stated promise is that a
	// malformed 200 lands in `unavailable` rather than in a render-time throw,
	// and a key is a place that promise can be broken by an edit that looks like
	// a tidy-up. The rows hold no state, so keying buys nothing to weigh
	// against it.
	for (const { node } of walkTemplate(sharingPanelAst().fragment)) {
		if (node.type !== 'EachBlock') continue;
		assert.equal(
			node.key ?? null,
			null,
			'the grant lists must stay unkeyed: a repeated key is a render-time throw on exactly the malformed answer this panel promises to survive'
		);
	}
});

test('the empty current-access state is composed, never written into the template', () => {
	// THE DEFECT THIS CLOSES (equaltoai/contentus#100, codex review 4941340448):
	// the branch held the sentence "No account holds access to @{username} right
	// now", which is the instance's answer only when the instance classified
	// everything it sent. With an entry it did not classify — the one case where
	// a live grant can be missing from `ledger.current` — that sentence tells the
	// owner the opposite of the only surviving claim.
	//
	// The wording lives in `noCurrentAccessStatement` and is asserted in
	// `tests/agent-share-view.test.mjs`, where both readings can be CALLED. What
	// this probe holds is the other half: that the screen keeps asking it. A
	// sentence written back into this branch is the whole defect returning, and
	// it would return with every unit test still green.
	const ast = sharingPanelAst();
	const branches = [];
	for (const { node } of walkTemplate(ast.fragment)) {
		if (node.type !== 'IfBlock') continue;
		const condition = node.test;
		if (condition?.type !== 'MemberExpression' || condition.property?.name !== 'length') continue;
		const list = condition.object;
		if (list?.type !== 'MemberExpression') continue;
		if (list.object?.name !== 'ledger' || list.property?.name !== 'current') continue;
		branches.push(node);
	}

	assert.equal(branches.length, 1, 'the panel tests ledger.current.length exactly once');
	const empty = branches[0].alternate;
	assert.ok(empty, 'and answers the empty case rather than rendering nothing at all');

	// Attribute values are `Text` too — a class name is not something the panel
	// says to the owner, so what is collected is the text a reader would read.
	const inAttribute = (ancestors) => ancestors.some((node) => node.type === 'Attribute');
	const spoken = [];
	const rendered = [];
	for (const { node, ancestors } of walkTemplate(empty)) {
		if (node.type === 'Text' && node.data?.trim() && !inAttribute(ancestors))
			spoken.push(node.data.trim());
		if (node.type === 'ExpressionTag' && !inAttribute(ancestors)) rendered.push(node.expression);
	}

	assert.deepEqual(
		spoken,
		[],
		`the empty state must carry no literal copy — a claim about who holds access cannot be written where the unclassified count is not in hand: ${spoken.join(' / ')}`
	);

	// FOLLOWED BY NAME into the instance script, because the panel renders
	// `$derived` values rather than calling into the template: what is asserted
	// is that whatever this branch prints is bound to the classifier's statement,
	// not merely that the module is imported somewhere in the file.
	const sources = rendered.map((expression) => {
		if (expression?.type === 'CallExpression') return expression.callee?.name ?? null;
		if (expression?.type !== 'Identifier') return null;
		for (const node of walkAst(ast.instance)) {
			if (node.type !== 'VariableDeclarator') continue;
			if (node.id?.name !== expression.name) continue;
			if (callsFn(node.init, 'noCurrentAccessStatement')) return 'noCurrentAccessStatement';
		}
		return null;
	});

	assert.ok(rendered.length > 0, 'the empty state must render something');
	assert.ok(
		sources.every((source) => source === 'noCurrentAccessStatement'),
		`every part of the empty state must come from the classifier’s own statement (src/lib/agents/share-view.ts), not from a value assembled here: ${JSON.stringify(sources)}`
	);
});

test('only current grants are offered a revoke control', () => {
	// A revoke button on an already-revoked row sends a call lesser answers by
	// returning the grant unchanged — harmless on the wire, and a claim on the
	// screen that the access is still there to take away. So the control's
	// position is the assertion: every call site sits inside the current list.
	const offered = [];
	for (const { node, ancestors } of walkTemplate(sharingPanelAst().fragment)) {
		if (node.type !== 'CallExpression') continue;
		if (node.callee?.type !== 'Identifier' || node.callee.name !== 'performRevoke') continue;
		offered.push(
			ancestors.some(
				(ancestor) =>
					ancestor.type === 'EachBlock' &&
					ancestor.expression?.type === 'MemberExpression' &&
					ancestor.expression.object?.name === 'ledger' &&
					ancestor.expression.property?.name === 'current'
			)
		);
	}

	assert.ok(offered.length > 0, 'the panel must offer revoke at all');
	assert.ok(offered.every(Boolean), 'and only from inside the list of accounts that hold access');
});

test('the revoked list does not present itself as every revocation', () => {
	// lesser keeps ONE ROW PER GRANTEE and `RegrantAgentShareGrant` removes that
	// row's `RevokedAt`/`RevokedBy`, so granting a revoked account again erases
	// the revocation it followed. A heading over that list is a claim, and the
	// claim "here is the history" is false in exactly the case an owner would
	// most want it to be true. The caveat is copy, so no probe over the
	// component tree catches its removal — this one reads the rendered words
	// with the comments stripped, for the same reason the M2.2 lede probes do.
	const copy = panelCopy('AgentSharingPanel.svelte');

	assert.match(
		copy,
		/again moves it back to the list above/i,
		'the panel must say a re-grant moves an account back rather than adding a line'
	);
	assert.match(
		copy,
		/activity log/i,
		'and name the record that does hold the full sequence (M2.4, a different read)'
	);
});

test('the owner grant list is read on the owner path and nowhere else', () => {
	// The revoked half of this contract is owner/admin-only by lesser's
	// construction — `ListByAgent` authorizes first, and the grantee's
	// `shared-with-me` list has revoked rows filtered out at the index. What
	// contentus owes is not to widen that: the read stays in the panel
	// `MyAgents` mounts behind lesser's `agent.owner` statement (probed above),
	// and any second caller would be a surface reaching for the audit view
	// without that gate over it.
	const callers = [];

	for (const path of trackedSource(repoRoot, 'src', MODULE_SOURCE)) {
		const file = relative(repoRoot, path);
		if (file === 'src/lib/agents/share-client.ts') continue;

		const live = liveScript(file, readFileSync(path, 'utf8'));
		if (sourceIdentifiers(live).includes('listShareGrants')) callers.push(file);
	}

	assert.deepEqual(
		callers,
		['src/lib/agents/AgentSharingPanel.svelte'],
		'the owner grant list — the one read that carries revoked audit history — must be read only from the panel gated on lesser’s ownership statement (equaltoai/contentus#94)'
	);
});

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
	toAgentSummary,
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
		// serves this surface carries the boolean set to false. From lesser#1418
		// it carries the ownership boolean too, false for the same viewer:
		// anonymous is neither an owner nor an admin.
		viewerCanSeePrivateFields: false,
		viewerIsOwner: false,
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

	// And the ownership statement beside it (lesser#1418). Two booleans because
	// they answer two questions; selecting only the first is what made every
	// admin look like an owner.
	assert.match(AGENT_DETAIL_QUERY, /viewerIsOwner/);
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
						viewerIsOwner: false,
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
		assert.equal(asNonOwner.agent.viewer.canSeePrivateFields, false);
		assert.equal(asNonOwner.agent.viewer.isOwner, false);

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

	for (const field of [
		'agentOwner',
		'delegatedScopes',
		'viewerCanSeePrivateFields',
		'viewerIsOwner',
	]) {
		assert.doesNotMatch(
			AGENT_MCP_ACCESS_QUERY,
			new RegExp(`\\b${field}\\b`),
			`${field} belongs to the ownership/visibility half, and this read makes no claim about either — it asks one question about somebody else's agent`
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

test('the owned view asks for the private fields and BOTH of lesser’s viewer statements', () => {
	// `myAgents` is answered AS the owner, so `agentOwner` and
	// `delegatedScopes` come back real rather than redacted — and
	// `viewerCanSeePrivateFields` comes back true, which is the statement the
	// view model reads before showing them.
	assert.match(MY_AGENTS_QUERY, /agentOwner/);
	assert.match(MY_AGENTS_QUERY, /delegatedScopes/);
	assert.match(MY_AGENTS_QUERY, /viewerCanSeePrivateFields/);

	// AND THE OWNERSHIP STATEMENT, which is what the owner-only panels mount on
	// (lesser#1418). Not selecting it would leave the mount with only the
	// visibility boolean to read, which is the state this sync migrated away
	// from — and `myAgents` carrying a schema description that its membership
	// means ownership is a promise about a conforming instance, not a
	// substitute for asking.
	assert.match(MY_AGENTS_QUERY, /viewerIsOwner/);
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
	viewerIsOwner: true,
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
 * The four client-only panels on the agents route, each carrying private
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
	{
		// M2.4 (equaltoai/contentus#95). WHO HAS BEEN DRIVING an agent is the
		// sharper half of the two owner views: the grant ledger names accounts
		// that could reach the agent, this one names the people who actually did
		// and when they last did it. lesser answers it to the owner and admins
		// alone, so a populated `ledger` left behind on sign-out would hand the
		// next reader of this browser a log of a stranger's collaborators.
		file: 'AgentDriversPanel.svelte',
		subject: 'who has been driving the agent',
		emptied: [/session = 'anonymous'/, /ledger = null/, /activityState = \{ status: 'loading' \}/],
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

/**
 * Evaluate an `{#if}` gate expression against one view model.
 *
 * READING THE GATE'S NAME IS NOT READING THE GATE, which is the whole reason
 * this exists. The probe this replaced asserted that the mount sat behind an
 * `{#if}` testing the member `agent.owner` — true of the migrated code's
 * predecessor and equally true of any other property spelled `owner`, and it
 * could say nothing at all about WHICH VIEWERS the gate admits. That is the
 * question the migration is about: `agent.owner` and `agent.viewer.isOwner`
 * differ on exactly one viewer, the admin, and a name check cannot see the
 * difference. So the gate is executed against real view models instead, built
 * by `toAgentSummary` from the shapes lesser actually serves.
 *
 * FAIL-CLOSED ON ANY NODE IT DOES NOT MODEL. A gate rewritten as `a && b`, a
 * call, a negation or an optional chain THROWS rather than returning a verdict.
 * A probe that quietly skipped the expressions it could not read would report a
 * pass it never established — the silent-cap shape — so the cost of a more
 * complex gate is that this function must be taught it deliberately.
 */
function evaluateGate(node, agent) {
	if (node?.type === 'Identifier') {
		if (node.name !== 'agent') {
			throw new Error(`gate reads an identifier this probe does not model: ${node.name}`);
		}
		return agent;
	}
	if (node?.type === 'MemberExpression') {
		if (node.computed || node.optional) {
			throw new Error('gate uses a computed or optional member access; teach this probe first');
		}
		const object = evaluateGate(node.object, agent);
		if (node.property?.type !== 'Identifier') {
			throw new Error('gate uses a non-identifier property; teach this probe first');
		}
		return object == null ? undefined : object[node.property.name];
	}
	throw new Error(`gate uses a ${node?.type ?? 'missing'} expression; teach this probe first`);
}

/**
 * Whether an expression reads the `agent` binding anywhere inside it.
 *
 * A GENERIC WALK, not a shape match, because a miss here would be a fail-open:
 * this decides which gates get executed, and a gate that reads `agent` in a
 * form the walker did not recognise would be silently excluded from the
 * verdict. Recursing over every own property cannot miss an `Identifier`.
 */
function expressionReadsAgent(node) {
	if (!node || typeof node !== 'object') return false;
	if (Array.isArray(node)) return node.some(expressionReadsAgent);
	if (node.type === 'Identifier' && node.name === 'agent') return true;
	return Object.entries(node).some(
		([key, value]) => key !== 'parent' && key !== 'loc' && expressionReadsAgent(value)
	);
}

/**
 * The per-agent `{#if}` tests guarding every mount of `panel`.
 *
 * GATES THAT DO NOT READ `agent` ARE EXCLUDED, and that is not a hole. The one
 * such gate here is `{#if session === 'authenticated'}`, which decides whether
 * the whole block renders at all and is asserted separately; it cannot vary by
 * viewer, so including it would only mean modelling a second scope to reach the
 * same verdict. The direction that matters is covered: an extra non-agent gate
 * can only ever narrow the conjunction, while REPLACING the ownership gate with
 * one leaves no per-agent gate at all — and the caller requires at least one.
 */
function mountGates(ast, panel) {
	const mounts = [];
	for (const { node, ancestors } of walkTemplate(ast.fragment)) {
		if (node.type !== 'Component' || node.name !== panel) continue;
		mounts.push(
			ancestors
				.filter((entry) => entry.type === 'IfBlock' && expressionReadsAgent(entry.test))
				.map((entry) => entry.test)
		);
	}
	return mounts;
}

/**
 * The owner-only panels `MyAgents` mounts per agent, each gated on lesser's own
 * ownership statement.
 *
 * Both read a surface lesser answers to the agent's owner and admins alone —
 * the share grants, and the activity log behind them (M2.4,
 * equaltoai/contentus#95, `agentActivity` answers `Forbidden` to anyone else).
 * The server gate is the real one; this list holds the client to not ASKING on
 * a screen it should not have drawn.
 */
const OWNER_GATED_PANELS = ['AgentSharingPanel', 'AgentDriversPanel'];

/**
 * The three viewers lesser distinguishes, as this client receives them.
 *
 * `admit` is what the owner-only panels must do for each. The ADMIN row is the
 * one the migration exists for and the one lesser pins in its own contract test
 * (`TestActorAgentInfoAppliesPrivateFieldPolicy`): private fields visible,
 * ownership false. Under the old gate that viewer was admitted, because the
 * only boolean available to read said "you may see this agent's private
 * fields" and the panel beneath it is the owner's management surface.
 */
const VIEWERS = [
	{
		name: 'the owner',
		admit: true,
		served: {
			agentOwner: 'https://example.invalid/users/ada',
			delegatedScopes: ['read', 'write'],
			viewerCanSeePrivateFields: true,
			viewerIsOwner: true,
		},
	},
	{
		name: 'an admin who does not own the agent',
		admit: false,
		served: {
			agentOwner: 'https://example.invalid/users/ada',
			delegatedScopes: ['read', 'write'],
			viewerCanSeePrivateFields: true,
			viewerIsOwner: false,
		},
	},
	{
		name: 'a grantee holding a share on the agent',
		admit: false,
		served: {
			agentOwner: null,
			delegatedScopes: [],
			viewerCanSeePrivateFields: false,
			viewerIsOwner: false,
		},
	},
];

test('the owner-only panels admit the owner and refuse every other viewer', () => {
	// STRUCTURAL, like the session probes above: the mount gate is one line whose
	// removal is silent — a later rework of the `{#each}` that drops the gate
	// returns the defect it fixed, and every other check stays green. So the gate
	// itself is the assertion, and it is EXECUTED rather than named.
	const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents/MyAgents.svelte'), 'utf8'), {
		modern: true,
	});

	for (const panel of OWNER_GATED_PANELS) {
		const mounts = mountGates(ast, panel);
		assert.ok(mounts.length > 0, `MyAgents must mount ${panel} at all`);

		for (const viewer of VIEWERS) {
			const agent = toAgentSummary(agentNode(viewer.served));

			for (const gates of mounts) {
				assert.ok(
					gates.length > 0,
					`${panel} must mount behind a per-agent gate at all — a session gate alone admits every agent in the list`
				);
				// EVERY enclosing `{#if}` must admit, which is how the mount is
				// actually reached — asserting on one of them would let a second,
				// wider gate be added beside it without notice.
				const admitted = gates.every((gate) => Boolean(evaluateGate(gate, agent)));
				assert.equal(
					admitted,
					viewer.admit,
					`${panel} must ${viewer.admit ? 'mount for' : 'stay unmounted for'} ${viewer.name}` +
						' — the gate is lesser’s served viewerIsOwner, not the visibility boolean it' +
						' stood in for before lesser#1418'
				);
			}
		}
	}
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

/* -------------------------------------------------------------------------
 * The grantee's view of what was shared with them
 *
 * THE SAME DEFECT AS #100, ON THE OTHER SIDE OF THE CONTRACT. The panel
 * filtered `grants.filter((grant) => grant.active)` — truthiness, not
 * `=== true` — and rendered a certain empty state under it. A row lesser sent
 * without the boolean was therefore dropped from the list and then denied by
 * the sentence beneath it, which is this client answering for the instance in
 * the one case where the hidden row could be a live grant.
 *
 * WHY IT WAS NOT A LIVE BUG, AND WHY THE PROBES STAY ANYWAY. lesser answers
 * `/api/v1/agents/shared-with-me` from a different index with
 * `Filter("RevokedAt", "attribute_not_exists", nil)`, and `active` is
 * server-computed on a field carrying no `omitempty`, so a conforming instance
 * sends `true` on every row. These hold the client honest about a NON-conforming
 * one — the case where a claim is least available and most damaging.
 * ---------------------------------------------------------------------- */

/** The grantee panel's parsed tree. */
function sharedPanelAst() {
	return parse(
		readFileSync(join(repoRoot, 'src/lib/agents/AgentSharedWithMePanel.svelte'), 'utf8'),
		{ modern: true }
	);
}

/**
 * Whether a node is the `{#if ledger.current.length}` block — the one branch
 * that decides between the list and its empty state.
 *
 * SPELLED OUT TO THE `.length`, and that is the whole reason this is a function
 * rather than two lines inlined at each call site. The first version of the
 * position probe below matched `test.object.name === 'ledger'`, which is the
 * shape of `{#if ledger.current}` and NOT of what the panel writes: in
 * `ledger.current.length` the test's object is itself a MemberExpression, so
 * the matcher never fired and the assertion it guarded passed on every input,
 * including the mutant it existed to catch. One reading, used by both probes,
 * is what keeps that from being true of only one of them.
 */
function isCurrentListBranch(node) {
	if (node?.type !== 'IfBlock') return false;
	const test = node.test;
	if (test?.type !== 'MemberExpression' || test.property?.name !== 'length') return false;
	const list = test.object;
	return (
		list?.type === 'MemberExpression' &&
		list.object?.name === 'ledger' &&
		list.property?.name === 'current'
	);
}

/**
 * The node types that decide, at the fan-out's own level, whether a row is
 * reached — every spelling of "this one, not that one" that does not need a
 * `.filter` to be written.
 *
 * CLOSED OVER JAVASCRIPT'S CONDITIONALS, not over the three shapes that occurred
 * to the author. The first version of this set held `IfStatement`,
 * `ConditionalExpression` and `ContinueStatement`, and a mutant sweep walked
 * `grant.active && void fetchAgentMcpAccess(…)` straight through it: a
 * `LogicalExpression` guards a dispatch with no `if` anywhere, and a `switch`
 * whose losing case `break`s does the same in a third spelling. A probe a
 * one-character bypass survives is not the proof the comment above claims, so
 * the set is now enumerated from the language — `if`, `?:`, `&&`/`||`/`??`,
 * `switch`, and the two jumps that skip a row inside a loop — rather than from
 * the defect that prompted it.
 *
 * WHAT IS STILL OUTSIDE IT, and why that is not a silent gap: a narrowing
 * written inside a nested callback, which `walkOwnScope` deliberately does not
 * reach, for the reason stated there. Everything the fan-out's own scope can use
 * to skip a row is in this set; if a spelling is found that is not, the sweep
 * that finds it is the one that adds it.
 */
const ROW_NARROWING = new Set([
	'IfStatement',
	'ConditionalExpression',
	'LogicalExpression',
	'SwitchStatement',
	'ContinueStatement',
	'BreakStatement',
]);

/**
 * The reads the fan-out may make on the classified list it was handed: `map`
 * seeds one loading state per row and touches no membership.
 *
 * ONE ENTRY, AND SHORT ON PURPOSE. `filter` is the defect by name, but `slice`,
 * `reduce`, `findIndex` and an index are selections too, and the honest closure
 * over "reads that cannot drop a row" is not a list this probe can be sure it
 * finished. So the allowlist names what the panel does rather than what it may
 * not do, and a new read fails until it is added deliberately.
 */
const FAN_OUT_ROW_READS = ['map'];

/** The expressions a walk must stop at, because they open a scope of their own. */
const NESTED_SCOPES = new Set([
	'ArrowFunctionExpression',
	'FunctionExpression',
	'FunctionDeclaration',
]);

/**
 * Every node in `root`'s OWN scope: the walk stops AT a nested function rather
 * than descending into it.
 *
 * THE BOUNDARY IS THE CLAIM, not an optimisation. What the fan-out probe asks is
 * which rows enter the dispatch loop, and that is settled by `loadAccess`'s own
 * statements. The guards inside its `.then` callbacks answer a different
 * question — whether a row's ANSWER may paint, which is the session stamp and
 * the abort, both probed above — so a walk that descended into them would read a
 * publish guard as a row selection and the assertion below would be
 * unsatisfiable by correct code. That is not hypothetical and it is checkable:
 * the callback's own guard is `if (signal.aborted || !scope.holds(stamp))`,
 * which is two members of `ROW_NARROWING` in one line, so the correct panel
 * passing the narrowing assertion is itself the evidence this walk stops where
 * it says it does.
 *
 * WHAT IT THEREFORE DOES NOT REACH, said rather than left as silence: a
 * selection written inside one of those callbacks. That would not change which
 * agents lesser is asked about; it would suppress a row's answer after the fact,
 * and it is the stamp/abort probes that own that surface.
 */
function* walkOwnScope(root) {
	function* visit(node, isRoot) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) yield* visit(item, false);
			return;
		}
		if (!isRoot && NESTED_SCOPES.has(node.type)) return;
		yield node;
		for (const [key, value] of Object.entries(node)) {
			if (key === 'parent' || key === 'loc') continue;
			yield* visit(value, false);
		}
	}

	yield* visit(root, true);
}

/** The initializer of `<name> = …` in a parsed script, or null when nothing declares it. */
function declaratorInit(script, name) {
	for (const node of walkAst(script))
		if (node.type === 'VariableDeclarator' && node.id?.name === name) return node.init ?? null;
	return null;
}

/**
 * Whether an expression IS a call to `accessLedger`, followed one name at a time
 * through the script's own declarations.
 *
 * `$derived(accessLedger(grants))` is how this panel holds the classification for
 * the template, so both that and the bare call are the classifier — what is
 * refused is a set that merely resembles one. `seen` is not tidiness: `let a = b`
 * beside `let b = a` would otherwise spin, and a probe that hangs is a probe that
 * never says no.
 */
function isClassifierCall(script, expression, seen) {
	if (expression?.type === 'Identifier') {
		if (seen.has(expression.name)) return false;
		seen.add(expression.name);
		return isClassifierCall(script, declaratorInit(script, expression.name), seen);
	}
	if (expression?.type !== 'CallExpression') return false;
	if (expression.callee?.name === '$derived')
		return isClassifierCall(script, expression.arguments?.[0], seen);
	return expression.callee?.name === 'accessLedger';
}

/**
 * Whether an expression is the classifier's ACTIVE side — `accessLedger(…).current`.
 *
 * The side is named as strictly as the call is. `.revoked` and `.unreadable` are
 * the other two answers `accessLedger` gives, and a fan-out reading either would
 * be asking lesser about agents this reader is not being shown.
 */
function isActiveSide(script, expression, seen = new Set()) {
	if (expression?.type === 'Identifier') {
		if (seen.has(expression.name)) return false;
		seen.add(expression.name);
		return isActiveSide(script, declaratorInit(script, expression.name), seen);
	}
	return (
		expression?.type === 'MemberExpression' &&
		expression.computed !== true &&
		expression.property?.name === 'current' &&
		isClassifierCall(script, expression.object, seen)
	);
}

test('the grantee list is the classifier’s output, never a truthiness filter', () => {
	// THE ASSERTION IS AT THE SOURCE OF THE LIST, not on its contents: what the
	// grantee sees must be the rows lesser said `active: true` about, and
	// `accessLedger` is the one place in this repo that reads that boolean
	// strictly. A template that iterated `grants` again — or a `.filter` written
	// back into the instance script — is the whole defect returning, with every
	// unit test of the classifier still green.
	const ast = sharedPanelAst();

	const each = [];
	for (const { node } of walkTemplate(ast.fragment)) {
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

	assert.ok(each.includes('ledger.current'), 'the panel must list the classifier’s active side');
	assert.ok(
		!each.includes('grants'),
		'and never iterate lesser’s unsplit answer, which is where a revoked or unclassified row reaches the screen'
	);

	// The MCP fan-out is the second reader of the same set, and it carried its
	// own copy of the truthiness filter. Two filters that must agree are one
	// correction away from disagreeing, so the assertion is that only one
	// classifier exists in the file.
	//
	// THIS IS THE FILTER'S ABSENCE AND NOTHING MORE. It says no `.filter` was
	// written back; it does not say the fan-out reads the classification, which
	// is a claim about provenance and is asserted in the probe below. Neither
	// stands in for the other: a fan-out handed lesser's unsplit answer passes
	// this assertion exactly, and a fan-out that filters passes the next one.
	assert.ok(
		!callsFn(ast.instance, 'filter'),
		'the panel must not filter the grant list itself: `accessLedger` is the classification, and a second filter beside it is the half a fix forgets'
	);
	assert.ok(
		callsFn(ast.instance, 'accessLedger'),
		'and it must actually classify — a list rendered straight from lesser’s answer is the defect with the filter merely deleted'
	);
});

test('the MCP fan-out is handed the classifier’s active side, and narrows nothing of its own', () => {
	// WHAT THE MISSING `.filter` DOES NOT PROVE, and this probe exists because it
	// does not: three bypasses satisfy the assertion above untouched. Handing the
	// fan-out lesser's unsplit answer — `loadAccess(result, …)` — writes no filter
	// at all. A loop over the module's own `grants` state ignores what it was
	// given. A `continue` drops rows one at a time. Each is the second classifier
	// returning in a spelling the first probe cannot see, and the panel's
	// correctness rests on the claim it cannot make: that the rows the fan-out
	// asks lesser about ARE the rows the list renders — one classification of one
	// answer, not two sets that happen to agree today.
	const ast = sharedPanelAst();

	// HALF ONE — WHAT IT IS HANDED, followed by name through the instance script
	// because the panel may pass either `accessLedger(result).current` or the
	// `$derived` it already holds, and both are the classification.
	const dispatches = [];
	for (const node of walkAst(ast.instance))
		if (node.type === 'CallExpression' && node.callee?.name === 'loadAccess') dispatches.push(node);

	assert.equal(dispatches.length, 1, 'the fan-out is dispatched from exactly one place');
	assert.ok(
		isActiveSide(ast.instance, dispatches[0].arguments?.[0]),
		'and is handed the classifier’s active side — `accessLedger(…).current`, not lesser’s unsplit answer and not another side of the ledger, either of which asks about agents the reader is not being shown'
	);

	// HALF TWO — WHAT IT DOES WITH IT. Provenance at the call site is undone by a
	// narrowing inside the callee, so the parameter has to reach the dispatch loop
	// as it arrived.
	const fanOut = [...walkAst(ast.instance)].find(
		(node) => node.type === 'FunctionDeclaration' && node.id?.name === 'loadAccess'
	);
	assert.ok(fanOut, 'the fan-out is a declaration this probe can read, not a value it cannot');

	const rows = fanOut.params?.[0]?.name;
	assert.ok(rows, 'and binds its classified list to a plain name');

	const iterated = [];
	const narrowing = [];
	const reads = [];
	for (const node of walkOwnScope(fanOut.body)) {
		if (node.type === 'ForOfStatement') iterated.push(node.right);
		if (ROW_NARROWING.has(node.type)) narrowing.push(node.type);
		if (node.type === 'MemberExpression' && node.object?.name === rows)
			reads.push(node.computed ? '[computed]' : (node.property?.name ?? '[unnamed]'));
	}

	assert.equal(iterated.length, 1, 'the fan-out dispatches from exactly one loop');
	assert.equal(
		iterated[0]?.type === 'Identifier' ? iterated[0].name : `<${iterated[0]?.type}>`,
		rows,
		'which iterates the list it was handed, bare — a loop over the module’s own `grants`, or over a re-selection of the parameter, is the classification being redone by the half that must not redo it'
	);
	assert.deepEqual(
		narrowing,
		[],
		`and drops no row of it on the way: ${narrowing.join(', ')} decides per row whether lesser is asked, which is a second classifier however few lines it takes`
	);
	assert.deepEqual(
		[...new Set(reads)].sort(),
		FAN_OUT_ROW_READS,
		`and reads the list only to seed one loading state per row: ${JSON.stringify([...new Set(reads)].sort())}. The allowlist is deliberately one entry long — a new read is not assumed to be a selection, it is asked to be shown not to be`
	);
});

test('the grantee empty state is composed, never written into the template', () => {
	// The wording lives in `noSharedAgentsStatement` and both readings are
	// asserted in `tests/agent-share-view.test.mjs`, where they can be CALLED.
	// What this holds is the other half: that the screen keeps asking. A sentence
	// written back into this branch — "No agents have been shared with you." is
	// the one that was there — is the defect returning with every unit test green.
	const ast = sharedPanelAst();

	const branches = [];
	for (const { node } of walkTemplate(ast.fragment))
		if (isCurrentListBranch(node)) branches.push(node);

	assert.equal(branches.length, 1, 'the panel tests ledger.current.length exactly once');
	const empty = branches[0].alternate;
	assert.ok(empty, 'and answers the empty case rather than rendering nothing at all');

	// Attribute values are `Text` too — a class name is not something the panel
	// says to the reader, so what is collected is the text a reader would read.
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
		`the empty state must carry no literal copy — a claim that nothing was shared cannot be written where the unclassified count is not in hand: ${spoken.join(' / ')}`
	);

	// FOLLOWED BY NAME into the instance script, because the panel renders
	// `$derived` values rather than calling into the template: what is asserted is
	// that whatever this branch prints is bound to the classifier's own statement.
	const sources = rendered.map((expression) => {
		if (expression?.type === 'CallExpression') return expression.callee?.name ?? null;
		if (expression?.type !== 'Identifier') return null;
		for (const node of walkAst(ast.instance)) {
			if (node.type !== 'VariableDeclarator') continue;
			if (node.id?.name !== expression.name) continue;
			if (callsFn(node.init, 'noSharedAgentsStatement')) return 'noSharedAgentsStatement';
			// Named explicitly so the owner panel's sentence — one import away in
			// the same module, and about a different subject entirely — cannot be
			// wired in here and pass as "composed".
			if (callsFn(node.init, 'noCurrentAccessStatement')) return 'noCurrentAccessStatement';
		}
		return null;
	});

	assert.ok(rendered.length > 0, 'the empty state must render something');
	assert.ok(
		sources.every((source) => source === 'noSharedAgentsStatement'),
		`every part of the empty state must come from the grantee’s own statement in src/lib/agents/share-view.ts: ${JSON.stringify(sources)}`
	);
});

/**
 * Where two template nodes sit, as child indices, in the one fragment holding
 * them both — or null when no fragment does.
 *
 * THE READER'S OWN ORDER, which is what "above" means and what source offsets
 * only approximate. Two nodes in different branches of the same `{#if}` are
 * written one after the other and are never met one after the other; sibling
 * indices in a shared fragment are a sequence a reader actually reads down.
 * Returning null rather than a guess when no fragment holds both is the whole
 * reason this is separate from the caller: "I cannot place these" must fail the
 * assertion, not satisfy it.
 */
function siblingOrder(first, second) {
	const path = (entry) => [...entry.ancestors, entry.node];
	const left = path(first);
	const right = path(second);

	let depth = 0;
	while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1;

	const shared = left[depth - 1];
	if (!Array.isArray(shared?.nodes)) return null;

	const a = shared.nodes.indexOf(left[depth]);
	const b = shared.nodes.indexOf(right[depth]);
	return a < 0 || b < 0 ? null : [a, b];
}

test('the grantee is told about unclassified rows above the list, not merely outside it', () => {
	// A reader with three agents listed and a fourth row the instance failed to
	// classify sees a list that is short by one and looks complete. That is the
	// same misreading as the empty state's, and it is the one the empty-state fix
	// does not reach — so the notice sits ABOVE the list rather than inside its
	// empty branch.
	//
	// OUTSIDE THE BRANCH IS HALF OF "ABOVE", AND THE WEAKER HALF. A notice moved
	// BELOW the list is outside the branch just as completely, and a reader meets
	// it only after the short list has already been taken for the whole answer —
	// which is the defect with the notice merely relocated. So both halves are
	// asserted, and the second is a position rather than a separation: the two
	// nodes' places in the one fragment a reader reads down.
	const ast = sharedPanelAst();

	const notices = [];
	const branches = [];
	for (const entry of walkTemplate(ast.fragment)) {
		if (isCurrentListBranch(entry.node)) branches.push(entry);
		if (entry.node.type !== 'ExpressionTag') continue;
		if (entry.node.expression?.type !== 'Identifier') continue;
		const init = declaratorInit(ast.instance, entry.node.expression.name);
		if (callsFn(init, 'unlistedSharesNotice')) notices.push(entry);
	}

	assert.equal(notices.length, 1, 'the panel must render the unclassified notice exactly once');
	assert.equal(branches.length, 1, 'and test ledger.current.length exactly once');

	assert.ok(
		!notices[0].ancestors.some(isCurrentListBranch),
		'the notice must sit outside the ledger.current branch — one only the empty screen shows leaves a short list looking complete, and one only the FULL list shows leaves the empty state claiming the instance answered everything'
	);

	const order = siblingOrder(notices[0], branches[0]);
	assert.ok(
		order,
		'and in the same fragment as the list, because "above the list" is a claim about one sequence the reader reads down and is unmakeable across two'
	);
	assert.ok(
		order[0] < order[1],
		`and before it in that sequence — a notice rendered after the list is read after the short list has already been taken for complete (notice at ${order[0]}, list at ${order[1]})`
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

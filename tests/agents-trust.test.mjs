import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parse } from 'svelte/compiler';

import {
	AGENT_DETAIL_QUERY,
	fetchAgent,
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
		file: 'AgentSharedWithMePanel.svelte',
		subject: 'the shared-with-me grants and the act-as selection',
		emptied: [/session = 'anonymous'/, /grants = \[\]/, /selected = null/],
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

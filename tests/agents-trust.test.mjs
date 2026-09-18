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
	AGENT_OWNERSHIP_QUERY,
	fetchAgent,
	fetchAgentMcpAccess,
	fetchAgentOwnership,
	fetchMyAgents,
	MY_AGENTS_QUERY,
	ownershipState,
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
	// NARROWER THAN THE DETAIL READ, ON PURPOSE — and no shipped surface sends it
	// any more, which this comment used to get wrong. It once read "this document
	// is sent by the grantee's list about somebody else's agent"; that provenance
	// ended at equaltoai/contentus#119, when the grantee's list stopped reading the
	// bundle per row and started linking to the agent page, where
	// `AGENT_DETAIL_QUERY` serves `mcpAccess` in full. What keeps the document and
	// `fetchAgentMcpAccess` alive is `scripts/probe-share-flow.mjs`, which imports
	// the document by name so the end-to-end exercise drives shipped text rather
	// than a retyped copy of it — retargeting that probe and then deleting both is
	// a named follow-up, not something #119 could do honestly in passing.
	//
	// THE PROPERTY OUTLIVES THE CALLER, which is why the assertions below stay. The
	// document must not carry an ownership selection, because every field asked for
	// is a field a later panel can start rendering without anyone deciding it
	// should. That is a rule about the text, and the text is still shipped, still
	// exported, and still exactly what the probe sends. A stale provenance sentence
	// is what let this read as coverage of a live path; the narrowness it justified
	// is real either way, and asserting it costs nothing.
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
 * The five client-only panels this face mounts, each carrying private
 * session-scoped subject matter and each required to end with the session.
 *
 * The fields listed are what `closeSession` must empty on each panel — the
 * assertion below reads each body, and each entry is a field the panel would
 * otherwise still be holding one sign-in away from the next reader's screen.
 *
 * The list is the coverage, and it grew rather than merely changed in
 * equaltoai/contentus#119: the owner's panels moved from the roster to the agent
 * page, and the gate that had to be asked for on that page is itself a
 * session-scoped read of a fact about the reader, so it is listed here beside
 * the panels it decides whether to mount.
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
		// The `access` map M2.2 added (equaltoai/contentus#93) left with the
		// per-grant MCP fan-out in equaltoai/contentus#119: a row now links to the
		// agent page, where lesser's whole bundle is already rendered, instead of
		// the panel paying one GraphQL read per row to restate a URL that link
		// leads to. WHAT THIS ENTRY STILL GUARDS is unchanged, and it is the
		// private half — WHICH agents were shared with this reader — sitting in a
		// populated `grants` list one sign-in away from the next reader's screen.
		emptied: [/session = 'anonymous'/, /grants = \[\]/],
	},
	{
		// equaltoai/contentus#119 moved the owner's two panels onto the agent page,
		// and that page is painted ANONYMOUSLY, so the ownership gate had to be
		// asked for rather than inherited. What this component holds is therefore
		// an answer ABOUT THE READER: lesser's `viewerIsOwner` for the agent on
		// screen. It is one boolean, and it is not private the way a grant ledger
		// is — but leaving it standing across a sign-out leaves the next reader of
		// this browser with the previous one's ownership answer gating the two
		// panels either side of this entry, which are the sharpest subjects on the
		// face. The abort matters more here than anywhere else on it, too: an
		// ownership read in flight across a sign-out is a pending decision to mount
		// somebody's management surface on the authority of a session that has
		// ended.
		file: 'AgentOwnerPanels.svelte',
		subject: "lesser's ownership answer for the agent on screen",
		emptied: [/session = 'anonymous'/, /ownership = null/],
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
	// components that need it — every panel the list above names, not only the
	// first one this check was written for.
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
 * Evaluate an `{#if}` gate expression against the values the gate reads.
 *
 * READING THE GATE'S NAME IS NOT READING THE GATE, which is the whole reason
 * this exists. The probe this replaced asserted that the mount sat behind an
 * `{#if}` testing the member `agent.owner` — true of the migrated code's
 * predecessor and equally true of any other property spelled `owner`, and it
 * could say nothing at all about WHICH VIEWERS the gate admits. That is the
 * question the migration is about: `agent.owner` and `agent.viewer.isOwner`
 * differ on exactly one viewer, the admin, and a name check cannot see the
 * difference. So the gate is executed against real values instead, built by the
 * shipped readers from the shapes lesser actually serves.
 *
 * `bindings` maps each identifier the gate may read to the value the component
 * would be holding when it reads it. Which values those are is the caller's
 * claim and the caller's to justify: the roster's mount was handed a
 * `toAgentSummary` view model, and the agent page's is handed the answer of a
 * driven `fetchAgentOwnership` passed through `ownershipState` — in both cases
 * the shipped code computes the binding, so what is executed here is the gate
 * and not a copy of it.
 *
 * FAIL-CLOSED ON ANY NODE IT DOES NOT MODEL. A gate rewritten as `a && b`, a
 * call, a negation, an optional chain or a comparison this function has not
 * been taught THROWS rather than returning a verdict. A probe that quietly
 * skipped the expressions it could not read would report a pass it never
 * established — the silent-cap shape — so the cost of a more complex gate is
 * that this function must be taught it deliberately. `===` against a literal is
 * modelled because that is the shape the agent page's gate has
 * (`ownershipGate === 'owner'`); `!==` is not, and a gate written that way fails
 * here until someone has looked at which viewers it admits.
 */
function evaluateGate(node, bindings) {
	if (node?.type === 'Identifier') {
		if (!Object.hasOwn(bindings, node.name)) {
			throw new Error(`gate reads an identifier this probe does not model: ${node.name}`);
		}
		return bindings[node.name];
	}
	if (node?.type === 'Literal') return node.value;
	if (node?.type === 'MemberExpression') {
		if (node.computed || node.optional) {
			throw new Error('gate uses a computed or optional member access; teach this probe first');
		}
		const object = evaluateGate(node.object, bindings);
		if (node.property?.type !== 'Identifier') {
			throw new Error('gate uses a non-identifier property; teach this probe first');
		}
		return object == null ? undefined : object[node.property.name];
	}
	if (node?.type === 'BinaryExpression' && node.operator === '===') {
		return evaluateGate(node.left, bindings) === evaluateGate(node.right, bindings);
	}
	throw new Error(`gate uses a ${node?.type ?? 'missing'} expression; teach this probe first`);
}

/**
 * Whether an expression reads the named binding anywhere inside it.
 *
 * A GENERIC WALK, not a shape match, because a miss here would be a fail-open:
 * this decides which gates get executed, and a gate that reads the binding in a
 * form the walker did not recognise would be silently excluded from the
 * verdict. Recursing over every own property cannot miss an `Identifier`.
 */
function expressionReads(node, name) {
	if (!node || typeof node !== 'object') return false;
	if (Array.isArray(node)) return node.some((entry) => expressionReads(entry, name));
	if (node.type === 'Identifier' && node.name === name) return true;
	return Object.entries(node).some(
		([key, value]) => key !== 'parent' && key !== 'loc' && expressionReads(value, name)
	);
}

/**
 * The `{#if}` tests guarding every mount of `panel` that read `binding`.
 *
 * GATES THAT DO NOT READ IT ARE EXCLUDED, and that is not a hole. The one such
 * gate on either mount is `{#if session === 'authenticated'}`, which decides
 * whether the whole block renders at all and is asserted separately; it cannot
 * vary by viewer or by agent, so including it would only mean modelling a
 * second scope to reach the same verdict. The direction that matters is
 * covered: an extra gate can only ever narrow the conjunction, while REPLACING
 * the ownership gate with one leaves no per-agent gate at all — and the caller
 * requires at least one.
 */
function mountGates(ast, panel, binding) {
	const mounts = [];
	for (const { node, ancestors } of walkTemplate(ast.fragment)) {
		if (node.type !== 'Component' || node.name !== panel) continue;
		mounts.push(
			ancestors
				.filter((entry) => entry.type === 'IfBlock' && expressionReads(entry.test, binding))
				.map((entry) => entry.test)
		);
	}
	return mounts;
}

/**
 * The owner-only panels the agent page mounts, each gated on lesser's own
 * ownership statement.
 *
 * Both read a surface lesser answers to the agent's owner and admins alone —
 * the share grants, and the activity log behind them (M2.4,
 * equaltoai/contentus#95, `agentActivity` answers `Forbidden` to anyone else).
 * The server gate is the real one; this list holds the client to not ASKING on
 * a screen it should not have drawn.
 *
 * MOUNTED BY `AgentOwnerPanels` SINCE equaltoai/contentus#119, and before that
 * by `MyAgents` — one pair per owned agent, which made the roster issue both
 * reads for every agent the viewer owned before anyone had chosen one. The
 * mount moved; the gate and this list did not.
 */
const OWNER_GATED_PANELS = ['AgentSharingPanel', 'AgentDriversPanel'];

/** The component that decides whether they exist on the page at all. */
const OWNER_GATE_FILE = 'AgentOwnerPanels.svelte';

/**
 * The binding its template gates on, and the answer behind that binding.
 *
 * Named here because both halves are asserted: the gate expression is evaluated
 * against the binding, and the binding is asserted to be the shipped classifier's
 * output over the shipped read's answer. A probe that evaluated the template's
 * gate against a value it had computed itself would be asserting its own
 * arithmetic.
 *
 * The binding is not called `state`, and the probe below that holds the face to
 * not binding a rune's name says why: `svelte-check` reads `$state` as the
 * auto-subscription of a store by that name, so a component that binds `state`
 * and calls `$state<T>(…)` elsewhere has its runes mistyped and its gate
 * silently inferred as `any`.
 */
const GATE_BINDING = 'ownershipGate';
const GATE_ANSWER = 'ownership';

/** Drive one `fetchAgentOwnership` against a stubbed transport. */
async function readOwnership(answer, { accessToken, username = 'weatherbot' } = {}) {
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
			result: await fetchAgentOwnership(accessToken ? { accessToken } : {}, username),
		};
	} finally {
		globalThis.fetch = originalFetch;
	}
}

/**
 * The `$derived(<fn>(<arg>))` a name is declared with, as `{ fn, arg }`, or null
 * when the declaration is not that shape.
 *
 * A SHAPE CHECK AND NOT A TEXT CHECK, because the text of a derived is exactly
 * what a rewrite keeps while changing what it means. What this returns is the
 * name of the function called and the name of the value handed it, both read
 * off the tree, so `$derived(ownershipState(ownership))` and a hand-rolled
 * `$derived(ownership?.ok && ownership.isOwner)` are different answers here
 * rather than two spellings of one string.
 */
function derivedOf(script, name) {
	const init = declaratorInit(script, name);
	if (init?.type !== 'CallExpression' || init.callee?.name !== '$derived') return null;
	const call = init.arguments?.[0];
	if (call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier') return null;
	const arg = call.arguments?.[0];
	return {
		fn: call.callee.name,
		arg: arg?.type === 'Identifier' ? arg.name : `<${arg?.type ?? 'missing'}>`,
	};
}

/** Every value assigned to `name` in the instance script, `null` for a literal null. */
function assignedValues(script, name) {
	const values = [];
	for (const node of walkAst(script)) {
		if (node.type !== 'AssignmentExpression' || node.operator !== '=') continue;
		if (node.left?.type !== 'Identifier' || node.left.name !== name) continue;
		const right = node.right;
		values.push(
			right?.type === 'Literal' && right.value === null
				? null
				: right?.type === 'Identifier'
					? right.name
					: `<${right?.type ?? 'missing'}>`
		);
	}
	return values;
}

/**
 * The parameter `<fn>(…).then(…)` binds its answer to, or null when no such call
 * exists in the script.
 *
 * THIS IS THE LINK BETWEEN A NAME AND A READER. `assignedValues` can say the
 * gate's answer is only ever `null` or something called `result`; only this can
 * say what `result` is the result OF, and without it a component that assigned
 * the gate's answer from its own arithmetic would pass.
 */
function readerCallbackParam(script, fn) {
	for (const node of walkAst(script)) {
		if (node.type !== 'CallExpression') continue;
		if (node.callee?.type !== 'MemberExpression') continue;
		if (node.callee.property?.name !== 'then') continue;
		const call = node.callee.object;
		if (call?.type !== 'CallExpression' || call.callee?.name !== fn) continue;
		const callback = node.arguments?.[0];
		if (callback?.type !== 'ArrowFunctionExpression') return `<${callback?.type ?? 'missing'}>`;
		const param = callback.params?.[0];
		return param?.type === 'Identifier' ? param.name : `<${param?.type ?? 'missing'}>`;
	}
	return null;
}

/**
 * Every place `fn(…)` is dispatched in a compiled instance script.
 *
 * THE UNIT THE REQUEST-COUNT CLAIMS ARE ACTUALLY HELD TO, and the reason those
 * claims are labelled structural rather than measured. This repo has no DOM
 * harness, so nothing here mounts a component and counts what it sends over a
 * session; what can be counted is dispatch SITES, and for the fan-out question
 * that is the stronger statement — a reader that is not in scope cannot be called
 * by a loop this probe never sees. It says nothing about how many times one site
 * EXECUTES, so a total built from it is an arithmetic consequence of the sites and
 * the mounts, not a measurement. Shared by the gate's pin and the two lists' probe
 * so that "counted the same way" is a property of the code and not a claim in a
 * comment.
 */
function dispatchSites(script, fn) {
	return [...walkAst(script)].filter(
		(node) => node.type === 'CallExpression' && node.callee?.name === fn
	);
}

/**
 * The three viewers lesser distinguishes, as this client receives them.
 *
 * `admit` is what the owner-only panels must do for each. The ADMIN row is the
 * one the migration exists for and the one lesser pins in its own contract test
 * (`TestActorAgentInfoAppliesPrivateFieldPolicy`): private fields visible,
 * ownership false. Under the old gate that viewer was admitted, because the
 * only boolean available to read said "you may see this agent's private
 * fields" and the panel beneath it is the owner's management surface.
 *
 * `served` is the shape of one `Agent` as lesser answers it, and both gate
 * paths read the same field of it: the roster's `toAgentSummary` takes
 * `viewerIsOwner` into `viewer.isOwner`, and `fetchAgentOwnership` takes the
 * same boolean out of `AGENT_OWNERSHIP_QUERY`. One list drives both so that
 * "the gate moved, the rule did not" is a measured property of this file and
 * not a sentence in a comment.
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

test('the owner-only panels admit the owner and refuse every other viewer', async () => {
	// STRUCTURAL, like the session probes above: the mount gate is one line whose
	// removal is silent — a later rework that drops the gate returns the defect it
	// fixed, and every other check stays green. So the gate itself is the
	// assertion, and it is EXECUTED rather than named.
	//
	// WHAT equaltoai/contentus#119 CHANGED ABOUT THE EXECUTION, and why this probe
	// grew a preamble instead of merely changing a file name. The panels used to
	// hang off the owned roster, whose whole read is authenticated, so
	// `agent.viewer.isOwner` was already in hand and the gate could be evaluated
	// against a view model `toAgentSummary` built. The agent page is painted
	// ANONYMOUSLY — its server pass carries no token, and its props are serialized
	// into contentus's public hydration endpoint, where one reader's ownership
	// answer would be served to any other — so that field arrives on this page as a
	// correct `false` for everybody, the owner included, and gating on it would
	// shut the panels for the one viewer they exist for. The gate there is a read
	// of its own. So the read is what gets executed: each viewer's answer goes
	// through the shipped `fetchAgentOwnership` over a stubbed transport, the
	// shipped `ownershipState` classifies it, and the template's own gate
	// expression is evaluated against that classification. No link of the chain is
	// reproduced by this file.
	const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents', OWNER_GATE_FILE), 'utf8'), {
		modern: true,
	});

	// THE BINDING IS THE CLASSIFIER'S OUTPUT, asserted before it is used, because
	// every verdict below evaluates it — and a binding the component computed some
	// other way would make those verdicts statements about a gate this component
	// does not have.
	assert.deepEqual(
		derivedOf(ast.instance, GATE_BINDING),
		{ fn: 'ownershipState', arg: GATE_ANSWER },
		`${GATE_BINDING} must be $derived(ownershipState(${GATE_ANSWER})): the shipped classifier over the shipped read, not a second ownership test written into the component`
	);

	// AND THE ANSWER IT CLASSIFIES HAS ONE SOURCE. Two claims, because either one
	// alone is satisfiable by a component that invents a third value: every
	// assignment is either the read's own answer or a clearing null, and the name
	// bound to that answer is the name the reader's callback binds it to. A gate
	// that anything other than lesser's reply can satisfy is not a gate, and "we
	// did not ask" is not an answer — see the state probe below.
	assert.deepEqual(
		new Set(assignedValues(ast.instance, GATE_ANSWER)),
		new Set([null, 'result']),
		`${GATE_ANSWER} is assigned only lesser’s answer or a clearing null — a third value is an ownership claim this client made for itself`
	);
	assert.equal(
		readerCallbackParam(ast.instance, 'fetchAgentOwnership'),
		'result',
		'and `result` is what the shipped reader’s own callback binds, not a name this probe happened to find'
	);

	// EXACTLY ONE DISPATCH SITE — the pin the line above cannot supply on its own.
	// `readerCallbackParam` returns the FIRST match, so a component issuing two
	// ownership reads would still bind `result` from the first and pass every
	// assertion so far, while costing the page a second read of the one question it
	// had already asked. This is the site the page's ownership read is dispatched
	// from, counted the same way and by the same helper as the two lists are counted
	// below, which is what makes "the gate costs one read" structural rather than a
	// number transcribed from a scratch run.
	assert.equal(
		dispatchSites(ast.instance, 'fetchAgentOwnership').length,
		1,
		`${OWNER_GATE_FILE} dispatches fetchAgentOwnership from exactly one place: a second dispatch site is a second ownership read on a page that already made one`
	);

	for (const panel of OWNER_GATED_PANELS) {
		const mounts = mountGates(ast, panel, GATE_BINDING);
		assert.ok(mounts.length > 0, `${OWNER_GATE_FILE} must mount ${panel} at all`);

		for (const viewer of VIEWERS) {
			// Authenticated, because the question is: ownership is a statement about
			// a caller, and the reader answers a missing token itself rather than
			// sending a request that could only come back false-or-refused. That is
			// probed on its own below.
			const { result } = await readOwnership(
				{ data: { agent: { viewerIsOwner: viewer.served.viewerIsOwner } } },
				{ accessToken: 'token-bob' }
			);
			assert.equal(result.ok, true, `${viewer.name}: the read itself must succeed`);
			const bindings = { [GATE_BINDING]: ownershipState(result) };

			for (const gates of mounts) {
				assert.ok(
					gates.length > 0,
					`${panel} must mount behind an ownership gate at all — a session gate alone admits every viewer of the page`
				);
				// EVERY enclosing `{#if}` must admit, which is how the mount is
				// actually reached — asserting on one of them would let a second,
				// wider gate be added beside it without notice.
				const admitted = gates.every((gate) => Boolean(evaluateGate(gate, bindings)));
				assert.equal(
					admitted,
					viewer.admit,
					`${panel} must ${viewer.admit ? 'mount for' : 'stay unmounted for'} ${viewer.name}` +
						' — the gate is lesser’s served viewerIsOwner, asked for on the page rather' +
						' than inherited from a list, and not the visibility boolean it stood in' +
						' for before lesser#1418'
				);
			}

			// THE MOUNT MOVED AND THE RULE DID NOT, measured here rather than
			// asserted in a comment: the roster's view model and the page's read
			// reach the same verdict for every viewer lesser distinguishes, because
			// both are reading the one boolean it serves.
			assert.equal(
				toAgentSummary(agentNode(viewer.served)).viewer.isOwner,
				result.ok && result.isOwner,
				`${viewer.name}: the gate that moved must decide what the gate it replaced decided`
			);
		}
	}
});

/* -------------------------------------------------------------------------
 * The ownership read the agent page's gate asks for (equaltoai/contentus#119)
 *
 * ONE MORE READ ON A PAGE THAT ALREADY MADE ONE, and the reason is the page
 * rather than the panels. `/agents/{username}` is server-rendered anonymously:
 * the server pass carries no token, because the token is in the reader's
 * `sessionStorage` where no server pass can reach it, and because this route's
 * props are serialized into contentus's PUBLIC hydration endpoint, where an
 * ownership answer about one reader would be served to any other. So the
 * `viewerIsOwner` the page is painted with is a correct `false` for everybody —
 * the owner included — and it is not a stale value a refresh would fix. The
 * gate has to be asked for, and these probes hold what asking costs and what
 * the answer may be used to conclude.
 *
 * WHAT THEY DO NOT RE-PROVE: that the panels are owner-gated server-side.
 * lesser's `ListByAgent` and `agentActivity` both refuse everyone else, and
 * that is the real gate. This is the client half — not ASKING on a screen it
 * should not have drawn, and not DRAWING one either.
 * ---------------------------------------------------------------------- */

test('the ownership read asks one question and no private field', () => {
	// ONE FIELD, and the assertion is the selection set rather than a search for
	// the field's name: `assert.match(…, /viewerIsOwner/)` passes on a document
	// that also asks for `agentOwner`, which is the whole thing this document must
	// not do. Every field added here is a field a later surface can start
	// rendering as an ownership claim, and the narrowness is the same discipline
	// `AGENT_MCP_ACCESS_QUERY` states for its own selection.
	assert.match(AGENT_OWNERSHIP_QUERY, /query ContentusAgentOwnership\(/);

	const selection =
		AGENT_OWNERSHIP_QUERY.match(/agent\(username: \$username\)\s*\{([^}]*)\}/)?.[1] ?? '';
	assert.deepEqual(
		selection.split(/[\s,]+/).filter(Boolean),
		['viewerIsOwner'],
		'the ownership read selects one field: not `id`, not `username` — the read is addressed by username, so echoing it back proves nothing — and nothing lesser redacts'
	);
});

test('the ownership read is not sent at all when there is no token to send it with', async () => {
	// ANSWERED IN THE READER, not by the instance. Ownership is a statement about
	// a caller, so an anonymous form of the question has no answer; sending it
	// anyway would spend a request on a reply that could only be false-or-refused,
	// and would put a network read on the agent page for every anonymous visitor —
	// which is the cost this milestone exists to remove, arriving by a new door.
	//
	// The stub below answers `viewerIsOwner: true`, so a reader that sent the
	// request would report an owner. That it reports `unauthenticated` with an
	// empty request log is the assertion, and it is why the stub is generous.
	const { seen, result } = await readOwnership({ data: { agent: { viewerIsOwner: true } } });

	assert.deepEqual(seen, [], 'no request is made on behalf of an anonymous reader');
	assert.equal(result.ok, false);
	assert.equal(result.failure?.reason, 'unauthenticated');

	// And a handle that is not a handle is refused here rather than sent for
	// lesser to reject: a not-found this client can see in its own arguments is
	// not a question worth a request.
	const { seen: blankSeen, result: blank } = await readOwnership(
		{ data: { agent: { viewerIsOwner: true } } },
		{ accessToken: 'token-bob', username: '   ' }
	);
	assert.deepEqual(blankSeen, [], 'a blank handle sends nothing either');
	assert.equal(blank.ok, false);
	assert.equal(blank.failure?.reason, 'not-found');
});

test('ownership is lesser’s boolean, read strictly', async () => {
	// `viewerIsOwner` is `Boolean!` in lesser's schema, so a conforming answer is
	// true or false. Everything else is read as false, which is the direction
	// that mounts nothing: an absent field, a null, or the STRING 'true' arriving
	// from an instance that serialized it differently all shut the gate rather
	// than opening it on a value this client had to interpret.
	const { seen, result } = await readOwnership(
		{ data: { agent: { viewerIsOwner: true } } },
		{ accessToken: 'token-bob' }
	);
	assert.equal(result.ok, true);
	assert.equal(result.isOwner, true);
	assert.match(seen[0].query, /query ContentusAgentOwnership\(/);
	assert.deepEqual(seen[0].variables, { username: 'weatherbot' });
	assert.equal(seen[0].authorization, 'Bearer token-bob', 'the caller’s own token is forwarded');

	for (const served of ['true', 1, null, undefined, {}]) {
		const { result: strict } = await readOwnership(
			{ data: { agent: { viewerIsOwner: served } } },
			{ accessToken: 'token-bob' }
		);
		assert.equal(strict.ok, true, `${JSON.stringify(served)} is still an answer`);
		assert.equal(
			strict.isOwner,
			false,
			`a served ${JSON.stringify(served)} is not lesser's true, and must not mount an owner's panel`
		);
	}

	// An agent the instance will not resolve is a failure, not a `false`: the two
	// are classified apart below, and folding them here would report a broken read
	// as lesser's answer about this viewer.
	const { result: missing } = await readOwnership({ data: { agent: null } }, { accessToken: 't' });
	assert.equal(missing.ok, false);
	assert.equal(missing.failure?.reason, 'not-found');
});

test('four states, because three of them are different facts that all permit nothing', () => {
	// THE CLASSIFIER IS THE CONTRACT, and it is a pure function so this drives it
	// directly instead of inferring a verdict from a rendered screen.
	assert.equal(ownershipState(null), 'unknown', 'nothing has asked yet');
	assert.equal(ownershipState({ ok: true, isOwner: true }), 'owner');
	assert.equal(ownershipState({ ok: true, isOwner: false }), 'not-owner', 'lesser’s served false');
	assert.equal(
		ownershipState({ ok: false, failure: { reason: 'transport', message: 'No answer.' } }),
		'unanswered',
		'lesser did not answer at all'
	);

	// AND THE ONE COLLAPSION THIS FACE FORBIDS, asserted as the inequality it is.
	// `unanswered` and `not-owner` both mount nothing, which makes folding them
	// the tempting simplification — and folding them tells an owner whose read hit
	// a network fault that this instance said they do not own their agent. That is
	// asserting access lesser has not confirmed, in the negative direction, which
	// is the same substitution the invariant rules out in the positive one.
	assert.notEqual(
		ownershipState({ ok: false, failure: { reason: 'transport', message: 'No answer.' } }),
		ownershipState({ ok: true, isOwner: false }),
		'a read that failed is not a served no'
	);
});

test('the gate mounts on one state and speaks on one other', () => {
	// `unknown` and `not-owner` render NOTHING and say nothing: a management
	// surface that is absent is not a claim, and announcing the absence to every
	// visitor who does not own the agent is noise about a question they did not
	// ask. `unanswered` is the one branch that speaks, because it is the one where
	// silence would be read as an answer. What this pins is that those are the
	// only two branches the component has — a third comparison is a third way to
	// mount, and it would not be `owner`.
	const ast = parse(readFileSync(join(repoRoot, 'src/lib/agents', OWNER_GATE_FILE), 'utf8'), {
		modern: true,
	});

	const branches = [];
	for (const { node } of walkTemplate(ast.fragment)) {
		if (node.type !== 'IfBlock') continue;
		if (!expressionReads(node.test, GATE_BINDING)) continue;
		const test = node.test;
		branches.push(
			test?.type === 'BinaryExpression' && test.right?.type === 'Literal'
				? test.right.value
				: `<${test?.type ?? 'missing'}>`
		);
	}

	assert.deepEqual(
		branches,
		['owner', 'unanswered'],
		'the ownership gate branches on `owner` to mount and on `unanswered` to explain, and on nothing else'
	);
});

test('the agent page’s server pass asks nothing about the viewer', async () => {
	// THE PUBLIC HALF OF THE SPLIT. This route's props are serialized into
	// contentus's public hydration endpoint, so a server-side ownership read
	// would put one reader's answer behind a URL anyone could request — the
	// defect `myAgents is never fetched on the server pass` holds against the
	// roster, on the page the owner's panels moved to. What the server paint
	// costs is therefore part of this milestone's contract: one anonymous detail
	// read, and nothing about the viewer.
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusAgent' ? { data: { agent: agentNode() } } : { data: null },
		() => renderRoute(handler, route('agent-detail'))
	);

	assert.equal(value.status, 200);
	assert.deepEqual(
		requests.filter((r) => r.operation === 'ContentusAgentOwnership'),
		[],
		'the ownership read is client-only'
	);
	assert.equal(
		requests.filter((r) => r.operation === 'ContentusAgent').length,
		1,
		'and the page’s own read is still exactly one'
	);
	assert.equal(requests[0].authorization, null, 'which the server makes anonymously');

	// Nothing of the client-only half is in the paint either: no ownership copy,
	// and neither owner panel — which is also what makes the notice's wording safe
	// to write at all, since it can only ever be read by the viewer it is about.
	assert.ok(!value.html.includes('is yours'), 'no ownership statement is served publicly');
	assert.ok(!value.html.includes('Sharing @weatherbot'), 'and no owner panel is in the paint');
});

test('neither list on the agents route reads per agent', () => {
	// THE TWO COUNTS THIS MILESTONE EXISTS TO CHANGE, held at their new values.
	// Opening `/agents` used to cost 2M requests for M owned agents — a share
	// grant list and an activity log per owned agent, mounted from the roster
	// before anyone had said which agent they cared about — and one MCP-access
	// read per shared-with-me row on top. A list is navigation: it costs one read
	// for itself and nothing per row.
	//
	// STRUCTURAL, and labelled as one, because the repo has no DOM harness: this
	// reads each component's COMPILED client script and counts dispatch sites.
	// What that proves is stronger than a request count over one render — no
	// per-agent reader is even in scope on either list, so a loop this probe
	// cannot see would still have to name one to call it.
	const LISTS = [
		{
			file: 'MyAgents.svelte',
			reads: ['fetchMyAgents'],
			neverNames: [
				'listShareGrants',
				'loadAgentDrivers',
				'fetchAgentOwnership',
				'fetchAgentMcpAccess',
			],
			neverMounts: ['AgentSharingPanel', 'AgentDriversPanel', 'AgentOwnerPanels'],
		},
		{
			file: 'AgentSharedWithMePanel.svelte',
			reads: ['listSharedWithMe'],
			neverNames: [
				'listShareGrants',
				'loadAgentDrivers',
				'fetchAgentOwnership',
				'fetchAgentMcpAccess',
			],
			neverMounts: [],
		},
	];

	for (const list of LISTS) {
		const source = readFileSync(join(repoRoot, 'src/lib/agents', list.file), 'utf8');
		const ast = parse(source, { modern: true });
		const named = sourceIdentifiers(liveScript(list.file, source));

		for (const read of list.reads) {
			assert.ok(named.includes(read), `${list.file} reads its own list, through ${read}`);
			assert.equal(
				dispatchSites(ast.instance, read).length,
				1,
				`${list.file} dispatches ${read} from exactly one place: a second dispatch is a second reader, and a dispatch inside a row loop is the fan-out returning`
			);
		}

		for (const reader of list.neverNames) {
			assert.ok(
				!named.includes(reader),
				`${list.file} must not name ${reader} — a per-agent read on a list is one request per row on it, for agents the reader has not chosen`
			);
		}

		// COMPILED SOURCE, not the file: both components discuss where the owner's
		// panels went at length, so a text search matches the explanation and
		// passes on a component that put the mount back.
		for (const panel of list.neverMounts) {
			assert.ok(
				!named.includes(panel),
				`${list.file} must not mount ${panel}: the owner's panels are on the agent page (equaltoai/contentus#119)`
			);
		}
	}
});

test('no component on the face binds a rune’s name', () => {
	// WHY THIS IS A PROBE AND NOT A STYLE PREFERENCE. `$state` in a Svelte
	// component is ambiguous: it is the rune, and it is also the auto-subscription
	// of a store named `state`. A component that BINDS that name and calls
	// `$state<T>(…)` anywhere else in the same file has every one of those calls
	// read as the subscription instead, and what `svelte-check` then reports is not
	// "you named a variable badly" but six errors about untyped calls taking type
	// arguments and values inferred as `any` from a circularity that does not exist
	// — including the ownership gate's own classification. Found on this face in
	// equaltoai/contentus#119, where the binding was
	// `const state = $derived(ownershipState(ownership))` beside two `$state<…>`
	// declarations, and the fix was a rename.
	//
	// THE BUILD IS THE REAL GATE AND THIS IS THE CHEAP ONE. `pnpm build` runs
	// `svelte-check --threshold error`, so that combination cannot ship. What the
	// build does NOT catch is the same collision in a file that spells `$state(…)`
	// with no type argument: the rune still resolves to the subscription, the
	// binding is simply `any`, and nothing reports. That case is silent, which is
	// why the name is refused outright rather than only in the reported
	// combination — and why the refusal covers every rune, not only `state`.
	//
	// SCOPED TO THE FACE because that is the tree this change touched. The rest of
	// the repository has two `state` bindings today and neither is in the reported
	// combination (`components/auth/Root.svelte` makes no other `$state` call,
	// `review/VerdictPanel.svelte` makes none at all), so widening this is a
	// follow-up rather than something this milestone can assert honestly.
	const RUNE_NAMES = ['state', 'derived', 'props', 'effect', 'bindable', 'inspect'];

	const offenders = [];
	for (const path of trackedSource(repoRoot, 'src/lib/agents', /\.svelte$/)) {
		const ast = parse(readFileSync(path, 'utf8'), { modern: true });
		for (const node of walkAst(ast.instance)) {
			if (node.type !== 'VariableDeclarator') continue;
			const names =
				node.id?.type === 'Identifier'
					? [node.id.name]
					: node.id?.type === 'ObjectPattern'
						? node.id.properties
								.map((property) => property.value?.name ?? property.key?.name)
								.filter(Boolean)
						: [];
			for (const name of names)
				if (RUNE_NAMES.includes(name)) offenders.push(`${relative(repoRoot, path)}: ${name}`);
		}
	}

	assert.deepEqual(
		offenders,
		[],
		'a binding named after a rune makes every call of that rune in the file ambiguous to the language tooling — rename the binding, not the rune'
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

test('the grantee’s panel assembles no part of an endpoint, and links to the page that states it', () => {
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

	// THE POSITIVE HALF CHANGED WITH THE ROW (equaltoai/contentus#119), AND IT IS
	// STILL THE HALF THAT MATTERS. "No URL literals" is equally true of a panel
	// that shows no endpoint at all, so what the panel DOES is asserted beside it.
	// It used to be a read: `fetchAgentMcpAccess` once per grant, classified by
	// `sharedMcpAccess`, printing one URL beside the link that led to it. It is now
	// the link — lesser's whole bundle is rendered on the agent page from
	// `AGENT_DETAIL_QUERY`, for the one agent the reader actually opened — so the
	// assertion is that every row goes there, and that no MCP reader is in scope
	// here to reach the fan-out by. Both classifier and reader left with their
	// only caller: an export nothing calls is a rule nobody is following.
	const source = readFileSync(
		join(repoRoot, 'src/lib/agents/AgentSharedWithMePanel.svelte'),
		'utf8'
	);
	const named = sourceIdentifiers(liveScript('AgentSharedWithMePanel.svelte', source));
	assert.ok(
		!named.includes('fetchAgentMcpAccess'),
		'the panel reads no MCP bundle: one read per row to restate a URL is a request per row for the page that states it in full'
	);
	assert.ok(
		!named.includes('location'),
		'never from the page origin, which is the app host and a different one'
	);
	assert.ok(
		named.includes('agentHref'),
		'and the way off a row is the routing helper, not an address this file spelled'
	);

	// EVERY ROW, rather than "there is a link in the file". A row with no way off
	// it is the defect the endpoint's removal would otherwise leave behind: the
	// grantee is told they hold access to an agent and given nowhere to go.
	const ast = parse(source, { modern: true });
	const lists = [...walkAst(ast.fragment)].filter(
		(node) =>
			node.type === 'EachBlock' &&
			node.expression?.type === 'MemberExpression' &&
			node.expression.object?.name === 'ledger' &&
			node.expression.property?.name === 'current'
	);
	assert.equal(lists.length, 1, 'the panel lists the classifier’s active side exactly once');

	const links = [...walkAst(lists[0].body)].filter(
		(node) => node.type === 'RegularElement' && node.name === 'a'
	);
	assert.ok(links.length > 0, 'and a row is not a dead end');
	for (const link of links) {
		const href = [...walkAst(link.attributes)].find(
			(node) => node.type === 'CallExpression' && node.callee?.name === 'agentHref'
		);
		assert.ok(href, 'the way off a row is the agent page, through the routing helper');
		assert.equal(
			href.arguments?.[0]?.object?.name,
			'grant',
			'and it is THIS row’s agent — a link built from anything else sends every row to one page'
		);
		assert.equal(href.arguments?.[0]?.property?.name, 'agent_username');
	}
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

/* THE MCP FAN-OUT'S PROVING MACHINERY WENT WITH THE FAN-OUT
 * (equaltoai/contentus#119), and what it proved is recorded here rather than
 * left as a hole, because it was a large piece of this file and a reader will
 * look for it.
 *
 * WHAT IT WAS. `AgentSharedWithMePanel` read one MCP-access bundle per grant —
 * `fetchAgentMcpAccess` in a loop over `accessLedger(result).current`, each
 * publish guarded by the session stamp and the abort. Two probes held it: that
 * the loop was handed the classifier's ACTIVE side and not lesser's unsplit
 * answer, and that it narrowed nothing on the way — no `if`, no `?:`, no `&&`,
 * no `switch`, no `continue`/`break`, and one allowlisted read (`map`) of the
 * list it was given. Behind them stood an enumerated closure over JavaScript's
 * conditionals, a walk that stopped at nested scopes so a publish guard was not
 * misread as a row selection, and a mutant sweep that had already found one
 * bypass a narrower enumeration let through.
 *
 * WHY DELETING IT IS NOT A LOSS OF COVERAGE. The subject is gone: the panel
 * makes one request, the grant list, and reads no MCP bundle at all. There is no
 * second reader of the classified set for a second classifier to disagree with,
 * which is the defect that machinery existed to make impossible. The properties
 * it was built from are still held, and by stronger probes because they no
 * longer have to reason about a loop: `the grantee list is the classifier's
 * output` still holds the rendered list to `accessLedger` and forbids a
 * `.filter` written back beside it; `neither list on the agents route reads per
 * agent` counts the panel's dispatch sites and asserts no per-agent reader is
 * even in scope on it; and `the grantee's panel assembles no part of an
 * endpoint` holds what the fan-out was FOR — that the endpoint is lesser's
 * string and never built here — now on the page that states the whole bundle.
 *
 * WHAT WOULD BRING IT BACK. A second per-row read on any list. If one is ever
 * added, the provenance question returns with it and so does the enumeration —
 * recovered from this file's history rather than rewritten, since the lesson it
 * encoded was that a narrowing can be spelled six ways and a probe that lists
 * three of them is a probe a one-character bypass survives.
 */

/** The initializer of `<name> = …` in a parsed script, or null when nothing declares it. */
function declaratorInit(script, name) {
	for (const node of walkAst(script))
		if (node.type === 'VariableDeclarator' && node.id?.name === name) return node.init ?? null;
	return null;
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

	// ONE CLASSIFIER IN THE FILE, and there used to be a reason to say it that has
	// gone: the MCP fan-out was a second reader of the same set and carried its
	// own copy of the truthiness filter, so two filters that had to agree were one
	// correction away from disagreeing. equaltoai/contentus#119 removed that reader
	// — the panel makes one request and links to the agent page — and the
	// assertion stays, because a `.filter` written back beside `accessLedger` is
	// the same defect whether or not anything else reads the set.
	//
	// THIS IS THE FILTER'S ABSENCE AND NOTHING MORE. It says no `.filter` was
	// written back; it does not say what the panel reads instead, which
	// `neither list on the agents route reads per agent` counts, and it does not
	// say where a row goes, which `the grantee's panel assembles no part of an
	// endpoint` holds. Neither stands in for the other.
	assert.ok(
		!callsFn(ast.instance, 'filter'),
		'the panel must not filter the grant list itself: `accessLedger` is the classification, and a second filter beside it is the half a fix forgets'
	);
	assert.ok(
		callsFn(ast.instance, 'accessLedger'),
		'and it must actually classify — a list rendered straight from lesser’s answer is the defect with the filter merely deleted'
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
	// `AgentOwnerPanels` mounts on the agent page behind lesser's served
	// `viewerIsOwner` (probed above), and any second caller would be a surface
	// reaching for the audit view without that gate over it.
	//
	// THE MOUNT MOVED IN equaltoai/contentus#119 AND THIS ASSERTION DID NOT, which
	// is the point of keeping it as a caller sweep rather than as a fact about one
	// file's template: it names no parent, so relocating the panel changed where
	// the gate is and left the claim — one caller, the owner's panel — exactly as
	// it was.
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

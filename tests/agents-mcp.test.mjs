import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	mcpClientConfigs,
	mcpConnectOriginForInstance,
	resolveMcpProbeTargets,
	toMcpDiscoveryDocument,
	toOAuthProtectedResourceDocument,
} from '../src/lib/agents/mcp.ts';
import { fetchAgent, toAgentSummary } from '../src/lib/agents/contract.ts';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';
// THE GATE'S OWN SCANNER, imported rather than reproduced.
//
// This file used to carry its own comment-masking regex. Two things were wrong
// with that, and they compound. It was a SECOND COPY of what
// `scripts/audit-renderer-authority.mjs` runs, so it could go green against
// itself while the gate scanned something else — the drift shape
// `scripts/lib/strip-comments.mjs` exists to end. And the copy was a
// `replace(/<!--…-->/g, '')`, which CodeQL flags as
// `js/incomplete-multi-character-sanitization` (CWE-116) because a nested
// delimiter lets it REINTRODUCE a comment around live template and erase a real
// `{@html}` sink — reporting this face clean over a defect. The regression case
// below drives the imported scanner over exactly that input.
import { stripComments } from '../scripts/lib/strip-comments.mjs';
import { renderComponent } from './helpers/svelte-server.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

/**
 * `mcpAccess` exactly as lesser's `BuildPublicMCPAccessBundle` produces it:
 * MCP canonicalised onto `api.<domain>`, the OAuth surfaces on the apex.
 */
const ACCESS = {
	mcpURL: 'https://api.example.invalid/mcp/weatherbot',
	protectedResourceURL:
		'https://api.example.invalid/.well-known/oauth-protected-resource/mcp/weatherbot',
	authorizationServerURL: 'https://example.invalid/.well-known/oauth-authorization-server',
	registrationURL: 'https://example.invalid/oauth/register',
	scopes: ['read', 'write', 'follow', 'push'],
	guidance: [
		'Start from the actor-scoped MCP URL.',
		'Use that same MCP URL as the OAuth resource value.',
	],
};

function agentNode(overrides = {}) {
	return {
		id: 'https://example.invalid/users/weatherbot',
		username: 'weatherbot',
		displayName: 'Weather Bot',
		bio: null,
		agentType: 'CURATOR',
		agentVersion: '1.4.0',
		verified: true,
		verifiedAt: '2026-06-01T00:00:00Z',
		quarantineStatus: null,
		quarantineStart: null,
		quarantineEnd: null,
		quarantineActive: false,
		createdAt: '2026-01-01T00:00:00Z',
		activityCount: 12,
		agentCapabilities: null,
		mcpAccess: ACCESS,
		...overrides,
	};
}

/* -------------------------------------------------------------------------
 * The URLs are lesser's, not ours
 * ---------------------------------------------------------------------- */

test('the endpoint and protected-resource URL are lesser’s, verbatim', () => {
	const targets = resolveMcpProbeTargets(ACCESS);

	// NOT rebuilt from the page origin the way sim's `resolveMcpTransport` does.
	// lesser's `BuildPublicMCPAccessBundle` is the authority for these strings.
	assert.equal(targets.endpoint, ACCESS.mcpURL);
	assert.equal(targets.protectedResourceUrl, ACCESS.protectedResourceURL);
});

test('only the discovery path is derived, and only beneath the host lesser named', () => {
	const targets = resolveMcpProbeTargets(ACCESS);

	// `mcpAccess` names four URLs and `/.well-known/mcp.json` is not among them.
	// It hangs off the MCP URL's own origin — never off the app origin, which is
	// a different host: lesser canonicalises MCP onto `api.<domain>`.
	assert.equal(targets.discoveryUrl, 'https://api.example.invalid/.well-known/mcp.json');
	assert.equal(targets.origin, 'https://api.example.invalid');
});

test('an instance publishing no MCP endpoint is a state, not a failure', () => {
	// `BuildPublicMCPAccessBundle` returns a guidance-only bundle with empty URLs
	// when it cannot name a base URL or an actor.
	assert.equal(resolveMcpProbeTargets({ mcpURL: '', protectedResourceURL: '' }), null);
	assert.equal(resolveMcpProbeTargets({ mcpURL: null, protectedResourceURL: null }), null);
	// And a malformed one is not turned into a probe against something else.
	assert.equal(resolveMcpProbeTargets({ mcpURL: 'not a url', protectedResourceURL: null }), null);
});

test('the CSP ceiling derives lesser’s own canonicalisation, or nothing at all', () => {
	// The detail route is a session read now, so the server cannot read the
	// probe origin off a fetched agent's `mcpAccess`. The ceiling is the one
	// fact the server does know — where this instance lives — run through
	// lesser's own `canonicalMCPResourceBaseURL` rule.
	assert.equal(
		mcpConnectOriginForInstance('https://trenchcoat.example.invalid'),
		'https://api.trenchcoat.example.invalid'
	);
	// Scheme and port travel, so a non-TLS or non-standard instance is covered.
	assert.equal(
		mcpConnectOriginForInstance('http://trenchcoat.example.invalid:8443'),
		'http://api.trenchcoat.example.invalid:8443'
	);
	// An already-prefixed host is not stacked.
	assert.equal(
		mcpConnectOriginForInstance('https://api.trenchcoat.example.invalid'),
		'https://api.trenchcoat.example.invalid'
	);
	// Local instances keep MCP on the instance host (lesser's
	// `isLocalMCPHostname`), so the probes are same-origin and 'self' already
	// covers them — no widening to give.
	assert.equal(mcpConnectOriginForInstance('http://localhost:8080'), null);
	assert.equal(mcpConnectOriginForInstance('http://dev.localhost:3000'), null);
	// And an unusable origin widens nothing.
	assert.equal(mcpConnectOriginForInstance(null), null);
	assert.equal(mcpConnectOriginForInstance(undefined), null);
	assert.equal(mcpConnectOriginForInstance('nonsense'), null);
});

/* -------------------------------------------------------------------------
 * Documents
 * ---------------------------------------------------------------------- */

test('the discovery document is read as lesser-body serializes it', () => {
	const doc = toMcpDiscoveryDocument({
		name: 'lesser-body',
		version: '1.6.0',
		endpoint: ACCESS.mcpURL,
		capabilities: { tools: true, resources: true, prompts: false, completions: true },
		auth: { type: 'bearer', scopes: ['read', 'write'], notes: 'Use a Lesser OAuth access token.' },
		tools: [
			{ name: 'timeline_read', description: 'Read a timeline.' },
			{ name: 'post_create' },
			{ description: 'nameless, and therefore not a tool' },
		],
	});

	assert.equal(doc.name, 'lesser-body');
	assert.equal(doc.authType, 'bearer');
	assert.deepEqual(doc.authScopes, ['read', 'write']);

	// Capabilities are carried as the server's own map. lesser-body adds keys —
	// `tasks` appears only when task discovery is enabled — so a fixed list of
	// the four that exist today would silently drop whatever it did not know.
	assert.deepEqual(
		doc.capabilities.map((c) => `${c.name}:${c.enabled}`),
		['tools:true', 'resources:true', 'prompts:false', 'completions:true']
	);

	assert.deepEqual(
		doc.tools.map((t) => t.name),
		['timeline_read', 'post_create']
	);
	assert.equal(doc.tools[1].description, null);
});

test('a document that is missing or the wrong shape yields empties, never throws', () => {
	// A probe returning something unexpected must degrade to "nothing to show",
	// because the panel's job at that point is to report the answer it got.
	for (const raw of [null, undefined, [], 'nope', 42, {}]) {
		const doc = toMcpDiscoveryDocument(raw);
		assert.deepEqual(doc.tools, []);
		assert.deepEqual(doc.capabilities, []);
		assert.equal(doc.name, null);
	}
});

test('the protected-resource document is read with its RFC 9728 field names', () => {
	const doc = toOAuthProtectedResourceDocument({
		resource: ACCESS.mcpURL,
		authorization_servers: ['https://example.invalid'],
		scopes_supported: ['read', 'write'],
		bearer_methods_supported: ['header'],
	});

	assert.equal(doc.resource, ACCESS.mcpURL);
	assert.deepEqual(doc.authorizationServers, ['https://example.invalid']);
	assert.deepEqual(doc.scopesSupported, ['read', 'write']);
	assert.deepEqual(doc.bearerMethodsSupported, ['header']);
});

/* -------------------------------------------------------------------------
 * Client configs
 * ---------------------------------------------------------------------- */

test('client configs carry lesser’s values and never a credential', () => {
	const targets = resolveMcpProbeTargets(ACCESS);
	const configs = mcpClientConfigs('weatherbot', targets, ACCESS);

	const claude = configs.find((c) => c.id === 'claude-code');
	const parsed = JSON.parse(claude.body);
	assert.equal(parsed.mcpServers['lesser-weatherbot'].url, ACCESS.mcpURL);

	// A placeholder, not a token. contentus never had one — the panel is
	// anonymous — and a snippet that looked ready to run would be advertising a
	// credential that does not exist.
	assert.match(parsed.mcpServers['lesser-weatherbot'].headers.Authorization, /<access-token>/);

	const oauth = JSON.parse(configs.find((c) => c.id === 'oauth').body);
	// RFC 8707, and lesser's own guidance: the resource value IS the MCP URL.
	assert.equal(oauth.resource, ACCESS.mcpURL);
	assert.equal(oauth.scope, 'read write follow push');

	for (const config of configs) {
		assert.ok(
			!/Bearer\s+[A-Za-z0-9._-]{16,}/.test(config.body),
			`${config.id} must not contain anything shaped like a real token`
		);
	}
});

test('the OAuth snippet names each of lesser’s four URLs as the thing it is', () => {
	// THE FIXTURE IS DELIBERATELY UN-SUBSTITUTABLE. All four URLs differ, and the
	// OAuth pair sits on the APEX while the MCP pair sits on `api.` — which is
	// how `BuildPublicMCPAccessBundle` actually returns them. An earlier version
	// filled `authorization_server` with the protected-resource URL and the
	// assertions could not tell, because the fixture let one stand for another.
	const targets = resolveMcpProbeTargets(ACCESS);
	const oauth = JSON.parse(
		mcpClientConfigs('weatherbot', targets, ACCESS).find((c) => c.id === 'oauth').body
	);

	assert.equal(oauth.authorization_server, ACCESS.authorizationServerURL);
	assert.equal(oauth.registration_endpoint, ACCESS.registrationURL);
	assert.equal(oauth.protected_resource_metadata, ACCESS.protectedResourceURL);
	assert.equal(oauth.resource, ACCESS.mcpURL);

	// Each of the other three explicitly, because "not the protected-resource
	// URL" is the specific substitution that happened.
	assert.notEqual(oauth.authorization_server, ACCESS.protectedResourceURL);
	assert.notEqual(oauth.authorization_server, ACCESS.mcpURL);
	assert.notEqual(oauth.registration_endpoint, ACCESS.authorizationServerURL);

	// And the whole snippet stays on the hosts lesser named for each half.
	assert.match(oauth.authorization_server, /^https:\/\/example\.invalid\//);
	assert.match(oauth.protected_resource_metadata, /^https:\/\/api\.example\.invalid\//);
});

test('a URL lesser did not publish is named as unpublished, not guessed at', () => {
	// `BuildPublicMCPAccessBundle` can return a bundle whose OAuth URLs are empty.
	// Filling them with something plausible would send a client to an address the
	// instance never claimed; the protected-resource document's
	// `authorization_servers` array is where it should look instead, and saying so
	// is the honest answer.
	const targets = resolveMcpProbeTargets(ACCESS);
	const oauth = JSON.parse(
		mcpClientConfigs('weatherbot', targets, {
			authorizationServerURL: null,
			registrationURL: null,
			scopes: [],
		}).find((c) => c.id === 'oauth').body
	);

	assert.match(oauth.authorization_server, /authorization_servers/);
	assert.match(oauth.registration_endpoint, /authorization server document/);
	// Never the protected-resource URL standing in for the authorization server.
	assert.ok(!oauth.authorization_server.startsWith('http'));
	// The addresses lesser DID publish are unaffected, and an empty scope set
	// falls back to the read scope rather than to an empty `scope=`.
	assert.equal(oauth.resource, ACCESS.mcpURL);
	assert.equal(oauth.protected_resource_metadata, ACCESS.protectedResourceURL);
	assert.equal(oauth.scope, 'read');
});

/* -------------------------------------------------------------------------
 * The seam and the renderer line
 * ---------------------------------------------------------------------- */

test('the detail route imports the seam, not the panel behind it', () => {
	const source = readFileSync(join(repoRoot, 'src/lib/routes/AgentDetailRoute.svelte'), 'utf8');
	const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

	assert.ok(specifiers.some((s) => s.endsWith('/AgentDetail.svelte')));
	assert.ok(
		!specifiers.some((s) => s.endsWith('/AgentMcpPanel.svelte')),
		'the MCP panel is its own swap seam and the route must not reach past it'
	);
});

test('nothing in the agent face renders HTML it built', () => {
	// Belt and braces over `scripts/audit-renderer-authority.mjs`, which scans
	// this directory on every build. The panel handles URLs and JSON from lesser
	// and lesser-body; all of it is TEXT, and an HTML sink here would be a defect
	// regardless of where the string came from.
	for (const file of [
		'src/lib/agents/AgentMcpPanel.svelte',
		'src/lib/agents/CopyBlock.svelte',
		'src/lib/agents/AgentDetail.svelte',
		'src/lib/agents/AgentRoster.svelte',
		'src/lib/agents/AgentCard.svelte',
	]) {
		assert.ok(
			!/\{@html\s/.test(stripComments(readFileSync(join(repoRoot, file), 'utf8'))),
			`${file} must not carry an HTML sink`
		);
	}
});

test('the HTML-sink check can still see a sink, and no longer sees one in prose', () => {
	// Both halves of the distinction, so the guard above is known to be able to
	// fail rather than merely observed to pass.
	assert.ok(/\{@html\s/.test(stripComments('<p>{@html body}</p>')));
	assert.ok(!/\{@html\s/.test(stripComments('<!-- never use {@html} here -->')));
});

test('a nested comment delimiter cannot hide a live sink from this face’s check', () => {
	// THE REGRESSION THAT DECIDED THE IMPORT ABOVE. This file used to carry its
	// own `source.replace(/<!--[\s\S]*?-->/g, '')`, which is the shape CodeQL
	// flags as `js/incomplete-multi-character-sanitization` (CWE-116) — and the
	// rule is right about the consequence, not merely pedantic about the form:
	//
	//   <!<!-- -->-- {@html evil} -->
	//
	// A parser finds its first `<!--` at index 2, so the comment is `<!-- -->`
	// and the sink after it is LIVE template. The single-pass replace removes the
	// inner match and REINTRODUCES `<!-- … -->` around the sink; a second pass —
	// the loop-until-stable fix the rule recommends — then deletes the sink with
	// it, and this face's check reports a clean file over a live `{@html}`.
	const nested = '<!<!-- -->-- {@html evil} -->';

	assert.match(
		stripComments(nested),
		/\{@html evil\}/,
		'a live sink must survive the strip, or this check cannot see it'
	);

	// The replace form is NOT reproduced here to demonstrate its failure: writing
	// it back into this file is what the alert is about, and a probe that plants
	// the defect it is testing for is not a probe. What the discarded form does to
	// this exact string is pinned once, in `tests/vendored-messaging-render.test.mjs`,
	// against the same scanner — and `scripts/lib/strip-comments.mjs` carries the
	// reasoning in full.
	assert.equal(
		stripComments('<p>keep</p><!-- drop --><span>keep</span>'),
		'<p>keep</p><span>keep</span>'
	);
	// An unterminated opener consumes the rest, which is what a parser does too.
	assert.equal(stripComments('ok <!-- never closed {@html x}'), 'ok ');
});

/* -------------------------------------------------------------------------
 * SSR: the server paints the gate; CSP is derived, not fetched
 * ---------------------------------------------------------------------- */

test('the server renders the session gate and makes no read of its own', async () => {
	// The detail is a session read now: the gateway refuses anonymous
	// `agent(username)` before the resolver runs, so the published MCP contract
	// arrives with the client's session fetch rather than in the server's
	// paint. The server makes NO fetch at all — no detail read (it would 401),
	// and no discovery probe of its own: the probes are the reader's browser
	// reaching a sibling origin, and running them here would report the SSR
	// host's reachability rather than the reader's and make a cold page wait
	// on a third host.
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) => {
			throw new Error(`the server must not call lesser for the detail (${operation})`);
		},
		() => renderRoute(handler, route('agent-detail'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Reading your session'), 'the gate is the server’s paint');
	assert.deepEqual(requests, [], 'no GraphQL read and no off-origin probe');
});

test('CSP permits the canonical MCP origin for the instance, and nothing wider', async () => {
	// The allowance used to be read off the fetched agent's `mcpAccess` — the
	// narrowest possible source, and one the session read took away. It is now
	// derived from the request origin with lesser's own canonicalisation rule
	// (`mcpConnectOriginForInstance`): one sibling origin, on the one route
	// whose panel probes it. The probe TARGETS are unchanged — whatever lesser
	// states for the agent — so an agent publishing no endpoint fires no probe
	// even though the ceiling is there.
	const handler = await loadHandler();
	const value = await renderRoute(handler, route('agent-detail'));
	const csp = value.headers['content-security-policy'];

	const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
	assert.match(connect, /'self'/);
	assert.match(connect, /https:\/\/api\.contentus-audit\.invalid/);

	// Still strict everywhere else — the widening is one origin on one directive.
	assert.ok(!csp.includes('unsafe-inline'), 'no unsafe-inline');
	assert.ok(!csp.includes('unsafe-eval'), 'no unsafe-eval');
	assert.ok(
		!/script-src[^;]*api\.contentus-audit\.invalid/.test(csp),
		'script-src must not be widened'
	);
	assert.ok(
		!/style-src[^;]*api\.contentus-audit\.invalid/.test(csp),
		'style-src must not be widened'
	);
});

test('no other route gets the MCP widening', async () => {
	// The ceiling is scoped to the route that probes. Everywhere else
	// `connect-src` stays at FaceTheory's canonical policy plus what that
	// route's own traffic needs.
	const handler = await loadHandler();
	const value = await renderRoute(handler, route('articles-index'));

	const connect = /connect-src ([^;]+)/.exec(value.headers['content-security-policy'])?.[1] ?? '';
	assert.ok(
		!connect.includes('api.contentus-audit.invalid'),
		'nothing to probe, nothing permitted'
	);
});

/* -------------------------------------------------------------------------
 * The client read: the contract arrives with the session fetch
 * ---------------------------------------------------------------------- */

/** `fetchAgent` against a stubbed `fetch`, recording what was sent. */
function stubbedAgentFetch(respond) {
	const requests = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		requests.push({
			query: payload.query ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
		});
		return new Response(JSON.stringify(respond() ?? { data: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	return {
		requests,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

test('the published MCP contract renders with every address lesser stated', async () => {
	// `mcpAccess` is not redacted for non-owners, so this is visible to any
	// signed-in reader by lesser's decision. The render is the component's now
	// — the server pass ships the gate — with the same props the old SSR pass
	// produced.
	const agent = toAgentSummary(agentNode(), false);
	const html = await renderComponent('src/lib/agents/AgentDetail.svelte', {
		agent,
		failure: null,
		username: 'weatherbot',
	});

	assert.ok(html.includes(ACCESS.mcpURL), 'the MCP endpoint must be rendered');
	assert.ok(html.includes(ACCESS.protectedResourceURL));
	assert.ok(html.includes(ACCESS.authorizationServerURL));
	assert.ok(html.includes(ACCESS.registrationURL));
	// lesser's guidance, verbatim.
	assert.ok(html.includes('Start from the actor-scoped MCP URL.'));
});

test('an agent publishing no MCP endpoint gets the stated-empty panel, not probes', async () => {
	const agent = toAgentSummary(
		agentNode({ mcpAccess: { ...ACCESS, mcpURL: '', protectedResourceURL: '' } }),
		false
	);
	const html = await renderComponent('src/lib/agents/AgentDetail.svelte', {
		agent,
		failure: null,
		username: 'weatherbot',
	});

	assert.ok(html.includes('publishes no MCP endpoint for this agent'));
});

test('an agent that does not resolve says so rather than rendering an empty panel', async () => {
	const stub = stubbedAgentFetch(() => ({ data: { agent: null } }));
	try {
		const result = await fetchAgent(
			{ endpoint: 'https://instance.invalid/api/graphql', accessToken: 'token-ada' },
			'weatherbot'
		);
		assert.equal(result.ok, false);
		assert.equal(result.failure.reason, 'not-found');
		assert.equal(result.failure.message, 'No agent matches this address.');
	} finally {
		stub.restore();
	}

	const html = await renderComponent('src/lib/agents/AgentDetail.svelte', {
		agent: null,
		failure: { reason: 'not-found', message: 'No agent matches this address.' },
		username: 'weatherbot',
	});
	assert.ok(html.includes('No agent matches this address.'));
	assert.ok(!html.includes('MCP endpoint'), 'no panel for an agent that is not there');
});

test('owner-only fields are requested only when a token travels, and rendered only when answered', async () => {
	// The detail read has two query documents: the owner selection is asked
	// ONLY with a token, because lesser redacts silently and "we sent a token"
	// is not evidence the token was the owner's.
	const withToken = stubbedAgentFetch(() => ({ data: { agent: agentNode() } }));
	try {
		await fetchAgent({ endpoint: 'https://instance.invalid/api/graphql', accessToken: 't' }, 'w');
	} finally {
		withToken.restore();
	}
	assert.match(withToken.requests[0].query, /agentOwner/);

	const withoutToken = stubbedAgentFetch(() => ({ data: { agent: agentNode() } }));
	try {
		await fetchAgent({ endpoint: 'https://instance.invalid/api/graphql' }, 'w');
	} finally {
		withoutToken.restore();
	}
	assert.ok(!withoutToken.requests[0].query.includes('agentOwner'));
	assert.equal(withoutToken.requests[0].authorization, null);

	// And the redacted answer renders no owner section — lesser blanks
	// `agentOwner` to null and `delegatedScopes` to [] for non-owners, and an
	// "Owner: —" row would be reporting a redaction as a fact.
	const agent = toAgentSummary(agentNode({ agentOwner: null, delegatedScopes: [] }), false);
	const html = await renderComponent('src/lib/agents/AgentDetail.svelte', {
		agent,
		failure: null,
		username: 'weatherbot',
	});
	assert.ok(!html.includes('Delegated scopes'));
	assert.ok(!html.includes('>Owner<'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	mcpClientConfigs,
	mcpConnectOrigin,
	resolveMcpProbeTargets,
	toMcpDiscoveryDocument,
	toOAuthProtectedResourceDocument,
} from '../src/lib/agents/mcp.ts';
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

test('the CSP origin is the one lesser returned, or nothing at all', () => {
	assert.equal(mcpConnectOrigin(ACCESS), 'https://api.example.invalid');
	// No endpoint means nothing to probe, so the policy is not widened at all.
	assert.equal(mcpConnectOrigin({ mcpURL: '' }), null);
	assert.equal(mcpConnectOrigin(null), null);
	assert.equal(mcpConnectOrigin(undefined), null);
	assert.equal(mcpConnectOrigin({ mcpURL: 'nonsense' }), null);
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
	const configs = mcpClientConfigs('weatherbot', targets, ACCESS.scopes);

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
 * SSR
 * ---------------------------------------------------------------------- */

async function renderDetail(node) {
	const handler = await loadHandler();
	return withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusAgent' ? { data: { agent: node } } : { data: null },
		() => renderRoute(handler, route('agent-detail'))
	);
}

test('the published MCP contract is in the server’s paint, anonymously', async () => {
	const { value, requests } = await renderDetail(agentNode());

	assert.equal(value.status, 200);
	// Every address a client needs, with no script at all. `mcpAccess` is not
	// redacted for non-owners, so this is public by lesser's decision.
	assert.ok(value.html.includes(ACCESS.mcpURL), 'the MCP endpoint must be server-rendered');
	assert.ok(value.html.includes(ACCESS.protectedResourceURL));
	assert.ok(value.html.includes(ACCESS.authorizationServerURL));
	assert.ok(value.html.includes(ACCESS.registrationURL));
	// lesser's guidance, verbatim.
	assert.ok(value.html.includes('Start from the actor-scoped MCP URL.'));

	const agentRequests = requests.filter((r) => r.operation === 'ContentusAgent');
	assert.equal(agentRequests.length, 1);
	assert.equal(agentRequests[0].authorization, null, 'the server pass must stay anonymous');
	assert.equal(agentRequests[0].variables.username, 'weatherbot');
});

test('the server makes no probe of its own while rendering', async () => {
	// The probes are the reader's browser reaching a sibling origin. Running them
	// here would report the SSR host's reachability rather than the reader's, and
	// would make a cold page wait on a third host.
	const { requests } = await renderDetail(agentNode());

	const offOrigin = requests.filter((r) => !r.url.includes('/api/graphql'));
	assert.deepEqual(offOrigin, [], 'the SSR pass must make no discovery request');
});

test('CSP permits exactly the MCP origin lesser named, and nothing wider', async () => {
	const { value } = await renderDetail(agentNode());
	const csp = value.headers['content-security-policy'];

	const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
	assert.match(connect, /'self'/);
	assert.match(connect, /https:\/\/api\.example\.invalid/);

	// Still strict everywhere else — the widening is one origin on one directive.
	assert.ok(!csp.includes('unsafe-inline'), 'no unsafe-inline');
	assert.ok(!csp.includes('unsafe-eval'), 'no unsafe-eval');
	assert.ok(!/script-src[^;]*api\.example\.invalid/.test(csp), 'script-src must not be widened');
	assert.ok(!/style-src[^;]*api\.example\.invalid/.test(csp), 'style-src must not be widened');
});

test('an agent with no published MCP endpoint gets no CSP widening at all', async () => {
	const { value } = await renderDetail(
		agentNode({
			mcpAccess: { ...ACCESS, mcpURL: '', protectedResourceURL: '' },
		})
	);

	const connect = /connect-src ([^;]+)/.exec(value.headers['content-security-policy'])?.[1] ?? '';
	assert.ok(!connect.includes('api.example.invalid'), 'nothing to probe means nothing permitted');
	assert.ok(value.html.includes('publishes no MCP endpoint for this agent'));
});

test('an agent that does not resolve says so rather than rendering an empty panel', async () => {
	const { value } = await renderDetail(null);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('No agent matches this address.'));
	assert.ok(!value.html.includes('MCP endpoint'), 'no panel for an agent that is not there');
});

test('owner-only fields stay absent on an anonymous detail render', async () => {
	// lesser redacts `agentOwner` to null and `delegatedScopes` to [] for
	// non-owners. The anonymous SSR pass sends no token, so the section must not
	// appear at all — an "Owner: —" row would be reporting a redaction as a fact.
	const { value } = await renderDetail(agentNode({ agentOwner: null, delegatedScopes: [] }));

	assert.ok(!value.html.includes('Delegated scopes'));
	assert.ok(!value.html.includes('>Owner<'));
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);
const agentsCss = readFileSync(join(repoRoot, 'src/lib/brand/agents.css'), 'utf8');

const ACCESS = {
	mcpURL: 'https://api.example.invalid/mcp/weatherbot',
	protectedResourceURL:
		'https://api.example.invalid/.well-known/oauth-protected-resource/mcp/weatherbot',
	authorizationServerURL: 'https://example.invalid/.well-known/oauth-authorization-server',
	registrationURL: 'https://example.invalid/oauth/register',
	scopes: ['read', 'write'],
	guidance: ['Start from the actor-scoped MCP URL.'],
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
		verifiedAt: null,
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

async function renderDetail() {
	const handler = await loadHandler();
	return withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusAgent' ? { data: { agent: agentNode() } } : { data: null },
		() => renderRoute(handler, route('agent-detail'))
	);
}

/* -------------------------------------------------------------------------
 * Accordions, and which way the enhancement runs
 * ---------------------------------------------------------------------- */

test('MCP sections are native disclosure widgets, not built ones', async () => {
	const { value } = await renderDetail();

	// `<details>`/`<summary>` opens and closes with no script at all, and is a
	// real disclosure widget to a screen reader without a single ARIA attribute.
	// lesser has no SPA fallback under `/l/*`, so the first paint of a phone deep
	// link is the server's — a button-and-class-toggle would do nothing there.
	assert.match(value.html, /<details class="contentus-accordion"/);
	assert.match(value.html, /<summary class="contentus-accordion__summary"/);
});

test('the server renders every section OPEN, so no-script hides nothing', async () => {
	const { value } = await renderDetail();

	// THE DIRECTION OF THE ENHANCEMENT. Script makes a phone tidier; its absence
	// must never hide the contract. Rendering closed and opening with script
	// would leave a no-script phone reader with headings and no addresses.
	const details = value.html.match(/<details class="contentus-accordion"[^>]*>/g) ?? [];
	assert.ok(details.length >= 3, 'the panel must render its accordions');
	for (const tag of details) {
		assert.match(tag, /\sopen\b/, 'every accordion is open in the server’s paint');
	}

	// And the content really is present, not just the container.
	assert.ok(value.html.includes('Start from the actor-scoped MCP URL.'));
	assert.ok(value.html.includes(ACCESS.mcpURL));
});

test('the MCP endpoint itself never collapses', () => {
	// A reader on a phone came here for the address. The accordions wrap what is
	// around it — scopes, guidance, the catalog, the snippets — not the addresses.
	const panel = readFileSync(join(repoRoot, 'src/lib/agents/AgentMcpPanel.svelte'), 'utf8');
	const addresses = /<div class="contentus-mcp__addresses">([\s\S]*?)<\/div>/.exec(panel)?.[1];

	assert.ok(addresses, 'the address block must exist');
	assert.ok(!addresses.includes('<Accordion'), 'the addresses must not sit inside an accordion');
	assert.ok(addresses.includes('CopyBlock'), 'they are copy blocks');
});

test('collapsing is keyed to the 960px breakpoint the rest of the app uses', () => {
	const accordion = readFileSync(join(repoRoot, 'src/lib/agents/Accordion.svelte'), 'utf8');

	assert.match(accordion, /max-width: 960px/);
	// Closed only when the query MATCHES — i.e. on a phone. The desktop stays open.
	assert.match(accordion, /open = !phone\.matches/);
});

/* -------------------------------------------------------------------------
 * Single column and touch targets
 * ---------------------------------------------------------------------- */

test('the roster is single column below 960px', () => {
	const mobile = /@media \(max-width: 960px\) \{([\s\S]*?)\n\}/.exec(agentsCss)?.[1] ?? '';
	assert.match(mobile, /\.contentus-agents__grid/);
	assert.match(mobile, /grid-template-columns:\s*1fr/);
});

test('every interactive target in the face clears 44px', () => {
	// Product design §4's floor. Checked in the stylesheet rather than by
	// eyeballing components, because that is where a regression would happen.
	for (const selector of [
		'.contentus-agents__filter-input',
		'.contentus-agents__filter-submit',
		'.contentus-agents__filter-clear',
		'.contentus-agents__next',
		'.contentus-copy__button',
		'.contentus-accordion__summary',
	]) {
		const block = new RegExp(`\\${selector}[^{]*\\{([^}]*)\\}`).exec(agentsCss)?.[1] ?? '';
		assert.match(block, /min-height:\s*44px/, `${selector} must clear the 44px floor`);
	}
});

test('long URLs wrap rather than pushing the layout wide on a phone', () => {
	// MCP endpoints and actor IDs are long, and a copy block that forced
	// horizontal scroll on the whole page would break the column.
	const copyValue = /\.contentus-copy__value\s*\{([^}]*)\}/.exec(agentsCss)?.[1] ?? '';
	assert.match(copyValue, /overflow-wrap:\s*anywhere/);

	const facts = /\.contentus-mcp__facts dd\s*\{([^}]*)\}/.exec(agentsCss)?.[1] ?? '';
	assert.match(facts, /overflow-wrap:\s*anywhere/);
});

test('the accordion marker respects reduced motion', () => {
	assert.match(agentsCss, /prefers-reduced-motion: reduce/);
});

/* -------------------------------------------------------------------------
 * The swap seam, stated as a checkable property
 * ---------------------------------------------------------------------- */

test('face 6 has exactly two seams, and nothing reaches past either', () => {
	// Two rather than one because greater M6a is expected to land the roster and
	// the MCP detail as separate components; a single seam would force them to be
	// swapped together.
	const behindASeam = [
		'AgentCard',
		'AgentTrustBadge',
		'AgentRosterFilters',
		'MyAgents',
		'CopyBlock',
		'Accordion',
		'AgentCapabilities',
		'AgentTrustDetail',
	];
	const importPattern = /^[ \t]*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
	const offenders = [];

	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				if (path === join(repoRoot, 'src', 'lib', 'agents')) continue;
				walk(path);
				continue;
			}
			if (!/\.(svelte|ts)$/.test(entry)) continue;
			for (const match of readFileSync(path, 'utf8').matchAll(importPattern)) {
				for (const name of behindASeam) {
					if (match[1].endsWith(`/${name}.svelte`)) offenders.push(`${path} → ${match[1]}`);
				}
			}
		}
	};

	walk(join(repoRoot, 'src'));
	assert.deepEqual(offenders, []);
});

test('the contract modules are free of the components, so a swap cannot reach them', () => {
	// `contract.ts`, `filters.ts` and `mcp.ts` are what survive the swap. If any
	// imported a component, replacing that component would drag the contract
	// layer with it and the seam would not be a seam.
	for (const file of ['contract.ts', 'filters.ts', 'mcp.ts']) {
		const source = readFileSync(join(repoRoot, 'src/lib/agents', file), 'utf8');
		assert.ok(!source.includes('.svelte'), `${file} must not depend on any component`);
	}
});

test('the routes import only the seams', () => {
	const roster = readFileSync(join(repoRoot, 'src/lib/routes/Agents.svelte'), 'utf8');
	const detail = readFileSync(join(repoRoot, 'src/lib/routes/AgentDetailRoute.svelte'), 'utf8');

	const specifiers = (source) =>
		[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
			.map((m) => m[1])
			.filter((s) => s.endsWith('.svelte'));

	// PageFrame is vendored shell, which is allowed; the only agent component
	// each route may name is its seam.
	assert.deepEqual(
		specifiers(roster).filter((s) => s.includes('/agents/')),
		['$lib/agents/AgentRoster.svelte']
	);
	assert.deepEqual(
		specifiers(detail).filter((s) => s.includes('/agents/')),
		['$lib/agents/AgentDetail.svelte']
	);
});

test('the swap seam is documented where the next steward will look', () => {
	const doc = readFileSync(join(repoRoot, 'docs/consumption/agent-contract.md'), 'utf8');

	assert.match(doc, /AgentRoster\.svelte/);
	assert.match(doc, /AgentMcpPanel\.svelte/);
	// And it records what must NOT change when the swap happens, which is the
	// half a future reader actually needs.
	assert.match(doc, /does \*\*not\*\* change/);
});

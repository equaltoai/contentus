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

/**
 * Face 6's component graph, declared.
 *
 * THREE SEAMS, NOT TWO. The docs said two — the roster and the MCP panel — and
 * the detail route imports neither: it imports `AgentDetail.svelte`, which
 * composes the identity header, the trust detail and the capability list, and
 * nests the MCP seam inside itself. That is a third replaceable boundary, and an
 * undeclared boundary is the one nobody checks. It is named here and in
 * `docs/consumption/agent-contract.md` rather than dissolved, because the detail
 * page genuinely has a component-shaped middle: greater M6a is expected to land
 * the roster and the MCP detail separately, and the page that arranges them is
 * contentus's until it does.
 *
 * `owns` is what a seam takes with it when it is replaced. `nests` is a seam
 * composed by another seam — the only cross-seam import that is not a defect,
 * because it is the one that keeps the MCP panel independently swappable.
 * `SHARED` is imported from more than one seam by design: `AgentTrustBadge` is
 * the one pill both the roster card and the detail header show, and greater's
 * `AgentStateBadge` replaces it on both at once.
 */
const SEAMS = {
	'AgentRoster.svelte': {
		owns: ['AgentCard.svelte', 'AgentRosterFilters.svelte', 'MyAgents.svelte'],
		nests: [],
	},
	'AgentDetail.svelte': {
		owns: ['AgentCapabilities.svelte', 'AgentTrustDetail.svelte'],
		nests: ['AgentMcpPanel.svelte'],
	},
	'AgentMcpPanel.svelte': {
		owns: ['Accordion.svelte', 'CopyBlock.svelte'],
		nests: [],
	},
};
const SHARED = ['AgentTrustBadge.svelte'];

const agentsDir = join(repoRoot, 'src', 'lib', 'agents');
const importPattern = /^[ \t]*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm;

/** The agent components a source file IMPORTS — not the ones it mentions. */
function agentComponentImports(source) {
	return [...source.matchAll(importPattern)]
		.map((match) => match[1])
		.filter((specifier) => specifier.endsWith('.svelte'))
		.map((specifier) => specifier.slice(specifier.lastIndexOf('/') + 1))
		.filter((name) => name in SEAMS || SHARED.includes(name) || ownerOf(name) !== null);
}

/** Which seam a component belongs to, or null if it is not behind one. */
function ownerOf(name) {
	for (const [seam, { owns }] of Object.entries(SEAMS)) {
		if (owns.includes(name)) return seam;
	}
	return null;
}

/**
 * Every import inside the face that crosses a seam it should not.
 *
 * Taken as a parameter so the check can be run over a planted graph as well as
 * the real one — a seam check that has never been shown to fail is a seam check
 * nobody should trust.
 */
function crossSeamImports(files) {
	const offenders = [];

	for (const [file, source] of Object.entries(files)) {
		const importerSeam = file in SEAMS ? file : ownerOf(file);

		for (const target of agentComponentImports(source)) {
			if (SHARED.includes(target)) continue;
			if (importerSeam && SEAMS[importerSeam]?.nests.includes(target)) continue;
			if (target in SEAMS) {
				offenders.push(`${file} → ${target} (an undeclared seam-to-seam import)`);
				continue;
			}
			if (ownerOf(target) !== importerSeam) {
				offenders.push(`${file} → ${target} (owned by ${ownerOf(target)}, imported from ${file})`);
			}
		}
	}

	return offenders;
}

test('every component in the face sits behind exactly one declared seam', () => {
	// The check that would have caught `AgentDetail.svelte` being a boundary
	// nothing named. A file that is neither a seam, nor owned by one, nor shared
	// on purpose fails here — which forces the decision rather than letting a new
	// component quietly become a fourth swap point.
	const onDisk = readdirSync(agentsDir)
		.filter((entry) => entry.endsWith('.svelte'))
		.sort();

	const declared = [
		...Object.keys(SEAMS),
		...Object.values(SEAMS).flatMap((s) => s.owns),
		...SHARED,
	];

	assert.deepEqual(onDisk, [...declared].sort(), 'every component must be declared exactly once');
	assert.equal(new Set(declared).size, declared.length, 'and named in only one place');
});

test('no import inside face 6 crosses a seam', () => {
	// The property the seams exist to hold, checked WHERE IT CAN BREAK. The old
	// version of this walked `src/` with the agents directory skipped, so it could
	// only see a route reaching past a seam — never `AgentRoster` importing
	// `CopyBlock`, which is what actually entangles two swaps.
	const files = Object.fromEntries(
		readdirSync(agentsDir)
			.filter((entry) => entry.endsWith('.svelte'))
			.map((entry) => [entry, readFileSync(join(agentsDir, entry), 'utf8')])
	);

	assert.deepEqual(crossSeamImports(files), []);
});

test('the cross-seam check can still see a violation', () => {
	// Both directions, on planted sources, so the green above is a result rather
	// than a property of a check that cannot fail.
	//
	// THE PLANTED SPECIFIERS RESOLVE FROM THIS FILE on purpose, which is why they
	// read `../src/lib/agents/…` rather than the `./…` a component would write.
	// CON-5 walks every relative import in a gate file and fails on one that
	// resolves to nothing — an unresolvable import in a gate is an unscanned one —
	// so a fixture written the way the component writes it would trip the rubric
	// beside the check it is testing. `tests/agents-roster.test.mjs` learned the
	// same thing. What the checker reads is the file name, so the two forms are
	// the same input to it.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `import CopyBlock from '../src/lib/agents/CopyBlock.svelte';`,
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);

	// A seam composing another seam is a defect unless it is the declared nesting.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `import Panel from '../src/lib/agents/AgentMcpPanel.svelte';`,
		}),
		['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)']
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentDetail.svelte': `import Panel from '../src/lib/agents/AgentMcpPanel.svelte';`,
		}),
		[]
	);

	// And a MENTION is not an import: pointing at where a component lives is
	// useful documentation, and an earlier version of this check failed on it.
	assert.deepEqual(
		crossSeamImports({ 'AgentRoster.svelte': `<!-- see CopyBlock.svelte for the mono block -->` }),
		[]
	);
});

test('nothing outside the face imports anything behind a seam', () => {
	// The other half: a swap must not leave orphaned imports in routes or in any
	// other face. The list is DERIVED from the declaration above rather than
	// retyped, so a component added behind a seam is covered the day it is
	// declared.
	const behindASeam = [...Object.values(SEAMS).flatMap((s) => s.owns), ...SHARED];
	const offenders = [];

	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				// The face's own directory is checked by `crossSeamImports`, which is
				// stricter than this walk rather than exempt from it.
				if (path === agentsDir) continue;
				walk(path);
				continue;
			}
			if (!/\.(svelte|ts)$/.test(entry)) continue;
			for (const match of readFileSync(path, 'utf8').matchAll(importPattern)) {
				for (const name of behindASeam) {
					if (match[1].endsWith(`/${name}`)) offenders.push(`${path} → ${match[1]}`);
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
	// each route may name is a seam — and each names exactly one.
	assert.deepEqual(
		specifiers(roster).filter((s) => s.includes('/agents/')),
		['$lib/agents/AgentRoster.svelte']
	);
	assert.deepEqual(
		specifiers(detail).filter((s) => s.includes('/agents/')),
		['$lib/agents/AgentDetail.svelte']
	);

	// And what a route names is a seam, checked against the declaration rather
	// than against these two literals — the detail route naming `AgentDetail` is
	// exactly the boundary the docs used to leave out.
	for (const specifier of [
		...specifiers(roster).filter((s) => s.includes('/agents/')),
		...specifiers(detail).filter((s) => s.includes('/agents/')),
	]) {
		assert.ok(
			specifier.slice(specifier.lastIndexOf('/') + 1) in SEAMS,
			`${specifier} is imported by a route but is not a declared seam`
		);
	}
});

test('every seam is documented where the next steward will look', () => {
	const doc = readFileSync(join(repoRoot, 'docs/consumption/agent-contract.md'), 'utf8');

	// All three, from the declaration: a seam the code has and the doc does not
	// is how face 6 arrived at review claiming two boundaries and having three.
	for (const seam of Object.keys(SEAMS)) {
		assert.ok(doc.includes(seam), `${seam} is a seam and the contract doc does not name it`);
	}
	// And it records what must NOT change when the swap happens, which is the
	// half a future reader actually needs.
	assert.match(doc, /does \*\*not\*\* change/);
});

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

const DECLARED = new Set([
	...Object.keys(SEAMS),
	...Object.values(SEAMS).flatMap((seam) => seam.owns),
	...SHARED,
]);

/**
 * Every module specifier a source depends on, in every form that reaches a file.
 *
 * THE FIRST VERSION READ `import … from` AND NOTHING ELSE, and three other forms
 * reach the same module: a side-effect import, a re-export, and a dynamic
 * `import()`. A seam check with documented ways around it reports the absence of
 * the careless violations rather than the absence of violations, so every form
 * that resolves to a module is read here.
 *
 * The gap between the keyword and `from` may hold neither `;` nor a backtick, so
 * a multi-line named import spanning several lines — which is how `AgentMcpPanel`
 * imports the mcp module — still matches, while an `export` statement's body
 * cannot run on and swallow a later line's specifier.
 *
 * The specifiers in the prose here are deliberately not written in `from '…'` or
 * `import('…')` form: CON-5 walks EVERY relative specifier in a gate file,
 * comments included, and fails on one that resolves to no file. The planted
 * fixtures below say the same thing in a form that resolves.
 */
function moduleSpecifiers(source) {
	const specifiers = new Set();
	for (const pattern of [
		/^[ \t]*(?:import|export)\b[^;`]*?\bfrom\s*['"]([^'"]+)['"]/gm,
		/^[ \t]*import\s*['"]([^'"]+)['"]/gm,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	])
		for (const [, specifier] of source.matchAll(pattern)) specifiers.add(specifier);
	return [...specifiers];
}

/**
 * `import(<anything but a bare literal>)` — a dependency no static read can name.
 *
 * Matched by taking EVERY `import(…)` call and subtracting the ones whose whole
 * argument is a string literal, rather than by pattern-matching the shapes a
 * computed specifier can take. `import('$lib/agents/' + name)` opens with a
 * quote and closes with an identifier, and a rule that looked at the first
 * character would have called it a literal and moved on.
 */
const importCallPattern = /(?<![.\w$])import\s*\(([^)]*)\)/g;
const isLiteralArgument = (expression) => /^\s*(['"])[^'"]*\1\s*$/.test(expression);
const computedImports = (source) =>
	[...source.matchAll(importCallPattern)]
		.map(([, expression]) => expression)
		.filter((expression) => !isLiteralArgument(expression));

/**
 * Whether a specifier addresses a file inside face 6.
 *
 * Two forms reach it and both are here: `./X`, which is how a component in the
 * directory writes it, and the directory named outright (`$lib/agents/X`,
 * `../src/lib/agents/X`), which is how a route — and how a planted fixture in
 * this file — writes it. `svelte`, `$lib/greater/…` and `../../facetheory/…` are
 * outside the face and none of this check's business.
 */
const namesTheFace = (specifier) => /(^|\/)agents(\/|$)/.test(specifier);
const pointsIntoTheFace = (specifier) => namesTheFace(specifier) || /^\.\/[^/]+$/.test(specifier);

/**
 * The face file a specifier names: a declared component, one of the face's plain
 * modules, or null when nothing in the declared graph answers to it.
 *
 * Null is a FINDING rather than a shrug — see `faceDependencies`. Names are the
 * unit because the planted graphs address the face the way THIS FILE resolves it
 * (`../src/lib/agents/X`) and a component addresses it the way a component does
 * (`./X`); the file at the end is the same either way.
 */
function faceFile(specifier, files) {
	const tail = specifier.replace(/\/+$/, '');
	const name = tail.slice(tail.lastIndexOf('/') + 1);
	if (name.endsWith('.svelte')) return DECLARED.has(name) ? { component: name } : null;
	const candidates =
		name === 'agents'
			? ['index.ts', 'index.js']
			: [name, `${name}.ts`, `${name}.js`, `${name}.mjs`];
	const module = candidates.find((candidate) => candidate in files);
	return module ? { module } : null;
}

/**
 * The components a file depends on, FOLLOWING the face's own modules so that a
 * barrel cannot launder a cross-seam import, plus the forms this cannot resolve.
 *
 * Both halves matter. Without the following, an `index.ts` re-exporting
 * `CopyBlock.svelte` turns every cross-seam import into a bare-name import the
 * checker sees nothing wrong with. Without the unresolved list, "the checker
 * could not name this" and "there is nothing there" produce the same green,
 * which is the same hole one level further back.
 */
function faceDependencies(file, files, seen = new Set()) {
	const targets = [];
	const unresolved = [];
	if (seen.has(file)) return { targets, unresolved };
	seen.add(file);

	const source = files[file] ?? '';
	for (const expression of computedImports(source))
		unresolved.push(
			`${file} → import(${expression.trim()}) (a dependency no static read can name)`
		);

	for (const specifier of moduleSpecifiers(source)) {
		if (!pointsIntoTheFace(specifier)) continue;
		const resolved = faceFile(specifier, files);
		if (!resolved) {
			unresolved.push(
				`${file} → ${specifier} (points into the face and resolves to nothing declared)`
			);
			continue;
		}
		if (resolved.component) {
			targets.push({ name: resolved.component, via: [] });
			continue;
		}
		const nested = faceDependencies(resolved.module, files, seen);
		unresolved.push(...nested.unresolved);
		for (const target of nested.targets)
			targets.push({ name: target.name, via: [resolved.module, ...target.via] });
	}

	return { targets, unresolved };
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
 *
 * The face's plain modules are importers here too, not just its components: a
 * module behind no seam that reaches a component behind one is exactly the
 * laundering step a barrel performs, and it is a finding on its own line.
 */
function crossSeamImports(files) {
	const offenders = [];

	for (const file of Object.keys(files)) {
		const importerSeam = file in SEAMS ? file : ownerOf(file);
		const { targets, unresolved } = faceDependencies(file, files);
		offenders.push(...unresolved);

		for (const { name: target, via } of targets) {
			if (SHARED.includes(target)) continue;
			if (importerSeam && SEAMS[importerSeam]?.nests.includes(target)) continue;
			const through = via.length ? ` through ${via.join(' → ')}` : '';
			if (target in SEAMS) {
				offenders.push(
					importerSeam
						? `${file} → ${target}${through} (an undeclared seam-to-seam import)`
						: `${file} → ${target}${through} (a seam imported from behind no seam)`
				);
				continue;
			}
			if (ownerOf(target) !== importerSeam) {
				offenders.push(
					`${file} → ${target}${through} (owned by ${ownerOf(target)}, imported from ${file})`
				);
			}
		}
	}

	return offenders;
}

/**
 * Imports of something behind a seam from OUTSIDE the face.
 *
 * Three ways in, and the walk has to see all three: naming the file
 * (`$lib/agents/CopyBlock.svelte`) in any import form, going through one of the
 * face's own modules (`$lib/agents` re-exporting it), and a computed
 * `import()` whose expression reaches into the directory. The last one cannot be
 * resolved at all, so it is reported rather than skipped — an unresolvable
 * import into the face is an unchecked one.
 */
function importsBehindASeam(outside, face) {
	const behindASeam = [...Object.values(SEAMS).flatMap((seam) => seam.owns), ...SHARED];
	const offenders = [];

	for (const [path, source] of Object.entries(outside)) {
		for (const expression of computedImports(source))
			if (/\bagents\b/.test(expression))
				offenders.push(`${path} → import(${expression.trim()}) (a computed import into the face)`);

		for (const specifier of moduleSpecifiers(source)) {
			const named = behindASeam.find((name) => specifier.endsWith(`/${name}`));
			if (named) {
				offenders.push(`${path} → ${specifier}`);
				continue;
			}
			// Only the directory named outright: a bare `./index.ts` from some other
			// directory is that directory's own barrel, not this face's.
			if (!namesTheFace(specifier)) continue;
			const resolved = faceFile(specifier, face);
			if (!resolved?.module) continue;
			for (const { name, via } of faceDependencies(resolved.module, face).targets)
				if (behindASeam.includes(name))
					offenders.push(
						`${path} → ${specifier} (re-exported ${name} through ${[resolved.module, ...via].join(' → ')})`
					);
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

/** The whole face on disk — components AND plain modules, which is what a barrel would be. */
const faceOnDisk = () =>
	Object.fromEntries(
		readdirSync(agentsDir)
			.filter((entry) => statSync(join(agentsDir, entry)).isFile())
			.map((entry) => [entry, readFileSync(join(agentsDir, entry), 'utf8')])
	);

test('no import inside face 6 crosses a seam', () => {
	// The property the seams exist to hold, checked WHERE IT CAN BREAK. The old
	// version of this walked `src/` with the agents directory skipped, so it could
	// only see a route reaching past a seam — never `AgentRoster` importing
	// `CopyBlock`, which is what actually entangles two swaps.
	//
	// The map carries `contract.ts`, `filters.ts` and `mcp.ts` as well, because a
	// module is where a re-export would sit and because an import of one has to
	// RESOLVE for the check to stay fail-closed on the ones that do not.
	assert.deepEqual(crossSeamImports(faceOnDisk()), []);
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

test('a dynamic import cannot walk past the cross-seam check', () => {
	// `import … from` was the ONLY form the first version of this read, so an
	// `await import()` of `CopyBlock.svelte` took the dependency and left the
	// check green. Both offender directions are planted, because a bypass
	// demonstrated in one direction is a bypass still open in the other.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `const block = await import('../src/lib/agents/CopyBlock.svelte');`,
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `const panel = () => import('../src/lib/agents/AgentMcpPanel.svelte');`,
		}),
		['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)']
	);

	// The declared nesting is still the declared nesting, whatever form it takes.
	assert.deepEqual(
		crossSeamImports({
			'AgentDetail.svelte': `const panel = () => import('../src/lib/agents/AgentMcpPanel.svelte');`,
		}),
		[]
	);

	// A side-effect import is a dependency too, and read the same way.
	assert.deepEqual(
		crossSeamImports({ 'AgentRoster.svelte': `import '../src/lib/agents/CopyBlock.svelte';` }),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
});

test('a barrel cannot launder a cross-seam import', () => {
	// The second bypass: route the import through a re-export and the importer's
	// own specifier names no component at all. The check follows the face's own
	// modules, so the target is found — and the barrel is reported on its own
	// line, because a module behind no seam holding a reference to a component
	// behind one is the laundering step itself.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `import { CopyBlock } from '../src/lib/agents/index.ts';`,
			'index.ts': `export { default as CopyBlock } from '../src/lib/agents/CopyBlock.svelte';`,
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte through index.ts (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
			'index.ts → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from index.ts)',
		]
	);

	// Seam-to-seam through the same barrel, and through two of them: the chain is
	// reported so the next reader is told where to cut rather than only that
	// something is wrong.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `import { McpPanel } from '../src/lib/agents/index.ts';`,
			'index.ts': `export * from '../src/lib/agents/panels.ts';`,
			'panels.ts': `export { default as McpPanel } from '../src/lib/agents/AgentMcpPanel.svelte';`,
		}),
		[
			'AgentRoster.svelte → AgentMcpPanel.svelte through index.ts → panels.ts (an undeclared seam-to-seam import)',
			'index.ts → AgentMcpPanel.svelte through panels.ts (a seam imported from behind no seam)',
			'panels.ts → AgentMcpPanel.svelte (a seam imported from behind no seam)',
		]
	);
});

test('an import form the check cannot resolve fails rather than passing', () => {
	// FAIL CLOSED. "The checker could not name what this loads" and "this loads
	// nothing behind a seam" are different facts, and a check that returns the
	// same green for both is a check that can be walked past by writing the import
	// in a form nobody taught it.
	assert.deepEqual(
		crossSeamImports({ 'AgentRoster.svelte': `const c = await import(componentPath);` }),
		['AgentRoster.svelte → import(componentPath) (a dependency no static read can name)']
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `const c = await import(\`../src/lib/agents/\${name}.svelte\`);`,
		}),
		[
			'AgentRoster.svelte → import(`../src/lib/agents/${name}.svelte`) (a dependency no static read can name)',
		]
	);

	// And a specifier that points into the face but names nothing declared: either
	// a component was added without being declared, or the graph moved under the
	// check. Both are answers the next steward needs, and neither is silence.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': `import X from '../src/lib/agents/Undeclared.svelte';`,
		}),
		[
			'AgentRoster.svelte → ../src/lib/agents/Undeclared.svelte (points into the face and resolves to nothing declared)',
		]
	);
});

test('nothing outside the face imports anything behind a seam', () => {
	// The other half: a swap must not leave orphaned imports in routes or in any
	// other face. The list is DERIVED from the declaration above rather than
	// retyped, so a component added behind a seam is covered the day it is
	// declared.
	const outside = {};

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
			outside[path] = readFileSync(path, 'utf8');
		}
	};

	walk(join(repoRoot, 'src'));
	assert.deepEqual(importsBehindASeam(outside, faceOnDisk()), []);
});

test('the outside-the-face check can still see a violation', () => {
	// Planted the same way the cross-seam fixtures are, and for the same reason:
	// this walk had never been shown to fail, and it read one import form.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': `import Card from '$lib/agents/AgentCard.svelte';` },
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': `const card = () => import('$lib/agents/AgentCard.svelte');`,
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);

	// Through a barrel inside the face, where the route's own specifier names no
	// component — the form that made this walk's green meaningless.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': `import { AgentCard } from '$lib/agents';` },
			{ 'index.ts': `export { default as AgentCard } from '../src/lib/agents/AgentCard.svelte';` }
		),
		['src/lib/routes/Agents.svelte → $lib/agents (re-exported AgentCard.svelte through index.ts)']
	);

	// And a computed import naming the directory, which resolves to nothing and is
	// therefore reported rather than skipped. It opens with a string literal and
	// is still not one, which is the case a first-character rule would have waved
	// through.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': `const c = await import('$lib/agents/' + name);` },
			{}
		),
		[
			"src/lib/routes/Agents.svelte → import('$lib/agents/' + name) (a computed import into the face)",
		]
	);

	// A route naming a SEAM is the allowed shape and stays quiet, including when it
	// is the directory's own module rather than a component.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': `import Roster from '$lib/agents/AgentRoster.svelte';` },
			{}
		),
		[]
	);
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

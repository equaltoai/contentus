import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { compile } from 'svelte/compiler';

import { DECLARED, SEAMS, SHARED, ownerOf } from '../scripts/lib/agent-seams.mjs';
import {
	computedImports,
	liveScript,
	modulePath,
	moduleSpecifiers,
	runtimeSpecifiers,
} from '../scripts/lib/module-imports.mjs';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';
import { MODULE_SOURCE, trackedSource } from './helpers/tracked-source.mjs';

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
		'.contentus-sharing__input',
		'.contentus-sharing__grant-btn',
		'.contentus-sharing__revoke-btn',
		// `.contentus-act-as__select-btn` and `.contentus-act-as__stop-btn` were
		// here until M2.1 removed the act-as selection control they styled
		// (equaltoai/contentus#92). They are absent from this list because the
		// buttons are absent from the face, not because the floor was relaxed —
		// `tests/agents-trust.test.mjs` is what holds them gone.
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
 * Face 6's component graph is declared in `../scripts/lib/agent-seams.mjs`,
 * imported above, and its header carries the reasoning for the three seams and
 * for what `owns`, `nests` and `SHARED` mean.
 *
 * IT USED TO BE DECLARED HERE, and it moved for one reason: a second reader
 * exists. `scripts/audit-seam-graph.mjs` asserts the same property from the
 * edges the BUILD resolves rather than from the imports source reading can see,
 * and two copies of a graph is how the second copy keeps passing after the first
 * is corrected — the same argument that put the reading itself in
 * `../scripts/lib/module-imports.mjs` when this file and
 * `tests/agents-roster.test.mjs` were carrying one regex each.
 */

const agentsDir = join(repoRoot, 'src', 'lib', 'agents');

/**
 * The readings this file's walks are built on live in
 * `../scripts/lib/module-imports.mjs`, imported above, and its header carries the
 * reasoning: `liveScript` is the script a file executes, `moduleSpecifiers` and
 * `computedImports` are what that script depends on.
 *
 * WHAT MOVED AND WHY. Both lived here as line-anchored regexes over raw text.
 * Round 3 of this pull request's review compiled four legal files that took a
 * cross-seam dependency and returned nothing from them; round 3's fix dropped
 * the anchors and stripped comments first; round 4's review compiled two more
 * past THAT — a comment that merges `import` into its binding when it is
 * stripped, and a markup comment carrying a fake `<script>` opener. So the scan
 * is no longer a scan: the Svelte compiler decides what a `<script>` block is
 * and the TypeScript compiler decides what an import is. The forms below are the
 * regression, and the class they belong to is closed by the parsers rather than
 * by the list. They are shared with `tests/agents-roster.test.mjs` because it
 * asserts the same property over the same tree, and one of two copies being
 * fixed is how a gate goes green while the hole it names is still open.
 *
 * THE PROSE RULE IN THIS FILE IS RETIRED, and what retired it is the same
 * change. CON-5 objected to `from '<a relative path>'` in a comment because its
 * reader was a raw-text scan of every gate file; it now reads with this module,
 * so a specifier in prose is trivia and a specifier in a fixture string is a
 * value in an expression. The planted fixtures below still address the face as
 * `../src/lib/agents/…` — the form costs nothing, resolves, and is what the rest
 * of the file uses — but they no longer have to.
 *
 * WHAT CON-5 IS STILL NOT is a fail-closed backstop for THIS scan, and an
 * earlier version of this comment implied it was. It walks the closure of the
 * guarded package.json scripts, which is gate code; `src/` is declared outside
 * that closure precisely because the probe is the gate and the application is
 * what it judges. A cross-seam import in application source is invisible to it
 * whatever it reads with, so nothing here may lean on it.
 */

/**
 * Whether a specifier addresses a file inside face 6.
 *
 * Two forms reach it and both are here: `./X`, which is how a component in the
 * directory writes it, and the directory named outright (`$lib/agents/X`,
 * `../src/lib/agents/X`), which is how a route — and how a planted fixture in
 * this file — writes it. `svelte`, `$lib/greater/…` and `../../facetheory/…` are
 * outside the face and none of this check's business.
 *
 * The QUESTION IS ASKED OF THE PATH, not of the specifier: `…/agents/X?raw`
 * addresses the same file `…/agents/X` does — see `modulePath`, which carries the
 * reasoning for counting a query as crossing the seam.
 */
const namesTheFace = (specifier) => /(^|\/)agents(\/|$)/.test(modulePath(specifier));
const pointsIntoTheFace = (specifier) =>
	namesTheFace(specifier) || /^\.\/[^/]+$/.test(modulePath(specifier));

/**
 * The face file a specifier names: a declared component, one of the face's plain
 * modules, or null when nothing in the declared graph answers to it.
 *
 * Null is a FINDING rather than a shrug — see `faceDependencies`. Names are the
 * unit because the planted graphs address the face the way THIS FILE resolves it
 * (`../src/lib/agents/X`) and a component addresses it the way a component does
 * (`./X`); the file at the end is the same either way, and so is `…/X?raw`.
 */
function faceFile(specifier, files) {
	const tail = modulePath(specifier).replace(/\/+$/, '');
	const name = tail.slice(tail.lastIndexOf('/') + 1);
	if (name.endsWith('.svelte')) return DECLARED.includes(name) ? { component: name } : null;
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

	const source = liveScript(file, files[file] ?? '');
	for (const call of computedImports(source))
		unresolved.push(`${file} → ${call.trim()} (a dependency no static read can name)`);

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
 * `import()` whose target no static read can name.
 *
 * THE THIRD ONE USED TO ASK WHETHER THE EXPRESSION SAID `agents`, which is not a
 * question a computed import can be trusted to answer about itself. Assigning
 * the specifier to a variable first empties the expression of every word the
 * test looked for while changing nothing about what loads, and round 3 of this
 * review walked through that gap. So the rule is now the same one the inside of
 * the face has always had: an import this walk cannot resolve is a finding,
 * whether or not its text mentions the directory. "Not provably outside the
 * face" and "outside the face" were the same green, and they are different
 * facts.
 *
 * There is no exclusion list any more. A class member NAMED `import` is not a
 * call — vendored greater-components has one, and this repository may not edit
 * vendored source to satisfy a probe — and the rule that used to keep them apart
 * by hand is now the difference between a declaration node and a call node.
 */
function importsBehindASeam(outside, face) {
	const behindASeam = [...Object.values(SEAMS).flatMap((seam) => seam.owns), ...SHARED];
	const offenders = [];

	for (const [path, raw] of Object.entries(outside)) {
		const source = liveScript(path, raw);
		for (const call of computedImports(source))
			offenders.push(
				/\bagents\b/.test(call)
					? `${path} → ${call.trim()} (a computed import into the face)`
					: `${path} → ${call.trim()} (a dependency no static read can name)`
			);

		for (const specifier of moduleSpecifiers(source)) {
			const named = behindASeam.find((name) => modulePath(specifier).endsWith(`/${name}`));
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

	assert.deepEqual(onDisk, [...DECLARED].sort(), 'every component must be declared exactly once');
	assert.equal(new Set(DECLARED).size, DECLARED.length, 'and named in only one place');
});

/** The whole face on disk — components AND plain modules, which is what a barrel would be. */
const faceOnDisk = () =>
	Object.fromEntries(
		readdirSync(agentsDir)
			.filter((entry) => statSync(join(agentsDir, entry)).isFile())
			.map((entry) => [entry, readFileSync(join(agentsDir, entry), 'utf8')])
	);

/**
 * A component the way a component is actually written, which every planted
 * `.svelte` fixture below goes through.
 *
 * IT IS NOT DECORATION. Svelte executes `<script>` and nothing else, so a
 * `.svelte` file holding a bare import statement is a file whose template
 * happens to read like code — it compiles to a component that imports nothing.
 * The reading these walks use is the compiler's, so it says so, and a fixture
 * written as a bare line would be asserting the checker sees a dependency that
 * does not exist. The earlier version of this file planted bare lines and was
 * answered by a fallback that read markup as script; that fallback is gone with
 * the patterns, and the fixtures are components instead.
 */
const component = (body) => `<script lang="ts">\n${body}\n</script>\n\n<div>face</div>\n`;

/**
 * A component whose dependency is in its MARKUP, which is the other half of the
 * sentence above and the one round 5's review had to write.
 *
 * Markup holds no import DECLARATION — that is why the fixtures above are
 * scripts — but it holds import CALLS, and the build takes them. A `<script>`
 * block declaring nothing beside a handler that loads a component behind a seam
 * is a component with a cross-seam dependency and an empty-looking script.
 */
const markup = (body) =>
	`<script lang="ts">\n\tlet ready = $state(false);\n\tlet block = $state(null);\n</script>\n\n${body}\n`;

test('a bare import line in markup is markup, because that is what Svelte compiles', () => {
	// The claim the fixture shape rests on, PROVEN rather than asserted. The witness
	// is the compiler's own output, read for the modules it actually imports —
	// searching that output for the TEXT would prove nothing, because markup is
	// emitted as text and the specifier would be found either way.
	const target = '../src/lib/agents/CopyBlock.svelte';
	const line = `import CopyBlock from '${target}';`;
	const emittedSpecifiers = (source) =>
		moduleSpecifiers(compile(source, { generate: 'server', filename: 'Fixture.svelte' }).js.code);

	const asMarkup = `${line}\n<div>face</div>\n`;
	assert.ok(!emittedSpecifiers(asMarkup).includes(target), 'markup must import nothing');
	assert.deepEqual(moduleSpecifiers(liveScript('Fixture.svelte', asMarkup)), []);

	assert.ok(emittedSpecifiers(component(line)).includes(target), 'a script must import it');
	assert.deepEqual(moduleSpecifiers(liveScript('Fixture.svelte', component(line))), [target]);
});

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
	// THE PLANTED SPECIFIERS RESOLVE FROM THIS FILE, which is why they read
	// `../src/lib/agents/…` rather than the `./…` a component would write. That
	// was once required — CON-5 read every gate file's raw text and failed on a
	// relative specifier resolving to nothing, so a fixture written the way the
	// component writes it tripped the rubric beside the check it was testing — and
	// it is now only a convention. What the checker reads is the file name, so the
	// two forms are the same input to it.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`import CopyBlock from '../src/lib/agents/CopyBlock.svelte';`
			),
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);

	// A seam composing another seam is a defect unless it is the declared nesting.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`import Panel from '../src/lib/agents/AgentMcpPanel.svelte';`
			),
		}),
		['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)']
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentDetail.svelte': component(
				`import Panel from '../src/lib/agents/AgentMcpPanel.svelte';`
			),
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
			'AgentRoster.svelte': component(
				`const block = await import('../src/lib/agents/CopyBlock.svelte');`
			),
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`const panel = () => import('../src/lib/agents/AgentMcpPanel.svelte');`
			),
		}),
		['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)']
	);

	// The declared nesting is still the declared nesting, whatever form it takes.
	assert.deepEqual(
		crossSeamImports({
			'AgentDetail.svelte': component(
				`const panel = () => import('../src/lib/agents/AgentMcpPanel.svelte');`
			),
		}),
		[]
	);

	// A side-effect import is a dependency too, and read the same way. So is a
	// TYPE-only one: swapping the component behind a seam breaks a type that names
	// it exactly as it breaks a value that names it.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(`import '../src/lib/agents/CopyBlock.svelte';`),
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`import type { Props } from '../src/lib/agents/CopyBlock.svelte';`
			),
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`type P = import('../src/lib/agents/CopyBlock.svelte').Props;`
			),
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
		]
	);
});

test('an import in MARKUP cannot walk past either seam check', () => {
	// ROUND 5's FIRST FORM. The reading returned a component's two `<script>`
	// blocks and nothing else, so a handler that loads a component behind a seam
	// took the dependency in front of a check that could not see the region it sat
	// in. Every form below is planted with its own WITNESS — the compiler's output,
	// read for the specifier — so each is a proven dependency before it is a caught
	// one, and the position list cannot drift into forms that never compiled.
	const target = '../src/lib/agents/CopyBlock.svelte';
	const offence =
		'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)';

	for (const body of [
		`<button onclick={async () => { block = (await import('${target}')).default; }}>load</button>`,
		`<button onclick={() => import('${target}')}>load</button>`,
		`{#await import('${target}') then Block}<Block />{/await}`,
		`{#if ready}{@const block = import('${target}')}<p>{block}</p>{/if}`,
		`{#snippet load()}<button onclick={() => import('${target}')}>load</button>{/snippet}`,
	]) {
		const source = markup(body);
		assert.ok(
			compile(source, { generate: 'client', filename: 'Fixture.svelte' }).js.code.includes(target),
			`the build must take this dependency: ${body}`
		);
		assert.deepEqual(crossSeamImports({ 'AgentRoster.svelte': source }), [offence], body);
	}

	// WHY THE WITNESS IS THE CLIENT BUILD. The server build drops event handlers,
	// so its output agrees with the bug: it reports no dependency for a file that
	// really has one. A check calibrated against it would have stayed green here.
	const handler = markup(`<button onclick={() => import('${target}')}>load</button>`);
	assert.ok(
		!compile(handler, { generate: 'server', filename: 'Fixture.svelte' }).js.code.includes(target),
		'the server build drops the handler, which is why it is not the witness'
	);

	// Both directions, because a bypass shown in one is a bypass open in the other.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': markup(
					`<button onclick={() => import('$lib/agents/AgentCard.svelte')}>load</button>`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);

	// And the fail-closed rule reaches the markup as well: a computed import there
	// is as unreadable as a computed import in a script, and reported the same way.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': markup(`<button onclick={() => import(componentPath)}>load</button>`),
		}),
		['AgentRoster.svelte → import(componentPath) (a dependency no static read can name)']
	);

	// Prose in markup is still prose. There is no compile witness for THIS half —
	// markup is emitted as text, so the specifier appears in the output either way,
	// which is the same reason the fixture-shape test reads the emitted MODULES.
	assert.deepEqual(
		crossSeamImports({ 'AgentRoster.svelte': `<p>{"import('${target}')"}</p>` }),
		[]
	);
	assert.deepEqual(
		crossSeamImports({ 'AgentRoster.svelte': `<!-- import('${target}') -->\n<div>face</div>\n` }),
		[]
	);
});

test('a query on a specifier does not hide the file it addresses', () => {
	// ROUND 5's THIRD FORM. `$lib/agents/CopyBlock.svelte?raw` builds, and every
	// match in both walks was `endsWith('/CopyBlock.svelte')` against a string that
	// ends in `?raw`. The specifier was read correctly and then compared whole.
	//
	// THE POSITION, because it is a judgement rather than a mechanic: a query
	// CROSSES the seam. The bundler resolves the same path, reads the same file and
	// rebuilds when it changes; what the query alters is what the importer receives
	// — text, a URL, a component — not which file the swap would replace, and the
	// file is the only thing a seam check is about. `modulePath` carries the rest.
	//
	// THESE FIXTURES ADDRESS THE FACE AS `$lib/…` rather than the `../src/…` the
	// fixtures above use, and the reason has been repaired rather than worked
	// around: CON-5 stopped at the query rather than at the path, so
	// `../src/lib/agents/CopyBlock.svelte?raw` read to it as a path with no file at
	// the end of it — this very defect, one gate over. Its reader now asks the same
	// `modulePath` question this one does. The `$lib/…` form stays because it is
	// what a route writes, which is what these fixtures are.
	const offence =
		'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)';

	for (const query of ['?raw', '?url', '?raw&inline', '#anchor', '?url#anchor'])
		assert.deepEqual(
			crossSeamImports({
				'AgentRoster.svelte': component(
					`import block from '$lib/agents/CopyBlock.svelte${query}';`
				),
			}),
			[offence],
			query
		);

	// In markup as well, which is where round 5's first form and its third meet.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': markup(
				`<button onclick={() => import('$lib/agents/CopyBlock.svelte?raw')}>load</button>`
			),
		}),
		[offence]
	);

	// From outside the face, where the offender names the specifier AS WRITTEN. The
	// query is not part of the path and it IS part of what the next reader has to
	// find in the file, so it is matched away and then reported back.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': component(
					`import raw from '$lib/agents/AgentCard.svelte?raw';`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte?raw']
	);

	// And through a barrel carrying one, where the query sits on the directory.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': component(`import { AgentCard } from '$lib/agents?url';`) },
			{ 'index.ts': `export { default as AgentCard } from '../src/lib/agents/AgentCard.svelte';` }
		),
		[
			'src/lib/routes/Agents.svelte → $lib/agents?url (re-exported AgentCard.svelte through index.ts)',
		]
	);

	// A query on a file outside the face is still outside it: this widens what a
	// specifier is matched against, not what the checks are about.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': component(`import css from '$lib/brand/agents.css?url';`) },
			{}
		),
		[]
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
			'AgentRoster.svelte': component(`import { CopyBlock } from '../src/lib/agents/index.ts';`),
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
			'AgentRoster.svelte': component(`import { McpPanel } from '../src/lib/agents/index.ts';`),
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
		crossSeamImports({ 'AgentRoster.svelte': component(`const c = await import(componentPath);`) }),
		['AgentRoster.svelte → import(componentPath) (a dependency no static read can name)']
	);
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(
				`const c = await import(\`../src/lib/agents/\${name}.svelte\`);`
			),
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
			'AgentRoster.svelte': component(`import X from '../src/lib/agents/Undeclared.svelte';`),
		}),
		[
			'AgentRoster.svelte → ../src/lib/agents/Undeclared.svelte (points into the face and resolves to nothing declared)',
		]
	);
});

/* -------------------------------------------------------------------------
 * The forms rounds 3 and 4 compiled and the scans walked past
 * ---------------------------------------------------------------------- */

/**
 * Every comment shape a reviewer has compiled past one of these scans, plus the
 * ones they imply. Each is legal, each compiles, and each returned nothing from
 * the version of the reading that was current when it was written.
 *
 * THE LAST FIVE ARE THE ROUND-4 CLASS and they are the reason the reading is a
 * parser now. Round 3's fix stripped comments before matching, which is fine
 * until the comment is the only thing SEPARATING two tokens: strip
 * `import/* n *\/X` and the text reads `importX`, which is not an import
 * statement to any pattern and is one to the module system. There is a form of
 * that for every keyword-and-token pair an import declaration contains, and
 * listing them is not what closes them — the tree is. They are here because a
 * class closed by construction should still have its known members regressed.
 *
 * The computed-`import()` form rounds 3 and 4 named is not here because it does
 * not resolve to a specifier at all; it has its own test below, and its expected
 * finding is the fail-closed one rather than a named target.
 */
const COMMENTED_FORMS = [
	['a block comment before the import', (s) => `/* note */ import X from '${s}';`],
	['a comment between `from` and the specifier', (s) => `import X from /* note */ '${s}';`],
	['a comment before a re-export', (s) => `/* note */ export { default as X } from '${s}';`],
	['a comment inside a re-export', (s) => `export { default as X } from /* note */ '${s}';`],
	['a line comment above the import', (s) => `// note\nimport X from '${s}';`],
	['a comment merging `import` into its binding', (s) => `import/* note */X from '${s}';`],
	['a comment merging `from` into the specifier', (s) => `import X from/* note */'${s}';`],
	['a comment merging `import` into a side-effect specifier', (s) => `import/* note */'${s}';`],
	[
		'a comment merging `export` into its clause',
		(s) => `export/* note */{ default as X } from '${s}';`,
	],
	[
		'a comment merging `from` into a re-exported specifier',
		(s) => `export { default as X } from/* note */'${s}';`,
	],
];

test('a comment cannot hide a cross-seam import, on the real face map', () => {
	// PLANTED ON THE REAL FACE rather than on a two-entry map. Round 3's fixtures
	// were compiled against the graph this repository actually declares and
	// returned `[]`, so the regression has to be run against that same graph — a
	// toy map would prove the pattern matches, not that the gate fires.
	const face = faceOnDisk();
	const planted = (source) => crossSeamImports({ ...face, 'AgentRoster.svelte': source });

	// Both offender directions for every form: a component owned by another seam,
	// and a seam composed by a seam that does not declare the nesting.
	for (const [label, form] of COMMENTED_FORMS) {
		assert.deepEqual(
			planted(component(form('../src/lib/agents/CopyBlock.svelte'))),
			[
				'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
			],
			`${label} must not hide an import of a component behind another seam`
		);
		assert.deepEqual(
			planted(component(form('../src/lib/agents/AgentMcpPanel.svelte'))),
			['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)'],
			`${label} must not hide a seam-to-seam import`
		);
	}

	// And the declared nesting stays declared however it is commented — a check
	// that fired on every form would be a check nobody could keep green.
	for (const [, form] of COMMENTED_FORMS)
		assert.deepEqual(
			crossSeamImports({
				...face,
				'AgentDetail.svelte': component(form('../src/lib/agents/AgentMcpPanel.svelte')),
			}),
			[]
		);
});

/**
 * Markup that steers a TAG-shaped pattern, which is the other half of the
 * round-4 class and a different defect from the comment forms above.
 *
 * The extraction used to be `/<script\b[^>]*>([\s\S]*?)(?:<\/script>|$)/`, and a
 * `<script>` written inside a markup comment is a substring that matches it. The
 * first one steered the match from inside the comment THROUGH the real closing
 * tag, so the text handed to the import scan was the markup between them; a `/*`
 * left open in that markup then swallowed the rest, and a component with a live
 * cross-seam import returned nothing. The others are the same trick from other
 * positions — an attribute value, a script-shaped string, a closer in prose.
 *
 * None of them is a script block to the Svelte compiler, which is the point: the
 * question "where does this component's script begin" belongs to the parser that
 * compiles it, and asking a pattern was the mistake all four rounds shared.
 */
const MARKUP_DISGUISES = [
	['a fake opener in a comment holding an open block comment', (b) => `<!-- <script> /* -->\n${b}`],
	['a fake opener in a comment', (b) => `<!-- <script> -->\n${b}`],
	['a fake opener in an attribute value', (b) => `<div data-snippet="<script>"></div>\n${b}`],
	['a fake closer in a comment before the script', (b) => `<!-- </script> -->\n${b}`],
	['a fake closer in a comment after the script', (b) => `${b}\n<!-- </script> -->`],
	['a script-shaped string in the template', (b) => `${b}\n<p>{'<script>'}</p>`],
];

test('markup cannot hide the script, on the real face map', () => {
	// ROUND 4's SECOND FORM, planted on the real graph like the comment forms. Each
	// disguise wraps a component whose script holds a live cross-seam import, and
	// each must leave that import visible in both offender directions.
	const face = faceOnDisk();

	for (const [label, disguise] of MARKUP_DISGUISES) {
		const planted = (specifier) =>
			crossSeamImports({
				...face,
				'AgentRoster.svelte': disguise(component(`import X from '${specifier}';`)),
			});

		assert.deepEqual(
			planted('../src/lib/agents/CopyBlock.svelte'),
			[
				'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
			],
			`${label} must not hide an import of a component behind another seam`
		);
		assert.deepEqual(
			planted('../src/lib/agents/AgentMcpPanel.svelte'),
			['AgentRoster.svelte → AgentMcpPanel.svelte (an undeclared seam-to-seam import)'],
			`${label} must not hide a seam-to-seam import`
		);

		// And the same disguise over the declared nesting stays quiet.
		assert.deepEqual(
			crossSeamImports({
				...face,
				'AgentDetail.svelte': disguise(
					component(`import X from '../src/lib/agents/AgentMcpPanel.svelte';`)
				),
			}),
			[],
			`${label} must not turn the declared nesting into a finding`
		);
	}
});

test('a `module` script is script too', () => {
	// `<script module>` runs once per module rather than once per instance, and an
	// import in it loads exactly what an import in the instance block loads. The
	// compiler hands back both blocks, so both are read.
	const face = faceOnDisk();
	const source = `<script module>\nimport X from '../src/lib/agents/CopyBlock.svelte';\n</script>\n\n<div>face</div>\n`;

	assert.deepEqual(crossSeamImports({ ...face, 'AgentRoster.svelte': source }), [
		'AgentRoster.svelte → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
	]);
});

test('a component the compiler cannot read is a red gate, not an empty scan', () => {
	// FAIL CLOSED ON THE READING ITSELF. Returning nothing for a file that cannot be
	// parsed makes "unreadable" and "clean" the same green, which is the hole this
	// whole line of review has been about, one level further back.
	// The specifier resolves even though the fixture never parses, which is now
	// belt and braces: CON-5 reads this file as TypeScript, where the fixture is a
	// template literal rather than an import position.
	assert.throws(
		() =>
			liveScript(
				'Broken.svelte',
				`<script>\nimport X from '../src/lib/agents/CopyBlock.svelte'\n<div>`
			),
		/cannot parse this component/
	);
	assert.throws(
		() => moduleSpecifiers(`import X from ; const y = ((;`),
		/does not parse as TypeScript/
	);
});

test('a comment cannot launder a cross-seam import through a barrel', () => {
	// The re-export forms above, in the module where a re-export actually lives.
	// A commented barrel is the shape that hides two edges at once: the importer's
	// specifier names no component, and the barrel's own line is the one the
	// comment sits on.
	assert.deepEqual(
		crossSeamImports({
			'AgentRoster.svelte': component(`import { CopyBlock } from '../src/lib/agents/index.ts';`),
			'index.ts': `/* re-exported for convenience */ export { default as CopyBlock } from '../src/lib/agents/CopyBlock.svelte';`,
		}),
		[
			'AgentRoster.svelte → CopyBlock.svelte through index.ts (owned by AgentMcpPanel.svelte, imported from AgentRoster.svelte)',
			'index.ts → CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from index.ts)',
		]
	);
});

test('an import of a variable fails closed on both sides of the face', () => {
	// ROUND 3's FOURTH FORM. The outside walk used to ask whether the expression
	// mentioned `agents`; assigning the specifier to a variable first answers no
	// while loading exactly the same file. Naming the target is not something a
	// computed import can be asked about itself, so neither walk asks any more.
	const face = faceOnDisk();
	// The specifier is written the way the route would write it, which is also the
	// point: the assignment is a plain string and no import form reads it, so the
	// finding cannot come from the specifier. It comes from the call being
	// unreadable, which is the only honest thing to say about it.
	const hidden = `const target = '$lib/agents/CopyBlock.svelte';\nconst block = await import(target);`;

	assert.deepEqual(crossSeamImports({ ...face, 'AgentRoster.svelte': component(hidden) }), [
		'AgentRoster.svelte → import(target) (a dependency no static read can name)',
	]);
	assert.deepEqual(
		importsBehindASeam({ 'src/lib/routes/Agents.svelte': component(hidden) }, face),
		['src/lib/routes/Agents.svelte → import(target) (a dependency no static read can name)']
	);

	// Without the variable to look at, there is nothing left to read at all — and
	// that is still a finding rather than a pass.
	assert.deepEqual(
		importsBehindASeam({ 'src/lib/routes/Agents.svelte': component(`import(load());`) }, face),
		['src/lib/routes/Agents.svelte → import(load()) (a dependency no static read can name)']
	);
});

test('a class member named import is not a computed import', () => {
	// Vendored `greater/primitives/stores/preferences` declares a METHOD called
	// `import`, and vendored source is CLI-managed: a probe that reported it would
	// be a probe asking for a hand-edit this repository forbids. The previous
	// reading needed a hand-written rule to tell a parameter list from an argument;
	// the tree tells them apart for free — one is a declaration, the other is a call
	// on the `import` keyword — so the rule is gone and this is its regression.
	assert.deepEqual(
		computedImports(`class P { import(json: string): boolean { return true; } }`),
		[]
	);
	assert.deepEqual(computedImports(`interface P { import(json: string): boolean; }`), []);
	// `import.meta` is a third node again, and never a call.
	assert.deepEqual(computedImports(`const url = import.meta.url;`), []);

	// And the shapes that ARE calls, including the one that has a colon in it.
	// The specifiers resolve from this file, as everywhere else here.
	// What comes back is the CALL, not its argument: `require(x)` belongs to the
	// same class and an offender line assembled around the text `import(` would
	// print the wrong keyword for half of it.
	const a = '../src/lib/agents/AgentCard.svelte';
	const b = '../src/lib/agents/CopyBlock.svelte';
	assert.deepEqual(computedImports(`import(target);`), ['import(target)']);
	assert.deepEqual(computedImports(`import(ok ? '${a}' : '${b}');`), [
		`import(ok ? '${a}' : '${b}')`,
	]);
	assert.deepEqual(computedImports(`import('${a}');`), []);
	// An un-interpolated template names its module as plainly as a quoted string.
	assert.deepEqual(computedImports('import(`' + a + '`);'), []);
	assert.deepEqual(moduleSpecifiers('import(`' + a + '`);'), [a]);

	// `import()` with no argument is not legal JavaScript, so it cannot reach here
	// from a file the Svelte compiler accepts — but the reading answers for it
	// anyway rather than falling through to a pass, because "the argument is
	// missing" is the same unreadable as "the argument is a variable".
	assert.deepEqual(computedImports(`import();`), ['import()']);
});

test('require is read as the import it is, in both directions', () => {
	// CON-5 resolves `.cjs` among its module extensions and its previous raw-text
	// scan matched `require(`, so a parser that dropped the form would have closed
	// symptom A by opening a hole beside it. The probes inherit it, and round 6's
	// literal `require()` in a `.cjs` is the reason they should: it compiled past
	// both of them.
	const a = '../src/lib/agents/AgentCard.svelte';
	assert.deepEqual(moduleSpecifiers(`const X = require('${a}');`), [a]);
	assert.deepEqual(runtimeSpecifiers(`const X = require('${a}');`), [a]);
	assert.deepEqual(computedImports(`const X = require(name);`), ['require(name)']);

	// The callee must be the identifier itself. A method call named `require` and a
	// member access are other people's functions, not CommonJS.
	assert.deepEqual(moduleSpecifiers(`module.require('${a}');`), []);
	assert.deepEqual(computedImports(`module.require(name);`), []);
	assert.deepEqual(computedImports(`class P { require(json: string) { return json; } }`), []);
});

test('a type-only declaration is a dependency to a seam and not to CON-5', () => {
	// THE JUDGEMENT, and the reason it differs by caller. `import type … from` is
	// erased by `--experimental-strip-types` and by `tsc` before anything runs, so
	// the file it names is not code a guarded command executes and CON-5 must not
	// pin its bytes. A swap behind a seam breaks a type that names a component
	// exactly as it breaks a value, so the seam walks must still see it.
	const a = '../src/lib/agents/AgentCard.svelte';
	for (const line of [
		`import type X from '${a}';`,
		`import type { X } from '${a}';`,
		`export type { X } from '${a}';`,
		`import type X = require('${a}');`,
		`type Y = import('${a}').X;`,
	]) {
		assert.deepEqual(moduleSpecifiers(line), [a], `the seam reading must see ${line}`);
		assert.deepEqual(runtimeSpecifiers(line), [], `CON-5's reading must not see ${line}`);
	}

	// A type-only SPECIFIER inside a value import is not a type-only DECLARATION:
	// the module is still loaded, and dropping it would unpin a file that runs.
	assert.deepEqual(runtimeSpecifiers(`import { type X, y } from '${a}';`), [a]);
	assert.deepEqual(runtimeSpecifiers(`import { type X } from '${a}';`), [a]);
	assert.deepEqual(runtimeSpecifiers(`import '${a}';`), [a]);
	assert.deepEqual(runtimeSpecifiers(`export * from '${a}';`), [a]);
});

test('the reading cannot be made to swallow live code by a string', () => {
	// The hazard a comment-stripping reading INTRODUCES, kept as a regression now
	// that the stripper is gone. This repository's own `MediaUpload.svelte` carries
	// `accept="image/*,video/*,audio/*"`; the round-3 reading had to track string
	// literals by hand so that `/*` would not open a block comment that never closes
	// and swallow every import after it. A tokenizer has no such hazard to manage,
	// which is the argument for using one — but the inputs that produced it are
	// still the inputs a future reading would have to survive.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': component(
					`const accept = 'image/*,video/*';\nimport Card from '$lib/agents/AgentCard.svelte';`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);

	// The same in the other delimiter, and in a regex literal whose body holds the
	// line-comment delimiter.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': component(
					`const opener = '<!--';\nconst slashes = /[//]/;\nimport Card from '$lib/agents/AgentCard.svelte';`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);

	// And the template is not script: markup holds no import declaration, so an
	// import-shaped line in it is prose. `<script>` is what Svelte executes.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': `<script>\n  const a = 1;\n</script>\n\n<p>write import Card from '$lib/agents/AgentCard.svelte' to use it</p>\n`,
			},
			{}
		),
		[]
	);
});

test('nothing outside the face imports anything behind a seam', () => {
	// The other half: a swap must not leave orphaned imports in routes or in any
	// other face. The list is DERIVED from the declaration above rather than
	// retyped, so a component added behind a seam is covered the day it is
	// declared.
	//
	// TRACKED source, not a directory listing — see `./helpers/tracked-source.mjs`.
	// Another test plants malformed fixtures inside `src/lib/compose` and removes
	// them, and a listing walk reads whatever is on disk when it happens to run.
	const outside = Object.fromEntries(
		trackedSource(repoRoot, 'src', MODULE_SOURCE)
			// The face's own directory is checked by `crossSeamImports`, which is
			// stricter than this walk rather than exempt from it.
			.filter((path) => !path.startsWith(`${agentsDir}/`))
			.map((path) => [path, readFileSync(path, 'utf8')])
	);

	assert.deepEqual(importsBehindASeam(outside, faceOnDisk()), []);

	// The walk must actually cover the tree, not merely return without complaint —
	// a file set narrowed to nothing would pass this test silently.
	assert.ok(Object.keys(outside).length > 100, 'the walk must still read the tree');
	assert.ok(
		Object.keys(outside).some((path) => path.endsWith('src/lib/routes/Agents.svelte')),
		'the routes that import the face must be in the walked set'
	);
});

test('the walked set is every module the build loads, not two suffixes', () => {
	// ROUND 5's SECOND FORM. Both walks matched `/\.(svelte|ts)$/`, so a tracked
	// `agents.svelte.js` — a runes module, ordinary source this build loads —
	// importing a component from behind a seam was never OPENED. The reading was
	// not the problem; the set it was pointed at was two suffixes wide, and a check
	// is only as honest as the files it is given.
	//
	// The set now comes from what the build can load (`MODULE_SOURCE`), shared by
	// both walks. Asserted in a scratch repository for the reason the test below
	// gives: planting files here to test which planted files are read is the race
	// `./helpers/tracked-source.mjs` exists to end.
	const scratch = mkdtempSync(join(tmpdir(), 'contentus-suffixes-'));

	try {
		execFileSync('git', ['-C', scratch, 'init', '-q']);
		const modules = [
			'Card.svelte',
			'agents.svelte.js',
			'agents.svelte.ts',
			'contract.d.ts',
			'contract.ts',
			'helper.cjs',
			'helper.cts',
			'helper.js',
			'helper.mjs',
			'helper.mts',
		];
		// Not modules whose imports this scan reads, and a parse error if handed over.
		const assets = ['logo.png', 'manifest.json', 'tokens.css'];
		for (const name of [...modules, ...assets]) writeFileSync(join(scratch, name), '\n');
		execFileSync('git', ['-C', scratch, 'add', '--', ...modules, ...assets]);

		assert.deepEqual(
			trackedSource(scratch, '.', MODULE_SOURCE).map((path) => path.slice(scratch.length + 1)),
			modules
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	// And a walked runes module gets the same reading every other module gets: it is
	// a `.js` file, not a component, so its import is read as a script's import.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/state/agents.svelte.js': `import Card from '$lib/agents/AgentCard.svelte';\n` },
			{}
		),
		['src/lib/state/agents.svelte.js → $lib/agents/AgentCard.svelte']
	);
});

test('the walked set is what the repository carries, not what is on the disk', () => {
	// WHY TRACKED FILES. `tests/renderer-authority-audit.test.mjs` plants malformed
	// `.svelte` fixtures inside `src/lib/compose` and removes them in a `finally`,
	// and `node --test` runs test files concurrently — so a walk that lists the
	// directory can read another test's fixture mid-flight. The lenient reading hid
	// that; a reading that fails closed on an unparseable component surfaced it.
	//
	// The property is asserted in a scratch repository rather than by planting a
	// file in this one, because planting a file to test the fix for planted files
	// is the same race again.
	const scratch = mkdtempSync(join(tmpdir(), 'contentus-tracked-'));

	try {
		execFileSync('git', ['-C', scratch, 'init', '-q']);
		writeFileSync(join(scratch, 'tracked.ts'), 'export const a = 1;\n');
		writeFileSync(join(scratch, 'untracked.ts'), 'export const b = 2;\n');
		execFileSync('git', ['-C', scratch, 'add', 'tracked.ts']);

		assert.deepEqual(
			trackedSource(scratch, '.', /\.ts$/),
			[join(scratch, 'tracked.ts')],
			'an untracked file is not source this repository carries'
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('the outside-the-face check can still see a violation', () => {
	// Planted the same way the cross-seam fixtures are, and for the same reason:
	// this walk had never been shown to fail, and it read one import form.
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': component(
					`import Card from '$lib/agents/AgentCard.svelte';`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);
	assert.deepEqual(
		importsBehindASeam(
			{
				'src/lib/routes/Agents.svelte': component(
					`const card = () => import('$lib/agents/AgentCard.svelte');`
				),
			},
			{}
		),
		['src/lib/routes/Agents.svelte → $lib/agents/AgentCard.svelte']
	);

	// Through a barrel inside the face, where the route's own specifier names no
	// component — the form that made this walk's green meaningless.
	assert.deepEqual(
		importsBehindASeam(
			{ 'src/lib/routes/Agents.svelte': component(`import { AgentCard } from '$lib/agents';`) },
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
			{
				'src/lib/routes/Agents.svelte': component(`const c = await import('$lib/agents/' + name);`),
			},
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
			{
				'src/lib/routes/Agents.svelte': component(
					`import Roster from '$lib/agents/AgentRoster.svelte';`
				),
			},
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

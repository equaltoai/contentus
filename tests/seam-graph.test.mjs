import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { build } from 'vite';

import { auditSeamGraph, overlayPlugin, unattributedAssets } from '../scripts/audit-seam-graph.mjs';

/**
 * The regression matrix for `scripts/audit-seam-graph.mjs`.
 *
 * WHAT THIS FILE IS FOR. Six rounds of review have compiled a legal cross-seam
 * dependency past the source-reading seam probes, and each round's fix taught the
 * reader one more form. Round 6 produced four at once — a `.jsx` helper, a `.tsx`
 * helper, a literal `require()` in a `.cjs`, and `import.meta.glob` in a `.ts` —
 * all four building a real dependency the client build takes, all four leaving
 * both probes green. The gate under test here answers that class differently: it
 * runs the repository's own Vite configuration and reads the graph the bundler
 * finishes with, so a form is covered because the build resolved it rather than
 * because someone listed it.
 *
 * A mechanism that covers a class BY CONSTRUCTION still has to be watched
 * failing, or "by construction" is a claim rather than a result. So every form
 * below is PLANTED as a real dependency and the gate must name it. The four from
 * round 6 are here because they are the ones that got through; the last two are
 * invented, and the wildcard glob is the interesting one — it names no component
 * at all, so there is nothing in the source for any reader, however good, to
 * match. The gate reports the ten components the pattern actually resolved to.
 *
 * ROUND 7 THEN FOUND ONE, which is why "by construction" was too strong a phrase
 * for what this file used to prove. `url('./CopyBlock.svelte')` in a component's
 * `<style>` is a dependency the client build takes — it emits the component as an
 * asset and writes its name into the generated stylesheet — and it left this
 * whole matrix green, because a CSS module's code is empty by the time the
 * recorder reads it. "The build resolved it" turned out to be several channels
 * rather than one, and a channel the gate was not reading is a channel it was not
 * covering. The url() cases below plant that form and the ones around it, with
 * the BUNDLE as their witness rather than the gate's own conclusion, and the
 * emitted-asset rule is what turns the next closed channel into a red gate
 * instead of another round.
 *
 * ROUND 9 THEN FOUND THE LIMIT OF THAT SENTENCE, which is what a claim about the
 * next round deserves. The emitted-asset rule turns a closed channel red only while
 * nothing ELSE accounts for the assets that channel was attributing — and the build
 * emits ONE file however many importers point at it. A window that closed for one
 * module was covered by another module's reference to the same file, and the gate
 * went green over a real cross-seam edge. The case below plants exactly that, with
 * the DEDUP as its witness, and what closes it is not a better backstop: it is the
 * gate checking that every module the build loads was read by one of its windows.
 *
 * ROUND 10 THEN CAME AT THAT RULE FROM THE OTHER SIDE, which every rule that can
 * go red deserves. "Every module the build loads" was decided by asking whether the
 * module id named a FILE — and an EXTERNAL module's id names a file too, because it
 * is one; the build simply never opens it. So every module a consumer externalizes
 * was reported as a module this gate had failed to read, and a legitimate build
 * went red for being configured. The cases below plant a genuine external through
 * the bundler's own mechanism and assert the silence, with the same plant LOADED as
 * the differential — and, in the same run as the external, a module the build did
 * load and nothing read, still named.
 *
 * ROUND 11 THEN FOUND WHAT "THE BUILD" MEANS IN A GATE THAT RUNS TWO OF THEM. The
 * modules a pass reached were recorded into ONE set, so a component the CLIENT pass
 * externalized was contained because the SERVER pass had loaded it — and the client
 * pass's own edges out of that component were neither recorded nor missed. The
 * channels are not symmetric, which is what makes that a hole rather than a
 * duplicate: a `new URL(…, import.meta.url)` is a client-pass edge and an `import()`
 * behind `import.meta.env.SSR` is a server-pass one, so the pass that was excusing
 * the other was not looking at the same graph. Both halves are planted below, each
 * with the unexternalized run as its differential, and the control is a module
 * externalized in BOTH passes — the case that must stay silent, because a file no
 * pass opens is a file no pass takes an edge from.
 *
 * HOW A TREE IS PLANTED. Through the gate's own overlay: a map of
 * repository-relative path to source, handed to the build as a plugin rather than
 * written to disk. Nothing here touches the working tree, which matters twice —
 * `node --test` runs test files concurrently and another probe plants fixtures
 * inside `src/lib/compose`, and `pnpm build` may be running beside this.
 *
 * WHY EVERY SPECIFIER IS A CONSTANT INTERPOLATED INTO THE FIXTURE. CON-5 reads
 * every gate file's RAW TEXT and fails on a relative specifier that resolves to
 * no file, so a fixture with its specifier spelled out beside an import keyword
 * would be read as this file importing something in `tests/` — this very header
 * tripped it once, in a sentence that named the offending shape outright. Held in
 * a constant and interpolated, the same string is a value the fixture computes
 * rather than an import position CON-5 reads, which is the convention the sibling
 * probes already use (`tests/agents-roster.test.mjs`). That its reader cannot
 * tell a fixture from an import is pre-existing verifier behaviour, recorded
 * rather than leaned on.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The face, and the component the MCP seam owns — the usual planted target. */
const BEHIND_SEAM = './CopyBlock.svelte';
const OWNED_BY = 'owned by AgentMcpPanel.svelte, imported from behind no seam';

/** A second component behind the same seam, for plants that need two targets. */
const ALSO_BEHIND_SEAM = './Accordion.svelte';

/**
 * A component behind a DIFFERENT seam, and the offence reaching it from the MCP
 * panel's own tree is. `CopyBlock` may be referenced by the seam that owns it and
 * may reach nothing outside it, so a dependency it takes on the roster's card is a
 * cross-seam edge in either direction it is planted.
 */
const OWNED_ELSEWHERE = './AgentCard.svelte';
const OWNED_BY_ROSTER = 'owned by AgentRoster.svelte, imported from AgentMcpPanel.svelte';

/** The same offence taken by the seam that is allowed to compose the MCP panel. */
const OWNED_BY_FROM_DETAIL = 'owned by AgentMcpPanel.svelte, imported from AgentDetail.svelte';

/**
 * A face module the build already loads, with one import prepended.
 *
 * `contract.ts` is the face's contract layer: a plain module behind no seam,
 * reached by both passes, and something every planted helper can hang off
 * without changing which components the real graph contains. Prepending leaves
 * every export it has, so nothing downstream of it stops resolving.
 */
const contract = readFileSync(join(repoRoot, 'src/lib/agents/contract.ts'), 'utf8');
const reaching = (specifier) => `import ${JSON.stringify(specifier)};\n${contract}`;

/**
 * Plant a tree, run the real gate over it, and return what it found.
 *
 * `blind` is the gate's fault injection: a predicate on the module id the
 * stylesheet observer does not look at, so a case can close ONE of the gate's
 * reading windows for ONE module and watch what the rest of it makes of that.
 * Round 9's finding is the case that needs it.
 *
 * `external` is the other one: a predicate on the resolved id AND THE PASS that
 * turns a match into a module the build resolves and then never loads, through the
 * bundler's own external mechanism rather than a mock of it. Round 10's finding
 * needs it, because nothing in this repository's configuration externalizes
 * anything but `node:` builtins and a rule nobody has watched is a rule nobody
 * should trust. Round 11's needs the pass: a consumer can externalize in one pass
 * and not the other, and a predicate that could not say so was a case nobody could
 * plant. A predicate that ignores the argument externalizes in both, which is round
 * 10's case unchanged.
 */
const audit = async (overlay, blind, external) =>
	(await auditSeamGraph({ root: repoRoot, overlay, blind, external })).findings;

/** Close the stylesheet window for one component's own `<style>` and nothing else. */
const stylesheetOf = (component) => (id) =>
	id.includes(`${component}?`) && id.includes('type=style');

/**
 * A face component with one statement spliced onto the end of its instance script,
 * and optional markup appended after it.
 *
 * Appended rather than woven into the component's own markup: a plant that matched
 * an element inside the file would silently become a no-op the day that element was
 * edited, and a no-op plant is a green that proves nothing. The differential run in
 * every case below is what would catch that, and this keeps it from arising.
 */
const scripted = (name, statement, markup = '') =>
	readFileSync(join(repoRoot, `src/lib/agents/${name}`), 'utf8').replace(
		'</script>',
		`\t${statement}\n</script>`
	) + markup;

/** A face component with a `<style>` block appended, which none of them has. */
const styled = (name, ...rules) =>
	`${readFileSync(join(repoRoot, `src/lib/agents/${name}`), 'utf8')}\n` +
	`<style>\n\t${rules.join('\n\t')}\n</style>\n`;

/**
 * What the CLIENT BUILD emitted for a planted tree, read from the bundle.
 *
 * THE WITNESS, and separate from the gate on purpose. A regression that asserts
 * only "the gate reports this" proves the gate consistent with itself; the r6
 * matrix answered that by reading the COMPILER's output for every planted form,
 * so each was a proven dependency before it was a caught one. A CSS `url()` has
 * no compiler output to read — the dependency exists because the BUNDLER emitted
 * a file and pointed the stylesheet at it — so this reads that instead: the same
 * planting mechanism the gate uses, a build of its own, and nothing of the gate's
 * judgement in between.
 */
async function emittedByClientBuild(overlay) {
	const assets = [];
	await build({
		root: repoRoot,
		logLevel: 'error',
		build: { write: false, minify: false, sourcemap: false },
		plugins: [
			overlayPlugin(repoRoot, overlay),
			{
				name: 'contentus:seam-graph-witness',
				enforce: 'post',
				generateBundle(_options, bundle) {
					for (const [fileName, output] of Object.entries(bundle))
						if (output.type === 'asset')
							assets.push({
								fileName,
								from: output.originalFileNames ?? [],
								text: typeof output.source === 'string' ? output.source : '',
							});
				},
			},
		],
	});
	return assets;
}

test('the tree the repository carries has no cross-seam edge', async () => {
	// The baseline every case below is a differential against. Without it a green
	// planted case could mean the gate is silent rather than that the plant failed
	// to build, and the whole matrix would be evidence of nothing.
	assert.deepEqual(await audit({}), []);
});

test('a .jsx helper cannot carry a dependency past the gate', async () => {
	// ROUND 6, FORM 1. The source probes walk `\.(svelte|[cm]?[jt]s)$`, so a `.jsx`
	// file was never opened — and Vite compiles one without comment.
	const helper = './seam-probe.jsx';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.jsx': `import CopyBlock from ${JSON.stringify(BEHIND_SEAM)};\nexport const use = () => CopyBlock;\n`,
		}),
		[`src/lib/agents/seam-probe.jsx → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('a .tsx helper cannot carry a dependency past the gate', async () => {
	// ROUND 6, FORM 2. The same hole in the same walk, one suffix over.
	const helper = './seam-probe.tsx';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.tsx': `import CopyBlock from ${JSON.stringify(BEHIND_SEAM)};\nexport const use = () => CopyBlock;\n`,
		}),
		[`src/lib/agents/seam-probe.tsx → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('a literal require() in a .cjs cannot carry a dependency past the gate', async () => {
	// ROUND 6, FORM 3. `.cjs` IS in the source probes' walked set, and the reading
	// is a TypeScript syntax tree: `require('…')` is a call to a function named
	// `require`, not an import node, so the walk opened the file and found nothing.
	// The bundler resolves it, which is the only question this gate asks.
	const helper = './seam-probe.cjs';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.cjs': `const CopyBlock = require(${JSON.stringify(BEHIND_SEAM)});\nmodule.exports = { CopyBlock };\n`,
		}),
		[`src/lib/agents/seam-probe.cjs → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('import.meta.glob cannot carry a dependency past the gate', async () => {
	// ROUND 6, FORM 4. `import.meta.glob(…)` is a member call on `import.meta` —
	// a different node from an import declaration and a different node from an
	// import call, so no import reading sees it. Vite rewrites it into imports
	// before the bundler ever parses the module, which is why the graph has it.
	const helper = './seam-probe.ts';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `export const blocks = import.meta.glob(${JSON.stringify(BEHIND_SEAM)}, { eager: true });\n`,
		}),
		[`src/lib/agents/seam-probe.ts → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('a wildcard glob naming no component is still ten cross-seam edges', async () => {
	// THE INVENTED FORM, and the one that makes the architectural point rather than
	// adding a seventh entry to a list. `'./[A-Z]*.svelte'` names nothing: there is
	// no component in the source for a reader to match, however many forms it
	// knows, because the set of files is not in the text — it is on the disk, and
	// only the bundler goes and looks. One line of a face module quietly takes a
	// dependency on every component behind every seam.
	//
	// The gate reports the ten it resolved to, each on its own line, which is also
	// the answer the next steward needs: the shared badge is the one component this
	// is allowed to reach, and every other name here is a swap this line would
	// break.
	const helper = './seam-probe.ts';
	const pattern = './[A-Z]*.svelte';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `export const all = import.meta.glob(${JSON.stringify(pattern)});\n`,
		}),
		[
			'src/lib/agents/seam-probe.ts → src/lib/agents/Accordion.svelte (owned by AgentMcpPanel.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentCapabilities.svelte (owned by AgentDetail.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentCard.svelte (owned by AgentRoster.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentDetail.svelte (a seam imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentMcpPanel.svelte (a seam imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentRoster.svelte (a seam imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentRosterFilters.svelte (owned by AgentRoster.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/AgentTrustDetail.svelte (owned by AgentDetail.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/CopyBlock.svelte (owned by AgentMcpPanel.svelte, imported from behind no seam)',
			'src/lib/agents/seam-probe.ts → src/lib/agents/MyAgents.svelte (owned by AgentRoster.svelte, imported from behind no seam)',
		]
	);
});

test('a dependency that is not an import at all is still a dependency', async () => {
	// THE SECOND INVENTED FORM. `new URL('./X', import.meta.url)` contains no
	// import in any dialect — an import reading has nothing to read. Vite emits the
	// file as an asset and leaves a reference marker in the importer, and the gate
	// turns that marker back into the file it came from, so the edge is recorded
	// through a channel that is not the module graph.
	//
	// The CLIENT pass is what sees this. The server pass leaves the expression
	// verbatim as a runtime URL and creates no dependency to record, which is
	// written down in the gate's header as a boundary rather than left to be found.
	const helper = './seam-probe.ts';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `export const href = new URL(${JSON.stringify(BEHIND_SEAM)}, import.meta.url).href;\n`,
		}),
		[`src/lib/agents/seam-probe.ts → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('a query on a specifier does not hide the file it addresses', async () => {
	// ROUND 5's third form, held under the new mechanism. `?raw` gives the importer
	// the component's TEXT rather than the component, and the bundler resolves the
	// same file either way — which is the only thing a seam check is about.
	const helper = './seam-probe.ts';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `import source from ${JSON.stringify(`${BEHIND_SEAM}?raw`)};\nexport const text = source;\n`,
		}),
		[`src/lib/agents/seam-probe.ts → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`]
	);
});

test('a dependency the build cannot name is a finding, not a pass', async () => {
	// FAIL CLOSED, on the build's own reading. A dynamic import whose target is not
	// a literal resolves to nothing, so it leaves no edge — and "the build could not
	// name what this loads" and "this loads nothing behind a seam" must not be the
	// same green. The expression is quoted from the module's FINAL code, which is
	// what the bundler parsed rather than what the author typed.
	const helper = './seam-probe.ts';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `const name = ${JSON.stringify(BEHIND_SEAM)};\nexport const load = () => import(name);\n`,
		}),
		['src/lib/agents/seam-probe.ts → import(name) (a dependency the build cannot name)']
	);
});

test('a worker is a channel this gate does not record, and says so', async () => {
	// THE TRIPWIRE. A worker's modules are bundled by a separate Rolldown build
	// whose plugin list is `config.worker.plugins`; nothing in the main pipeline is
	// in it, so no recorder placed there can see inside one. Supplying that list
	// from the gate was tried and rejected — it would replace whatever
	// `vite.config.ts` sets and measure a build that is not the one `pnpm build`
	// runs.
	//
	// So the channel is detected instead of covered, from VITE'S OWN MARKER in the
	// final code rather than from any spelling of the constructor, and reported as
	// unknown. Contentus has no workers today; the day it has one this is red until
	// someone extends the gate, which is the honest order of events.
	//
	// The finding names the module the marker lands in, which is the WORKER ENTRY
	// for a `?worker` import and the IMPORTER for `new Worker(new URL(…))`. Both
	// are the file a reader has to go and look at, so the wording fits either.
	const helper = './seam-probe.ts';
	const worker = './mcp.ts?worker';
	assert.deepEqual(
		await audit({
			'src/lib/agents/contract.ts': reaching(helper),
			'src/lib/agents/seam-probe.ts': `import Probe from ${JSON.stringify(worker)};\nexport const spawn = () => new Probe();\n`,
		}),
		[
			"src/lib/agents/mcp.ts carries a worker reference, and a worker's own modules are bundled by a separate build this gate does not record, so what that worker depends on is unknown",
		]
	);
});

test('a face file the build never loads is a finding, not a silence', async () => {
	// CONTAINMENT. This gate can only judge what the build resolves, so a tracked
	// file in the face that no pass loads is a file it cannot judge — and saying so
	// is the difference between a gap and a silence. It is also what closes the
	// channels the module graph does not model: a `.css` added to the face, reached
	// only by an `@import` Vite resolves through postcss, turns this red instead of
	// passing unexamined.
	//
	// Planted by replacing the seam that composes them: with the detail page's
	// imports gone, two tracked components stop being reachable from any entry.
	const detail = `<script lang="ts">\n\tconst face = 'detail';\n</script>\n\n<div>{face}</div>\n`;
	assert.deepEqual(await audit({ 'src/lib/agents/AgentDetail.svelte': detail }), [
		'src/lib/agents/Accordion.svelte is tracked inside the face and no build pass loads it, so no edge of its own is recorded and this gate cannot judge it',
		'src/lib/agents/AgentCapabilities.svelte is tracked inside the face and no build pass loads it, so no edge of its own is recorded and this gate cannot judge it',
		'src/lib/agents/AgentMcpPanel.svelte is tracked inside the face and no build pass loads it, so no edge of its own is recorded and this gate cannot judge it',
		'src/lib/agents/AgentTrustDetail.svelte is tracked inside the face and no build pass loads it, so no edge of its own is recorded and this gate cannot judge it',
		'src/lib/agents/CopyBlock.svelte is tracked inside the face and no build pass loads it, so no edge of its own is recorded and this gate cannot judge it',
	]);
});

test("a url() in a component's own <style> is a dependency the build takes", async () => {
	// ROUND 7's FINDING, planted the way it was found. `AgentDetail` composes the
	// MCP seam and may not reach past it; a stylesheet in `AgentDetail` that points
	// at `CopyBlock` does exactly that, and every check in this repository said
	// nothing. The gate ran the real build, the real build EMITTED the component as
	// an asset, and the edge existed in no channel the gate was reading: a CSS
	// module's code is empty by `buildEnd`, so the marker naming that asset was not
	// hidden from the recorder, it was gone before the recorder looked.
	const overlay = {
		'src/lib/agents/AgentDetail.svelte': styled(
			'AgentDetail.svelte',
			`:global(.contentus-agent-detail__probe) { background-image: url('${BEHIND_SEAM}'); }`
		),
	};

	// THE WITNESS, before the gate is asked anything. The client build emits
	// `CopyBlock.svelte` as a file of its own and writes that file's name into the
	// stylesheet it generates — which is the dependency, in the bundler's own
	// output, whatever any check makes of it.
	const assets = await emittedByClientBuild(overlay);
	const emitted = assets.find(({ from }) => from.includes('src/lib/agents/CopyBlock.svelte'));
	assert.ok(emitted, 'the client build must emit the component the stylesheet points at');
	assert.ok(
		assets.some(
			({ fileName, text }) => fileName.endsWith('.css') && text.includes(emitted.fileName)
		),
		'the generated stylesheet must carry the emitted file name'
	);

	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/AgentDetail.svelte → src/lib/agents/CopyBlock.svelte (${OWNED_BY_FROM_DETAIL})`,
	]);
});

/**
 * The url() forms, each planted in a HOST of its own so one build proves them all.
 *
 * A separate gate run per form would be a separate pair of Vite builds per form.
 * Planting each in a different component instead makes every finding name its own
 * importer, so a form that stopped resolving loses its own line rather than
 * hiding behind another form's. Two targets per host — both behind the MCP seam —
 * because that doubles the hosts available without making two forms produce the
 * same sentence.
 *
 * `:global(…)` throughout: an unused scoped selector is pruned by the Svelte
 * compiler before Vite ever sees the URL, and what is under test is the URL.
 */
const URL_FORMS = [
	{
		host: 'AgentRoster.svelte',
		seam: 'AgentRoster.svelte',
		target: 'CopyBlock.svelte',
		form: 'double quotes',
		rule: `:global(.p1) { background-image: url("${BEHIND_SEAM}"); }`,
	},
	{
		host: 'AgentRoster.svelte',
		seam: 'AgentRoster.svelte',
		target: 'Accordion.svelte',
		form: 'no quotes at all',
		rule: `:global(.p2) { background-image: url(${ALSO_BEHIND_SEAM}); }`,
	},
	{
		host: 'AgentCard.svelte',
		seam: 'AgentRoster.svelte',
		target: 'CopyBlock.svelte',
		form: 'a sibling named without ./',
		rule: `:global(.p3) { background-image: url('${BEHIND_SEAM.slice(2)}'); }`,
	},
	{
		host: 'AgentCard.svelte',
		seam: 'AgentRoster.svelte',
		target: 'Accordion.svelte',
		form: 'through the $lib alias',
		rule: `:global(.p4) { background-image: url('$lib/agents/Accordion.svelte'); }`,
	},
	{
		host: 'AgentRosterFilters.svelte',
		seam: 'AgentRoster.svelte',
		target: 'CopyBlock.svelte',
		form: 'a query on the URL',
		rule: `:global(.p5) { background-image: url('${BEHIND_SEAM}?variant'); }`,
	},
	{
		host: 'AgentRosterFilters.svelte',
		seam: 'AgentRoster.svelte',
		target: 'Accordion.svelte',
		form: 'a root-absolute path that names a real file',
		rule: `:global(.p6) { background-image: url('/src/lib/agents/Accordion.svelte'); }`,
	},
	{
		host: 'MyAgents.svelte',
		seam: 'AgentRoster.svelte',
		target: 'CopyBlock.svelte',
		form: 'nested inside image-set()',
		rule: `:global(.p7) { background-image: image-set(url('${BEHIND_SEAM}') 1x); }`,
	},
	{
		host: 'MyAgents.svelte',
		seam: 'AgentRoster.svelte',
		target: 'Accordion.svelte',
		form: 'an @font-face source rather than a rule',
		rule: `@font-face { font-family: probe; src: url('${ALSO_BEHIND_SEAM}'); }`,
	},
	{
		host: 'AgentCapabilities.svelte',
		seam: 'AgentDetail.svelte',
		target: 'CopyBlock.svelte',
		form: 'inside @media',
		rule: `@media (min-width: 1px) { :global(.p9) { background-image: url('${BEHIND_SEAM}'); } }`,
	},
	{
		host: 'AgentCapabilities.svelte',
		seam: 'AgentDetail.svelte',
		target: 'Accordion.svelte',
		form: 'inside @supports',
		rule: `@supports (display: grid) { :global(.pa) { background-image: url('${ALSO_BEHIND_SEAM}'); } }`,
	},
];

/**
 * The url() forms that are NOT dependencies, planted together in one host.
 *
 * Each names something a build cannot resolve to a file: a `data:` URL carries
 * its own bytes, a remote origin and a protocol-relative one are fetched at
 * runtime, and a root-absolute path with no file behind it is left as written for
 * a server to answer. None emits an asset, so none is an edge — and the rule is
 * "did the build resolve it", not "how was it spelled", which is why the
 * root-absolute form appears on BOTH lists: the one above names a real file and
 * is a dependency, this one does not and is not.
 */
const INERT_HOST = 'AgentTrustDetail.svelte';
const INERT_URLS = [
	`background-image: url('data:image/gif;base64,R0lGODlhAQABAAAAACw=');`,
	`border-image: url('https://example.invalid/src/lib/agents/CopyBlock.svelte');`,
	`list-style-image: url('//example.invalid/src/lib/agents/Accordion.svelte');`,
	`mask-image: url('/src/lib/agents/NoSuchComponentIsHere.svelte');`,
];

test('every url() the build resolves is an edge, and nothing else is', async () => {
	const hosts = new Map();
	for (const { host, rule } of URL_FORMS) hosts.set(host, [...(hosts.get(host) ?? []), rule]);
	hosts.set(INERT_HOST, [`:global(.inert) {\n\t\t${INERT_URLS.join('\n\t\t')}\n\t}`]);

	const overlay = Object.fromEntries(
		[...hosts].map(([host, rules]) => [`src/lib/agents/${host}`, styled(host, ...rules)])
	);

	// One line per resolving form. A form that stopped resolving would drop its own
	// line; an inert URL that started resolving would add one nothing expects.
	assert.deepEqual(
		await audit(overlay),
		URL_FORMS.map(
			({ host, seam, target }) =>
				`src/lib/agents/${host} → src/lib/agents/${target} ` +
				`(owned by AgentMcpPanel.svelte, imported from ${seam})`
		).sort()
	);
});

test('an emitted asset nothing accounts for is a finding, not a pass', () => {
	// THE BACKSTOP, watched failing. Reading references is how this gate turns an
	// emitted asset into an edge, and round 7 is the proof that a reference channel
	// can be closed without anyone noticing. So the question is asked from the other
	// end as well: everything the build emits must be accounted for.
	//
	// It is exercised here rather than through a planted tree because no tree this
	// overlay can plant produces an unaccounted asset — every asset in this build
	// carries a reference marker somewhere. What CAN be done is to close the channel
	// and watch: with `styleRecorder`'s transform disabled, the round-7 plant above
	// stops being a seam finding and becomes
	//
	//   assets/CopyBlock-DCUnZRxx.svelte: the client build emits this file and
	//   nothing this gate records references it, so what depends on
	//   src/lib/agents/CopyBlock.svelte is unknown
	//
	// which is the whole point: a closed channel costs this gate its green, not its
	// coverage. That demonstration is a one-line edit and a run, recorded here
	// rather than committed as a test that would have to break the gate to pass.
	const emitted = [
		{ fileName: 'assets/CopyBlock-hash.svelte', from: ['src/lib/agents/CopyBlock.svelte'] },
		{ fileName: 'assets/entry-client-hash.css', from: ['src/facetheory/entry-client.ts'] },
	];
	assert.deepEqual(
		unattributedAssets('client', emitted, new Set(['assets/entry-client-hash.css'])),
		[
			'assets/CopyBlock-hash.svelte: the client build emits this file and nothing this gate ' +
				'records references it, so what depends on src/lib/agents/CopyBlock.svelte is unknown',
		]
	);

	// The worker exception, which is an exception to the ORIGIN-LESS half only. A
	// worker's bundle is generated code named by a marker Vite rewrites from a map
	// of its own, so it can never be attributed — and the worker tripwire has
	// already made that pass red, in a sentence that says what is actually unknown.
	const workerBundle = [{ fileName: 'assets/mcp-hash.js', from: [] }];
	assert.deepEqual(unattributedAssets('client', workerBundle, new Set(), true), []);
	assert.deepEqual(unattributedAssets('client', workerBundle, new Set(), false), [
		'assets/mcp-hash.js: the client build emits this file and nothing this gate records ' +
			'references it, so what depends on it is unknown',
	]);

	// A file with an origin is reported whether or not the pass builds a worker,
	// because that is the case a seam can hide in.
	assert.deepEqual(unattributedAssets('server', emitted, new Set(), true), [
		'assets/CopyBlock-hash.svelte: the server build emits this file and nothing this gate ' +
			'records references it, so what depends on src/lib/agents/CopyBlock.svelte is unknown',
		'assets/entry-client-hash.css: the server build emits this file and nothing this gate ' +
			'records references it, so what depends on src/facetheory/entry-client.ts is unknown',
	]);
});

test('a window that closes for one module is a finding, not a dedup', async () => {
	// ROUND 9's FINDING, planted step for step the way the review demonstrated it.
	// Two components point a `url()` at the SAME file: `AgentMcpPanel`, which owns
	// `CopyBlock` and may reference it, and `AgentDetail`, which nests that seam and
	// may not reach past it. The build emits ONE asset for the two of them.
	//
	// Close the stylesheet window for `AgentDetail` alone — a plugin-order or
	// compiler change that alters handling for a SUBSET of modules — and every rule
	// that reads references still holds: the legal reference is recorded, the one
	// emitted file is attributed by it, and the emitted-asset backstop has nothing
	// left to report. The illegal edge disappears into the other importer's
	// attribution, and the gate was GREEN. Attribution is by emitted file name, and
	// a file name cannot tell two importers apart.
	const url = (probe) => `:global(.${probe}) { background-image: url('${BEHIND_SEAM}'); }`;
	const overlay = {
		'src/lib/agents/AgentMcpPanel.svelte': styled('AgentMcpPanel.svelte', url('legal')),
		'src/lib/agents/AgentDetail.svelte': styled('AgentDetail.svelte', url('illegal')),
	};

	// THE WITNESS, and here it is the DEDUP that has to be witnessed rather than the
	// dependency: one emitted file, named twice in one generated stylesheet. Without
	// that the case would prove nothing — two emitted files would give each importer
	// a name of its own and there would be no concealment to close.
	const assets = await emittedByClientBuild(overlay);
	const emitted = assets.filter(({ from }) => from.includes('src/lib/agents/CopyBlock.svelte'));
	assert.equal(emitted.length, 1, 'the two references must resolve to ONE emitted file');
	const sheet = assets.find(
		({ fileName, text }) => fileName.endsWith('.css') && text.includes(emitted[0].fileName)
	);
	assert.ok(sheet, 'the generated stylesheet must carry the emitted file name');
	assert.equal(
		sheet.text.split(emitted[0].fileName).length - 1,
		2,
		'both rules must point at that one file'
	);

	// BOTH WINDOWS OPEN, which is the control. The legal reference is silent because
	// the seam that owns `CopyBlock` is allowed to reference it; the illegal one is
	// the finding. A case that only asserted the blinded run would pass just as well
	// against a gate that reported this offence for no reason at all.
	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/AgentDetail.svelte → src/lib/agents/CopyBlock.svelte (${OWNED_BY_FROM_DETAIL})`,
	]);

	// ONE WINDOW CLOSED, on one module, in both passes. The gate no longer records
	// the edge — it cannot; nothing read the module that carries it — and that is
	// exactly why the finding it does report is the honest one: this gate read no
	// code at all for that stylesheet, so what it references is unknown. Red, naming
	// the module, rather than a green built on another importer's attribution.
	assert.deepEqual(await audit(overlay, stylesheetOf('AgentDetail.svelte')), [
		'src/lib/agents/AgentDetail.svelte?svelte&type=style&lang.css: neither window this gate ' +
			"reads holds the client build's code for this module, so what it references is unknown",
		'src/lib/agents/AgentDetail.svelte?svelte&type=style&lang.css: neither window this gate ' +
			"reads holds the server build's code for this module, so what it references is unknown",
	]);
});

test('a module the build never loads is not a module this gate failed to read', async () => {
	// ROUND 10's FINDING, planted the way the review demonstrated it. A module marked
	// EXTERNAL is resolved and then deliberately skipped: the bundler lists it in the
	// graph under the id it resolved TO, holds no code for it, and never calls a load
	// or a transform hook for it. For an external FILE that id is an absolute path,
	// spelled exactly like every module the build did open — so the rule that decided
	// "the build went and got this" from the id's shape said yes, found no code in
	// either reading window, and reported it unread. In both passes. Every module a
	// consumer's configuration externalizes was a finding, which is this gate turning
	// red at a build for doing something legitimate.
	const helper = './seam-external.ts';
	const overlay = {
		'src/lib/agents/contract.ts': reaching(helper),
		'src/lib/agents/seam-external.ts': `import CopyBlock from ${JSON.stringify(BEHIND_SEAM)};\nexport const use = () => CopyBlock;\n`,
	};
	const externalHelper = (id) => id.endsWith('seam-external.ts');

	// LOADED, which is the differential the runs below are against. The same plant,
	// the same position, nothing externalized: a real module taking a real cross-seam
	// dependency, and the gate names it. Without this, a clean run below would be
	// evidence that the plant never built.
	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/seam-external.ts → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`,
	]);

	// EXTERNALIZED, and therefore SILENT — the whole finding. There is no code for
	// this module in any window because there is no code for it anywhere: the build
	// resolved it and left it alone. Nothing here went unread. The cross-seam import
	// it carries is gone too, and correctly so — a module the build does not load
	// takes no dependency in this build.
	assert.deepEqual(await audit(overlay, undefined, externalHelper), []);

	// AND THE SAME RUN STILL FAILS CLOSED, which is what the silence above must not
	// have cost. Round 9's two-importer plant rides along — `AgentMcpPanel` legally
	// references `CopyBlock` from its own `<style>`, `AgentDetail` illegally does the
	// same, one asset is emitted for the two of them — with the window closed for
	// `AgentDetail` alone. One module the build never loaded is silent and one module
	// the build loaded and nothing read is named, in one gate run, told apart by the
	// build rather than by the shape of an id.
	const url = (probe) => `:global(.${probe}) { background-image: url('${BEHIND_SEAM}'); }`;
	const alsoBlinded = {
		...overlay,
		'src/lib/agents/AgentMcpPanel.svelte': styled('AgentMcpPanel.svelte', url('legal')),
		'src/lib/agents/AgentDetail.svelte': styled('AgentDetail.svelte', url('illegal')),
	};
	assert.deepEqual(await audit(alsoBlinded, stylesheetOf('AgentDetail.svelte'), externalHelper), [
		'src/lib/agents/AgentDetail.svelte?svelte&type=style&lang.css: neither window this gate ' +
			"reads holds the client build's code for this module, so what it references is unknown",
		'src/lib/agents/AgentDetail.svelte?svelte&type=style&lang.css: neither window this gate ' +
			"reads holds the server build's code for this module, so what it references is unknown",
	]);
});

test('a face component the build externalizes is a file this gate cannot judge', async () => {
	// THE OTHER HALF OF ROUND 10, and the reason the silence above is not a hole.
	// Excusing an external from the reading rule must not excuse it from the
	// CONTAINMENT rule: a tracked file in the face that no pass loads is a file this
	// gate has nothing to say about, and externalizing one is a way to arrange that
	// from the outside. So a module the build never loaded is not counted as reached
	// either, and the face's own rule reports it — rather than a green resting on a
	// module the gate never saw the inside of.
	//
	// No overlay at all: the tree the repository carries, with one component
	// externalized through the gate's own injection. A predicate that ignores the
	// pass externalizes in BOTH, so both passes report it — each for its own graph,
	// which is round 11's rule and reads here as the same fact said twice.
	assert.deepEqual(await audit({}, undefined, (id) => id.endsWith('CopyBlock.svelte')), [
		'src/lib/agents/CopyBlock.svelte is tracked inside the face and the client build resolves ' +
			'it and never loads it, so the edges it takes in that pass are unrecorded and this gate ' +
			'cannot judge it there',
		'src/lib/agents/CopyBlock.svelte is tracked inside the face and the server build resolves ' +
			'it and never loads it, so the edges it takes in that pass are unrecorded and this gate ' +
			'cannot judge it there',
	]);
});

test('the pass that loads a component does not excuse the pass that externalizes it', async () => {
	// ROUND 11's FINDING, planted the way the review demonstrated it. `CopyBlock`
	// takes a `new URL('./AgentCard.svelte', import.meta.url)` — a dependency ONLY THE
	// CLIENT PASS has, because the server build leaves that expression verbatim as a
	// runtime URL and emits nothing. Externalize `CopyBlock` in the client pass alone
	// and the edge is gone: the pass that had it never opened the module that carries
	// it. The gate was green, because the containment rule read one set of reached
	// modules for both passes and the SERVER pass had loaded the file.
	const overlay = {
		'src/lib/agents/CopyBlock.svelte': scripted(
			'CopyBlock.svelte',
			`const probe = new URL(${JSON.stringify(OWNED_ELSEWHERE)}, import.meta.url).href;`,
			'\n<span hidden data-probe={probe}></span>\n'
		),
	};

	// LOADED, the differential. The plant is a real cross-seam dependency and the
	// gate names it — so a clean run below is the masking rather than a plant that
	// never built.
	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/CopyBlock.svelte → src/lib/agents/AgentCard.svelte (${OWNED_BY_ROSTER})`,
	]);

	// EXTERNALIZED IN THE CLIENT PASS ONLY, which is the whole case. The edge is
	// unrecorded and unrecordable — and the finding says exactly that about exactly
	// that pass, rather than resting on the server pass having opened the same file.
	assert.deepEqual(
		await audit(
			overlay,
			undefined,
			(id, pass) => pass === 'client' && id.endsWith('CopyBlock.svelte')
		),
		[
			'src/lib/agents/CopyBlock.svelte is tracked inside the face and the client build ' +
				'resolves it and never loads it, so the edges it takes in that pass are unrecorded ' +
				'and this gate cannot judge it there',
		]
	);
});

test('the same holds for the pass the other one cannot see into', async () => {
	// THE SYMMETRIC HALF, and the reason the rule is about passes rather than about
	// the client pass. `import.meta.env.SSR` is replaced with a constant before the
	// bundler parses, so the client build eliminates this branch and never resolves
	// the target: the edge exists in the SERVER graph and in no other. Externalizing
	// `CopyBlock` in the server pass alone takes it away, and the client pass — which
	// loads the file and records its imports — has nothing to say about it.
	const overlay = {
		'src/lib/agents/CopyBlock.svelte': scripted(
			'CopyBlock.svelte',
			`if (import.meta.env.SSR) void import(${JSON.stringify(OWNED_ELSEWHERE)});`
		),
	};

	// LOADED, the differential again. One finding, from the server pass's `import()`.
	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/CopyBlock.svelte → src/lib/agents/AgentCard.svelte (${OWNED_BY_ROSTER})`,
	]);

	assert.deepEqual(
		await audit(
			overlay,
			undefined,
			(id, pass) => pass === 'server' && id.endsWith('CopyBlock.svelte')
		),
		[
			'src/lib/agents/CopyBlock.svelte is tracked inside the face and the server build ' +
				'resolves it and never loads it, so the edges it takes in that pass are unrecorded ' +
				'and this gate cannot judge it there',
		]
	);
});

test('a module no pass opens is a module no pass takes an edge from', async () => {
	// THE CONTROL, and the direction a rule that just got stricter owes. Round 10's
	// silence must survive round 11's fix: a module the configuration externalizes in
	// BOTH passes is not a file this gate failed to read, and the per-pass rule must
	// not turn it into two findings where the union rule had none.
	//
	// The plant carries the same client-pass-only reference as the case above, so
	// this is the closest thing to a false positive the new rule could produce — a
	// cross-seam dependency in the source, invisible to the server pass by channel and
	// to the client pass by configuration — and the answer is still silence, because
	// no pass opened the module and none of them takes the edge.
	const helper = './seam-external.ts';
	const overlay = {
		'src/lib/agents/contract.ts': reaching(helper),
		'src/lib/agents/seam-external.ts': `export const href = new URL(${JSON.stringify(BEHIND_SEAM)}, import.meta.url).href;\n`,
	};

	assert.deepEqual(await audit(overlay), [
		`src/lib/agents/seam-external.ts → src/lib/agents/CopyBlock.svelte (${OWNED_BY})`,
	]);
	assert.deepEqual(await audit(overlay, undefined, (id) => id.endsWith('seam-external.ts')), []);
});

test('the declared nesting is the one cross-seam import that is not a defect', async () => {
	// A check that fired on every edge would be a check nobody could keep green.
	// `AgentDetail` composing `AgentMcpPanel` is the declared nesting — the thing
	// that keeps the MCP panel independently swappable — and it stays quiet however
	// it is written, here through a component planted from scratch.
	const detail =
		`<script lang="ts">\n` +
		`\timport Panel from ${JSON.stringify('./AgentMcpPanel.svelte')};\n` +
		`\timport Capabilities from ${JSON.stringify('./AgentCapabilities.svelte')};\n` +
		`\timport TrustDetail from ${JSON.stringify('./AgentTrustDetail.svelte')};\n` +
		`</script>\n\n<div><Capabilities /><TrustDetail /><Panel /></div>\n`;
	assert.deepEqual(await audit({ 'src/lib/agents/AgentDetail.svelte': detail }), []);
});

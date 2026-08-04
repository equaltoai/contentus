import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { auditSeamGraph } from '../scripts/audit-seam-graph.mjs';

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

/** Plant a tree, run the real gate over it, and return what it found. */
const audit = async (overlay) => (await auditSeamGraph({ root: repoRoot, overlay })).findings;

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

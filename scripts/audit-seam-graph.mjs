#!/usr/bin/env node

/**
 * Face 6's swap seams, checked against the edge set THE BUILD ITSELF RESOLVES.
 *
 * WHY THIS EXISTS, which is the whole argument for the shape of it. Two probes
 * — `tests/agents-mobile.test.mjs` and `tests/agents-roster.test.mjs` — assert
 * the same seam property by READING SOURCE and extracting the imports they can
 * see. Six rounds of review have now compiled a legal cross-seam dependency past
 * each successive version of that reading, and every round's fix was the same
 * move: teach the reader one more form. Round 3 found four comment placements,
 * round 4 found two more plus a markup disguise, round 5 found markup imports,
 * a `.svelte.js` suffix the walk never opened, and a `?raw` query, round 6 found
 * `.jsx` and `.tsx` helpers, a literal `require()` in a `.cjs`, and
 * `import.meta.glob` in a `.ts`. Each was a real dependency the client build
 * takes; each left both probes green.
 *
 * The class is not "comments" or "queries" or "suffixes". It is EVERY WAY VITE
 * CAN CREATE A DEPENDENCY, and that set is defined by the bundler, extended by
 * its plugins, and not enumerable by anyone reading source with a parser. A
 * seventh round would find a seventh form.
 *
 * So this gate does not read source at all. It runs the repository's own Vite
 * configuration, twice — the client pass and the server pass `pnpm build` runs —
 * and records the module graph the bundler finishes with. Every dependency form
 * is covered BY CONSTRUCTION: `.jsx`, `.tsx`, `require()` in a `.cjs`,
 * `import.meta.glob`, `?raw`, a dynamic `import()`, a `new URL(…,
 * import.meta.url)` asset reference, and the forms nobody has thought of,
 * because the question asked is not "what does this text say" but "what did the
 * build resolve". A form Vite does not support creates no dependency and is not
 * one; a form it supports creates a module, and every module is here.
 *
 * WHAT THIS GATE CANNOT SEE, stated plainly, because a mechanism that claims
 * everything is a mechanism nobody can check. Each one is either covered by
 * another check that stays, or turned into a TRIPWIRE — a red gate the day the
 * channel is used — rather than left as a silence:
 *
 *   1. A file the build never loads. 707 of this repository's 1246 tracked
 *      modules are vendored greater source nothing imports, and a dependency
 *      inside dead code is invisible here. That is not a hole this gate should
 *      close by pretending to load them — it is why the source-reading probes
 *      STAY, and their headers say so. The two checks have different domains:
 *      this one reads every form on the modules the build loads, they read every
 *      tracked file in one form. Neither subsumes the other and both run.
 *   2. `@import` inside CSS, which Vite resolves through postcss rather than
 *      through the module graph. CSS cannot import a component, so it cannot
 *      cross a seam — and the containment check below turns any non-module file
 *      appearing in the face into a finding rather than a silence, so the day
 *      that assumption changes is the day this gate goes red.
 *   3. A WORKER's own modules. `new Worker(new URL(…))` is bundled by a separate
 *      Rolldown build whose plugin list is `config.worker.plugins` — the main
 *      pipeline is not in it, so a recorder in `plugins` never sees inside one.
 *      Supplying `worker.plugins` from here was tried and rejected: it REPLACES
 *      whatever `vite.config.ts` sets, so the gate would measure a build that is
 *      not the one `pnpm build` runs, which is the one thing this mechanism may
 *      not do. Instead the reference is detected — Vite leaves its own marker in
 *      the importer — and reported as a channel this gate does not record. A
 *      worker is a red gate here until someone extends this, which is the honest
 *      order of events.
 *   4. `new URL('./X', import.meta.url)` in a module the SERVER pass loads and
 *      the client pass does not. Vite rewrites that form to an emitted asset in
 *      the client build, which this gate reads; in the server build it leaves it
 *      verbatim as a runtime URL and creates no dependency to record.
 *
 * FAIL-CLOSED, in the three places it can matter: a build that throws is a red
 * gate rather than an empty edge set, a module whose final code the build's own
 * parser cannot read is a finding, and a dynamic `import()` whose target is not
 * a literal is a finding wherever it sits under `src/` — "the build cannot name
 * what this loads" and "this loads nothing behind a seam" are different facts.
 *
 * The build runs with `write: false`, so this never touches `build/` and can run
 * beside `pnpm build` without racing its output.
 */

import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { DECLARED, FACE_DIR, faceName, seamOffence } from './lib/agent-seams.mjs';

/**
 * The two passes `pnpm build` runs, named the way the package scripts name them.
 *
 * `ssr: true` rather than a path: `vite.config.ts` already supplies the server
 * entry when it is building for SSR, and the flag is only what tells it which
 * build this is. Naming the entry here would be a second copy of a path the
 * configuration already owns, free to drift from it.
 */
const PASSES = [
	{ name: 'client', options: {} },
	{ name: 'server', options: { ssr: true } },
];

/** Vite's marker for a file referenced as an asset rather than imported. */
const ASSET_REFERENCE = /__VITE_ASSET__([\w$]+)__/g;

/**
 * Vite's marker for a worker bundled by a build of its own.
 *
 * Read from the importer's final code rather than from anyone's source, so it
 * keys on the channel Vite actually opened and not on the spelling that opened
 * it — `new Worker`, `new SharedWorker`, `?worker`, `?worker&inline` and
 * whatever comes next all leave this behind.
 */
const WORKER_REFERENCE = /__VITE_WORKER_ASSET__[a-z\d]{8}__/;

/**
 * A module id as a repository-relative path.
 *
 * A virtual id — a plugin's own module, which Vite prefixes with a NUL — is
 * returned VERBATIM rather than dropped. It cannot be a file in the face, so it
 * reads as "outside the face" to every rule, which is the fail-closed answer: a
 * plugin-generated module that imports a component behind a seam is still an
 * import from outside the face and still a finding.
 *
 * The query and fragment are removed, because `…/CopyBlock.svelte?raw` is the
 * same FILE a swap would replace — the reasoning `tests/helpers/module-imports.mjs`
 * carries for the reading probes, held here for the same reason.
 */
function repoPath(root, id) {
	const file = String(id).split('?')[0].split('#')[0];
	if (!isAbsolute(file)) return file;
	const path = relative(root, file).split(sep).join('/');
	return path.startsWith('..') ? file : path;
}

/**
 * Every `import(…)` in a module's FINAL code whose target is not a literal.
 *
 * Read from the code the bundler ended up with rather than from the file on
 * disk, which is the point: a computed import inside a Svelte event handler has
 * been through the component compiler by the time it gets here, and one produced
 * by a plugin never had a source file at all. The build's own parser is what
 * reads it, so this asks the same question the bundler asked.
 *
 * The reported text comes from the transformed code and can differ from what the
 * author typed. That is deliberate — the finding should name what the build saw.
 */
function unreadableImports(ast, code) {
	const found = [];
	const visit = (node) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
		if (node.type === 'ImportExpression') {
			const { source } = node;
			const literal = source?.type === 'Literal' && typeof source.value === 'string';
			if (!literal)
				found.push(
					typeof source?.start === 'number' && typeof source?.end === 'number'
						? code.slice(source.start, source.end).trim()
						: `<a ${source?.type ?? 'missing'} expression>`
				);
		}
		for (const key of Object.keys(node)) if (key !== 'type') visit(node[key]);
	};
	visit(ast);
	return found;
}

/**
 * The plugin that records the graph. It resolves nothing and rewrites nothing —
 * it reads what the bundler finished with, so its presence cannot change the
 * build it is measuring.
 *
 * `buildEnd` is where the module graph is complete. `generateBundle` is where an
 * emitted asset's originating file is known, which is the second channel: a
 * `new URL('./X', import.meta.url)` leaves a reference marker in the importer's
 * code instead of an edge, and the two hooks together turn that marker back into
 * an importer-to-file pair.
 */
function recorder(pass, root, sink) {
	const references = [];

	return {
		name: 'contentus:seam-graph',
		enforce: 'post',

		buildEnd(error) {
			if (error) return;
			for (const id of this.getModuleIds()) {
				const info = this.getModuleInfo(id);
				const importer = repoPath(root, id);
				if (!info) {
					sink.findings.push(
						`${importer}: the ${pass} build lists this module and cannot describe it, ` +
							'so its dependencies are unknown'
					);
					continue;
				}

				sink.modules.add(importer);
				for (const target of info.importedIds ?? [])
					sink.edges.push({ importer, target: repoPath(root, target), channel: `${pass}:import` });
				for (const target of info.dynamicallyImportedIds ?? [])
					sink.edges.push({
						importer,
						target: repoPath(root, target),
						channel: `${pass}:import()`,
					});

				if (typeof info.code !== 'string') continue;
				for (const [, reference] of info.code.matchAll(ASSET_REFERENCE))
					references.push([importer, reference]);
				if (WORKER_REFERENCE.test(info.code))
					sink.findings.push(
						`${importer} carries a worker reference, and a worker's own modules are bundled ` +
							'by a separate build this gate does not record, so what that worker depends ' +
							'on is unknown'
					);
				if (!importer.startsWith('src/')) continue;

				let ast;
				try {
					ast = this.parse(info.code);
				} catch (parseError) {
					sink.findings.push(
						`${importer}: the ${pass} build's own parser cannot read the module it just ` +
							`loaded, so its dependencies are unknown — ${parseError.message}`
					);
					continue;
				}
				for (const expression of unreadableImports(ast, info.code))
					sink.findings.push(
						`${importer} → import(${expression}) (a dependency the build cannot name)`
					);
			}
		},

		generateBundle(_options, bundle) {
			const origins = new Map(
				Object.entries(bundle).map(([name, output]) => [name, output.originalFileNames ?? []])
			);
			for (const [importer, reference] of references) {
				let name;
				try {
					name = this.getFileName(reference);
				} catch (error) {
					sink.findings.push(
						`${importer}: the ${pass} build references an emitted file it will not name ` +
							`(${reference}), so what it depends on is unknown — ${error.message}`
					);
					continue;
				}
				for (const origin of origins.get(name) ?? [])
					sink.edges.push({
						importer,
						target: repoPath(root, resolve(root, origin)),
						channel: `${pass}:new URL()`,
					});
			}
		},
	};
}

/**
 * A specifier's file part and the query-and-fragment tail that follows it.
 *
 * The tail is what a plugin adds to address a PIECE of a file rather than the
 * file: `?svelte&type=style&lang.css` is a component's stylesheet, `?raw` is its
 * text, `?worker` is a build of its own. Splitting rather than stripping keeps
 * "which file is this" and "which piece of it" as two answers.
 */
function splitSpecifier(specifier) {
	const mark = specifier.search(/[?#]/);
	return mark < 0 ? [specifier, ''] : [specifier.slice(0, mark), specifier.slice(mark)];
}

/**
 * A tree that is not the one on disk, for proving this gate FAILS.
 *
 * A seam check nobody has watched fail is a seam check nobody should trust, and
 * the six rounds behind this file are six demonstrations of exactly that. So the
 * regression suite runs THIS gate — not a copy of it — against planted trees, and
 * this is how a planted tree gets in: a map of repository-relative path to source
 * that replaces a file's content or adds a file that is not on disk.
 *
 * It is a build input rather than a disk write on purpose. `node --test` runs
 * test files concurrently and another probe plants fixtures inside
 * `src/lib/compose`; a gate that planted real files would race it, and a gate
 * that planted them in the face would race `pnpm build`.
 *
 * THE QUERY IS PART OF THE ID, and an earlier version of this dropped it. A
 * planted component's own compiler asks for `…/X.svelte?svelte&type=style&lang.css`
 * to get the stylesheet it just compiled; answering that with the id stripped
 * back to `…/X.svelte` handed the request to the component again, and answering
 * its `load` with the component's source handed the CSS pipeline a `<script>`
 * tag. Either way a `<style>` block in a planted component reached the build as
 * nothing at all — so a plant that lived in one was unfalsifiable HERE while
 * being a real dependency in `pnpm build`. Round 7's review found exactly that
 * plant. The tail now rides along, and a request carrying one is left to the
 * pipeline that invented it: this overlay replaces a FILE, and a plugin's view
 * of that file is the plugin's to produce.
 *
 * The command-line path passes no overlay, so this plugin is not in the gate the
 * rubric runs at all.
 */
function overlayPlugin(root, overlay) {
	const files = new Map(Object.entries(overlay).map(([path, code]) => [resolve(root, path), code]));

	return {
		name: 'contentus:seam-graph-overlay',
		enforce: 'pre',

		async resolveId(source, importer, options) {
			const [direct, tail] = splitSpecifier(String(source));
			// An entry, or an id another plugin has already resolved to a full path.
			if (isAbsolute(direct) && files.has(direct)) return direct + tail;
			// Everything the real configuration can resolve resolves the real way.
			const resolved = await this.resolve(source, importer, options);
			if (resolved) return resolved;
			if (!direct.startsWith('.')) return null;
			const base = importer ? dirname(splitSpecifier(String(importer))[0]) : root;
			const guess = resolve(base, direct);
			return files.has(guess) ? guess + tail : null;
		},

		load(id) {
			const [file, tail] = splitSpecifier(String(id));
			if (tail) return null;
			return files.get(file) ?? null;
		},
	};
}

/**
 * Run both passes and return everything they resolved.
 *
 * `minify` and `sourcemap` are off because neither changes which modules the
 * build resolves — they change how the output is printed, and this gate reads
 * the graph rather than the output.
 *
 * A pass that throws records a finding and the walk continues, so a broken
 * client build still reports what the server build resolved instead of reporting
 * nothing at all. Either way the gate is red.
 */
export async function seamGraph({ root = process.cwd(), overlay = {} } = {}) {
	const sink = { edges: [], modules: new Set(), findings: [], passes: [] };
	const planted = Object.keys(overlay).length > 0;
	const stack = (pass) => [
		...(planted ? [overlayPlugin(root, overlay)] : []),
		recorder(pass, root, sink),
	];

	for (const pass of PASSES) {
		try {
			await build({
				root,
				logLevel: 'error',
				build: { ...pass.options, write: false, minify: false, sourcemap: false },
				plugins: stack(pass.name),
			});
			sink.passes.push(pass.name);
		} catch (error) {
			sink.findings.push(
				`the ${pass.name} build failed, so the dependencies it would have resolved are ` +
					`unknown — ${String(error?.message ?? error).split('\n')[0]}`
			);
		}
	}

	return sink;
}

/** The files the repository carries inside the face, asked of git. */
export function trackedFaceFiles(root = process.cwd()) {
	return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', FACE_DIR], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 16,
	})
		.split('\0')
		.filter(Boolean)
		.sort();
}

/**
 * Everything wrong with a recorded graph, as lines a reader can act on.
 *
 * Three questions, and the last one is the one the seams are about:
 *
 *   - Did every pass run? A gate that recorded nothing must not read as clean.
 *   - Is the face DECLARED and CONTAINED? Every component named exactly once, and
 *     every tracked file in the face reached by the build. A file the build never
 *     loads is a file this gate cannot judge, and saying so is the difference
 *     between a gap and a silence.
 *   - Does any edge cross a seam? `seamOffence` in `./lib/agent-seams.mjs` is the
 *     rule, shared with the reading probes so that one graph answers both.
 */
export function seamFindings(sink, tracked) {
	const findings = [...sink.findings];

	for (const pass of PASSES)
		if (!sink.passes.includes(pass.name))
			findings.push(
				`the ${pass.name} build never completed, so this gate judged an incomplete graph`
			);

	if (tracked.length === 0)
		findings.push(`${FACE_DIR} has no tracked files; this gate would assert nothing`);

	const components = tracked.filter((path) => path.endsWith('.svelte')).map(faceName);
	const declared = [...DECLARED].sort();
	for (const name of components)
		if (!DECLARED.includes(name))
			findings.push(
				`${FACE_DIR}/${name} is a component in the face and no seam declaration names it`
			);
	for (const name of declared)
		if (!components.includes(name))
			findings.push(
				`${name} is declared behind a seam and no such component is tracked in the face`
			);
	for (const name of declared)
		if (DECLARED.filter((entry) => entry === name).length > 1)
			findings.push(`${name} is named in more than one place in the seam declaration`);

	for (const path of tracked)
		if (!sink.modules.has(path))
			findings.push(
				`${path} is tracked inside the face and no build pass loads it, so no edge of ` +
					'its own is recorded and this gate cannot judge it'
			);

	const seen = new Set();
	for (const { importer, target } of sink.edges) {
		const key = `${importer} ${target}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const offence = seamOffence(importer, target);
		if (offence) findings.push(offence);
	}

	return [...new Set(findings)].sort();
}

/** Run the gate as `pnpm run validate:seam-graph` runs it. */
export async function auditSeamGraph({ root = process.cwd(), overlay = {} } = {}) {
	const sink = await seamGraph({ root, overlay });
	return { sink, findings: seamFindings(sink, trackedFaceFiles(root)) };
}

async function main() {
	const root = process.cwd();
	const { sink, findings } = await auditSeamGraph({ root });

	const intoTheFace = new Map();
	for (const { importer, target, channel } of sink.edges) {
		if (!faceName(target)) continue;
		const key = `${importer} → ${target}`;
		intoTheFace.set(key, (intoTheFace.get(key) ?? new Set()).add(channel));
	}

	console.log('# Seam graph audit — face 6 (%s)\n', FACE_DIR);
	console.log(`- Build passes recorded: ${sink.passes.join(', ') || 'none'}`);
	console.log(`- Modules in the resolved graph: ${sink.modules.size}`);
	console.log(`- Dependency edges recorded: ${sink.edges.length}`);
	console.log(`- Distinct edges into the face: ${intoTheFace.size}`);
	console.log(`- Findings: ${findings.length}\n`);

	console.log('## Edges into the face');
	for (const key of [...intoTheFace.keys()].sort())
		console.log(`- ${key} [${[...intoTheFace.get(key)].sort().join(', ')}]`);

	if (findings.length > 0) {
		console.log('\n## Findings');
		for (const finding of findings) console.log(`- ${finding}`);
	}

	console.log(
		findings.length === 0
			? '\nSeam graph audit: clean.'
			: `\nSeam graph audit: ${findings.length} problem(s).`
	);
	return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}

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
 * and asks what the bundler resolved rather than what the text says. `.jsx`,
 * `.tsx`, `require()` in a `.cjs`, `import.meta.glob`, `?raw`, a dynamic
 * `import()`, a `new URL(…, import.meta.url)` asset reference and a CSS `url()`
 * are all covered because the build resolved them, not because they are on a
 * list, and a form Vite does not support creates no dependency to cover.
 *
 * WHAT IT ACTUALLY READS, because "the build resolved it" is not one channel and
 * an earlier version of this header claimed the module graph was all of them.
 * Round 7 disproved that with a `url('./X')` in a component's `<style>`: a real
 * dependency, the asset emitted, no module edge anywhere, the gate green. There
 * are three channels, and the third exists because of that finding:
 *
 *   - THE MODULE GRAPH, at `buildEnd`. Static and dynamic imports, every form
 *     that produces a module.
 *   - ASSET REFERENCES IN MODULE CODE, at `buildEnd`. A `new URL(…,
 *     import.meta.url)` leaves Vite's own marker where an edge would be; the
 *     marker names an emitted file, and `generateBundle` names what it came from.
 *   - ASSET REFERENCES IN STYLESHEETS, mid-pipeline. Same marker, same
 *     resolution, but a CSS module's code is empty by `buildEnd` — the content
 *     has left the module graph for the stylesheet being assembled — so it is
 *     read in the one window where it exists. See `styleRecorder`.
 *
 * A CHANNEL IS A WINDOW, AND A WINDOW CAN CLOSE FOR ONE MODULE. Round 8 left the
 * emitted-asset rule below as the thing that made a closed window red. Round 9
 * showed that is not enough by itself: two components pointing at one file get ONE
 * emitted asset, so a window that closed for one of them was still accounted for by
 * the other's reference, and a real cross-seam edge was green. Attribution is by
 * emitted FILE NAME, and a file name cannot tell two importers apart.
 *
 * So the windows are checked directly rather than through what they attribute:
 * every module the build LOADS has its code held either by `buildEnd` or by the
 * observer's window, and a module neither one holds is a finding naming that
 * module. A window that closes — for every module or for one — costs this gate its
 * green there, whoever else references the same file.
 *
 * WHICH MODULES THE BUILD LOADS IS ASKED OF THE BUILD, not of the id, and round 10
 * is why that distinction is written down. A module the build marks EXTERNAL is
 * resolved and then deliberately never loaded — and Rolldown lists it in the graph
 * under the id it resolved TO, which for an external file is an absolute path
 * spelled exactly like every loaded module's. Reading "the build went and got this
 * file" off that spelling made every module a consumer externalizes a module this
 * gate had failed to read, so a legitimate build went red for doing something
 * legitimate. `ModuleInfo` cannot be asked either: Rolldown has no `isExternal`,
 * and its `code` is `null` for "external OR not yet available" — the two cases this
 * rule exists to tell apart. So the LOAD PIPELINE is watched instead, by a plugin
 * that reads nothing and returns nothing and records every id the build enters it
 * for. An id it never saw and for which the build holds no code is a module nobody
 * loaded, and there is nothing here this gate failed to read.
 *
 * That watch only ever WIDENS what must be covered: a module the build holds code
 * for is loaded whether or not the watch saw it, so the day that plugin's position
 * stops seeing every load, the rule falls back to what it checked before rather
 * than quietly covering less. And what the build never loaded it also cannot be
 * judged for — so an externalized module is not counted as reached, and a tracked
 * face file a consumer externalizes lands in the containment rule below as a file
 * this gate cannot judge rather than passing as one it read.
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
 *      tracked file in one form. Neither subsumes the other and both run. A module
 *      the build EXTERNALIZES is the same boundary reached from the other side —
 *      the configuration saying this file is not part of this build — and inside
 *      the face it is a red gate, because a tracked face file no pass loads is
 *      already a finding of its own.
 *   2. A WORKER's own modules. `new Worker(new URL(…))` is bundled by a separate
 *      Rolldown build whose plugin list is `config.worker.plugins` — the main
 *      pipeline is not in it, so a recorder in `plugins` never sees inside one.
 *      Supplying `worker.plugins` from here was tried and rejected: it REPLACES
 *      whatever `vite.config.ts` sets, so the gate would measure a build that is
 *      not the one `pnpm build` runs, which is the one thing this mechanism may
 *      not do. Instead the reference is detected — Vite leaves its own marker in
 *      the importer — and reported as a channel this gate does not record. A
 *      worker is a red gate here until someone extends this, which is the honest
 *      order of events.
 *   3. A reference the CLIENT pass turns into an emitted asset and the SERVER
 *      pass does not. `new URL('./X', import.meta.url)` is left verbatim as a
 *      runtime URL in the server build, and a CSS `url('./X')` resolves there
 *      without emitting, so both are client-pass edges. A module only the server
 *      pass loads takes those dependencies unrecorded.
 *
 * FAIL-CLOSED, in five places. A build that throws is a red gate rather than an
 * empty edge set. A module whose final code the build's own parser cannot read is
 * a finding. A dynamic `import()` whose target is not a literal is a finding
 * wherever it sits under `src/` — "the build cannot name what this loads" and
 * "this loads nothing behind a seam" are different facts. Every module the build
 * loads must have its code held by one of the windows above, which is the one that
 * generalises: reading references is a channel, channels close, and a channel that
 * closes on one module now costs this gate its green rather than its coverage. And
 * every asset the build EMITS must be attributable to something that references it,
 * which asks the same question from the other end for the assets no other importer
 * accounts for.
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
 *
 * It is NOT an asset reference despite reading like one: Vite's worker plugin
 * rewrites it from a map of its own rather than through the bundler's reference
 * table, so `getFileName` cannot turn it into a file name. It is detected and
 * counted; what it emits is handled where that matters, in `unattributedAssets`.
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
 * Vite's own test for a request whose content is a stylesheet.
 *
 * The svelte compiler addresses a component's styles as
 * `X.svelte?svelte&type=style&lang.css`, so the extension this matches is
 * frequently in the QUERY rather than on the file — which is why it is written
 * the way Vite writes it rather than as a check on the path.
 */
const CSS_REQUEST = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/**
 * Every reference of one marker family a module's code carries, into
 * `references`. Returns how many it found.
 *
 * The key is the pair, not the position: one marker seen in two windows is one
 * dependency, and recording it twice would inflate the edge count without
 * telling anyone anything.
 */
function collectReferences(references, importer, code, marker, channel) {
	let found = 0;
	for (const [, reference] of code.matchAll(marker)) {
		found += 1;
		const key = `${importer}\0${reference}`;
		if (!references.has(key)) references.set(key, { importer, reference, channel });
	}
	return found;
}

/**
 * The stylesheet observer, and the reason it is a plugin of its own.
 *
 * A CSS `url('./X')` is a dependency: Vite resolves it against the stylesheet,
 * emits the file it names as an asset, and leaves a reference marker where the
 * URL was. That marker is the same channel `new URL(…, import.meta.url)` uses —
 * but it lives in the STYLESHEET's code, and by the time `buildEnd` runs a CSS
 * module's `code` is empty, because the content has left the module graph for the
 * stylesheet the bundler is assembling. The marker is not hidden at `buildEnd`;
 * it is gone.
 *
 * The one window where it exists is between the plugin that resolves CSS URLs and
 * the plugin that moves CSS out of the module graph, and that window is where a
 * plugin with no `enforce` runs. So this observer has no `enforce` and the
 * recorder keeps its `post` — the two want different positions and are therefore
 * two plugins. It returns null from every hook, so it still cannot change the
 * build it is measuring.
 *
 * A position in a plugin order is a weaker thing to rest on than "the build
 * resolved it", which is what the rest of this gate rests on. So the position is
 * CHECKED rather than assumed: every module this transform reads goes into
 * `observed`, and `recorder` requires every module the build loaded to be held by
 * this window or by `buildEnd`. The day this window moves, the stylesheets it was
 * reading become modules nothing read, and the gate names them.
 *
 * That replaces an argument round 9 disproved. This block used to rest on the
 * emitted-asset rule instead — the day the window closes, the assets it was
 * attributing become unattributable — which holds only while no OTHER importer
 * references the same file. Two components pointing at one file get one emitted
 * asset, and one surviving reference accounts for it on behalf of both.
 *
 * `blind` is fault injection, and the reason this window can be watched failing at
 * all: a predicate on the module id that this observer does not look at, so the
 * regression suite can close the window for one module — which is exactly the shape
 * round 9 found — and watch THIS gate go red rather than a copy of it. The
 * command-line path passes none, so it is never in the gate the rubric runs.
 */
function styleRecorder(pass, root, references, observed, blind) {
	return {
		name: 'contentus:seam-graph-styles',

		transform(code, id) {
			if (blind(String(id)) || typeof code !== 'string') return null;
			observed.add(String(id));
			collectReferences(
				references,
				repoPath(root, id),
				code,
				ASSET_REFERENCE,
				`${pass}:${CSS_REQUEST.test(String(id)) ? 'css url()' : 'asset'}`
			);
			return null;
		},
	};
}

/**
 * Which modules the build actually LOADED, which is not a question about ids.
 *
 * `load` is the hook the bundler calls when it is about to go and get a module's
 * content, and it is called for exactly the modules it goes and gets: a module
 * marked external is resolved and then skipped, so this hook never sees it. That
 * is the whole answer, and the reason it is asked here rather than inferred at
 * `buildEnd` — see the header. This returns null for everything, so it says
 * nothing about what any module contains and cannot change the build it counts.
 *
 * `enforce: 'pre'` and first in the stack, so a module another plugin LOADS is
 * still a module this hook was called for. If that position ever stops seeing
 * every load, the rule that uses this falls back to "the build holds code for it",
 * which is what it checked before this existed.
 */
function loadWatcher(loads) {
	return {
		name: 'contentus:seam-graph-loads',
		enforce: 'pre',

		load(id) {
			loads.add(String(id));
			return null;
		},
	};
}

/**
 * A module the build resolves and then never loads, for proving this gate does NOT
 * fire — the one direction the planted trees above cannot reach.
 *
 * Round 10 found the false positive this answers: an absolute module externalized
 * through Vite is listed in the graph under an absolute id with no code, which read
 * as a file the build had gone and got and then lost. Nothing in this repository's
 * own configuration externalizes anything but `node:` builtins, and a rule that
 * only ever runs against ids that happen to be bare would be a rule nobody has
 * watched. So the case is INJECTED, the way `blind` injects a closed window: a
 * predicate on the resolved id, and a match becomes a genuine external through the
 * bundler's own mechanism rather than a mock of one.
 *
 * `enforce: 'pre'` and ahead of the overlay, because this asks the rest of the
 * pipeline to resolve first and then marks what came back — so a planted file is
 * externalized at the id the plant resolved to, which is the shape round 10 found.
 *
 * The command-line path passes no predicate and this plugin is not in the stack at
 * all, so the gate the rubric runs resolves exactly what it resolved before.
 */
function externalizer(external) {
	return {
		name: 'contentus:seam-graph-external',
		enforce: 'pre',

		async resolveId(source, importer, options) {
			const resolved = await this.resolve(source, importer, options);
			if (!resolved || !external(String(resolved.id))) return null;
			return { id: resolved.id, external: true };
		},
	};
}

/**
 * The emitted files nothing accounts for, as findings.
 *
 * WHY THIS IS THE BACKSTOP AND NOT A DETAIL. An emitted asset is the build saying
 * "something needs this file at runtime". Reading the references that point at one
 * is how this gate turns that into an edge — and every way of reading references
 * is a channel that can close. Round 7's finding was exactly a closed channel: a
 * CSS `url()` crossing a seam, the asset emitted, the edge recorded nowhere, the
 * gate green. Asking the question from the emitted side as well means the assets a
 * closed channel was attributing go unaccounted for and land here.
 *
 * WHAT IT DOES NOT CATCH, which is why it is a backstop and not the guarantee.
 * Attribution is by emitted FILE NAME, and the build emits one file however many
 * importers reference it — so an importer this gate stopped seeing is covered here
 * by any other importer that still references the same file, and this rule stays
 * quiet while a real edge goes unrecorded. Round 9 found exactly that. It is caught
 * where it actually lives, in `recorder`: a module neither reading window holds is
 * a finding of its own, whatever anyone else references.
 *
 * WHAT `workers` IS DOING HERE, because an exception in a fail-closed rule has to
 * earn its place. A worker's bundle is emitted as an asset with no originating
 * file — it is generated code, not a file the build was pointed at — and Vite
 * rewrites the marker that names it from a map of its own, so this gate cannot
 * turn that marker into a file name. It is therefore permanently unattributable,
 * and reporting it would be a second sentence about a pass the worker tripwire
 * has ALREADY made red, with a hashed file name in it. So a pass that builds a
 * worker does not report its origin-less assets. An asset that names an
 * originating file is still reported, worker or no worker: that is the case a
 * seam can hide in.
 *
 * A separate function because the plumbing that feeds it — the bundle, the two
 * reference windows — is only exercised by a real build, and a rule nobody has
 * watched fail is a rule nobody should trust. This one can be handed an emitted
 * file and an empty account and watched.
 */
export function unattributedAssets(pass, emitted, attributed, workers = false) {
	return emitted
		.filter(({ fileName }) => !attributed.has(fileName))
		.filter(({ from }) => from.length > 0 || !workers)
		.map(
			({ fileName, from }) =>
				`${fileName}: the ${pass} build emits this file and nothing this gate records ` +
				`references it, so what depends on ${from.length > 0 ? from.join(', ') : 'it'} is unknown`
		);
}

/**
 * The plugin that records the graph. It resolves nothing and rewrites nothing —
 * it reads what the bundler finished with, so its presence cannot change the
 * build it is measuring.
 *
 * `buildEnd` is where the module graph is complete. `generateBundle` is where an
 * emitted asset's originating file is known, which is the second channel: a
 * `new URL('./X', import.meta.url)` and a CSS `url('./X')` both leave a reference
 * marker where a dependency was, and the hooks together turn that marker back
 * into an importer-to-file pair.
 *
 * `generateBundle` also asks the question the other way round, which is what
 * keeps that channel honest: every asset the build EMITS must be attributable to
 * something. An emitted file nothing accounts for is a dependency of something,
 * and this gate not knowing of what is a finding rather than a silence.
 */
function recorder(pass, root, sink, references, observed, loads) {
	// Whether this pass built a worker, which `unattributedAssets` needs and the
	// tripwire below is what learns.
	let workers = false;

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

				// WHETHER THE BUILD LOADED THIS MODULE, which decides both rules that follow.
				// `load` is called for the modules the bundler goes and gets and for no
				// others, so an id it never saw and for which the build holds no code is a
				// module the build resolved and then left alone — a bare `node:…` the server
				// pass externalizes, or anything a consumer's configuration externalizes,
				// whatever the id it resolved to looks like. `info.code` is `null` for those
				// and for nothing else here; a module the build DID load holds a string,
				// empty or not.
				const loaded = loads.has(String(id)) || typeof info.code === 'string';

				// REACHED, and therefore judgeable. A module the build never loaded takes no
				// dependency it could record, so counting it as reached would tell the
				// containment rule that a tracked face file had been examined when nothing
				// examined it. Externalizing a component in the face is a red gate for that
				// reason, in the sentence that says what is actually unknown.
				if (loaded) sink.modules.add(importer);
				for (const target of info.importedIds ?? [])
					sink.edges.push({ importer, target: repoPath(root, target), channel: `${pass}:import` });
				for (const target of info.dynamicallyImportedIds ?? [])
					sink.edges.push({
						importer,
						target: repoPath(root, target),
						channel: `${pass}:import()`,
					});

				// THE WINDOWS MUST COVER THIS MODULE, asked here because this is where every
				// module the build loaded is enumerated. A module whose code is a non-empty
				// string is read RIGHT HERE. A module whose code is EMPTY has been emptied —
				// a stylesheet's content leaves the module graph for the sheet being
				// assembled — and the only place it existed is the observer's window, so the
				// observer must have been there. Neither, and this gate read nothing at all
				// for this module: it cannot say what the module references, and saying so is
				// the difference between a gap and a silence.
				//
				// WHAT IS EXCLUDED AND WHY. Only a module the build never loaded, which is
				// `loaded` above and is asked of the build rather than read off the id. An
				// earlier version of this asked whether the id named a FILE, on the reasoning
				// that the build had gone and got it — and round 10 found that an external
				// module's id names a file too, because it IS one; the build just never
				// opened it. Every module a consumer externalizes was reported unread, which
				// is this gate going red at a build for being configured.
				//
				// The request is reported whole — `X.svelte?svelte&type=style&lang.css` rather
				// than `X.svelte` — because WHICH PIECE of a file went unread is the first
				// thing the next reader needs.
				const [, tail] = splitSpecifier(String(id));
				const readable = typeof info.code === 'string' && info.code !== '';
				if (loaded && !readable && !observed.has(String(id)))
					sink.findings.push(
						`${importer}${tail}: neither window this gate reads holds the ${pass} build's ` +
							'code for this module, so what it references is unknown'
					);

				if (typeof info.code !== 'string') continue;
				collectReferences(references, importer, info.code, ASSET_REFERENCE, `${pass}:asset`);
				if (WORKER_REFERENCE.test(info.code)) {
					workers = true;
					sink.findings.push(
						`${importer} carries a worker reference, and a worker's own modules are bundled ` +
							'by a separate build this gate does not record, so what that worker depends ' +
							'on is unknown'
					);
				}
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

			// Every emitted file some recorded reference points at. What is left over
			// after this is what nothing this gate can see accounts for.
			const attributed = new Set();
			for (const { importer, reference, channel } of references.values()) {
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
				attributed.add(name);
				for (const origin of origins.get(name) ?? [])
					sink.edges.push({
						importer,
						target: repoPath(root, resolve(root, origin)),
						channel,
					});
			}

			// A chunk's stylesheet is a file the build PRODUCED, not a file it was
			// pointed at: the bundler assembled it out of modules that are all in the
			// graph above, and nothing references it by name. Its own `url()`s are
			// references and are recorded as such.
			//
			// `importedAssets` is deliberately NOT read here, and the reason is the
			// whole point of the loop below. It is the set of assets a chunk's CSS
			// refers to — CopyBlock, in round 7's finding — so treating it as
			// attribution would account for exactly the files this gate is trying to
			// account for, using the bundler's word rather than an importer's name.
			for (const output of Object.values(bundle))
				if (output.type === 'chunk')
					for (const name of output.viteMetadata?.importedCss ?? []) attributed.add(name);

			// FAIL CLOSED on the rest.
			const emitted = Object.entries(bundle)
				.filter(([, output]) => output.type === 'asset')
				.map(([fileName, output]) => ({
					fileName,
					from: (output.originalFileNames ?? []).map((origin) =>
						repoPath(root, resolve(root, origin))
					),
				}));
			sink.findings.push(...unattributedAssets(pass, emitted, attributed, workers));
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
 *
 * EXPORTED so the regression suite can build its own WITNESS on the same planted
 * tree — a build that reads what was emitted rather than what this gate concluded
 * about it. One planting mechanism, two readers; a second copy of it in the tests
 * would be a second thing to keep true.
 */
export function overlayPlugin(root, overlay) {
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
export async function seamGraph({
	root = process.cwd(),
	overlay = {},
	blind = () => false,
	external,
} = {}) {
	const sink = { edges: [], modules: new Set(), findings: [], passes: [] };
	const planted = Object.keys(overlay).length > 0;
	const stack = (pass) => {
		// One reference table per pass, written by the observer in the middle of the
		// pipeline and by the recorder at the end of it, read once when the bundle
		// exists. A marker is a dependency wherever it was seen.
		const references = new Map();
		// Which module ids the observer actually read, so the recorder can tell a
		// module with nothing to read from one it never looked at.
		const observed = new Set();
		// Which module ids the build LOADED, so the recorder can tell that module from
		// one the build resolved and deliberately never opened.
		const loads = new Set();
		return [
			loadWatcher(loads),
			...(external ? [externalizer(external)] : []),
			...(planted ? [overlayPlugin(root, overlay)] : []),
			styleRecorder(pass, root, references, observed, blind),
			recorder(pass, root, sink, references, observed, loads),
		];
	};

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
export async function auditSeamGraph({ root = process.cwd(), overlay = {}, blind, external } = {}) {
	const sink = await seamGraph({ root, overlay, blind, external });
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
	console.log(`- Modules the build loaded: ${sink.modules.size}`);
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

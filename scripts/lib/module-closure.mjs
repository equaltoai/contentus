/**
 * The module closure: which files this repository's build can reach, resolved by
 * the resolver that actually runs.
 *
 * IN scripts/lib BECAUSE TWO READERS SHARE IT, and sharing the code is the only
 * way the second reader is evidence about the first. `scripts/audit-graphql-contract.mjs`
 * uses it to decide the vendored-tree boundary; `tests/graphql-contract.test.mjs`
 * uses the SAME functions to compare that closure with the modules a real Vite
 * build loads. A test that reimplemented the walk would be comparing two of its
 * own opinions, which is the shape of the defect this whole milestone is about.
 *
 * Three questions, kept apart:
 *
 *   - `resolveClosure` — every specifier, resolved once, to a fixpoint. Async,
 *     because Vite's resolver is; everything downstream is then synchronous.
 *   - `resolverOver` — the synchronous view of that map, for the document fold.
 *   - `reachableFrom` — what a given set of roots can actually execute, with the
 *     places the walk could not see reported rather than skipped.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
	computedImports,
	liveScript,
	moduleSpecifiers,
	runtimeSpecifiers,
} from './module-imports.mjs';

/**
 * A predicate over an extension set, rather than a set of its own.
 *
 * WHAT WENT WRONG WITH THE CONSTANT IT REPLACES. `SCRIPT_EXTENSIONS` was a literal
 * list, and it omitted `.tsx` and `.jsx` — two suffixes this repository's Vite has
 * resolved and built the entire time. The review made an entry import a `.tsx`
 * module that sent a dynamically assembled invalid document through the production
 * transport, and the full audit exited 0/PASS. Worse, the test that compares this
 * closure against a REAL Vite build filtered the build's loaded modules through the
 * same list, so the omission was invisible from both sides: a second opinion that
 * inherits the first one's blind spot is not evidence, it is an echo.
 *
 * The set now comes from `executableExtensions(resolver)` in `module-resolution.mjs`,
 * which reads Vite's resolved `resolve.extensions` and its loader plugins' declared
 * extensions. Callers pass it in; nothing here restates it.
 */
export function isScriptIn(extensions) {
	const suffixes = [...extensions];
	return (file) => suffixes.some((extension) => file.endsWith(extension));
}

/** Source a file executes — a component's scripts and markup imports, or the file. */
export function scriptOf(root, file) {
	return liveScript(file, readFileSync(path.join(root, file), 'utf8'));
}

/**
 * Whether this file's bytes must be parsed with JSX syntax enabled.
 *
 * A `.tsx` read as plain TypeScript turns `<Foo />` into a type assertion and the
 * parse recovers into something that is not the program. The readers throw on a
 * recovered parse rather than guessing, which is right — but the answer for a
 * legitimate component is to read it correctly, not to refuse it.
 */
export const isJsx = (file) => /\.[jt]sx$/i.test(file);

/**
 * Resolve every specifier in the tree, using Vite's own resolver, to a fixpoint.
 *
 * WHY A CLOSURE AND NOT A LOOKUP PER CALL SITE. Two readers downstream need
 * resolution and both are synchronous — the fold, which follows an imported
 * constant to the module that defines it, and the boundary walk. Vite's resolver
 * is async. So every specifier in every reachable script is resolved once, here,
 * and both readers then ask a map. The frontier grows: resolving `src/lib/routes`
 * pulls in files outside the walked document roots, and those files' own imports
 * matter to both questions.
 *
 * `findings` carries loads this resolver could not answer. They are failures, not
 * diagnostics: an unresolvable load is a module whose target is unknown, and the
 * boundary claim is exactly that no unknown target is a document-bearing vendored
 * module.
 */
export async function resolveClosure(root, seeds, resolver, isScript) {
	const resolution = new Map();
	const sources = new Map();
	const findings = [];
	const seen = new Set();
	const queue = [];

	const enqueue = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (isScript(file)) queue.push(file);
	};
	for (const seed of seeds) enqueue(seed);

	while (queue.length) {
		const file = queue.shift();
		let source;
		try {
			source = scriptOf(root, file);
			sources.set(file, source);
		} catch (error) {
			findings.push(`${file} could not be read: ${error.message}`);
			continue;
		}

		let specifiers;
		try {
			specifiers = moduleSpecifiers(source, { jsx: isJsx(file) });
		} catch (error) {
			// Reported here rather than skipped: a module this reader cannot parse
			// is a module whose imports are unknown, and an unknown import set is
			// exactly what the boundary claim cannot survive.
			findings.push(`${file} could not be parsed for its imports: ${error.message}`);
			continue;
		}

		for (const specifier of specifiers) {
			const answer = await resolver.resolve(specifier, file);
			resolution.set(`${file}\0${specifier}`, answer);
			for (const target of answer.files) enqueue(target);
		}
	}

	return { resolution, sources, findings, isScript, files: [...seen].filter(isScript) };
}

/** Synchronous resolution over the pre-computed closure. */
export function resolverOver(closure) {
	const answerFor = (specifier, fromFile) => closure.resolution.get(`${fromFile}\0${specifier}`);

	/** The single file a specifier names, for folding an imported constant. */
	const resolveSync = (specifier, fromFile) => {
		const answer = answerFor(specifier, fromFile);
		if (!answer || answer.files.length !== 1) return null;
		return answer.files[0];
	};

	const resolveForReader = (specifier, fromFile) => {
		const target = resolveSync(specifier, fromFile);
		if (target === null) return null;
		const source = closure.sources.get(target);
		if (source === undefined) return null;
		return { file: target, source };
	};

	return { answerFor, resolveSync, resolveForReader };
}

/* -------------------------------------------------------------------------
 * Boundary
 * ---------------------------------------------------------------------- */

/**
 * Every file reachable by import from `roots`, following Vite's own resolution.
 *
 * This is what turns "we excluded the vendored tree" from an assertion into a
 * checked claim. Contentus imports vendored FACES freely and must keep doing so;
 * what it must never do is reach a vendored module that declares a GraphQL
 * document, because that document would then be one contentus can execute and
 * this gate has declared it out of scope.
 *
 * WHY THE RESOLVER HAD TO CHANGE. The previous walk used a hand-written candidate
 * list and called the result an over-approximation. It was not one. Production
 * source imports `$lib/greater/faces/blog/components/Article/index.js` where the
 * file is `index.ts`; the candidate list tested `index.js`, then `index.js.ts`,
 * and answered nothing. The review turned that into a demonstration: an outside
 * module importing a document-bearing vendored `adapter.ts` failed the gate as it
 * should, and re-spelling the same import `adapter.js` made the gate PASS. A
 * boundary that a rename defeats is not a boundary, and an approximation that can
 * miss an edge is not conservative — it is wrong in the unsafe direction.
 *
 * UNREADABLE AND UNFOLLOWABLE LOADS ARE FAILURES HERE. A module whose imports
 * cannot be parsed, a specifier Vite cannot resolve, and a dynamic `import(expr)`
 * whose target no static read can name are each a place the closure stops without
 * knowing what is past it. The exclusion's safety is a claim about EVERYTHING
 * reachable, so a gap in the walk is a gap in the claim, not a smaller answer.
 */
export function reachableFrom(roots, closure, resolve) {
	const seen = new Set(roots);
	const queue = [...roots];
	const findings = [];
	const unresolvedPackages = new Set();

	while (queue.length) {
		const file = queue.shift();
		if (!closure.isScript(file)) continue;

		const source = closure.sources.get(file);
		if (source === undefined) {
			findings.push(
				`${file} is reachable from contentus source but this gate never read it, so what it ` +
					'imports is unknown. The vendored-tree exclusion is a claim about everything ' +
					'reachable; an unread module is a hole in it.'
			);
			continue;
		}

		let specifiers;
		try {
			specifiers = runtimeSpecifiers(source, { jsx: isJsx(file) });
		} catch (error) {
			findings.push(
				`${file} is reachable and could not be parsed for its imports: ${error.message}`
			);
			continue;
		}

		for (const specifier of specifiers) {
			const answer = resolve.answerFor(specifier, file);
			if (!answer) {
				findings.push(
					`${file} loads '${specifier}', which this gate never resolved. An unresolved ` +
						'reachable load leaves the closure incomplete.'
				);
				continue;
			}
			if (answer.unresolved) {
				if (answer.namesAPath) {
					findings.push(
						`${file} loads '${specifier}', which Vite cannot resolve in either build ` +
							'environment even though it names a path in this tree. A load whose target ' +
							'is unknown cannot be excluded from the vendored boundary, so it fails ' +
							'rather than being skipped.'
					);
				} else {
					// A bare specifier no alias touches names a PACKAGE, and a package
					// this repository does not install cannot be a file inside
					// src/lib/greater/. Dormant vendored source imports several
					// (`@apollo/client`, `viem`, `shiki`, `remark-*`). Counting them is
					// honest; failing on them would be a rule about upstream's
					// dependencies whose only repair here is a disclosure.
					unresolvedPackages.add(`${specifier}  (${file})`);
				}
				continue;
			}
			if (answer.divergent) {
				findings.push(
					`${file} loads '${specifier}', which resolves to different files in the client and ` +
						`ssr environments (${answer.files.join(', ')}). Both are followed; this is ` +
						'reported because a reader that silently picked one would be describing a ' +
						'module that may never run.'
				);
			}
			for (const target of answer.files) {
				if (!seen.has(target)) {
					seen.add(target);
					queue.push(target);
				}
			}
		}

		// A dynamic import whose target no static read can name.
		let computed;
		try {
			computed = computedImports(source, { jsx: isJsx(file) });
		} catch {
			computed = [];
		}
		for (const expression of computed) {
			findings.push(
				`${file} is reachable and performs \`${expression}\`, a load whose target no static ` +
					'read can name. The boundary cannot say what it reaches, so it is a finding.'
			);
		}
	}

	return { seen, findings, unresolvedPackages };
}

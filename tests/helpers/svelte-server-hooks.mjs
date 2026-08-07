/**
 * Module hooks for `./svelte-server.mjs`: compile `.svelte` files for the
 * SERVER on the way through node's loader, so a test can render a real
 * component — children, aliases and all — without standing up vite.
 *
 * Registered programmatically by the helper (`module.register`), never on the
 * command line, so a test file that does not render components pays nothing
 * and the ordinary `.ts` stripping is untouched for everything else.
 *
 * The gaps between "what vite resolves" and "what node resolves" are closed
 * here, and they are exactly the ones `vite.config.ts` closes for the bundle:
 *
 * 1. THE ALIASES — `$lib`, the vendored bare `src/...` form, and the
 *    bare-specifier stubs (`hast-util-to-mdast` and friends, `$app/*`), each
 *    pointing where the vite alias points.
 * 2. EXTENSION LOOSENESS — extensionless imports (`./contract`) and
 *    TypeScript's explicit `./x.js`-names-`x.ts` form, which vite resolves
 *    and node's ESM resolver refuses.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

import { compile, compileModule, preprocess } from 'svelte/compiler';

const LIB_PREFIX = '$lib/';
const LIB_BASE = new URL('../../src/lib/', import.meta.url).href;
const SRC_BASE = new URL('../../src/', import.meta.url).href;

/**
 * The aliases `vite.config.ts` carries that a server render can also meet.
 * Kept in the same order and pointing at the same targets, with the vite
 * comments as the authority — the Markdown-conversion modules are the
 * throwing stub because rendering authority is lesser's, and the `$app/*`
 * shims are contentus's own FaceTheory equivalents.
 */
const BARE_ALIASES = {
	'hast-util-to-mdast': `${SRC_BASE}lib/build/absent-renderer-module.ts`,
	'mdast-util-to-markdown': `${SRC_BASE}lib/build/absent-renderer-module.ts`,
	'mdast-util-gfm': `${SRC_BASE}lib/build/absent-renderer-module.ts`,
	'$app/environment': `${SRC_BASE}facetheory/shims/app-environment.ts`,
	'$app/paths': `${SRC_BASE}facetheory/shims/app-paths.ts`,
};

export async function resolve(specifier, context, nextResolve) {
	// Aliases first: `$lib`, the bare `src/...` form the `greater` CLI emits
	// into vendored files (vite absorbs it with an alias; see `vite.config.ts`),
	// and the bare-specifier stubs the same config carries.
	const rewritten = specifier.startsWith(LIB_PREFIX)
		? LIB_BASE + specifier.slice(LIB_PREFIX.length)
		: specifier in BARE_ALIASES
			? BARE_ALIASES[specifier]
			: specifier.startsWith('src/')
				? SRC_BASE + specifier.slice('src/'.length)
				: specifier;

	try {
		return await nextResolve(rewritten, context);
	} catch (error) {
		// What vite resolves and node's ESM resolver refuses, tried in the forms
		// this repo actually produces: extensionless imports, and TypeScript's
		// explicit `./x.js` naming the `.ts` file beside it. Applied to the
		// REWRITTEN specifier, so an aliased path gets the same courtesy.
		const local =
			rewritten.startsWith('./') || rewritten.startsWith('../') || rewritten.startsWith('file:');
		if (!local) throw error;

		const candidates = rewritten.endsWith('.js')
			? [rewritten.replace(/\.js$/, '.ts')]
			: [`${rewritten}.ts`, `${rewritten}.js`, `${rewritten}/index.ts`, `${rewritten}/index.js`];
		for (const candidate of candidates) {
			try {
				return await nextResolve(candidate, context);
			} catch {
				// Try the next form vite would resolve.
			}
		}
		throw error;
	}
}

export async function load(url, context, nextLoad) {
	// `.svelte.ts` / `.svelte.js` rune modules: node would strip the types and
	// leave `$state` as an undefined call, so they go through the compiler too.
	if (url.endsWith('.svelte.ts') || url.endsWith('.svelte.js')) {
		const raw = readFileSync(fileURLToPath(url), 'utf8');
		const source = url.endsWith('.ts') ? stripTypeScriptTypes(raw, { mode: 'strip' }) : raw;
		const { js } = compileModule(source, { generate: 'server', filename: url });
		return { format: 'module', source: js.code, shortCircuit: true };
	}

	if (!url.endsWith('.svelte')) return nextLoad(url, context);

	const source = readFileSync(fileURLToPath(url), 'utf8');

	// `<script lang="ts">` is type-stripped with node's own stripper — the same
	// transformation `--experimental-strip-types` applies to `.ts` files — so
	// the compiler sees the JavaScript it expects. Only erasable syntax
	// survives, which is all this repo's components use.
	const { code: preprocessed } = await preprocess(
		source,
		{
			script({ content, attributes }) {
				if (attributes.lang !== 'ts') return undefined;
				return { code: stripTypeScriptTypes(content, { mode: 'strip' }) };
			},
		},
		{ filename: url }
	);

	const { js } = compile(preprocessed, { generate: 'server', filename: url });
	return { format: 'module', source: js.code, shortCircuit: true };
}

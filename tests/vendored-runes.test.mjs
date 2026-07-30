import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Runes must not survive into the shipped bundles.
 *
 * Svelte 5 runes are compiler directives, not runtime functions. A module that
 * reaches a bundle with `$state(...)` still written literally does not degrade —
 * it throws `ReferenceError: $state is not defined` the moment that code path
 * runs. vite-plugin-svelte only compiles them in modules whose filename carries
 * the `.svelte.` infix, and greater's vendored blog-face Article context does
 * not have one, so contentus widens the plugin's module filter in
 * `vite.config.ts`.
 *
 * That widening is a build-config line nothing else references, which makes it
 * exactly the kind of thing a future config edit silently drops. This asserts
 * the property it exists for, against the artifacts that actually ship, rather
 * than asserting the config still says what it says.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * A rune CALL. Compiled output references the runtime as `$.state(...)`, so the
 * bare, unprefixed call is unambiguous evidence that nothing compiled it.
 */
const UNCOMPILED_RUNE = /(?<![.\w$])\$(?:state|derived|effect|props|bindable|host|inspect)\s*\(/;

function bundleFiles() {
	const roots = ['build/server', 'build/client'];
	const found = [];

	function walk(dir) {
		let entries;
		try {
			entries = readdirSync(join(repoRoot, dir));
		} catch {
			return;
		}
		for (const entry of entries) {
			const rel = join(dir, entry);
			if (statSync(join(repoRoot, rel)).isDirectory()) walk(rel);
			else if (/\.(mjs|js)$/.test(entry)) found.push(rel);
		}
	}

	for (const root of roots) walk(root);
	return found;
}

test('no shipped bundle carries an uncompiled rune', () => {
	const bundles = bundleFiles();

	assert.ok(
		bundles.length > 0,
		'no bundles found; run `pnpm run build:client && pnpm run build:server` first'
	);

	for (const bundle of bundles) {
		const match = UNCOMPILED_RUNE.exec(readFileSync(join(repoRoot, bundle), 'utf8'));
		assert.equal(
			match,
			null,
			`${bundle} ships ${match?.[0] ?? ''} uncompiled — a module using runes is not reaching ` +
				"Svelte's compiler, and will throw ReferenceError at runtime"
		);
	}
});

test('the vendored source this guard exists for is still unedited', () => {
	// Belt and braces on the other half of the invariant: the fix is a build-config
	// widening precisely so the vendored file stays byte-identical and checksummed.
	// If this rune ever disappears from source, it was either fixed upstream (drop
	// the widening) or edited locally (do not).
	const vendored = 'src/lib/greater/faces/blog/components/Article/context.ts';
	const source = readFileSync(join(repoRoot, vendored), 'utf8');

	assert.match(
		source,
		/\$state\s*\(/,
		`${relative(repoRoot, vendored)} no longer uses runes. If greater fixed this upstream, ` +
			'remove the compileModule widening in vite.config.ts; if it was hand-edited, revert it.'
	);
});

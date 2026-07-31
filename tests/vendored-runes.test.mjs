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

/**
 * Blank out comments and string literals, preserving offsets.
 *
 * THIS IS THE PROBE, not a tidying step, and it was added because the raw scan
 * asserted something narrower than it claimed. Svelte's own runtime carries a
 * JSDoc block on `untrack` whose prose contains the literal text `$effect(`.
 * The moment contentus imported `untrack` — a legitimate import — that comment
 * entered the server bundle and the probe went red on a bundle with no
 * uncompiled rune anywhere in it. A gate that fails on prose is not measuring
 * what it says it measures, and would have been silenced rather than believed.
 *
 * Offsets are preserved by replacing each masked character with a space, so the
 * match index still points at the real source position.
 *
 * Deliberately does NOT try to recognise regex literals: telling `/` division
 * from `/` regex needs a parser, and guessing wrong the OTHER way — masking
 * real code as a literal — would turn a false positive into a false negative,
 * which is the failure that matters. A rune call inside a regex literal would
 * still be reported; that is the safe direction to be wrong in.
 */
function maskCommentsAndStrings(source) {
	const out = source.split('');
	let i = 0;

	const blank = (from, to) => {
		for (let j = from; j < to && j < out.length; j += 1) {
			if (out[j] !== '\n') out[j] = ' ';
		}
	};

	while (i < source.length) {
		const two = source.slice(i, i + 2);

		if (two === '//') {
			const end = source.indexOf('\n', i);
			const stop = end === -1 ? source.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}

		if (two === '/*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}

		const quote = source[i];
		if (quote === '"' || quote === "'" || quote === '`') {
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === '\\') {
					j += 2;
					continue;
				}
				if (source[j] === quote) break;
				j += 1;
			}
			blank(i, Math.min(j + 1, source.length));
			i = j + 1;
			continue;
		}

		i += 1;
	}

	return out.join('');
}

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
		const source = readFileSync(join(repoRoot, bundle), 'utf8');
		const match = UNCOMPILED_RUNE.exec(maskCommentsAndStrings(source));
		assert.equal(
			match,
			null,
			`${bundle} ships ${match?.[0] ?? ''} uncompiled at offset ${match?.index} — a module using ` +
				"runes is not reaching Svelte's compiler, and will throw ReferenceError at runtime. " +
				`Context: ${JSON.stringify(source.slice(Math.max(0, (match?.index ?? 0) - 120), (match?.index ?? 0) + 80))}`
		);
	}
});

test('the rune scan can still see a rune, and no longer sees one in prose', () => {
	// A differential on the masking itself, because the masking is now the part
	// of this gate most able to break it. Silently masking everything would make
	// the probe above pass forever.
	const real = 'let count = $state(0);';
	assert.match(
		maskCommentsAndStrings(real),
		UNCOMPILED_RUNE,
		'a real rune call must survive masking'
	);

	for (const prose of [
		'/** any state read inside `$effect(...)` is a dependency */ const x = 1;',
		'// see $state( for details\nconst y = 2;',
		'const doc = "call $derived( to compute";',
		'const tpl = `use $props( here`;',
	]) {
		assert.doesNotMatch(
			maskCommentsAndStrings(prose),
			UNCOMPILED_RUNE,
			`a rune named in prose must not be reported: ${prose}`
		);
	}

	// Offsets must survive, or the failure message points somewhere useless.
	assert.equal(maskCommentsAndStrings(real).length, real.length);
	assert.equal(maskCommentsAndStrings(real).indexOf('$state('), real.indexOf('$state('));
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

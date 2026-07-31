#!/usr/bin/env node

/**
 * Site stylesheet assembly.
 *
 * Contentus serves ONE external stylesheet rather than inlining critical CSS.
 * Two reasons, both load-bearing:
 *
 *   1. Strict CSP. `scripts/audit-csp.mjs` treats every inline `<style>` in the
 *      rendered output as ship-blocking. An external `<link rel="stylesheet">`
 *      on our own origin needs no inline-style allowance, so adopting the blog
 *      face's several thousand lines of CSS costs no CSP relaxation.
 *   2. The greater CSS files are upstream-owned. Serving them verbatim keeps
 *      them refreshable by the `greater` CLI; pasting them into a template
 *      string would turn them into hand-edited source.
 *
 * WEBFONT NOTE. The design pack's `colors_and_type.css` opens with an `@import`
 * of a Google Fonts stylesheet. Contentus strips it:
 *
 *   - It is a third-party origin. Adding one to a public Theory Cloud page is a
 *     CSP and third-party-governance decision that needs explicit operator
 *     authorization; a build step must not smuggle it in.
 *   - CSS `@import` is only valid at the head of a stylesheet, so it could not
 *     survive concatenation anyway.
 *   - Neither the faces nor the pack ship `@font-face` rules or font binaries,
 *     so there is no self-hosted substitute to put in its place.
 *
 * The brand font STACKS still apply, so Inter / Geist / JetBrains Mono are used
 * wherever a reader has them and the documented system fallbacks apply
 * otherwise. Self-hosting the licensed files is an open operator decision
 * (product design §2), recorded rather than silently made here.
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Output path, relative to the client build dir (served at /l/_assets/...). */
export const SITE_STYLESHEET_FILE = 'brand/contentus.css';

function readRepoFile(relativePath) {
	return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/**
 * Strip `@import` at-rules from a stylesheet layer.
 *
 * Scans to the end of the statement rather than matching to the first `;`. A
 * Google Fonts URL contains semicolons in its weight axis
 * (`family=Inter:wght@400;500;600;700`), so a `[^;]*;` match truncates mid-URL
 * and leaves the remainder as top-level garbage — a CSS parse error that takes
 * the FOLLOWING rule down with it. That would silently undefine the pack's
 * entire `--tc-*` block, leaving every bridge mapping resolving to nothing and
 * the faces reverting to light-theme defaults. Failure mode inherited from
 * emdash, which found it by rendering the page rather than by any assertion.
 */
export function stripCssImports(css) {
	let out = '';
	let i = 0;

	while (i < css.length) {
		// Copy comments through verbatim — `@import` mentioned in prose stays.
		if (css.startsWith('/*', i)) {
			const end = css.indexOf('*/', i + 2);
			const stop = end < 0 ? css.length : end + 2;
			out += css.slice(i, stop);
			i = stop;
			continue;
		}

		const char = css[i];
		if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < css.length && css[j] !== char) {
				if (css[j] === '\\') j += 1;
				j += 1;
			}
			const stop = Math.min(j + 1, css.length);
			out += css.slice(i, stop);
			i = stop;
			continue;
		}

		// An `@import` only counts at a statement boundary: nothing before it on
		// the line, and outside any comment or string.
		if (css.startsWith('@import', i) && /(?:^|\n)[ \t]*$/.test(out)) {
			let j = i + '@import'.length;
			let quote = null;
			for (; j < css.length; j += 1) {
				const c = css[j];
				if (quote) {
					if (c === '\\') j += 1;
					else if (c === quote) quote = null;
					continue;
				}
				if (c === '"' || c === "'") quote = c;
				else if (c === ';') {
					j += 1;
					break;
				} else if (c === '{') {
					// `@import` takes no block, so a brace means malformed input.
					// Stop before it rather than swallowing the following rule.
					break;
				}
			}
			const trailing = /^[ \t]*\r?\n/.exec(css.slice(j));
			out = out.replace(/[ \t]*$/, '');
			i = j + (trailing ? trailing[0].length : 0);
			continue;
		}

		out += char;
		i += 1;
	}

	return out;
}

/** Every CSS file in a vendored directory, in stable name order. */
function readVendoredDir(relativeDir) {
	const dir = join(repoRoot, relativeDir);
	return readdirSync(dir)
		.filter((name) => name.endsWith('.css'))
		.sort()
		.map((name) => ({
			label: `${relativeDir}/${name} (vendored, CLI-copy channel)`,
			css: readFileSync(join(dir, name), 'utf8'),
		}));
}

/** Read every stylesheet layer in cascade order. */
function stylesheetLayers() {
	return [
		{
			label: 'greater tokens (tarball-pin channel) — --gr-* defaults',
			css: readFileSync(require_.resolve('@equaltoai/greater-components-tokens/theme.css'), 'utf8'),
		},
		{
			label: 'greater tokens animations (tarball-pin channel)',
			css: readFileSync(
				require_.resolve('@equaltoai/greater-components-tokens/animations.css'),
				'utf8'
			),
		},
		{
			label: 'greater primitives theme (vendored, CLI-copy channel)',
			css: readRepoFile('src/lib/greater/primitives/theme.css'),
		},
		{
			label: 'greater shell base (vendored, CLI-copy channel)',
			css: readRepoFile('src/lib/greater/shell/styles/base.css'),
		},
		...readVendoredDir('src/lib/greater/shell/components'),
		{
			label: 'greater blog face theme (vendored, CLI-copy channel)',
			css: readRepoFile('src/lib/greater/faces/blog/theme.css'),
		},
		{
			label: 'Theory Cloud design pack — --tc-* brand tokens (webfont @import stripped)',
			css: stripCssImports(readRepoFile('colors_and_type.css')),
		},
		{
			label: 'contentus brand bridge — maps --gr-* onto --tc-*',
			css: readRepoFile('src/lib/brand/bridge.css'),
		},
		{
			// Interim: `greater add compose` (and the media/poll/emoji patterns)
			// vendors components with no stylesheet, and their `.compose-*` classes
			// live only in the social face theme. See the header of the file itself
			// for why installing that whole face is the wider fix, not the narrower
			// one. Deleted when the CLI emits per-module CSS.
			label: 'contentus compose theme — appearance for upstream class contract',
			css: readRepoFile('src/lib/brand/compose.css'),
		},
	];
}

/**
 * Every `--tc-*` token the bridge maps onto the `--gr-*` contract and that the
 * shell styles depend on. If any is missing from the assembled sheet, the
 * bridge's `var(--tc-…)` references resolve to nothing and the faces silently
 * revert to their light-theme defaults.
 */
const REQUIRED_BRAND_TOKENS = [
	'--tc-bg',
	'--tc-fg',
	'--tc-fg-muted',
	'--tc-fg-dim',
	'--tc-surface',
	'--tc-surface-1',
	'--tc-surface-2',
	'--tc-outline',
	'--tc-outline-variant',
	'--tc-midnight',
	'--tc-midnight-depth',
	'--tc-midnight-lift-1',
	'--tc-midnight-lift-2',
	'--tc-steel',
	'--tc-steel-dim',
	'--tc-core-blue',
	'--tc-phi-gold',
	'--tc-violet-signal',
	'--tc-font-sans',
	'--tc-font-display',
	'--tc-font-mono',
	'--tc-radius-md',
	'--tc-radius-pill',
	'--tc-space-4',
	'--tc-lh-body-lg',
	'--tc-ls-eyebrow',
];

/**
 * Assert the assembled sheet is actually usable.
 *
 * A stylesheet can be byte-perfect by every markup assertion and still be
 * inert: one stray top-level token is a parse error that takes the next rule
 * with it, and CSS fails silently. These checks are the cheap standing version
 * of render evidence.
 */
export function assertStylesheetIntegrity(css) {
	const problems = [];
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

	for (const token of REQUIRED_BRAND_TOKENS) {
		// A definition, not merely a `var()` reference.
		if (!new RegExp(`${token}\\s*:`).test(withoutComments)) {
			problems.push(`brand token ${token} is never defined`);
		}
	}

	// No surviving at-rule that would pull a third-party origin, and no fragment
	// left behind by stripping one.
	for (const remnant of ['@import', 'fonts.googleapis.com', 'fonts.gstatic.com', 'display=swap']) {
		if (withoutComments.includes(remnant)) {
			problems.push(`stylesheet contains "${remnant}" outside a comment`);
		}
	}

	// Any absolute URL in the sheet is a third-party fetch at render time.
	for (const match of withoutComments.matchAll(/url\(\s*['"]?(https?:)?\/\/[^)]*\)/gi)) {
		problems.push(`stylesheet references an off-origin url(): ${match[0].slice(0, 80)}`);
	}

	// Balanced blocks. An imbalance means a layer was truncated.
	const open = (withoutComments.match(/{/g) ?? []).length;
	const close = (withoutComments.match(/}/g) ?? []).length;
	if (open !== close) {
		problems.push(`unbalanced blocks: ${open} "{" vs ${close} "}"`);
	}

	if (problems.length > 0) {
		throw new Error(
			`site stylesheet failed integrity checks:\n  - ${problems.join('\n  - ')}\n` +
				'The faces render from these tokens; shipping without them silently reverts ' +
				'them to light-theme defaults.'
		);
	}
}

/**
 * Assemble the single site stylesheet.
 *
 * Deterministic: the same inputs always produce the same bytes, so build output
 * stays reproducible across hosts.
 */
export function buildSiteStylesheet() {
	const css = stylesheetLayers()
		.map((layer) => `/* ===== ${layer.label} ===== */\n${layer.css.trim()}\n`)
		.join('\n');
	assertStylesheetIntegrity(css);
	return css;
}

function main() {
	const css = buildSiteStylesheet();
	const outPath = join(repoRoot, 'build/client', SITE_STYLESHEET_FILE);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, css, 'utf8');

	const tokenCount = (css.match(/--tc-[a-z0-9-]+\s*:/g) ?? []).length;
	console.log(
		`stylesheet: ${SITE_STYLESHEET_FILE} — ${css.length} bytes, ` +
			`${tokenCount} --tc-* definitions, integrity assertions passed`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}

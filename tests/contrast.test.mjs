import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { getContrastRatio } from '../src/lib/greater/utils/theme/contrast.ts';

/**
 * The contrast guardrail.
 *
 * The 2026-08-06 audit's worst finding was text at 1.01:1 — light-mode
 * defaults painting on a dark ground because no element carried
 * `data-theme="dark"`. Two probes already pin that root cause (the shell's
 * `data-theme` in tests/ssr-probe.test.mjs, the dark rules' presence in the
 * sheet in tests/stylesheet.test.mjs). What neither covers is the quieter
 * failure mode: a token edit or a vendored refresh that leaves a text/surface
 * pair below WCAG 2.2 AA while the cascade is otherwise correct.
 *
 * So this probe resolves the custom properties from the SERVED sheet — the
 * same build artifact the instance gets, assembled by
 * `scripts/build-stylesheet.mjs` — and computes every text/surface pair the
 * dark theme actually paints, using the vendored WCAG implementation rather
 * than a second one invented here. Static, deliberately: it judges token
 * pairs, not rendered pixels. That is honest scope, not a shortcut — a token
 * that fails here fails everywhere it is used, with no browser required.
 *
 * Scope note: `--tc-fg-dim` IS pinned, at 4.5 on the surfaces tertiary text
 * occupies. It failed by 0.02 on `--tc-bg` the first time this probe ran
 * (#6F7D95 on #081226), which is how `--tc-steel-bright` came to exist —
 * linework and tertiary text no longer share `--tc-steel`.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sheetPath = resolve(repoRoot, 'build/client/brand/contentus.css');

if (!existsSync(sheetPath)) {
	throw new Error(
		'build/client/brand/contentus.css is missing; run `pnpm run build:assets` first.'
	);
}

const sheet = readFileSync(sheetPath, 'utf8');

/**
 * Collect custom-property declarations by theme context. The base context is
 * every `:root` block that is not theme-qualified; the dark context overlays
 * `[data-theme="dark"]` blocks, which is the theme the shell paints.
 */
function declarations(selectorFilter) {
	const properties = new Map();
	const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
	let match;
	while ((match = blockPattern.exec(sheet)) !== null) {
		const selectors = match[1];
		const body = match[2];
		if (!selectorFilter(selectors)) continue;
		const declarationPattern = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
		let declaration;
		while ((declaration = declarationPattern.exec(body)) !== null) {
			properties.set(declaration[1], declaration[2].trim());
		}
	}
	return properties;
}

const isBaseRoot = (selectors) =>
	selectors.includes(':root') && !selectors.includes('[data-theme') && !selectors.includes(':not');
const isDark = (selectors) =>
	(selectors.includes(`[data-theme="dark"]`) || selectors.includes(`[data-theme='dark']`)) &&
	!selectors.includes(':not');

const base = declarations(isBaseRoot);
const dark = new Map([...base, ...declarations(isDark)]);

/** Resolve `var(--name)` and `var(--name, fallback)` chains to a literal. */
function resolveToken(name, context) {
	let value = context.get(name);
	assert.ok(value, `${name} is not defined in the served sheet — a vendored refresh renamed it`);
	for (let depth = 0; depth < 10; depth += 1) {
		const reference = /^var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*(.+))?\)$/.exec(value);
		if (!reference) return value;
		value = context.get(reference[1]) ?? reference[2];
		assert.ok(value, `${name} resolves through ${reference[1]}, which the sheet does not define`);
	}
	assert.fail(`${name} does not resolve to a literal within 10 var() hops`);
}

const token = (name) => resolveToken(name, dark);

// ── the pairs the dark theme paints ─────────────────────────────────────────
// [foreground token, surface token, minimum ratio, what the pair is]

const TEXT_PAIRS = [
	['--tc-fg', '--tc-bg', 4.5, 'primary text on the page ground'],
	['--tc-fg', '--tc-surface-1', 4.5, 'primary text on cards/panels'],
	['--tc-fg', '--tc-surface-2', 4.5, 'primary text on raised panels'],
	['--tc-fg', '--tc-surface-3', 4.5, 'primary text on hover/active surfaces'],
	['--tc-fg-muted', '--tc-bg', 4.5, 'secondary text on the page ground'],
	['--tc-fg-muted', '--tc-surface-1', 4.5, 'secondary text on cards (meta, :visited titles)'],
	['--tc-fg-muted', '--tc-surface-2', 4.5, 'secondary text on raised panels'],
	['--tc-fg-dim', '--tc-bg', 4.5, 'tertiary text on the page ground (the 0.02 finding)'],
	['--tc-fg-dim', '--tc-surface-1', 4.5, 'tertiary text on cards'],
	['--tc-fg-dim', '--tc-surface-2', 4.5, 'tertiary text on raised panels'],
	['--tc-accent', '--tc-bg', 4.5, 'links and eyebrows on the page ground'],
	['--tc-accent', '--tc-surface-1', 4.5, 'links on cards'],
	['--tc-accent', '--tc-surface-2', 4.5, 'links on raised panels'],
	['--tc-error', '--tc-bg', 4.5, 'error text on the page ground'],
	['--tc-error', '--tc-surface-2', 4.5, 'error text on raised panels (account menu)'],
	// The vendored blog face's dark card: title, excerpt, and meta on BOTH the
	// vendored card ground and the contentus surface-1 companion override.
	['--gr-color-gray-100', '--gr-color-gray-900', 4.5, 'vendored card title on vendored card'],
	['--gr-color-gray-300', '--gr-color-gray-900', 4.5, 'vendored card excerpt on vendored card'],
	['--gr-color-gray-400', '--gr-color-gray-900', 4.5, 'vendored 14px card meta on vendored card'],
	['--gr-color-gray-100', '--tc-surface-1', 4.5, 'card title on the contentus card surface'],
	['--gr-color-gray-300', '--tc-surface-1', 4.5, 'card excerpt on the contentus card surface'],
	['--gr-color-gray-400', '--tc-surface-1', 4.5, 'card meta on the contentus card surface'],
	// Article body text and links as the reader paints them (the article
	// background is transparent in contentus, so the ground is --tc-bg).
	['--gr-blog-article-text', '--tc-bg', 4.5, 'article body text on the page ground'],
	['--gr-blog-article-heading', '--tc-bg', 4.5, 'article headings on the page ground'],
	['--gr-blog-article-link', '--tc-bg', 4.5, 'article links on the page ground'],
];

const UI_PAIRS = [
	// Non-text UI: WCAG 2.2 SC 1.4.11 asks 3:1 for focus indicators.
	['--tc-core-blue', '--tc-bg', 3.0, 'focus ring on the page ground'],
	['--tc-core-blue', '--tc-surface-2', 3.0, 'focus ring on raised panels'],
];

for (const [foreground, surface, minimum, label] of [...TEXT_PAIRS, ...UI_PAIRS]) {
	test(`${label} meets ${minimum}:1`, () => {
		const fg = token(foreground);
		const bg = token(surface);
		assert.match(fg, /^#[0-9a-f]{6}$/i, `${foreground} resolves to a hex literal (got ${fg})`);
		assert.match(bg, /^#[0-9a-f]{6}$/i, `${surface} resolves to a hex literal (got ${bg})`);

		const ratio = getContrastRatio(fg, bg);
		assert.ok(
			ratio >= minimum,
			`${foreground} (${fg}) on ${surface} (${bg}) is ${ratio.toFixed(2)}:1, below the ${minimum}:1 minimum`
		);
	});
}

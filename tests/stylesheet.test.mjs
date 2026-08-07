import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	assertStylesheetIntegrity,
	buildSiteStylesheet,
	stripCssImports,
} from '../scripts/build-stylesheet.mjs';

/**
 * The `@import` stripper is tested against the design pack's real URL because
 * its failure mode is silent: a naive `[^;]*;` match truncates mid-URL at the
 * semicolons in the font weight axis, leaving top-level garbage that is a CSS
 * parse error — which takes the FOLLOWING rule down with it and un-defines the
 * whole `--tc-*` block. Nothing in the markup would look wrong.
 */

const REAL_PACK_IMPORT =
	"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');";

test('the pack webfont import is removed whole, semicolons and all', () => {
	const css = `${REAL_PACK_IMPORT}\n:root { --tc-bg: #081226; }\n`;
	const stripped = stripCssImports(css);

	assert.ok(!stripped.includes('@import'));
	// Compare hostnames exactly, never by substring on the raw CSS: extract any
	// surviving url() references and parse them. (A substring check here is what
	// CodeQL js/incomplete-url-substring-sanitization flags — rightly so.)
	const survivingHosts = [...stripped.matchAll(/url\(\s*['"]([^'"]+)['"]/g)].map(
		([, href]) => new URL(href).hostname
	);
	assert.ok(
		!survivingHosts.includes('fonts.googleapis.com'),
		'the webfont host must not survive the strip'
	);
	assert.ok(!stripped.includes('display=swap'));
	// The following rule must survive intact — this is the regression that matters.
	assert.match(stripped, /--tc-bg:\s*#081226/);
});

test('an @import mentioned inside a comment is left alone', () => {
	const css = '/* we strip @import url("x") here */\n:root { --tc-bg: #081226; }\n';
	assert.equal(stripCssImports(css), css);
});

test('an @import that is not at a statement boundary is not treated as one', () => {
	const css = ':root { --tc-note: "@import"; }\n';
	assert.equal(stripCssImports(css), css);
});

test('the assembled stylesheet passes its own integrity assertions', () => {
	// Exercises the real layer stack: greater tokens, primitives, shell, blog
	// face, the pack, and the bridge.
	const css = buildSiteStylesheet();

	assert.ok(css.length > 10_000, 'assembled sheet is implausibly small');
	assert.match(css, /--tc-bg\s*:/);
	assert.match(
		css,
		/\[data-theme='dark'\] \.gr-blog-article-card/,
		'the vendored dark rules must ship in the assembled sheet'
	);
	assert.doesNotMatch(
		css,
		/--gr-color-neutral-0\s*:/,
		'the pre-0.13.2 inverted neutral ramp is deleted; nothing vendored consumes it'
	);
	assert.doesNotThrow(() => assertStylesheetIntegrity(css));
});

test('integrity assertion fails when a required brand token is missing', () => {
	assert.throws(() => assertStylesheetIntegrity(':root { --tc-bg: #081226; }'), /never defined/);
});

test('integrity assertion fails on a surviving third-party origin', () => {
	const css = buildSiteStylesheet() + '\n@import url("https://fonts.googleapis.com/x");\n';
	assert.throws(() => assertStylesheetIntegrity(css), /@import|fonts\.googleapis\.com/);
});

test('integrity assertion fails on unbalanced blocks', () => {
	const css = buildSiteStylesheet() + '\n.contentus-broken {\n';
	assert.throws(() => assertStylesheetIntegrity(css), /unbalanced/);
});

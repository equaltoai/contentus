#!/usr/bin/env node

/**
 * Renderer-authority audit.
 *
 * lesser's server-side renderer/sanitizer is the single authority for article
 * HTML (lesser `docs/architecture/cms/fediverse-first-blog-cms-contract.md`
 * → "Renderer authority contract"; contentus `AGENTS.md` and product design
 * §8). Contentus displays that output and nothing else.
 *
 * That invariant is easy to state and easy to erode — one `{@html}` in a
 * template, one `marked` import added to "fix previews", and the client has
 * quietly become a second canonical renderer. This audit makes the erosion
 * fail the build.
 *
 * Four checks:
 *
 *   1. No Markdown-rendering package is a direct contentus dependency.
 *   2. No contentus-owned source imports a Markdown/HTML rendering package.
 *   3. No contentus-owned Svelte template contains an `{@html}` sink.
 *   4. The vendored blog face still ESCAPES non-HTML content instead of
 *      rendering it.
 *
 * Check 4 deserves explanation: contentus's reader delegates body display to
 * the vendored `Article.Content`, which renders `{@html}` only when
 * `contentFormat === 'html'` and escapes Markdown source otherwise. That
 * upstream behavior is load-bearing for our invariant, so a `greater update`
 * that changed it would silently weaken contentus. Asserting it here turns an
 * assumption into a checked fact.
 *
 * Scope note: the audit deliberately does NOT forbid greater's HTML SANITIZER
 * chain (`unified` + `rehype-*` + `hast-util-sanitize`). Sanitizing HTML is not
 * rendering Markdown, and the vendored blog face imports `sanitizeHtml` as
 * defence-in-depth over lesser's authority. The forbidden set is the RENDERING
 * chain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Markdown/HTML RENDERING packages. Adding any of these to contentus makes it a
 * second canonical renderer, which the contract forbids.
 */
const FORBIDDEN_RENDERER_PACKAGES = [
	'marked',
	'markdown-it',
	'showdown',
	'commonmark',
	'remark',
	'remark-parse',
	'remark-gfm',
	'remark-rehype',
	'remark-html',
	'mdast-util-to-markdown',
	'mdast-util-gfm',
	'hast-util-to-mdast',
	'shiki',
	'highlight.js',
	'prismjs',
	'markdown-to-jsx',
	'micromark',
];

/**
 * Directories containing CONTENTUS-OWNED source. The vendored greater tree is
 * upstream-owned and deliberately excluded: it is CLI-managed, verified by
 * `greater doctor`, and its `{@html}` usage is greater's sanitizer boundary,
 * not ours. Check 4 covers the part of it we actually depend on.
 */
const OWNED_SOURCE_DIRS = [
	'src/facetheory',
	'src/lib/auth',
	'src/lib/brand',
	'src/lib/cms',
	'src/lib/config',
	'src/lib/routes',
	'src/lib/shell',
	'scripts',
];

const VENDORED_ARTICLE_CONTENT = 'src/lib/greater/faces/blog/components/Article/Content.svelte';

function walkFiles(dir) {
	const absolute = join(repoRoot, dir);
	const results = [];
	let entries;
	try {
		entries = readdirSync(absolute);
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = join(absolute, entry);
		if (statSync(full).isDirectory()) {
			results.push(...walkFiles(relative(repoRoot, full)));
		} else if (/\.(ts|svelte|mjs|js)$/.test(entry)) {
			results.push(full);
		}
	}
	return results;
}

function checkDependencies() {
	const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
	const declared = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
	]);

	return FORBIDDEN_RENDERER_PACKAGES.filter((name) => declared.has(name)).map(
		(name) =>
			`package.json declares "${name}" — contentus must not ship a Markdown/HTML renderer.`
	);
}

function checkImports() {
	const problems = [];
	const pattern = new RegExp(
		`from\\s+['"](${FORBIDDEN_RENDERER_PACKAGES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(/[^'"]*)?['"]`,
		'g'
	);

	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			const content = readFileSync(file, 'utf8');
			for (const match of content.matchAll(pattern)) {
				problems.push(
					`${relative(repoRoot, file)} imports "${match[1]}" — renderer authority is lesser's.`
				);
			}
		}
	}
	return problems;
}

function checkHtmlSinks() {
	const problems = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			if (!file.endsWith('.svelte')) continue;
			const content = readFileSync(file, 'utf8');
			// Ignore the token inside comments: this file's own rationale mentions it.
			const withoutComments = content
				.replace(/<!--[\s\S]*?-->/g, '')
				.replace(/\/\*[\s\S]*?\*\//g, '');
			if (/\{@html\b/.test(withoutComments)) {
				problems.push(
					`${relative(repoRoot, file)} contains an {@html} sink — contentus-owned templates ` +
						'must not inject HTML; body display goes through the vendored blog face.'
				);
			}
		}
	}
	return problems;
}

/**
 * Confirm the vendored blog face still refuses to render non-HTML content.
 *
 * Not a style check — this is the upstream guarantee contentus's reader relies
 * on. If `greater update` ever replaced the escaping fallback with a Markdown
 * renderer, contentus would start client-rendering source without a single
 * line of our own code changing.
 */
function checkVendoredEscapeFallback() {
	const path = join(repoRoot, VENDORED_ARTICLE_CONTENT);
	let content;
	try {
		content = readFileSync(path, 'utf8');
	} catch {
		return [`${VENDORED_ARTICLE_CONTENT} is missing — the blog face vendoring is incomplete.`];
	}

	const problems = [];

	// The HTML branch must be gated on contentFormat.
	if (!/contentFormat\s*===\s*'html'/.test(content)) {
		problems.push(
			`${VENDORED_ARTICLE_CONTENT} no longer gates its {@html} branch on ` +
				"contentFormat === 'html'. Re-verify renderer authority before shipping."
		);
	}

	// The non-HTML branch must escape, not render.
	if (!/\{article\.content\}/.test(content)) {
		problems.push(
			`${VENDORED_ARTICLE_CONTENT} no longer escapes non-HTML content as text. ` +
				'It may now render Markdown client-side — route upstream before shipping.'
		);
	}

	for (const forbidden of FORBIDDEN_RENDERER_PACKAGES) {
		if (new RegExp(`from\\s+['"]${forbidden}(/|['"])`).test(content)) {
			problems.push(
				`${VENDORED_ARTICLE_CONTENT} now imports "${forbidden}" — the vendored face ` +
					'has become a second canonical renderer.'
			);
		}
	}

	return problems;
}

function main() {
	const checks = [
		['dependencies', checkDependencies()],
		['owned-source imports', checkImports()],
		['owned-source {@html} sinks', checkHtmlSinks()],
		['vendored blog-face escape fallback', checkVendoredEscapeFallback()],
	];

	console.log('# Renderer-authority audit\n');

	let total = 0;
	for (const [label, problems] of checks) {
		total += problems.length;
		console.log(`- ${label}: ${problems.length === 0 ? 'clean' : `${problems.length} problem(s)`}`);
	}

	console.log(
		`\n- Forbidden renderer packages checked: ${FORBIDDEN_RENDERER_PACKAGES.length}` +
			`\n- Contentus-owned source roots scanned: ${OWNED_SOURCE_DIRS.length}`
	);

	if (total > 0) {
		console.log('\n## Problems');
		for (const [label, problems] of checks) {
			for (const problem of problems) console.log(`- [${label}] ${problem}`);
		}
		console.log('\nRenderer-authority audit: FAILED.');
		return 1;
	}

	console.log('\nRenderer-authority audit: clean.');
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}

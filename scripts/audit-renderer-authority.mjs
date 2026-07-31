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
 * Five checks:
 *
 *   1. No Markdown-rendering package is a direct contentus dependency.
 *   2. No contentus-owned source imports a Markdown/HTML rendering package.
 *   3. No contentus-owned Svelte template contains an `{@html}` sink.
 *   4. The vendored blog face still ESCAPES non-HTML content instead of
 *      rendering it.
 *   5. Every source file under `src/` is classified — owned and therefore
 *      scanned by 2 and 3, or explicitly declared vendored.
 *
 * Check 5 exists because checks 2 and 3 are only ever as good as their list of
 * directories, and that list silently fell behind: `src/lib/compose` was
 * written whole in M3 without being added, so an audit that reported "clean"
 * had not looked at twelve contentus-owned components — one of which cites
 * this audit as the reason it does not render a status body. A new directory
 * is now a FINDING until somebody says which side of the line it is on, which
 * is the difference between a gate and a list somebody has to remember.
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
import { join, relative, resolve, sep } from 'node:path';
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
 *
 * THE RULE FOR ADDING TO THIS LIST, because it was got wrong once: a directory
 * belongs here when contentus AUTHORS the files in it, not when it happens to
 * sit under `src/lib`. `src/lib/compose` was written whole in M3 — twelve
 * contentus-owned components, including one whose header cites this audit as
 * the reason it does not render the source status's body — and was not added,
 * so for the length of that milestone the audit's claim to cover
 * contentus-owned templates was true of every directory except the newest one.
 * A `{@html}` in any of them would have shipped clean.
 *
 * `src/lib/components`, `src/lib/patterns`, `src/lib/generics`, and
 * `src/lib/greater` stay out: every one of them is `greater` CLI-managed
 * (`components.json` → `installMode: vendored`).
 */
const OWNED_SOURCE_DIRS = [
	'src/facetheory',
	'src/lib/auth',
	'src/lib/brand',
	'src/lib/build',
	'src/lib/cms',
	'src/lib/compose',
	'src/lib/config',
	// Face 5's contentus-owned messaging consumption (M5). Same rule as
	// `src/lib/review` and `src/lib/timelines` below: added WITH the directory.
	// The claim this audit is checking here is a sharp one — every message body
	// on this surface is lesser's server-sanitized HTML, handed to the vendored
	// component untouched, and nothing in this directory renders, transforms or
	// re-sanitizes it. That is only worth stating if the audit is looking.
	'src/lib/messaging',
	// Face 2's contentus-owned review controls (M2d.3). Added WITH the directory
	// rather than after it, which is the rule check 5 exists to enforce: the
	// components here render lesser's rendered output and never produce HTML of
	// their own, and that claim is only worth anything if this audit is looking.
	'src/lib/review',
	'src/lib/routes',
	'src/lib/shell',
	// Face 4's contentus-owned timeline consumption (M4). Same rule as
	// `src/lib/review` above: added WITH the directory, because a module that
	// passes lesser's server-sanitized status HTML straight to the vendored
	// card is only making that claim if this audit is looking at it.
	'src/lib/timelines',
	'src/types',
	'scripts',
];

/**
 * The `greater` CLI-managed trees, declared so check 5 can tell "upstream owns
 * this" apart from "nobody remembered to audit this". Mirrors
 * `components.json` → `installMode: vendored` and its alias targets.
 */
const VENDORED_SOURCE_ROOTS = [
	'src/lib/components',
	'src/lib/generics',
	'src/lib/greater',
	'src/lib/patterns',
	// The `utils` alias target. Empty until M4, when the social face's shared
	// modules placed notificationGrouping.ts here; it is the CLI's directory,
	// not contentus's, despite the generic name.
	'src/lib/utils',
];

/**
 * Vendored modules the CLI emits loose at the `src/lib` root, not in a tree.
 *
 * This list grows at every face that vendors a shared module, because the
 * registry spells those paths `lib/lib/<name>` and the components.json `lib`
 * alias resolves that to `src/lib` — so they land as siblings of contentus's
 * own directories rather than under one of their own. Listing them one by one
 * is the cost of that; a `src/lib/*.ts` glob would classify contentus-owned
 * files as vendored the moment somebody added one, which is exactly the
 * misclassification check 5 exists to catch.
 */
const VENDORED_SOURCE_FILES = [
	'src/lib/blog-share.ts',
	'src/lib/blog-types.ts',
	'src/lib/types.ts',
	// M4: the social face's timeline, notification and realtime modules.
	// contentus imports none of them — the stores assume an Apollo client it
	// does not run, and `transport.ts` speaks Mastodon's streaming protocol
	// rather than lesser's GraphQL subscriptions — but they are on disk, so
	// check 5 requires them classified rather than merely unused.
	'src/lib/graphqlTimelineStore.svelte.ts',
	'src/lib/graphqlTimelineStore.ts',
	'src/lib/integration.svelte.ts',
	'src/lib/integration.ts',
	'src/lib/lesserTimelineStore.svelte.ts',
	'src/lib/lesserTimelineStore.ts',
	'src/lib/notificationStore.svelte.ts',
	'src/lib/notificationStore.ts',
	'src/lib/timelineStore.svelte.ts',
	'src/lib/timelineStore.ts',
	'src/lib/transport.ts',
];

const VENDORED_ARTICLE_CONTENT = 'src/lib/greater/faces/blog/components/Article/Content.svelte';

/**
 * Extensions the walk opens: source this toolchain executes or compiles.
 *
 * Deliberately wider than what the repo happens to contain today, because the
 * narrow version was the bug. The walk recognized `ts|svelte|mjs|js`, so an
 * `.mts` — a module `node` runs and `vite` compiles without comment — was
 * invisible to every check that walks, including check 5, whose entire job is
 * to notice source nobody classified. A file the walk never opens is a file
 * each check silently passes: the same failure as `src/lib/compose`, one level
 * further down, and worse for being in the mechanism rather than the list.
 *
 * So the set is defined by what runs, not by what exists. `.css`, `.json`, and
 * assets stay out: they are not module code, and admitting them would make
 * check 5 demand a classification for every stylesheet.
 */
const EXECUTABLE_SOURCE_EXTENSIONS = [
	'ts',
	'mts',
	'cts',
	'tsx',
	'js',
	'mjs',
	'cjs',
	'jsx',
	'svelte',
];

const EXECUTABLE_SOURCE = new RegExp(`\\.(${EXECUTABLE_SOURCE_EXTENSIONS.join('|')})$`);

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
		} else if (EXECUTABLE_SOURCE.test(entry)) {
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
		(name) => `package.json declares "${name}" — contentus must not ship a Markdown/HTML renderer.`
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

/**
 * Every source file under `src/` is either owned (and scanned) or declared
 * vendored. Neither is a finding, because "unclassified" is exactly the state
 * `src/lib/compose` sat in while this audit called itself clean.
 *
 * Scoped to `src/`. `scripts/` is listed whole in OWNED_SOURCE_DIRS, and
 * `gov-infra/` is the governance tree — bound by CON-5's content pins rather
 * than by renderer authority.
 */
function checkOwnedSourceCoverage() {
	const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
	const problems = [];

	for (const file of walkFiles('src')) {
		const path = relative(repoRoot, file).split(sep).join('/');
		if (OWNED_SOURCE_DIRS.some((dir) => isUnder(path, dir))) continue;
		if (VENDORED_SOURCE_ROOTS.some((dir) => isUnder(path, dir))) continue;
		if (VENDORED_SOURCE_FILES.includes(path)) continue;

		problems.push(
			`${path} is scanned by neither the owned-source checks nor declared vendored. ` +
				'Add its directory to OWNED_SOURCE_DIRS, or declare it in VENDORED_SOURCE_ROOTS/FILES.'
		);
	}

	return problems;
}

function main() {
	const checks = [
		['dependencies', checkDependencies()],
		['owned-source imports', checkImports()],
		['owned-source {@html} sinks', checkHtmlSinks()],
		['vendored blog-face escape fallback', checkVendoredEscapeFallback()],
		['owned-source coverage', checkOwnedSourceCoverage()],
	];

	console.log('# Renderer-authority audit\n');

	let total = 0;
	for (const [label, problems] of checks) {
		total += problems.length;
		console.log(`- ${label}: ${problems.length === 0 ? 'clean' : `${problems.length} problem(s)`}`);
	}

	console.log(
		`\n- Forbidden renderer packages checked: ${FORBIDDEN_RENDERER_PACKAGES.length}` +
			`\n- Contentus-owned source roots scanned: ${OWNED_SOURCE_DIRS.length}` +
			`\n- Executable source extensions walked: ${EXECUTABLE_SOURCE_EXTENSIONS.join(', ')}`
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

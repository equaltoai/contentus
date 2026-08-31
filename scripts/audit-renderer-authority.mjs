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
 * Seven checks:
 *
 *   1. No Markdown-rendering package is a direct contentus dependency.
 *   2. No contentus-owned source imports a Markdown/HTML rendering package —
 *      read with the same TypeScript parser the toolchain runs, so a dynamic
 *      `import('marked')` is as visible as a static one and a package name in
 *      a comment or string is not a finding.
 *   3. No contentus-owned Svelte template contains an `{@html}` sink — with
 *      ONE pinned exception: the lesser-preview display sink below, which
 *      check 6 content-binds rather than trusts. Read with the Svelte
 *      compiler, so a comment or a string can never hide a live tag (round-1
 *      bypass A) and a commented-out tag is not a finding.
 *   4. The vendored blog face still ESCAPES non-HTML content instead of
 *      rendering it.
 *   5. Every source file under `src/` is classified — owned and therefore
 *      scanned by 2, 3, and 7, or explicitly declared vendored.
 *   6. The preview display sink is exactly the pinned file and exactly the
 *      pinned shape: one sink, bound to `preview.html` verbatim, type-only
 *      imports, no transform. The exception check 3 admits is narrower than
 *      the rule it suspends, and this check is what makes it so.
 *   7. No contentus-owned executable source reaches the DOM through an
 *      alternate raw-HTML sink — `.innerHTML` / `.outerHTML` writes,
 *      `.insertAdjacentHTML` calls, `document.write`, `srcdoc` attributes —
 *      the sink shapes `{@html}` scanning cannot see (round-1 bypass C).
 *
 * WHY THE GATE IS A PARSER NOW. Round-1 adversarial review proved three live
 * bypasses against the previous comment-stripped regex gate: a `/*` inside a
 * quoted template expression hid a second computed `{@html}` sink; a
 * script-side reassignment of `preview.html` passed a binding that only
 * counted sinks; alternate sinks were unscanned. All three are properties of
 * reading text with comments removed. The Svelte compiler and TypeScript
 * parser decide what is comment, what is string, what is a live tag, and what
 * is an assignment — `scripts/lib/source-scan.mjs` is the one copy of that
 * reading, imported here and driven by the probes.
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
import ts from 'typescript';

import { liveScript, moduleSpecifiers } from './lib/module-imports.mjs';
import {
	alternateSinksInScript,
	alternateSinksInSvelte,
	previewDisplayScriptFindings,
	svelteConstTags,
	svelteHtmlTags,
	svelteScriptContents,
} from './lib/source-scan.mjs';

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
	// Face 6's contentus-owned agent roster and MCP detail (M6). Added WITH the
	// directory, the rule check 5 enforces. The claim being made here is narrow
	// but real: this surface renders agent METADATA — handles, types, capability
	// flags, MCP URLs — and never article or status content, so nothing in it has
	// any business owning a renderer. An `{@html}` or a Markdown import appearing
	// in this directory would be a defect wherever it came from.
	'src/lib/agents',
	'src/lib/drones',
	'src/lib/auth',
	'src/lib/brand',
	'src/lib/build',
	'src/lib/cms',
	'src/lib/compose',
	'src/lib/config',
	// The served-instance reader (v1.6.4 contract sync). Added WITH the
	// directory, the rule check 5 enforces. This module reads instance metadata
	// — the subscription endpoint, upload and status budgets, CMS feature
	// flags — and renders nothing, so nothing in it has any business owning a
	// renderer; an `{@html}` or a Markdown import here would be a defect.
	'src/lib/instance',
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
	// `lesserTimelineStore.svelte.ts` and `lesserTimelineStore.ts` WERE declared here
	// and are now retired, because the files are gone. greater-v0.13.1 withdrew them
	// from the `social-timeline` registry entry and taught `greater update` to prune a
	// managed file the registry no longer owns, so the managed channel removed them —
	// which is what this repository was waiting for rather than hand-deleting them.
	// The entries go with the files: this list is a PERMISSION, and a permission that
	// outlives its subject silently reclassifies whatever next takes the name.
	'src/lib/notificationStore.svelte.ts',
	'src/lib/notificationStore.ts',
	'src/lib/timelineStore.svelte.ts',
	'src/lib/timelineStore.ts',
	'src/lib/transport.ts',
];

const VENDORED_ARTICLE_CONTENT = 'src/lib/greater/faces/blog/components/Article/Content.svelte';

/**
 * The ONE contentus-owned template permitted to carry an `{@html}` sink.
 *
 * The body it displays is `draftPreview.renderedHtml` — HTML lesser rendered
 * AND sanitized server-side (`cms.RenderDraftPreviewWithMedia`), behind the
 * authenticated preview read. lesser is therefore the single renderer and
 * sanitizer of these bytes, and contentus's job reduces to displaying them.
 *
 * Why that display does not go through the vendored blog face like every other
 * body: `Article.Content`'s defence-in-depth pass is an allowlist shaped for
 * UNTRUSTED FEDIVERSE content, and it strips the lesser-authored
 * `<figure>`/`<img>` that `includeAccessUrls: true` exists to serve — the
 * operator failure behind #112 was exactly a bound image the review DOM never
 * showed. Re-filtering trusted server output is not added safety; it is a
 * second opinion disagreeing with the named authority, and the milestone
 * contract forbids it ("never secondary sanitization"). The public article
 * path keeps its vendored defence pass untouched; this exception is the
 * authenticated preview only.
 *
 * The exception is a PERMISSION, and a permission without a shape is a hole.
 * Check 6 below binds the shape: exactly one sink, bound to `preview.html`
 * verbatim (the projection field `toDraftPreview` nulls unless lesser reported
 * success), type-only imports, no transform. `tests/renderer-authority-audit
 * .test.mjs` plants violations of the binding and fails. A preview display that
 * grows a second sink, a value import, a function call, a `$effect`, a
 * markup `{@const}`, or any other statement between lesser's bytes and the DOM
 * is a renderer-authority change, and it fails here first.
 */
const PREVIEW_DISPLAY_SINK = 'src/lib/review/PreviewBody.svelte';

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

/**
 * Check 2's scanner lives in `./lib/module-imports.mjs`, imported above.
 *
 * It is a module rather than a local function for the same governance reason
 * `./lib/source-scan.mjs` exists: the reading this gate runs and the reading
 * the probes drive must be the same bytes. `moduleSpecifiers` parses with the
 * TypeScript parser — comments and strings are trivia, dynamic `import(…)` is
 * as visible as a static `from`, and an unparseable file is a finding, never
 * an empty scan. For a Svelte file, `liveScript` hands it the compiler's own
 * script blocks plus the markup's `import(…)` calls.
 */
function checkImports() {
	const problems = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			const path = relative(repoRoot, file);
			const source = readFileSync(file, 'utf8');
			let specifiers;
			try {
				if (path.endsWith('.svelte')) specifiers = moduleSpecifiers(liveScript(path, source));
				else specifiers = moduleSpecifiers(source, { jsx: /\.(tsx|jsx)$/.test(path) });
			} catch (error) {
				problems.push(`${path} could not be read as module source: ${error.message}`);
				continue;
			}
			for (const specifier of specifiers) {
				const forbidden = FORBIDDEN_RENDERER_PACKAGES.find(
					(name) => specifier === name || specifier.startsWith(`${name}/`)
				);
				if (forbidden) {
					problems.push(`${path} imports "${forbidden}" — renderer authority is lesser's.`);
				}
			}
		}
	}
	return problems;
}

/**
 * Check 3's scanner lives in `./lib/source-scan.mjs`, imported above.
 *
 * It reads every owned template with the Svelte compiler and reports each
 * `HtmlTag` — the modern-AST node type for `{@html}`. That is the entire
 * content of the round-1 bypass this replaced: a `/*` inside a quoted template
 * expression could hide a second live sink from a comment-stripping scan,
 * because stripping text is not parsing. The compiler knows what is a string,
 * what is a comment, and what is a live tag; a file it cannot parse is a
 * finding, never a clean scan.
 */
function checkHtmlSinks() {
	const problems = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			if (!file.endsWith('.svelte')) continue;
			const path = relative(repoRoot, file);
			// The one pinned exception, content-bound by checkPreviewDisplaySink
			// below. Skipping it here is not trusting it: the binding check reads
			// the same file and fails on any shape other than the pinned one.
			if (path === PREVIEW_DISPLAY_SINK) continue;
			try {
				const tags = svelteHtmlTags(path, readFileSync(file, 'utf8'));
				if (tags.length > 0) {
					problems.push(
						`${path} contains an {@html} sink — contentus-owned templates ` +
							'must not inject HTML; body display goes through the vendored blog face, ' +
							`and the only pinned display sink is ${PREVIEW_DISPLAY_SINK}.`
					);
				}
			} catch (error) {
				problems.push(`${path} could not be scanned for {@html} sinks: ${error.message}`);
			}
		}
	}
	return problems;
}

/**
 * Check 7 — alternate raw-HTML sinks in owned executable source.
 *
 * The `{@html}` ban is only as strong as the set of sink shapes it names.
 * Round-1 bypass C demonstrated the rest: a `.ts` file writing `el.innerHTML`,
 * a template carrying `<iframe srcdoc=…>` — each passed a gate that scanned
 * only for `{@html` in `.svelte` files. This check scans ALL owned executable
 * source (the same extension set the walk opens) for the alternate shapes,
 * read with the same parsers: `.innerHTML`/`.outerHTML` writes, compound and
 * update forms and the `el['innerHTML']` spelling; `.insertAdjacentHTML` and
 * `document.write`/`document.writeln` calls; `srcdoc` attributes in templates
 * and JSX. Vendored greater source stays out, exactly as it does for checks 2
 * and 3 — greater's sanitizer boundary is disclosed, not ours to re-judge.
 */
function checkAlternateHtmlSinks() {
	const problems = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			const path = relative(repoRoot, file);
			const source = readFileSync(file, 'utf8');
			try {
				if (path.endsWith('.svelte')) {
					problems.push(...alternateSinksInSvelte(path, source));
				} else {
					problems.push(
						...alternateSinksInScript(path, source, { jsx: /\.(tsx|jsx)$/.test(path) })
					);
				}
			} catch (error) {
				problems.push(`${path} could not be scanned for raw-HTML sinks: ${error.message}`);
			}
		}
	}
	return problems;
}

/**
 * The content binding for the ONE display sink check 3 admits.
 *
 * Each assertion here is a way the permission could widen, stated before the
 * code so a future edit argues with the audit rather than around it: a second
 * sink, a sink bound to anything other than the `preview.html` projection
 * field, a value import that could carry a transform, a script statement or
 * markup `{@const}` that could hide one, or a sanitizer/rewriter touching
 * lesser's bytes on the way to the DOM. Read with the Svelte compiler and
 * TypeScript parser, so a comment or string can neither hide a violation nor
 * become a false positive (round-1 bypasses A and B).
 */
function checkPreviewDisplaySink() {
	const problems = [];
	let content;
	try {
		content = readFileSync(join(repoRoot, PREVIEW_DISPLAY_SINK), 'utf8');
	} catch {
		return [
			`${PREVIEW_DISPLAY_SINK} is missing. If the preview display moved, move the pin, ` +
				'this check, and its probes together — never delete the check and leave the sink.',
		];
	}

	const path = PREVIEW_DISPLAY_SINK;
	let tags;
	try {
		tags = svelteHtmlTags(path, content);
	} catch (error) {
		return [`${path} could not be parsed: ${error.message}`];
	}

	if (tags.length !== 1)
		problems.push(
			`${path} carries ${tags.length} {@html} sinks — the disclosure admits exactly one.`
		);

	const sink = tags[0];
	if (sink) {
		const expression = sink.expression;
		const bindsPreviewHtml =
			expression?.type === 'MemberExpression' &&
			expression.object?.type === 'Identifier' &&
			expression.object.name === 'preview' &&
			expression.property?.type === 'Identifier' &&
			expression.property.name === 'html' &&
			!expression.computed;
		if (!bindsPreviewHtml)
			problems.push(
				`${path} no longer binds its sink to \`preview.html\` verbatim — ` +
					'the sink must display the DraftPreview projection field, never something computed from it.'
			);
	}

	for (const finding of previewDisplayScriptFindings(path, svelteScriptContents(path, content)))
		problems.push(finding);

	for (const tag of svelteConstTags(path, content)) {
		const text = content.slice(tag.start, tag.end);
		problems.push(
			`${path} declares a markup \`{@const}\` (${text.trim()}) — a markup binding can shadow the ` +
				'`preview` prop; the display sink must read the component prop directly.'
		);
	}

	// Names that would mean a second sanitization or a rewrite — scanned over
	// the parsed script identifiers so prose can name them without tripping the
	// gate, while a live binding cannot hide. (The statement binding above
	// already rejects any runtime statement carrying one; this names the shape.)
	for (const { text: script } of svelteScriptContents(path, content)) {
		try {
			const sourceFile = ts.createSourceFile(
				'probe.ts',
				script,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			const visit = (node) => {
				if (!node || typeof node !== 'object') return;
				if (ts.isIdentifier(node)) {
					for (const forbidden of ['sanitizeHtml', 'DOMPurify', 'linkify', 'marked', 'remark']) {
						if (node.text === forbidden) {
							problems.push(
								`${path} names "${forbidden}" — the preview display applies no second ` +
									'sanitization and no rewrite to lesser-rendered HTML.'
							);
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		} catch {
			// The parse failure is already reported by previewDisplayScriptFindings.
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
		['preview display sink binding', checkPreviewDisplaySink()],
		['alternate raw-HTML sinks', checkAlternateHtmlSinks()],
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

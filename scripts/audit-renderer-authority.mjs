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
 * Nine checks:
 *
 *   1. No Markdown-rendering package is a direct contentus dependency.
 *   2. No contentus-owned source imports a Markdown/HTML rendering package —
 *      read with the same TypeScript parser the toolchain runs, so a dynamic
 *      `import('marked')` is as visible as a static one and a package name in
 *      a comment or string is not a finding. A dynamic import whose specifier
 *      no static read can name (`import(pkg)`) is also a finding: it could
 *      load any package, so the position fails closed (round-2 evasion).
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
 *      alternate raw-HTML sink — `.innerHTML` / `.outerHTML` / `.srcdoc`
 *      writes in every spelling, `.insertAdjacentHTML` and
 *      `.createContextualFragment` calls, `document.write`, `srcdoc`
 *      attributes, and computed keys the analysis cannot resolve — the sink
 *      shapes `{@html}` scanning cannot see (round-1 bypass C), read for the
 *      round-2 evasion spellings (Reflect.set, Object.assign, aliased
 *      document, iframe attribute spreads) and failing closed on any key the
 *      parsers cannot fold (round-2). Round-5 (R5-4) added destructured
 *      renamed dangerous methods, identifier-laundered Object.assign sources,
 *      case-insensitive attribute names, and execCommand('insertHTML');
 *      round-6 (R6-3) follows aliases of dangerous built-in callees
 *      (Object.assign / defineProperty / defineProperties / Reflect.set /
 *      execCommand / setAttribute through identifiers, destructures,
 *      .call/.apply/.bind), call-result payloads, rest/spread payload arrays,
 *      and the narrow residual primitives setHTMLUnchecked and JSX
 *      dangerouslySetInnerHTML. Round-7 (R7-4) added the launderings the
 *      round-7 review planted: property-descriptor setter extraction
 *      (`Object.getOwnPropertyDescriptor(…)?.set?.call(…)`), multi-step method
 *      binding (`const m = host.insertAdjacentHTML; const inj = m.bind(host);
 *      inj(…)`), computed Object.assign keys folded through constant strings
 *      with unresolved computed keys failing closed, `Reflect.apply` /
 *      `Reflect.construct` dispatch, and the Sanitizer-API spellings
 *      `setHTML`/`setHTMLUnsafe` beside `setHTMLUnchecked`.
 *   8. Every `PreviewBody` invocation receives the authorized preview result
 *      verbatim — the sink's caller is bound, not only the sink file, so a
 *      parent `$derived` that spreads `preview` and rewrites `preview.html`
 *      between `toDraftPreview` and the sink is a finding (round-2). The
 *      round-5 value binding follows the reference through aliases,
 *      containers, returning helpers and function hops; the round-6 (R6-1)
 *      cross-file reading additionally rejects a SECOND route built by
 *      forwarding the PreviewBody component or the preview value through
 *      props into a wrapper that invokes them via `<svelte:component>`, and
 *      R6-2 follows the identity through destructures, accessors, class
 *      constructors, loop and catch bindings, and iteration callbacks.
 *      Round-7 (R7-1/R7-3) closes what that reading still skipped: static
 *      invocations whose callee is a prop, an unbound name, a dotted member,
 *      or an owned module no resolution proves a component fail closed the
 *      moment a preview-flowing value can reach them; markup spread objects
 *      are read (keys, shorthand, aliases, helper returns, computed keys
 *      folded through constants) instead of flagged blind; dotted callees and
 *      owned barrels are never trusted owned components; and the value
 *      identity additionally follows late-populated containers, collection
 *      transforms, element access through folded keys, setters, inherited
 *      constructors, and generator yields. Round-8 (R8-2) closes the
 *      local-function return laundering the round-8 review planted: when a
 *      call site hands a value-carrying argument to a local function, the
 *      callee's parameter joins the value names, so a `return p` marks the
 *      callee preview-returning and declaration, inline, `await`, and
 *      `.then` reads of the result bind the identity — sync, async,
 *      generator, arrow, and multi-hop chains alike, with `.then`/`.catch`
 *      callbacks on a value-carrying expression binding their parameter and
 *      `await`/`Promise.resolve` read as same-reference wrappers;
 *      unresolvable callees receiving the value stay fail-closed, and an
 *      import the bundler resolves only through `resolve.alias` is
 *      classified by its alias target rather than read as a benign package
 *      (R8-1). Round-9 (R9-3) closes the relay spellings the round-9 review
 *      planted over that: a default-parameter initializer that reads the
 *      value binds the parameter at any call site leaving the position to
 *      the default; a rest parameter receiving the value is an array
 *      container, so an element read of it carries the identity;
 *      `Promise.all`/`Promise.allSettled` fulfill with an array holding the
 *      reference at the argument positions (awaited destructure and `.then`
 *      destructure alike); `.then`/`.catch`/`.finally` call results carry
 *      the reference onward — multi-hop chains, with a `.then` callback's
 *      return read exactly as a collection transform's is; and an inline
 *      IIFE returning the value is a relay exactly as a named local arrow
 *      is, with a provably fresh literal return the one cleared shape.
 *      Round-10 (R10-3/R10-4/R10-5) closes what that reading still skipped:
 *      a BINDING-ELEMENT default reading the value (`{ x = preview } = {}`
 *      at parameter or declaration position) binds the element at any call
 *      or destructure that can leave its key/position to the default;
 *      object-literal and class METHODS resolve at member call sites
 *      (`o.m()`), so a method parameter default binds and a `return p` marks
 *      the method preview-returning for the member spelling, with a computed
 *      member call on an object carrying value-default methods failing
 *      closed; `Promise.allSettled` fulfillments ADDITIONALLY carry behind
 *      each wrapper's `.value` read (elements stay carried, over-approximated,
 *      as round-9 bound them), and a generator's `.next()` result carries the
 *      same way; a local helper returning a LITERAL container holding the
 *      value (`function box(v) { return [v]; }`) makes a destructure of the
 *      call result, and element/property reads of it, bind the identity; and
 *      a tagged template handing the value to its tag is judged exactly as a
 *      call, while scalar-returning tags that never write their parameters
 *      stay clean the way read-only helpers do.
 *   9. The executable source universe is derived from reachability, not from
 *      the `src/` walk (round-7 R7-2): an executable module outside the
 *      classified owned/vendored roots that an owned file or a build entry
 *      loads — by static or dynamic import, re-export, glob, relative alias,
 *      root-relative path, query-suffixed specifier, case variant, or
 *      symlink — is a finding, and the chain is followed hop by hop.
 *      Round-8 (R8-1/R8-3) adds the route spellings the round-8 review
 *      planted: the bundler's `resolve.alias` table is parsed from the
 *      governed root modules (string, object, array, `.map`-generated, and
 *      regex-find entries; an unreadable entry or a replacement the scan
 *      cannot place inside the repository fails closed), alias-resolved
 *      specifiers join the closure like spelled ones, a bare specifier no
 *      alias claims and no installed package answers for fails closed, and
 *      `import.meta.glob` collects no-substitution template literals and
 *      arrays of patterns beside plain strings, failing closed on any
 *      non-literal glob argument. Round-9 (R9-1/R9-2) closes what that
 *      closure still dropped: a resolved route base NO CANDIDATE MATCHES is
 *      classified instead of silently passed — the benign set the
 *      classification proves (a classified owned/vendored root, a governed
 *      root module, a non-executable path, or a `node_modules` package
 *      `package.json` declares and installs — the last as POLICY over the
 *      declared dependency graph SEC-3 screens, not a byte proof over what
 *      an install contains) stays clean, while a route into any other
 *      excluded root, escaping the repository, or answered for by nothing is
 *      a finding, in each route spelling the closure models (alias,
 *      relative, root-relative, glob — aliased or plain — and dynamic
 *      import); and the alias table itself is distrusted where the runtime
 *      can override the declaration: an entry carrying any property the
 *      model does not consume (`customResolver` first — its return IS the
 *      resolution), a config declaring `resolve.alias` more than once, and
 *      a table naming one find twice are all unreadable and fail closed.
 *      Round-10 (R10-1/R10-2/R10-6/R10-7) closes what that closure still
 *      served un-normalized or un-consulted: EVERY resolved route base is
 *      normalized (`.`/`..` folded the way the runtime folds them) before
 *      candidate matching and miss classification, in every spelling —
 *      `$lib`, root-relative, alias-resolved bare, glob patterns, dynamic
 *      imports, and `new URL(…, import.meta.url)` targets — because the
 *      bundler normalizes alias-replaced paths the gate kept raw, and a
 *      classifier trusting the un-normalized prefix cleared excluded-root
 *      files; the alias table is consulted for EVERY specifier spelling
 *      (first match wins over the raw specifier, exactly as the runtime),
 *      and an alias match redirecting a module the audit scans somewhere
 *      else is a finding; a POST-LITERAL write or mutation of
 *      `resolve.alias` (`cfg.resolve.alias.push(…)`, reassignment, mutating
 *      methods, a mutated table-bound identifier) makes the table
 *      unreadable, because the runtime resolves with the mutation while a
 *      sequential reader meets only the declaration; and `new URL` literals
 *      into the repository are collected as routes — a worker/asset spelling
 *      Vite bundles — with a route into `node_modules` staying clean only
 *      as POLICY (the declared and installed dependency graph SEC-3
 *      screens), never as a byte-level proof over what an install contains.
 *      Rounds 11–13 (R11-1/2/3, R12-1/2/3, R12-A/B/C/D) close what that
 *      state still read or resolved too narrowly — tracking the VALUE's
 *      reach rather than its spellings: the alias table is UNREADABLE the
 *      moment it escapes the literal's textual reach — identifiers bound
 *      from a `resolve`/`alias` chain only through the modeled channels
 *      (direct bindings, parameter or binding-element defaults); a builtin
 *      mutation API, call argument, member-call receiver, or spread handed
 *      the state; and any unmodeled position — a return or yield, a
 *      wrapped initializer, a member or element target, a slot, a computed
 *      key, an iteration, or a plugin `config()` hook returning or
 *      mutating the table — so every consumer fails closed; a member call
 *      CHASES THE HERITAGE CLAUSE to the declaring base — bounded, cycle-
 *      guarded, multi-hop, class-expression, STATIC, SUPER dispatch, cast
 *      receivers unwrapped, an install tainting the chain through ANY
 *      binding that reaches the prototype or constructor — declarations and
 *      assignments alike, shadows included, aliased and element-access
 *      callees and folded computed keys resolved — getters and
 *      computed calls reading it; and the barrel tracer consults the alias
 *      table BEFORE owned resolution, catching a hijacked re-export.
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

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
	liveScript,
	modulePath,
	moduleSpecifiers,
	computedImports,
} from './lib/module-imports.mjs';
import {
	alternateSinksInScript,
	alternateSinksInSvelte,
	eachNode,
	normalizeRepoPath,
	parseResolveAliases,
	parseTypeScript,
	previewDisplayScriptFindings,
	previewForwardingFindings,
	previewInvocationFindings,
	resolveAliasedSpecifier,
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

const EXECUTABLE_SOURCE = new RegExp(`\\.(${EXECUTABLE_SOURCE_EXTENSIONS.join('|')})$`, 'i');

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
 *
 * `computedImports` is the same reading's fail-closed half: an `import(pkg)`
 * whose specifier no static read can name could load ANY package, including a
 * Markdown renderer, so it is a finding unless it is the one pinned exception
 * below. The exception is a permission without a shape being a hole, so it
 * names the file AND the exact expression.
 */
const COMPUTED_IMPORT_EXCEPTIONS = new Map([
	// `scripts/render-routes.mjs` loads SSR handlers the same repository built,
	// from `build/server/`, by converting a local path to a file URL — a
	// computed import of this repository's own build output, never a package
	// specifier, so it cannot be a second canonical renderer. The exception is
	// exact-text: a second computed import anywhere, or a changed one here,
	// is a finding again.
	['scripts/render-routes.mjs', 'import(pathToFileURL(handlerPath).href)'],
]);

function checkImports() {
	const problems = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			const path = relative(repoRoot, file);
			const source = readFileSync(file, 'utf8');
			let specifiers;
			let computed;
			try {
				if (path.toLowerCase().endsWith('.svelte')) {
					const script = liveScript(path, source);
					specifiers = moduleSpecifiers(script);
					computed = computedImports(script);
				} else {
					const jsx = /\.(tsx|jsx)$/.test(path);
					specifiers = moduleSpecifiers(source, { jsx });
					computed = computedImports(source, { jsx });
				}
			} catch (error) {
				problems.push(`${path} could not be read as module source: ${error.message}`);
				continue;
			}
			for (const expression of computed) {
				if (COMPUTED_IMPORT_EXCEPTIONS.get(path) === expression) continue;
				problems.push(
					`${path} loads a module no static read can name (${expression}) — a dynamic import with ` +
						'a computed specifier could load any package, including a Markdown renderer'
				);
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
			if (!file.toLowerCase().endsWith('.svelte')) continue;
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
				if (path.toLowerCase().endsWith('.svelte')) {
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

/**
 * The repository roots the executable-source universe walk never descends
 * into — dependencies, generated output, the governance tree, and non-code
 * content. Each entry is a reason stated elsewhere in this repository's
 * controls: `node_modules` is the dependency graph SEC-3 screens; `build` is
 * generated output COM-1 asserts; `gov-infra` is bound by CON-5's content
 * pins rather than by renderer authority; the rest carry no executable source
 * contentus renders. A directory the walk never opens is governed by those
 * controls, not silently admitted to the app's source.
 */
const UNIVERSE_EXCLUDED_ROOTS = [
	'node_modules',
	'.git',
	'.github',
	'.agents',
	'.claude',
	'.codex',
	'.kimi-code',
	'.theorymcp',
	'.pai',
	'.theory',
	'build',
	'dist',
	'coverage',
	'gov-infra',
	'docs',
	'assets',
	'contracts',
];

/**
 * Executable modules at the repository root that are BUILD CONFIGURATION
 * rather than application source: `vite build` reads them as its own input.
 * They are permissions with a shape, named one by one exactly like the
 * vendored-file list — a new root-level module is unclassified (and, the
 * moment owned code or a build entry loads it, a finding) rather than
 * silently governed. They ALSO seed the reachability walk, because a build
 * entry can load a module nothing under `src/` names.
 */
const GOVERNED_ROOT_MODULES = ['vite.config.ts', 'svelte.config.js'];

/**
 * The extensions the universe resolution tries when a specifier names a
 * module without one — the suffixes this toolchain resolves, in no particular
 * preference: a hit on ANY of them is a reach.
 */
const UNIVERSE_RESOLVE_EXTENSIONS = [
	'',
	'.svelte',
	'.ts',
	'.mts',
	'.cts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.jsx',
];

function walkUniverse(dir) {
	const absolute = join(repoRoot, dir);
	const results = [];
	let entries;
	try {
		entries = readdirSync(absolute);
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (dir === '' && UNIVERSE_EXCLUDED_ROOTS.includes(entry)) continue;
		// The owned trees are classified by the walk that feeds checks 2, 3, 7,
		// and 8; the universe walk only looks OUTSIDE them.
		if (
			dir === '' &&
			OWNED_SOURCE_DIRS.some((owned) => owned === entry || owned.startsWith(`${entry}/`))
		)
			continue;
		const full = join(absolute, entry);
		if (statSync(full).isDirectory()) {
			results.push(...walkUniverse(relative(repoRoot, full)));
		} else if (EXECUTABLE_SOURCE.test(entry)) {
			results.push(full);
		}
	}
	return results;
}

/**
 * A specifier's repository-relative module base, the way the toolchain
 * resolves it — `$lib/x` is the `src/lib/x` alias, `/x` is Vite's
 * root-relative spelling, `./x` and `../x` resolve against the importing
 * file. Query and hash suffixes are already stripped by the caller. A bare
 * specifier is a package and returns null.
 *
 * R10-1: EVERY resolved base is normalized — `.`/`..` folded the way the
 * runtime folds them — whatever the spelling. The round-9 reading folded
 * `..` only for the relative spellings, so a `$lib/x/../../build/y.js`, a
 * `/src/x/../../build/y.js`, or a regex-alias path carrying `..` kept the
 * un-normalized segments, and the classifier trusted a prefix the runtime
 * never serves. Leading `..` segments the base cannot absorb stay visible —
 * they are the escape the classification fails closed on (R9-1).
 */
function resolveUniverseSpecifier(specifier, fromFile) {
	let target;
	if (specifier.startsWith('$lib/')) target = `src/lib/${specifier.slice('$lib/'.length)}`;
	else if (specifier === '$lib') target = 'src/lib';
	else if (specifier.startsWith('/')) target = specifier.slice(1);
	else if (specifier.startsWith('./') || specifier.startsWith('../'))
		target = `${fromFile.split('/').slice(0, -1).join('/')}/${specifier}`;
	else return null;
	return normalizeRepoPath(target);
}

/**
 * The modules Node itself answers for — never an executable outsider.
 * `node:test` is a builtin the `builtinModules` list does not name (it is a
 * runner module, not a loadable library), so it joins by hand.
 */
const NODE_BUILTIN_MODULES = new Set([...builtinModules, 'test']);

/**
 * R8-1: whether a BARE specifier is answered for by an installed package (or
 * a Node builtin). The package root is the first segment, or the first two
 * for a scoped name; a specifier no alias claims and no package answers for
 * is a route no static read can prove, and the scans fail closed on it.
 */
function bareSpecifierPackage(specifier) {
	const stripped = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
	const root = stripped.startsWith('@')
		? stripped.split('/').slice(0, 2).join('/')
		: stripped.split('/')[0];
	if (NODE_BUILTIN_MODULES.has(root)) return true;
	return existsSync(join(repoRoot, 'node_modules', root, 'package.json'));
}

/**
 * R8-1: the build's `resolve.alias` table, read from the governed root
 * modules with the same parser reading everything else in this audit uses.
 * Replacements fold relative to the config file — the governed root modules
 * sit at the repository root, so a `./` prefix strips to a repository-relative
 * path; a replacement the fold cannot place inside the repository (an absolute
 * path, a helper the fold cannot follow when the entry itself still resolved)
 * keeps the entry's find with a NULL replacement, which both scans judge as
 * unproven for any specifier it matches. Entries the parser could not read at
 * all land in `unresolved`, reported once by the universe check and turned
 * into fail-closed verdicts by both scans.
 *
 * R9-2 widened the unreadable set to the override shapes the model names: an
 * entry carrying a property the model does not consume (`customResolver` and
 * any other extra key), a config that declares `resolve.alias` more than once
 * (the runtime keeps the LAST table), and a table naming one find twice (the
 * winner is runtime semantics the scan cannot faithfully model). R10-6 adds
 * POST-LITERAL writes and mutations of the table — a member assignment, an
 * element write, a mutating method call (`push`/`splice` and kin),
 * `Object.assign`, or a mutated identifier- or shorthand-bound table — which
 * the runtime honors while a sequential reader meets only the declaration.
 * R11-1 adds the ESCAPE closure: identifiers the table, its `resolve` parent,
 * or the config object is bound into (chased to a fixed point), any builtin
 * mutation API handed one of those targets, and the state flowing into any
 * call argument, member-call receiver, or spread — once the reference leaves
 * the declaration's textual reach, the table is unreadable and every
 * consumer fails closed. R12-1 completes the closure by treating the table
 * as ESCAPED unless every binding derived from it is provably through the
 * modeled channels: derivation keeps only direct identifier and pattern
 * bindings (keyed to the state-bearing keys of the config literal, so a
 * sibling like `plugins` binds nothing the table touches) and parameter or
 * binding-element defaults, and any other position a state read appears in —
 * a return, a yield, a concise-arrow body, a wrapped initializer, a member
 * or element assignment target, a property or class-property slot, a computed
 * pattern key — fails closed. The one stated exception: the config object
 * itself, returned or yielded as the identifier the declaration bound it to.
 * Round 13 adds the two positions that reading still keyed on spelling: a
 * for-of/for-in ITERATION over the state (`for await` included) fails
 * closed at the iterable — the loop variable binds entries the derivation
 * never models — and a Vite plugin `config()` hook, which Vite hands the
 * config object and whose return it merges, escapes the table when it
 * returns or mutates `resolve.alias` (or its shape is unreadable), while
 * readable hooks that provably contribute no alias state and opaque plugin
 * values like `svelte(...)` stay clean. Round 14 chases the readable plugin
 * spellings that scan declined — a shorthand `plugins` key, a `get
 * config()` accessor judged by what it returns, a spread into the plugin
 * object, a hook ASSIGNED onto the bound plugin object after its literal,
 * an instance of a locally declared class read as its `config` member —
 * fails closed on a list populated after its literal, and drops the
 * declaration-statement exemption from the binding-position readings, so an
 * INLINE hook body is judged by the same mutation/escape/binding-position
 * readings as a bound one.
 */
function readBuildAliases() {
	const aliases = [];
	const unresolved = [];
	for (const rootModule of GOVERNED_ROOT_MODULES) {
		let source;
		try {
			source = readFileSync(join(repoRoot, rootModule), 'utf8');
		} catch {
			continue; // a governed root module that does not exist aliases nothing
		}
		let parsed;
		try {
			parsed = parseResolveAliases(source, { file: rootModule });
		} catch (error) {
			unresolved.push(`${rootModule} could not be parsed: ${error.message}`);
			continue;
		}
		for (const snippet of parsed.unresolved) unresolved.push(`${rootModule}: ${snippet}`);
		for (const { find, replacement } of parsed.aliases) {
			let normalized;
			if (replacement.startsWith('./')) normalized = replacement.slice(2);
			else if (!replacement.startsWith('/')) normalized = replacement;
			else normalized = null; // absolute, outside the repository reading
			// R10-1: a replacement can itself carry `.`/`..` the runtime folds —
			// normalize it so consumers judge the base the runtime serves.
			aliases.push({
				find,
				replacement: normalized === null ? null : normalizeRepoPath(normalized),
			});
		}
	}
	return { aliases, unresolved };
}

/**
 * The `import.meta.glob('pattern')` arguments in script text — Vite expands
 * them into imports of every file the pattern matches, so a glob that reaches
 * outside the classified roots loads it exactly as a spelled import would.
 *
 * R8-3 (round-8 H-2): the bundler accepts a no-substitution template literal
 * and an ARRAY of patterns beside the plain string, and the round-7 reading
 * collected only `isStringLiteral` first arguments — both alternate spellings
 * of the same plant sailed through. Every pattern position is collected now,
 * and any argument or array element that is not a string or no-substitution
 * template literal lands in `unresolved`, which the universe check fails
 * closed on: an unreadable glob could enumerate any module.
 */
function importMetaGlobPatterns(source, { jsx = false } = {}) {
	const sourceFile = parseTypeScript(source, { jsx });
	const patterns = [];
	const unresolved = [];
	eachNode(sourceFile, (node) => {
		if (!(
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'glob' &&
			ts.isMetaProperty(node.expression.expression)
		))
			return;
		const argument = node.arguments[0];
		if (!argument) {
			unresolved.push('import.meta.glob()');
			return;
		}
		if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
			patterns.push(argument.text);
			return;
		}
		if (ts.isArrayLiteralExpression(argument)) {
			for (const element of argument.elements) {
				if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
					patterns.push(element.text);
				else unresolved.push(element.getText(sourceFile).slice(0, 60));
			}
			return;
		}
		unresolved.push(argument.getText(sourceFile).slice(0, 60));
	});
	return { patterns, unresolved };
}

/**
 * The `new URL('<literal>', import.meta.url)` targets in script text — Vite
 * bundles the referenced module (asset or worker) exactly as a spelled import
 * would, so a target that resolves into the executable universe joins the
 * closure.
 *
 * R10-7: the round-10 review proved worker/asset routes into excluded roots
 * dropped silently while Vite bundled both patterns. Literal targets — the
 * shape Vite rewrites — are collected and judged as routes.
 *
 * R11-3: a target that is not a literal is DROPPED, not failed closed, and
 * that asymmetry with the dynamic-import reading — which fails closed on its
 * unreadable positions — is deliberate: Vite's `new URL(…, import.meta.url)`
 * asset/worker handling is a build-time static rewrite that only ever fires
 * on a literal target, so a computed first argument is never rewritten and
 * never bundles a module — it stays the runtime's concern. A computed
 * `import(…)` is the opposite case — the runtime loader reaches it — which
 * is why that reading fails closed where this one can safely look away.
 */
function metaUrlLiterals(source, { jsx = false } = {}) {
	const sourceFile = parseTypeScript(source, { jsx });
	const literals = [];
	eachNode(sourceFile, (node) => {
		if (
			!ts.isNewExpression(node) ||
			!ts.isIdentifier(node.expression) ||
			node.expression.text !== 'URL'
		)
			return;
		const args = node.arguments ?? [];
		const target = args[0];
		const baseUrl = args[1];
		if (!target || !baseUrl) return;
		const isMetaUrl =
			ts.isMetaProperty(baseUrl) ||
			(ts.isPropertyAccessExpression(baseUrl) &&
				ts.isMetaProperty(baseUrl.expression) &&
				baseUrl.name.text === 'url');
		if (!isMetaUrl) return;
		if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target))
			literals.push(target.text);
	});
	return literals;
}

/** Compile a Vite-style glob pattern into a matcher over repository paths. */
function globToRegExp(pattern) {
	let expression = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				expression += '.*';
				index += 1;
				if (pattern[index + 1] === '/') index += 1;
			} else {
				expression += '[^/]*';
			}
		} else if (character === '?') {
			expression += '[^/]';
		} else if ('\\^$.|+()[]{}'.includes(character)) {
			expression += `\\${character}`;
		} else {
			expression += character;
		}
	}
	return new RegExp(`^${expression}$`, 'i');
}

/**
 * Check 9 — the EXECUTABLE SOURCE UNIVERSE (round-7 R7-2).
 *
 * Checks 2, 3, 7, and 8 classify and scan files beneath `src/` (plus the
 * owned `scripts/` tree). That left a universe hole: an executable module
 * OUTSIDE the classified roots — a `RootShim.svelte` at the repository root —
 * was walked by no check, and an owned file could import it with an
 * `@ts-ignore` and never be asked about it. The round-7 plant did exactly
 * that: a root-level Svelte module importing `PreviewBody`, reconstructing
 * the preview bytes, and rendering them, green through every audit.
 *
 * The universe is therefore derived from REACHABILITY rather than from the
 * `src/` walk: every executable module outside the owned and vendored roots
 * that an owned file or a build entry loads — by static import, dynamic
 * import, re-export, glob, relative alias, root-relative path, query-suffixed
 * specifier, case variant, or symlink — is a finding, and the walk follows
 * the chain, so a module reached only through another outsider is caught at
 * both hops. Framework, vendor, and generated trees stay governed by their
 * existing controls through the explicit exclusion roots; dependencies are
 * never scanned as owned source.
 *
 * ROUND 9 CLOSES THE DROP. As round 8 shipped, a resolved route base NO
 * CANDIDATE MATCHED was silent — and the round-9 review proved the silence
 * by routing every spelling into an excluded root: an alias to `build/`, to
 * `docs/`, to a planted `node_modules` package, a relative import into
 * `build/`, a glob over it. The walk never opens those roots, so no candidate
 * existed to match, and the route left no hit and no finding. The closure now
 * CLASSIFIES every missed base: a classified owned/vendored root, a governed
 * root module, a non-executable path, or a route into a `node_modules`
 * package `package.json` declares and installs stays clean — the last as
 * POLICY over the declared dependency graph SEC-3 screens, not as a byte
 * proof over what an install contains; a route into any other excluded root,
 * escaping the repository, or answered for by nothing is a finding, for
 * aliases, spelled routes, aliased and plain globs, and dynamic imports
 * alike. The alias reading itself fails closed where the runtime can override
 * the declaration (R9-2): an entry property the model does not consume
 * (`customResolver`'s return IS the resolution), a second `resolve.alias`
 * declaration in one config, and a duplicate find in one table are all
 * unreadable.
 *
 * ROUND 10 CLOSES THE SHAPES THE ROUND-10 REVIEW PLANTED against that state.
 * R10-1: every resolved route base is NORMALIZED — `.`/`..` folded exactly as
 * the runtime folds them — before candidate matching and classification, in
 * every spelling, because the round-9 reading folded only the relative ones
 * and a `$lib/x/../../build/y.js`, a `/src/x/../../build/y.js`, or a
 * regex-alias path carrying `..` was classified by a prefix the runtime never
 * serves. R10-2: the alias table is consulted for EVERY specifier spelling —
 * the runtime's first-match-wins over the raw specifier is not limited to
 * bare ones — and an alias match redirecting a module the audit scans
 * somewhere else is a finding (the round-10 plant aliased
 * `$lib/review/PreviewBody.svelte` itself to a root shim that shipped).
 * R10-6: a write or mutation of `resolve.alias` after the literal —
 * `cfg.resolve.alias.push(…)`, a reassignment, a mutating method, a mutated
 * table-bound identifier — makes the table unreadable, because the runtime
 * resolves with the mutation while a sequential reader meets only the
 * declaration. R10-7: `new URL('<literal>', import.meta.url)` targets join
 * the closure as routes — Vite bundles the worker/asset spelling — and the
 * `node_modules` bullet above is stated as policy rather than proof.
 */
function checkExecutableSourceUniverse() {
	const problems = [];
	const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

	// --- the candidate set: executable source outside the classified roots ----
	const candidates = [];
	for (const file of walkUniverse('')) {
		const path = relative(repoRoot, file).split(sep).join('/');
		if (OWNED_SOURCE_DIRS.some((dir) => isUnder(path, dir))) continue;
		if (VENDORED_SOURCE_ROOTS.some((dir) => isUnder(path, dir))) continue;
		if (VENDORED_SOURCE_FILES.includes(path)) continue;
		if (GOVERNED_ROOT_MODULES.includes(path)) continue;
		candidates.push(path);
	}

	// Index candidates by their own path, case-insensitively, and by the real
	// path a symlink resolves to — both spellings reach the same bytes.
	const candidateIndex = new Map();
	for (const path of candidates) {
		candidateIndex.set(path.toLowerCase(), path);
		try {
			const real = relative(repoRoot, realpathSync(join(repoRoot, path)))
				.split(sep)
				.join('/');
			if (!candidateIndex.has(real.toLowerCase())) candidateIndex.set(real.toLowerCase(), path);
		} catch {
			// A candidate that disappeared between the walk and the read is a
			// reachability target no more; the walk itself is the evidence.
		}
	}
	const matchCandidate = (base) => {
		const lower = base.toLowerCase();
		for (const extension of UNIVERSE_RESOLVE_EXTENSIONS) {
			const hit = candidateIndex.get(`${lower}${extension}`.toLowerCase());
			if (hit) return hit;
		}
		for (const extension of UNIVERSE_RESOLVE_EXTENSIONS.slice(1)) {
			const hit = candidateIndex.get(`${lower}/index${extension}`.toLowerCase());
			if (hit) return hit;
		}
		return null;
	};

	// --- R9-1: classification of resolved routes -----------------------------
	// The round-8 closure recorded only the HITS of a resolved base and was
	// silent on everything else — and the round-9 review proved the silence:
	// each modeled route spelling into an excluded root (`build`, `docs`, a
	// planted `node_modules` package) resolved to a base no candidate could
	// match and dropped without a finding, because the walk never opens those
	// roots and therefore never lists what lives in them. A route the closure
	// cannot match to a candidate is therefore classified, and only the benign
	// set the classification proves stays clean — when in doubt, it is a
	// finding.
	const declaredPackages = (() => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		return new Set([
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		]);
	})();

	/**
	 * Classify a resolved route base no candidate matched. Null is the only
	 * benign verdict and it demands proof:
	 *
	 *   - the classified owned/vendored roots and the governed root modules
	 *     are scanned by checks 2, 3, 5, 7, and 8 — a route into them is a
	 *     route into the audit itself;
	 *   - a path whose final segment carries a non-executable extension is not
	 *     module code — the universe is executable source;
	 *   - a route INTO `node_modules` is clean only while `package.json`
	 *     declares the package and the package is installed. That is POLICY,
	 *     not a byte proof: the declared dependency graph is what SEC-3
	 *     screens and `pnpm install --frozen-lockfile` reconstructs, and this
	 *     scan does not verify the bytes inside an installed package — a
	 *     locally tampered `node_modules` sits outside its reach the same way
	 *     any local file write does (the probe suite's own plants live at
	 *     that trust level).
	 *
	 * Everything else fails closed: a route escaping the repository, a route
	 * into any other excluded root (the roots the walk never opens), an
	 * undeclared package path, and any base nothing answers for.
	 */
	const classifyMissedRoute = (base) => {
		if (base === '..' || base.startsWith('../')) return { kind: 'escape' };
		if (OWNED_SOURCE_DIRS.some((dir) => isUnder(base, dir))) return null;
		if (VENDORED_SOURCE_ROOTS.some((dir) => isUnder(base, dir))) return null;
		// Vendored loose files and governed root modules, with the same
		// extension resolution the toolchain applies — `$lib/types` routes to
		// the vendored `src/lib/types.ts` exactly as a spelled path would.
		for (const extension of UNIVERSE_RESOLVE_EXTENSIONS) {
			const withExt = `${base}${extension}`;
			if (VENDORED_SOURCE_FILES.includes(withExt)) return null;
			if (GOVERNED_ROOT_MODULES.includes(withExt)) return null;
		}
		const last = base.split('/').pop();
		const dot = last.lastIndexOf('.');
		if (dot > 0 && !EXECUTABLE_SOURCE.test(last)) return null;
		// A route INTO `node_modules` is clean while `package.json` declares
		// the package and the package is installed. This is POLICY, not byte
		// proof: the declared dependency graph is what SEC-3 screens and
		// `pnpm install --frozen-lockfile` reconstructs, and this scan does
		// not verify the bytes inside an installed package — a locally
		// tampered `node_modules` is outside its reach the same way any local
		// file write is (the probe suite's own plants live at that trust
		// level).
		if (base === 'node_modules' || base.startsWith('node_modules/')) {
			const rest = base === 'node_modules' ? '' : base.slice('node_modules/'.length);
			const pkgRoot = rest.startsWith('@')
				? rest.split('/').slice(0, 2).join('/')
				: rest.split('/')[0];
			if (
				pkgRoot !== '' &&
				declaredPackages.has(pkgRoot) &&
				existsSync(join(repoRoot, 'node_modules', ...pkgRoot.split('/'), 'package.json'))
			)
				return null;
			return { kind: 'undeclared-package', pkg: pkgRoot === '' ? base : pkgRoot };
		}
		for (const excluded of UNIVERSE_EXCLUDED_ROOTS) {
			if (isUnder(base, excluded)) return { kind: 'excluded-root', root: excluded };
		}
		return { kind: 'unclassified' };
	};

	/**
	 * The static prefix of a glob base — everything before the first wildcard,
	 * cut at the last complete segment. Classification judges that prefix: a
	 * pattern whose static head sits inside an excluded root can enumerate
	 * executable source there whatever it matches today.
	 */
	const staticGlobPrefix = (base) => {
		const cut = base.search(/[*?{[]/);
		if (cut === -1) return base;
		const head = base.slice(0, cut);
		const slash = head.lastIndexOf('/');
		return slash === -1 ? '' : head.slice(0, slash);
	};

	const reportedRoute = new Set();
	const routeProblem = (loader, specifier, base, miss, how) => {
		const key = `${loader}\u0000${specifier}\u0000${base}`;
		if (reportedRoute.has(key)) return;
		reportedRoute.add(key);
		let reason;
		if (miss.kind === 'escape')
			reason = `the route resolves outside the repository root ("${base}"), and no static read can follow it`;
		else if (miss.kind === 'excluded-root')
			reason =
				`the route resolves into the excluded root "${miss.root}" ("${base}") — a root the universe ` +
				'walk never opens, so no static read can prove what the bundler loads there';
		else if (miss.kind === 'undeclared-package')
			reason =
				`the route resolves into the node_modules package "${miss.pkg}" ("${base}"), and no ` +
				'package.json declaration answers for it';
		else if (miss.kind === 'unplaced')
			reason =
				'no static read can place the pattern — not relative, not root-relative, and no resolve ' +
				'alias routes it' +
				(aliasUnresolvedEntries.length > 0
					? ', and an unreadable resolve.alias entry could capture it'
					: '');
		else
			reason = `the route resolves to "${base}", which no candidate, classified root, or declared package answers for`;
		problems.push(
			`${loader} ${how} "${specifier}" — ${reason}; executable application source must live under the classified owned/vendored roots`
		);
	};

	// R10-2: whether a normalized base names a module the audit scans SOMEWHERE
	// ELSE — an owned/vendored root, a vendored loose file, or a governed root
	// module. An alias match redirecting such a module anywhere else is the
	// round-10 hijack: the runtime loads the alias target while the gate scans
	// the spelled module.
	const isScannedBase = (base) => {
		if (OWNED_SOURCE_DIRS.some((dir) => isUnder(base, dir))) return true;
		if (VENDORED_SOURCE_ROOTS.some((dir) => isUnder(base, dir))) return true;
		for (const extension of UNIVERSE_RESOLVE_EXTENSIONS) {
			const withExt = `${base}${extension}`;
			if (VENDORED_SOURCE_FILES.includes(withExt)) return true;
			if (GOVERNED_ROOT_MODULES.includes(withExt)) return true;
		}
		return false;
	};

	// --- the build's alias table (R8-1) ----------------------------------------
	// The bundler's `resolve.alias` is a route spelling like any other: the
	// round-8 C-1 plant loaded a root-level shim through an owned file's
	// `import AliasShim from '@shim'` with only the alias table in
	// `vite.config.ts` naming the target. The table is parsed from the
	// governed root modules, alias-resolved specifiers join the closure like
	// spelled ones, and an entry the scan cannot read fails closed.
	const { aliases: buildAliasTable, unresolved: aliasUnresolvedEntries } = readBuildAliases();
	for (const entry of aliasUnresolvedEntries) {
		problems.push(
			`${entry} — a resolve.alias entry the scan cannot read could route any specifier to any module`
		);
	}
	for (const { find, replacement } of buildAliasTable) {
		if (replacement !== null) continue;
		const named = find instanceof RegExp ? find.toString() : `"${find}"`;
		problems.push(
			`the build config aliases ${named} to a target the scan cannot place inside the repository — ` +
				'an alias route no static read can follow fails closed'
		);
	}

	// --- the reachability closure ---------------------------------------------
	const queue = [];
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) queue.push(relative(repoRoot, file).split(sep).join('/'));
	}
	for (const rootModule of GOVERNED_ROOT_MODULES) {
		try {
			statSync(join(repoRoot, rootModule));
			queue.push(rootModule);
		} catch {
			// A governed root module that does not exist loads nothing.
		}
	}
	const visited = new Set();
	const reported = new Set();
	const reportedBare = new Set();
	while (queue.length > 0) {
		const current = queue.shift();
		if (visited.has(current)) continue;
		visited.add(current);
		let source;
		try {
			source = readFileSync(join(repoRoot, current), 'utf8');
		} catch {
			continue;
		}
		const jsx = /\.(tsx|jsx)$/i.test(current);
		let specifiers;
		let globbed;
		let urlLiterals;
		try {
			if (current.toLowerCase().endsWith('.svelte')) {
				const script = liveScript(current, source);
				specifiers = moduleSpecifiers(script);
				globbed = importMetaGlobPatterns(script);
				urlLiterals = metaUrlLiterals(script);
			} else {
				specifiers = moduleSpecifiers(source, { jsx });
				globbed = importMetaGlobPatterns(source, { jsx });
				urlLiterals = metaUrlLiterals(source, { jsx });
			}
		} catch (error) {
			problems.push(
				`${current} could not be read for the executable-source universe scan: ${error.message}`
			);
			continue;
		}
		const record = (target, how) => {
			if (reported.has(target)) return;
			reported.add(target);
			problems.push(
				`${target} is executable source outside the classified owned/vendored roots — ` +
					`${current} ${how}, and application source must live under the classified roots`
			);
			queue.push(target); // the chain continues: an outsider can load an outsider
		};
		for (const specifier of specifiers) {
			const cleaned = modulePath(specifier);
			// R10-2: the runtime's alias matching runs on EVERY raw specifier —
			// first match wins — not only bare ones, so the closure consults the
			// table first for every spelling. An alias match that redirects a
			// module the audit scans somewhere else is a finding in itself: the
			// runtime loads the alias target while the gate scans the spelled
			// module (the round-10 plant aliased `$lib/review/PreviewBody.svelte`
			// to a root shim).
			const aliased = resolveAliasedSpecifier(cleaned, buildAliasTable);
			const plain = resolveUniverseSpecifier(cleaned, current);
			if (aliased !== null) {
				if (aliased.kind === 'path') {
					if (plain !== null && aliased.path !== plain && isScannedBase(plain)) {
						const key = `${current}\u0000${cleaned}\u0000redirect`;
						if (!reportedBare.has(key)) {
							reportedBare.add(key);
							problems.push(
								`${current} loads "${specifier}" through a resolve alias redirecting the scanned module "${plain}" to "${aliased.path}" — ` +
									'the runtime loads the alias target while the scan judges the spelled module'
							);
						}
					}
					const hit = matchCandidate(aliased.path);
					if (hit) record(hit, `loads it through a resolve alias ("${specifier}")`);
					else {
						// R9-1: an alias-resolved base no candidate matches is a
						// route the walk must classify — a target inside an
						// excluded root dropped silently at round 8.
						const miss = classifyMissedRoute(aliased.path);
						if (miss)
							routeProblem(
								current,
								specifier,
								aliased.path,
								miss,
								'routes through a resolve alias'
							);
					}
				} else {
					const key = `${current}\u0000${cleaned}`;
					if (!reportedBare.has(key)) {
						reportedBare.add(key);
						problems.push(
							`${current} loads "${specifier}" through a resolve alias the scan cannot follow — ` +
								'an alias route no static read can prove fails closed'
						);
					}
				}
				continue;
			}
			if (plain === null) {
				// BARE SPECIFIER no alias claims (R8-1). An unreadable alias
				// entry could capture it; a specifier no installed package
				// answers for is a route no static read can prove — both fail
				// closed.
				if (aliasUnresolvedEntries.length > 0) {
					const key = `${current}\u0000${cleaned}`;
					if (!reportedBare.has(key)) {
						reportedBare.add(key);
						problems.push(
							`${current} loads "${specifier}" — an unreadable resolve.alias entry could capture the specifier, ` +
								'so no static read can prove it stays out of the executable universe'
						);
					}
					continue;
				}
				if (!bareSpecifierPackage(cleaned)) {
					const key = `${current}\u0000${cleaned}`;
					if (!reportedBare.has(key)) {
						reportedBare.add(key);
						problems.push(
							`${current} loads "${specifier}" — the specifier matches no resolve alias and no installed package, ` +
								'so no static read can prove it stays out of the executable universe'
						);
					}
				}
				continue;
			}
			const hit = matchCandidate(plain);
			if (hit) record(hit, `loads it ("${specifier}")`);
			else {
				// R9-1: a spelled route no candidate matches is classified —
				// bases inside excluded roots, escaping the repository, or
				// answered for by nothing fail closed instead of dropping.
				const miss = classifyMissedRoute(plain);
				if (miss) routeProblem(current, specifier, plain, miss, 'routes');
			}
		}
		for (const pattern of globbed.patterns) {
			// R10-2: alias consultation is first-match-wins over the raw pattern
			// exactly as over an import specifier.
			const aliasedPattern = resolveAliasedSpecifier(pattern, buildAliasTable);
			let base;
			if (aliasedPattern !== null) {
				if (aliasedPattern.kind !== 'path') {
					problems.push(
						`${current} globs "${pattern}" through a resolve alias the scan cannot follow — ` +
							'a glob route no static read can prove fails closed'
					);
					continue;
				}
				base = aliasedPattern.path;
			} else {
				base = resolveUniverseSpecifier(pattern, current);
				if (base === null) {
					// R9-1: a pattern spelled neither relative nor root-relative
					// and claimed by no alias — nothing the scan can place.
					routeProblem(current, pattern, '(unplaced)', { kind: 'unplaced' }, 'globs');
					continue;
				}
			}
			const matcher = globToRegExp(base);
			let matched = false;
			for (const path of candidates) {
				if (matcher.test(path)) {
					matched = true;
					record(path, `globs it ("${pattern}")`);
				}
			}
			if (!matched) {
				// R9-1: a glob matching no candidate is classified by its static
				// prefix — a pattern whose head sits in an excluded root can
				// enumerate executable source there, whatever matches today.
				const miss = classifyMissedRoute(staticGlobPrefix(base));
				if (miss) routeProblem(current, pattern, base, miss, 'globs');
			}
		}
		// R10-7: `new URL('<literal>', import.meta.url)` targets — Vite bundles
		// the pattern as an asset or worker exactly as a spelled import would,
		// and the round-10 review proved routes into excluded roots dropped
		// silently. Literal targets join the closure; a protocol URL is not a
		// repository route.
		for (const literal of urlLiterals) {
			const cleaned = modulePath(literal);
			const spec =
				cleaned.startsWith('/') || cleaned.startsWith('./') || cleaned.startsWith('../')
					? cleaned
					: /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned)
						? null
						: `./${cleaned}`;
			if (spec === null) continue;
			const base = resolveUniverseSpecifier(spec, current);
			// A bare `.`/`..` chain resolving to the repository ROOT is the
			// directory-anchor spelling (`fileURLToPath(new URL('.',
			// import.meta.url))`), not a route to a module.
			if (base === null || base === '') continue;
			const hit = matchCandidate(base);
			if (hit) record(hit, `loads it through new URL('${literal}', import.meta.url)`);
			else {
				const miss = classifyMissedRoute(base);
				if (miss)
					routeProblem(current, `new URL('${literal}', import.meta.url)`, base, miss, 'routes');
			}
		}
		for (const snippet of globbed.unresolved) {
			problems.push(
				`${current} calls import.meta.glob with an argument no static read can enumerate (${snippet}) — ` +
					'an unreadable glob could load any module'
			);
		}
	}

	return problems;
}

/**
 * Check 8 — the preview VALUE PATH, bound at the caller (round-2, widened
 * round-5).
 *
 * Check 6 binds the sink file; this check binds every `PreviewBody`
 * invocation in owned source. The round-2 attack planted a parent transform
 * — `const shown = $derived(preview.success ? { ...preview, html:
 * preview.html.replace(...) } : preview)` with `<PreviewBody
 * preview={shown} />` — and every check that only read PreviewBody.svelte
 * stayed green, because the value arriving at the sink was no longer lesser's
 * bytes. The scan lives in `./lib/source-scan.mjs` (the one copy of the
 * reading): every invocation must pass the preview value itself, verbatim,
 * and that value must be bound only from the `loadDraftPreview` result.
 *
 * ROUND 5 WIDENS THE WALK to every owned executable file, not only `.svelte`
 * components. A `.ts` module cannot instantiate PreviewBody, but it can
 * `import('$lib/review/PreviewBody.svelte')` — a dynamic route to the sink
 * module that the component-only walk never saw — so the non-Svelte files
 * are scanned for exactly that shape while the Svelte files run the full
 * invocation binding.
 *
 * ROUND 13 KEYS THE VALUE'S REACH, NOT THE SPELLING, in the two places the
 * round-12 reading still matched text. The prototype-install taint resolves
 * its callee and its target through the bindings a name receives, and a
 * SPREAD of a value-carrying array into call arguments holds the value at
 * the call gate — `f(...args)` over `const args = [preview]` hands the
 * reference exactly as `f(preview)` does, at any position the spread lands
 * it.
 *
 * ROUND 14 CLOSES THE SPELLINGS THE ROUND-13 MAP DECLINED: it recorded only
 * declarations-with-initializers, first-binding-wins and scope-blind, and
 * the callee/target readers chased nothing else, so eight plants installed
 * the getter over green. Now the map records EVERY binding of a name —
 * declarations and assignments, a shadow over a benign first binding
 * included; the callee reads the element-access (`Object['defineProperty']`)
 * and indirect comma (`(0, Object.defineProperty)`) spellings and resolves
 * the namespace of either through the same bindings; the target folds
 * computed `prototype` keys (`C[k]` over `const k = 'prototype'`); a
 * destructure reads its source through the same bindings and folds computed
 * binding keys (`const { ['defineProperty']: dp } = Object`); and
 * `Object.assign` taints the static side exactly as the prototype side.
 */
function checkPreviewValuePath() {
	const problems = [];
	// R6-1: the per-file scan cannot see a SECOND route built by forwarding the
	// PreviewBody COMPONENT and the preview VALUE through props into a wrapper
	// that invokes them via <svelte:component> — the wrapper never imports
	// PreviewBody, so its own file scans clean. The cross-file reading runs
	// over the owned Svelte modules (the same walk, the same "one copy"
	// parser-based scanner) and resolves the flow through the owned module
	// graph, failing closed on any route that is not statically the one
	// canonical direct invocation. R7-1 hands the same reading the FULL owned
	// executable module map — barrels and re-exports resolve through the
	// non-Svelte modules too — and the vendored declaration, so a CLI-managed
	// component stays benign while an owned module nobody can resolve to a
	// component fails closed instead.
	const ownedSvelteFiles = new Map();
	const ownedModuleSources = new Map();
	for (const dir of OWNED_SOURCE_DIRS) {
		for (const file of walkFiles(dir)) {
			const path = relative(repoRoot, file);
			const source = readFileSync(file, 'utf8');
			ownedModuleSources.set(path, source);
			try {
				if (path.toLowerCase().endsWith('.svelte')) {
					ownedSvelteFiles.set(path, source);
					problems.push(...previewInvocationFindings(path, source));
				} else {
					// A dynamic import of the sink module — the same parser reading
					// covers script and markup positions, so a `$lib` module reaching
					// PreviewBody without the canonical static import is a finding
					// wherever it hides.
					const script = liveScript(path, source);
					for (const specifier of moduleSpecifiers(script)) {
						if (/(?:^|\/)PreviewBody\.svelte$/.test(modulePath(specifier)))
							problems.push(
								`${path} loads the PreviewBody module dynamically (${specifier}) — the display ` +
									'route must be the canonical static import, never a dynamic one'
							);
					}
				}
			} catch (error) {
				problems.push(`${path} could not be scanned for PreviewBody invocations: ${error.message}`);
			}
		}
	}
	// R8-1: the cross-file reading gets the SAME alias table the universe
	// check reads — an import whose specifier only the bundler's alias table
	// resolves is classified by its alias target (owned, vendored, or
	// unproven when it escapes the classified roots), and a bare specifier no
	// alias claims is benign only while an installed package answers for it.
	const { aliases: resolveAliasTable, unresolved: resolveAliasUnresolved } = readBuildAliases();
	problems.push(
		...previewForwardingFindings(ownedSvelteFiles, {
			modules: ownedModuleSources,
			vendoredRoots: VENDORED_SOURCE_ROOTS,
			vendoredFiles: VENDORED_SOURCE_FILES,
			resolveAliases: resolveAliasTable,
			aliasUnresolved: resolveAliasUnresolved.length > 0,
			packageInstalled: bareSpecifierPackage,
		})
	);
	return problems;
}

function main() {
	const checks = [
		['dependencies', checkDependencies()],
		['owned-source imports', checkImports()],
		['owned-source {@html} sinks', checkHtmlSinks()],
		['vendored blog-face escape fallback', checkVendoredEscapeFallback()],
		['owned-source coverage', checkOwnedSourceCoverage()],
		['executable source universe', checkExecutableSourceUniverse()],
		['preview display sink binding', checkPreviewDisplaySink()],
		['alternate raw-HTML sinks', checkAlternateHtmlSinks()],
		['preview value path', checkPreviewValuePath()],
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

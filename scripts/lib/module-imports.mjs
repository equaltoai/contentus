/**
 * What a source file actually imports, read with the PARSERS THE TOOLCHAIN
 * ALREADY RUNS rather than with a pattern over its text.
 *
 * WHY IT LIVES IN `scripts/lib/` AND NOT IN `tests/helpers/`, where it was
 * written. The callers stopped being only probes. A GATE reads source the same
 * way they do — CON-5 (`gov-infra/verifiers/check-package-scripts.mjs`) walks the
 * executable closure of every guarded package.json script — and a verifier that
 * reaches into `tests/helpers/` for its reading has the dependency backwards:
 * `tests/` is code that gate JUDGES, and one of the closure members it hashes.
 * `scripts/lib/` is where this repository already keeps a reading a gate and a
 * probe share — `strip-comments.mjs` is read by
 * `scripts/audit-renderer-authority.mjs` and two probes, `agent-seams.mjs` by
 * `scripts/audit-seam-graph.mjs` and two more. The mirror placement,
 * `gov-infra/verifiers/`, was rejected for the mirror reason: the probes would
 * then read source through the governance genome, and the genome would carry a
 * dependency on `svelte` and `typescript` that belongs to this repository rather
 * than to the rubric.
 *
 * WHY A PARSER AND NOT A FIFTH PATTERN. Two probes assert the face-6 swap seams
 * — `tests/agents-mobile.test.mjs` for the whole face and
 * `tests/agents-roster.test.mjs` for the interim roster pieces — and this module
 * is what both of them read with. It has now been rewritten three times. Round 3
 * of this pull request's review compiled four legal files that took a cross-seam
 * dependency and returned nothing from a line-anchored regex; round 3's fix
 * dropped the anchors and stripped comments before matching; round 4's review
 * then compiled two more:
 *
 *   1. `import/* a comment *\/X from '<a component behind another seam>';`
 *      — legal ESM, because a comment separates two tokens exactly as a space
 *      does. Removing it CONCATENATES them, the stripped text reads `importX`,
 *      and `\bimport\b` no longer matches a statement the module system runs.
 *
 *   2. a markup comment carrying a fake `<script>` opener, which steered the
 *      block-extracting regex from inside the comment through the REAL closing
 *      tag — so the text handed to the import scan was the markup between them
 *      and never the script Svelte compiles.
 *
 * Both are the same defect as the first four, and so was every fix: a pattern
 * was asked a question about SYNTAX. A comment is exactly what sits where a
 * pattern expects whitespace, and `<script>` is a tag rather than a substring.
 * There is no sixth pattern worth writing, because the class is unbounded — the
 * next reviewer only has to find a seventh place a comment may legally sit.
 *
 * So nothing here matches text any more. A component's script is extracted by
 * the SVELTE COMPILER, which is the thing that decides what a `<script>` block
 * is, and imports are extracted from the TYPESCRIPT COMPILER's syntax tree,
 * which is the thing that decides what an import is. A fake opener inside a
 * comment is not a script block to a parser that has already tokenized the
 * comment; a comment between `import` and its binding is a trivia node between
 * two tokens rather than a hole in a regex. Comment placement stops being a
 * question this module answers, by construction, in every form and every
 * position — which is the whole point of the change.
 *
 * Both parsers are already in this repository's dependency tree and are already
 * what judges these same files: `svelte` compiles every component the build
 * emits, and `typescript` is what `pnpm run typecheck` and `svelte-check` run.
 * This module adds no dependency; it stops reimplementing two that are present.
 *
 * WHAT IS STILL NOT READABLE, said plainly, because a parser is not omniscience.
 * `import(someExpression)` names a module no static read can resolve, and so does
 * `require(someExpression)`. Both are a FINDING in every walked file, inside the
 * face and outside it — see `computedImports`. A module reached by something that
 * is not a load at all is outside any static reach and outside this module's
 * claim.
 *
 * WHICH LOADER, NOT JUST WHICH TEXT. Round 7's review took the specifier
 * `'./lib/helper'` out of a `require(…)` and pointed out that the reading had
 * thrown away the only thing that decides which FILE it names: CommonJS adds
 * `.js`, `.json` and `.node` and reads a directory's index, ES module resolution
 * adds nothing and reads no directory. A consumer handed only the text has to
 * invent an order, CON-5 invented one starting at `.mjs`, and the gate pinned a
 * file `require` cannot open while Node executed the unpinned `.js` beside it. So
 * `runtimeLoads` reports the loader with the specifier, and the resolution
 * belongs to whoever knows the loader's rules rather than to whoever is holding
 * the string.
 *
 * WHICH LOADERS EXIST AT ALL is the other half of the same round, and the reason
 * `unfollowableLoads` is a closed grammar rather than a list of two call shapes.
 * `const r = require`, `module.require(…)`, `eval("require('…')")`, `new
 * Function('require', …)(require)` and a `createRequire(…)` binding all load a
 * file at run time; a reader that knows only the `import` keyword and a bare
 * `require(…)` answered the same green for all five as for a file that loads
 * nothing. Anything that reaches the module loader or the evaluator is now
 * reported unless this module can follow it, and that function's header states
 * exactly where its reach stops.
 *
 * WHERE THAT GRAMMAR WAS STILL READING TWO DIFFERENT NAMES, which is round 8. A
 * grammar over names is closed only while both ends agree which name they watch,
 * and three ways of writing one down slipped between them.
 *
 *   1. `import { createRequire as cr } from 'node:module'` was ACCEPTED as the one
 *      modelled loader construction — `unfollowableLoads` asks which EXPORT the
 *      specifier names, and an alias does not change that — and then never carried,
 *      because `requireLike` asked whether a callee is spelled `createRequire`. A
 *      form this module accepts has to be a form it follows, so the factory's LOCAL
 *      name is what is tracked now; and its BASE argument is part of the model,
 *      because a loader built on someone else's directory resolves against that
 *      directory, and pinning against this file's would name a decoy — round 7's
 *      failure respelled.
 *
 *   2. `const { require: r } = module` reads exactly the property `module.require`
 *      reads, and the grammar reports that one. It did not report this one, because
 *      a binding element is neither a property access nor an element access, and the
 *      key inside it is — correctly — a name rather than a reference. Being a name
 *      was not the whole answer: in a DESTRUCTURING it is also a read.
 *
 *   3. `spawnSync(process.execPath, ['scripts/lib/helper.mjs'])` ran an editable
 *      repository file while this module's header said out loud that it was not
 *      looking. The argument was that a child's closure belongs to the child, which
 *      is true and was not an answer, because nobody was walking the child. The
 *      named execution facilities are in the grammar now, and a caller that needs
 *      one declares the repository paths it runs so CON-5 pins them. What stays
 *      stated rather than closed is the reflective class — a loader assembled out
 *      of `Reflect.get` and string pieces, which has no name to watch.
 *
 * WHERE A NAME LEFT THE FILE, AND WHERE A SECOND DOOR HAD THE SAME NAME, which is
 * round 9. Both halves are the round-8 defect again: a grammar over names is closed
 * only while it watches every place a watched name can be written.
 *
 *   1. `export { cr }` hands a tracked `createRequire` binding — or a tracked
 *      `spawnSync` — to every importer of the file, and the importer's own walk sees
 *      an ordinary local it has never heard of. The identifier was classified as a
 *      NAME, which is right for every other clause TypeScript builds with a `name`
 *      slot and wrong for this one: an export specifier's local is a reference, and
 *      it sits in `propertyName` the moment an alias is written. `exportedLocal`
 *      asks that question, and the class closes at the ORIGIN — the file that first
 *      obtained the binding — so a barrel, a rename and a chain of them need no
 *      rules of their own.
 *
 *   2. `process.getBuiltinModule('node:child_process')` returns the same module
 *      object the import form returns, and every import form of it was watched while
 *      this one was not. It is a property with a name, so it is watched now, and the
 *      residue it leaves is the one `process.binding` is in — measured, and stated
 *      where the residue is stated.
 *
 * WHAT A SITE IS WRITTEN TO RUN is the third half, and it is here rather than in
 * the caller because the answer is in the syntax. CON-5 lets an execution site
 * DECLARE the repository paths it runs, and nothing checked the declaration against
 * the site: a fixture bound a pinned file while `spawnSync` literally ran an
 * unpinned one. So every finding now carries the literals its call is written to
 * hand its facility, and the caller can hold a declaration to them.
 *
 * WHERE THOSE LITERALS ARE RESOLVED is round 10, and it is the round-7 lesson
 * arriving for the third time: A LOADER'S BASE IS PART OF ITS MODEL. A text is not
 * a file until something resolves it, `spawnSync(node, ['scripts/lib/helper.mjs'],
 * { cwd: 'sub' })` resolves it in `sub`, and the caller was resolving every literal
 * against the repository root — so the declaration bound a real, pinned, never-run
 * file at the root while the child rewrote `sub/scripts/lib/helper.mjs` freely. The
 * `cwd` an execution site WRITES is now reported beside its literals, in the frame
 * it is written in (`siteBase`), and a `cwd` this reading cannot read is reported as
 * unreadable rather than defaulted — because defaulting it is the guess that put a
 * pin on the decoy.
 *
 * AND WHOSE NAME DECIDES THAT BASE, which is round 12 and the fourth arrival of the
 * same lesson. `join(import.meta.dirname, 'ignored')` names a directory only where
 * `join` IS `node:path`'s, and this reading asked no such question: it read any
 * two-argument call or member spelled that way, so `['sub'].join(…)` — which returns
 * `sub` at run time — named a file-framed directory the call never composes, and a
 * declaration bound the pinned helper sitting in it while the child ran an unpinned
 * one somewhere else entirely. So a composer must be PROVEN: bound in this file from
 * `node:path` or `node:url`, and not bound anywhere else in it, which is what
 * `pathComposers` answers and `writtenPath` now requires. The loose reading stays
 * exactly where it belongs — `pathComposer` still recognises the SHAPE, so the words
 * inside a composition this walk cannot name land in the `unknown` frame rather than
 * in the child's.
 *
 * THE OTHER TWO HALVES OF ROUND 12 are the same defect in the environment channel.
 * A write into `INHERITED_EXECUTION` was read for two operators when JavaScript has
 * a dozen — `??=`, `||=` and `&&=` each loaded an unpinned preload into every child
 * with the gate green — and the target was looked for only at the top of the
 * assignment, so a destructuring wrote the same variable invisibly. Both are direct
 * writes to a channel this reading watches, and both are reported now. And an `env`
 * was read only inside object literals, so an options bag held in a NAME answered
 * the same green as a site that writes no environment — while `siteBase`, reading
 * the identical argument for a `cwd`, has always called it unknown. One shape may
 * not have two answers, and the permissive one may not be the unchecked one.
 *
 * WHERE THE READING IS WIDER THAN THE MODULE SYSTEM, and where it is not. A
 * type-only import and an `import('…')` in type position are not runtime edges.
 * `moduleSpecifiers` reports them, because swapping a component behind a seam
 * breaks a type that names it exactly as it breaks a value that names it, and for
 * a SEAM check they are dependencies. `runtimeSpecifiers` drops them, because
 * CON-5's subject is the code a guarded command executes and an erased
 * declaration opens no file. Those are the same walk asked two questions, not two
 * readings; everywhere else this module reports what the compilers see, no more
 * and no less.
 *
 * WHAT THIS READING IS NOT, AFTER ROUND 6. A parser closed the forms that had
 * been found and did not close the CLASS. Round 6 produced four more at once — a
 * `.jsx` helper and a `.tsx` helper, neither in the walked file set; a literal
 * `require` call in a `.cjs`, which is a call to a function rather than an import
 * node to any syntax tree; and `import.meta.glob`, which is a member call on
 * `import.meta` and not an import either. Each built a real dependency the client
 * build takes, and this reading returned nothing for all four. `require` is read
 * now — CON-5 resolves `.cjs` and needed it, and one reader means the probes
 * gained it in the same change — but that is one form falling, not the class:
 * the class is every way Vite can create a dependency, and no reader of source
 * enumerates it.
 *
 * So a second check exists and asks the question a different way.
 * `scripts/audit-seam-graph.mjs` runs the repository's own Vite configuration and
 * asserts the seam rules against the edges the BUILD resolves, which covers every
 * form by construction. It does not replace this module, and the reason is a
 * measurement rather than a preference: of the 1246 tracked source FILES the two
 * walks read, the build loads at least one module of 539 and never opens the
 * other 707 — 557 of them vendored greater source nothing imports, 150 more no
 * entry reaches. Those are counts of files, which is what this module's domain is
 * measured in; a file is not a module, and one file produces several
 * (`X.svelte`, `X.svelte?raw`, its compiled stylesheet), so the per-pass module
 * counts that gate prints measure something else. This reading covers every
 * tracked source file in one class of form; that gate covers every form on the
 * modules the build loads. A cross-seam import inside source nothing loads is
 * visible here and invisible there. Both run.
 */
import { parse } from 'svelte/compiler';
import ts from 'typescript';

/**
 * The script a file executes.
 *
 * For a component that is its `<script>` blocks, both of them — instance and
 * `module` — taken from the compiler's own parse rather than from a tag-shaped
 * regex. The compiler is what decides where a script begins and ends, which is
 * the entire content of the second bypass above: a `<script>` written inside a
 * markup comment is a comment, and no amount of care with a pattern makes that
 * distinction reliably, because the distinction is the parser's.
 *
 * A component with no script executes no import and yields the empty string.
 *
 * THE MARKUP IS PART OF THE SCRIPT, and round 5's version of this said it was
 * not. Markup holds no import DECLARATION — that much was true and is why the
 * old text-reading fallback had to go — but it holds import CALLS, and
 * `<button onclick={async () => (await import('…/CopyBlock.svelte')).default}>`
 * is a dependency the client build takes. Round 5's review compiled exactly that
 * and both seam checks stayed green, because this function returned two script
 * blocks and nothing else. So `markupImports` walks the rest of the component's
 * tree and appends every `import(…)` it finds, as source text, to be read by the
 * same TypeScript pass that reads the script blocks: one extraction, one set of
 * semantics, whichever region the call sits in.
 *
 * The server build DROPS event handlers, so `generate: 'server'` output is not a
 * witness for this class — the regression in `tests/agents-mobile.test.mjs`
 * compiles for the client, where the import is emitted.
 *
 * For anything else the file IS the script and is returned unchanged. Comments
 * are not stripped anywhere here — the TypeScript parser tokenizes them as
 * trivia, which is the correct handling and the one no stripper reproduced.
 *
 * A component the compiler cannot parse THROWS rather than scanning as empty.
 * Silence would be the fail-open answer — an unreadable file and a file with no
 * cross-seam import would return the same green — and a thrown error is a red
 * gate, which is the direction a seam check should fail in. Nothing in this
 * repository's tree trips it: all 1246 files the two walks touch parse.
 */
export function liveScript(file, source) {
	if (!/\.svelte$/i.test(file)) return source;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: file });
	} catch (error) {
		throw new Error(
			`${file}: the Svelte compiler cannot parse this component, so its imports cannot be read — ${error.message}`,
			{ cause: error }
		);
	}

	const scripts = [ast.module, ast.instance]
		.filter(Boolean)
		.map((block) => source.slice(block.content.start, block.content.end));

	return [...scripts, ...markupImports(ast, source, file)].join('\n');
}

/**
 * Every `import(…)` the component's markup runs, as source text ready to be read
 * as a statement.
 *
 * WHERE IT LOOKS. Everywhere in the component's tree except the two script
 * blocks — which the caller has already taken, and skipping them is what keeps a
 * script import from being counted twice. That covers an event handler, an
 * attribute, `{@const …}`, `{#await import(…)}`, `{#if}`, a snippet body and
 * every position a future Svelte release adds, because the walk is over the
 * tree's shape rather than over a list of the node types that may carry an
 * expression. Such a list is the enumeration this module exists to stop writing.
 *
 * WHAT IT LOOKS FOR is one node type, `ImportExpression`, which is what Svelte's
 * own expression parser emits for `import(…)`. A static `import … from` cannot
 * appear in markup at all — it is a declaration, and markup holds no
 * declarations — so a dynamic call is the whole class.
 *
 * The node's SOURCE TEXT is what comes back, not its parse: handing the text to
 * the TypeScript pass that reads the scripts is what makes a markup import and a
 * script import the same fact to every caller, including the fail-closed
 * treatment of `import(<something unreadable>)`. Nesting needs no special case
 * for the same reason — the outer call's text contains the inner one, and the
 * TypeScript walk finds both, so the walk here stops descending at the first.
 *
 * A node whose position the compiler will not report THROWS, for the reason
 * `liveScript` throws on a component it cannot parse: a dependency this cannot
 * quote is not a dependency it may drop.
 */
function markupImports(ast, source, file) {
	const scripts = new Set([ast.module, ast.instance].filter(Boolean));
	const calls = [];

	const visit = (node) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== 'object' || scripts.has(node)) return;

		if (node.type !== 'ImportExpression') {
			for (const key of Object.keys(node)) visit(node[key]);
			return;
		}
		if (typeof node.start !== 'number' || typeof node.end !== 'number')
			throw new Error(
				`${file}: the Svelte compiler no longer reports where a markup import() sits, so its ` +
					'target cannot be read; this scan cannot see markup dependencies until that is re-bound'
			);
		calls.push(`${source.slice(node.start, node.end)};`);
	};

	visit(ast);
	return calls;
}

/**
 * A specifier with its Vite query and fragment removed — the PATH it addresses.
 *
 * Round 5 of this pull request's review compiled `$lib/agents/CopyBlock.svelte?raw`
 * past both seam checks, which matched with `endsWith('/CopyBlock.svelte')` and
 * were handed a string ending in `?raw`. The specifier is reported correctly by
 * `moduleSpecifiers` — this is what the callers must MATCH on.
 *
 * THE POSITION THIS TAKES, stated because it is a judgement rather than a
 * mechanic: `?raw`, `?url`, `?inline` and every other query COUNT as crossing the
 * seam. The bundler resolves the same path, reads the same file, and rebuilds
 * when it changes; what the query alters is what the importer RECEIVES — text, a
 * URL, a component — not which file the swap would replace, and the file is the
 * only thing a seam check is about. Reading a component's source as text is a
 * stranger dependency on it than importing it, not a weaker one.
 *
 * The callers match on this and report the specifier AS WRITTEN, so an offender
 * line names what is in the file rather than a normalised form of it.
 */
export function modulePath(specifier) {
	return specifier.replace(/[?#][\s\S]*$/, '');
}

/**
 * The script parsed as TypeScript, which is a superset of every dialect this
 * repository writes — `.ts` modules, `.mjs` probes, and `lang="ts"` or plain
 * `<script>` component bodies alike.
 *
 * A source with parse errors THROWS, for the reason `liveScript` throws: a tree
 * the parser recovered from by guessing is a tree that can silently omit a
 * statement, and a gate must not read a broken file as a clean one. The check
 * asserts the diagnostic array EXISTS as well as being empty, so a TypeScript
 * release that moves this property turns the gate red instead of quietly
 * removing the check.
 */
function parsed(source) {
	const file = ts.createSourceFile(
		'probe.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	if (!Array.isArray(file.parseDiagnostics))
		throw new Error(
			'the TypeScript parser no longer reports parse diagnostics under `parseDiagnostics`; ' +
				'this scan cannot tell a clean parse from a recovered one until that is re-bound'
		);
	if (file.parseDiagnostics.length)
		throw new Error(
			`this source does not parse as TypeScript, so its imports cannot be read — ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, ' ')}`
		);
	return file;
}

/** Depth-first over every node, which is where an import may legally appear. */
function eachNode(node, visit) {
	visit(node);
	ts.forEachChild(node, (child) => eachNode(child, visit));
}

/**
 * The identifier and statically named element-access tokens in executable
 * TypeScript source.
 *
 * This is deliberately a syntax-tree reading, not source text with comments
 * removed. A string containing `<!--` cannot erase the live nodes before a
 * later string containing `-->`, and names written only in comments never
 * become nodes. Callers that start with a Svelte component should hand this
 * function the compiler's client JavaScript so expressions in markup event
 * handlers are included as well as the component's script blocks.
 *
 * Static element-access names are included so `storage['setItem']()` is the
 * same structural name as `storage.setItem()`. The result is unique in source
 * order; the caller decides which names matter to its claim.
 */
export function sourceIdentifiers(source) {
	const identifiers = [];
	const seen = new Set();
	const add = (name) => {
		if (seen.has(name)) return;
		seen.add(name);
		identifiers.push(name);
	};

	eachNode(parsed(source), (node) => {
		if (ts.isIdentifier(node)) add(node.text);
		else if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			ts.isElementAccessExpression(node.parent) &&
			node.parent.argumentExpression === node
		)
			add(node.text);
	});

	return identifiers;
}

/** The text of a specifier a static read can name, or null when it cannot. */
function staticSpecifier(node) {
	if (!node) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return null;
}

/**
 * `import(…)` as a CALL, which is a question only the tree can answer.
 *
 * The text `import(` also spells a class member NAMED `import` — vendored
 * greater-components has one in `primitives/stores/preferences` — and the
 * previous scan needed a hand-written rule to tell a parameter list from an
 * argument so it would not report source this repository may not edit. The rule
 * is gone: a method declaration is a `MethodDeclaration`, an import call is a
 * `CallExpression` whose callee is the `import` KEYWORD, and no exclusion list
 * has to be maintained to keep them apart. `import.meta` is a third node again.
 */
const isImportCall = (node) =>
	ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;

/* -------------------------------------------------------------------------
 * The names the loader grammar watches.
 *
 * THEY SIT ABOVE BOTH READERS because both read them. `unfollowableLoads` uses
 * them to decide what it cannot follow, and `requireLike` and `executionLike` use
 * them to decide which LOCAL name a modelled import was bound to — which is the
 * half round 8 found missing, and the reason the two halves have to be looking at
 * one list rather than at two copies of it.
 * ---------------------------------------------------------------------- */

/**
 * Names that hand out a loader, an evaluator, or the module object holding them,
 * when they appear as a PROPERTY.
 *
 * `getBuiltinModule` is the round-9 addition and the widest of them:
 * `process.getBuiltinModule('node:child_process')` returns the same module object
 * the import form does, and codex's fixture spawned and rewrote a helper straight
 * through it with this control green. The import form of every module in this
 * grammar is watched — `node:module`, `node:vm`, `node:child_process`,
 * `node:worker_threads` — and a second, equally named way of asking for exactly
 * those modules cannot be the one that is not. Which module it returns is not
 * modelled, for the reason the namespace import is not modelled: the local it
 * produces is an object whose members this reading would then have to track
 * through arbitrary access. So it is reported wherever it is reached, and the
 * caller discloses the site — the same repair `import cp from 'node:child_process'`
 * already has.
 */
const LOADER_PROPERTIES = new Set([
	'require',
	'createRequire',
	'getBuiltinModule',
	'eval',
	'constructor',
]);

/** Identifiers that turn text into running code. */
const EVALUATORS = new Set(['eval', 'Function']);

/** The global object, whose members this grammar insists are reached BY NAME. */
const REALMS = new Set(['globalThis', 'global']);

/** Modules that hand out a loader, and the one export of them this reading models. */
const LOADER_MODULES = new Set(['module', 'node:module']);
const MODELLED_LOADER_EXPORTS = new Set(['createRequire']);

/** Modules that evaluate text as code. */
const EVALUATOR_MODULES = new Set(['vm', 'node:vm']);

/**
 * Modules that start code running where this walk does not follow it, and the
 * exports of them this reading can NAME at each of their call sites.
 *
 * WHY THEY ARE IN THE GRAMMAR AT ALL, when round 7's version of this module said
 * out loud that they were outside it. That header argued the reading is scoped to
 * code THIS process runs, so a probe that spawns `node` is ordinary and the child's
 * closure is the child's own. Round 8's review took that boundary and walked
 * straight through it: `spawnSync(process.execPath, ['scripts/lib/helper.mjs'])`
 * inside a gate file executes an editable repository helper, the content pin on the
 * parent binds nothing about the child, and CON-5 was green in both directions —
 * as written and with the helper rewritten wholesale. "The child's closure is the
 * child's" is true and is not an answer: nobody was walking the child.
 *
 * The residue this module still states is the one codex's ruling left standing —
 * a loader or an evaluator ASSEMBLED without ever writing a name, out of
 * `Reflect.get` and string pieces. That class is genuinely unbounded. This one is
 * not: it is four facilities with names, and a reader that watches names can watch
 * these. So it does, and the caller declares the sites it needs — with the paths
 * they run, where those are repository files.
 */
const EXECUTION_MODULES = new Set([
	'child_process',
	'node:child_process',
	'worker_threads',
	'node:worker_threads',
]);
const MODELLED_EXECUTION_EXPORTS = new Set([
	'spawn',
	'spawnSync',
	'exec',
	'execSync',
	'execFile',
	'execFileSync',
	'fork',
	'Worker',
]);

/** Properties and globals that run code this module system never loaded. */
const EXECUTION_PROPERTIES = new Set(['dlopen']);
const EXECUTION_GLOBALS = new Set(['WebAssembly']);

/**
 * Environment variables whose VALUE names code a child loads before it reaches its
 * own entry point, and which every child of this process inherits by default.
 *
 * WHY A WRITE TO ONE IS A LOAD, which is round 11's fourth finding. This grammar
 * watched what a call HANDS a facility and nothing else, so
 * `process.env.NODE_OPTIONS = '--require=./scripts/lib/helper.cjs'` on one line and
 * `spawnSync(process.execPath, ['-e', ''])` on the next executed a repository
 * helper with no literal anywhere near the spawn — the site had nothing to bind,
 * and CON-5 was green with the helper rewritten wholesale. The channel is not
 * ambient: the variable has a name, this repository writes it, and a reading that
 * watches names can watch this one, which is the argument round 8 used to put
 * `spawn` in the grammar at all.
 *
 * WHAT IS NOT HERE is the environment this process INHERITS. What a developer or a
 * CI runner exports is not something this repository writes, and a gate that
 * reported it would be reporting the world rather than the tree. The boundary is
 * the write, because the write is the part that lives in a file a hash binds.
 *
 * The set is exported because two readings need exactly this list and two copies
 * of one list is how the halves of a model drift apart — the defect round 8 found
 * between `unfollowableLoads` and `requireLike`. The caller reads the VALUE of one
 * of these as the flag list a child's interpreter parses; here they decide which
 * write is a load at all.
 */
export const INHERITED_EXECUTION = new Set([
	'NODE_OPTIONS',
	'NODE_REPL_EXTERNAL_MODULE',
	'NODE_PATH',
	'LD_PRELOAD',
	'DYLD_INSERT_LIBRARIES',
]);

const isLiteralKey = (node) =>
	Boolean(node) &&
	(ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node));

/**
 * `require('…')` as a CALL — CommonJS's import, in the one dialect that has one.
 *
 * IT IS HERE BECAUSE A GATE NEEDS IT. CON-5's closure resolves `.cjs` among its
 * module extensions and its previous raw-text scan matched `require(`, so a
 * reading that dropped the form would have closed one hole by opening another —
 * the shape this repository has now hit twice, most recently when a fix for a
 * false positive introduced a false negative beside it. The seam probes inherit
 * it, which is correct for them too: round 6 compiled a literal `require()` in a
 * `.cjs` past both of them, and the build-reading gate had to catch it alone.
 *
 * The callee must be the IDENTIFIER `require` or one BOUND FROM `createRequire`
 * — see `requireLike` — so `module.require(x)` and a method named `require` are
 * not this node. Those are not silently dropped either; they are rejected by the
 * loader grammar below, which is the half of this that round 7 was missing. A
 * locally defined function called `require` is read as a require call, and that
 * over-inclusion is deliberate: a specifier it yields resolves to a real file or
 * is reported as unresolvable, and neither outcome is worse than trusting a name.
 */
const isRequireCall = (node, names) =>
	ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text);

/**
 * The names that hold a CommonJS loader in this file: `require` itself, and every
 * identifier a `createRequire(…)` call is bound to.
 *
 * WHY `createRequire` IS MODELLED RATHER THAN REJECTED. An ESM file that must
 * read a package's own resolution has no other spelling of it, and this
 * repository has one: `scripts/build-stylesheet.mjs` binds
 * `createRequire(import.meta.url)` and uses it only as `require_.resolve(…)` to
 * locate two vendored stylesheets. Rejecting the form outright would leave a real
 * gate file red with no repair but a disclosure, and a disclosure is what this
 * module asks for when nothing better exists — not when the shape can simply be
 * read. So a `const <name> = createRequire(…)` binding makes `<name>(…)` a
 * require call like any other: a literal argument is an edge the closure follows,
 * a computed one is a finding.
 *
 * ALIASING `require` ITSELF IS NOT MODELLED and is a finding, and the asymmetry
 * is a judgement about necessity rather than about difficulty. `const r =
 * require` adds nothing a file needs — `require` is already in scope wherever the
 * alias is legal — so the shape appears when someone is walking around a reader,
 * which is exactly codex's probe. `createRequire` appears when a file needs a
 * loader it cannot otherwise have.
 *
 * WHICH NAME `createRequire` IS, and the half round 8's review found missing. The
 * two ends of this model were reading two different names. `unfollowableLoads`
 * ACCEPTS `import { createRequire as cr } from 'node:module'` — it asks which
 * EXPORT a specifier names, and the alias does not change that — while this
 * function asked whether a callee is spelled `createRequire`, which `cr` is not.
 * So `cr(import.meta.url)('./lib/helper.cjs')` executed an unpinned file with the
 * gate green in both directions: the import was modelled and the binding it
 * produced was invisible. A model that ACCEPTS a form has to carry it, so the
 * factory names are collected from the import clause — the local name each
 * modelled export is bound to — and `createRequire` itself stays in the set for
 * the file that imports it plainly.
 *
 * THE ARGUMENT IS PART OF THE MODEL, for the reason round 7 established about
 * `require`: a loader resolves against a BASE, and a reading that ignores the base
 * pins a file the loader never opens. `createRequire('/elsewhere/x.js')` returns a
 * loader whose `('./lib/helper.mjs')` opens `/elsewhere/lib/helper.mjs`, while this
 * walk would resolve that specifier against the gate file's own directory and pin
 * a decoy — round 7's failure in a new spelling. Only a base that names THIS file
 * is modelled: `import.meta.url`, and `__filename` for the CommonJS dialect. Any
 * other base leaves the factory call unmodelled, which reports it.
 *
 * The set is file-wide rather than scope-aware, which over-includes: a `require`
 * shadowed inside one function marks calls elsewhere too. That direction reports
 * more edges and more findings, which is the direction this reading fails in.
 */
function requireLike(file) {
	const names = new Set(['require']);
	const factories = new Set(['createRequire']);
	const modelled = new Set();

	for (const local of importedLocals(file, LOADER_MODULES, MODELLED_LOADER_EXPORTS))
		factories.add(local);

	// Read only where a factory call is actually found, which is almost nowhere: the
	// seam probes run this walk over every tracked source file in the repository.
	let bound = null;
	const declarations = () => (bound ??= boundNames(file));

	eachNode(file, (node) => {
		if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
		const initializer = node.initializer;
		if (!initializer || !ts.isCallExpression(initializer)) return;
		if (!ts.isIdentifier(initializer.expression) || !factories.has(initializer.expression.text))
			return;
		if (!namesThisFile(initializer.arguments[0], declarations())) return;
		names.add(node.name.text);
		modelled.add(initializer.expression);
	});

	return { names, factories, modelled };
}

/**
 * The LOCAL names a file binds to the modelled exports of a set of modules —
 * `cr` for `import { createRequire as cr } from 'node:module'`, `execFileSync` for
 * the same import written plainly.
 *
 * Only a NAMED import binds a local this reading can follow. A default import, a
 * namespace import and a `require('node:module')` all hand out the module object
 * instead, and `unfollowableLoads` reports every one of them at the import, which
 * is why nothing here has to guess what came out of them.
 */
function importedLocals(file, modules, exports_) {
	const locals = new Set();
	eachNode(file, (node) => {
		if (!ts.isImportDeclaration(node)) return;
		const specifier = staticSpecifier(node.moduleSpecifier);
		if (specifier === null || !modules.has(specifier)) return;
		const bindings = node.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) return;
		for (const element of bindings.elements)
			if (exports_.has((element.propertyName ?? element.name).text)) locals.add(element.name.text);
	});
	return locals;
}

/** `import.meta.<name>`, which is how a module names its own location. */
const importMeta = (node, name) =>
	Boolean(node) &&
	ts.isPropertyAccessExpression(node) &&
	node.name.text === name &&
	ts.isMetaProperty(node.expression) &&
	node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/**
 * True where an identifier BINDS the name it is written as — a declaration this
 * file makes — rather than referring to a value or naming a property.
 *
 * ONE SHAPE TEST, for the reason `namesRatherThanReferences` gives: TypeScript puts
 * every declaration's own name in its parent's `name` slot, and so does every
 * member of an object, a class, an interface and an enum. The members are the ones
 * that bind nothing in scope — `{ join: 1 }` and `class C { join() {} }` declare a
 * property OF something — so they are subtracted and the rest is the class,
 * including the ones a list would have to be extended for.
 */
function bindsName(node) {
	const parent = node.parent;
	if (!parent || parent.name !== node) return false;
	return !(
		ts.isPropertyAccessExpression(parent) ||
		ts.isObjectLiteralElementLike(parent) ||
		ts.isClassElement(parent) ||
		ts.isTypeElement(parent) ||
		ts.isEnumMember(parent) ||
		ts.isExportSpecifier(parent)
	);
}

/**
 * Every name this file DECLARES, each with the declarations that declare it.
 *
 * WHY A MODEL OVER NAMES OWES ITSELF THIS, which is round 12's first finding. A
 * name this reading models is only that model's while nothing else in the file is
 * spelled the same way. `import { join } from 'node:path'` makes `join(a, b)` a
 * composition; `const join = (a, b) => a` two scopes down makes the identical text
 * something else entirely, and a reading that answers the first for the second
 * names a directory the call does not — which is the decoy this whole control
 * exists to refuse, arriving through a local rather than through a resolver.
 *
 * So a modelled name is dropped where the file binds it anywhere BUT at the
 * declaration the model came from: the count is what says so, since the modelled
 * import is itself one binding. Dropping it costs the site its frame and leaves the
 * words in it `unknown`, which is the direction this reading fails in.
 */
function boundNames(file) {
	const bound = new Map();
	eachNode(file, (node) => {
		if (!ts.isIdentifier(node) || !bindsName(node)) return;
		const declarations = bound.get(node.text) ?? [];
		declarations.push(node);
		bound.set(node.text, declarations);
	});
	return bound;
}

/**
 * `import.meta.url` or `__filename` — the two spellings of "the file this is
 * written in", and the only bases under which a loader built here resolves a
 * relative specifier the way this walk resolves it.
 *
 * `__filename` IS A NAME LIKE ANY OTHER, and a file that binds one of its own has
 * said the word means something else here. `import.meta.url` cannot be bound at
 * all — it is syntax rather than an identifier — which is why only one of the two
 * is asked about.
 */
function namesThisFile(node, bound) {
	if (!node) return false;
	if (ts.isIdentifier(node)) return node.text === '__filename' && !bound.has('__filename');
	return importMeta(node, 'url');
}

/**
 * Every module specifier a source references, in every form that reaches a file:
 * `import … from`, `export … from`, `export * from`, a side-effect `import '…'`,
 * `import x = require('…')`, a `require('…')` call, a dynamic `import('…')` with
 * a readable argument, and `import('…')` in type position.
 *
 * Pass a component's source through `liveScript` first. This function reads what
 * it is given, and what it is given must be script.
 */
export function moduleSpecifiers(source) {
	return [...new Set(collect(source, false).map((load) => load.specifier))];
}

/**
 * Every module specifier the module system LOADS — the same reading with the
 * type positions removed.
 *
 * ONE WALK, TWO PROJECTIONS, and the difference is which question the caller is
 * asking rather than which reading it trusts. The seam probes ask
 * `moduleSpecifiers`, because a swap behind a seam breaks a type that names a
 * component exactly as it breaks a value that names it, and a dependency is a
 * dependency to them. CON-5 asks this one, because its subject is the code a
 * guarded command EXECUTES: `import type … from './x'`, `export type … from
 * './x'`, `import type X = require('./x')` and `import('./x')` in type position
 * are erased before anything runs — Node's `--experimental-strip-types` deletes
 * them and `tsc` emits nothing for them — so pinning the file's content would
 * bind bytes no command opens.
 *
 * A type-only SPECIFIER inside a value import (`import { type A, B } from './x'`)
 * is not this: the declaration still loads the module, the clause is not
 * type-only, and it binds. Only a declaration the compiler erases WHOLE is
 * dropped here.
 */
export function runtimeSpecifiers(source) {
	return [...new Set(collect(source, true).map((load) => load.specifier))];
}

/**
 * The same runtime reading with the LOADER each specifier is handed to kept
 * beside it: `{ specifier, kind }`, where kind is `'esm'` or `'cjs'`.
 *
 * WHY THE KIND SURVIVES THE PROJECTION NOW. It used not to, and dropping it was
 * a hole rather than a simplification. The two loaders resolve the same text to
 * DIFFERENT FILES: CommonJS adds `.js`, `.json` and `.node` to an extensionless
 * specifier, in that order, and reads `<dir>/index.js` for a directory; ES module
 * resolution adds nothing and reads no directory at all — Node answers
 * `ERR_MODULE_NOT_FOUND` and `ERR_UNSUPPORTED_DIR_IMPORT`. A consumer handed only
 * the text has to invent an order, and CON-5's invented one began with `.mjs`. So
 * `require('./lib/helper')` with `helper.mjs` and `helper.js` both present pinned
 * the `.mjs` — a file `require` cannot even open — while Node executed the
 * unpinned `.js`, and rewriting that `.js` wholesale left the gate green. The
 * kind is not a nicety; it is which file runs.
 *
 * A static `import`, an `export … from` and a dynamic `import()` are `'esm'`. A
 * `require(…)` call — including one through a `createRequire` binding — and
 * `import x = require('…')`, which TypeScript emits as one, are `'cjs'`.
 */
export function runtimeLoads(source) {
	return collect(source, true);
}

/**
 * The shared walk. `runtimeOnly` drops the declarations that are erased before
 * execution; everything else about the reading is identical, which is the
 * property that keeps the exports from drifting into several readings.
 */
function collect(source, runtimeOnly) {
	const file = parsed(source);
	const { names } = requireLike(file);
	const loads = [];
	const seen = new Set();
	const add = (node, typeOnly, kind) => {
		if (runtimeOnly && typeOnly) return;
		const specifier = staticSpecifier(node);
		if (specifier === null) return;
		const key = `${kind} ${specifier}`;
		if (seen.has(key)) return;
		seen.add(key);
		loads.push({ specifier, kind });
	};

	eachNode(file, (node) => {
		if (ts.isImportDeclaration(node))
			add(node.moduleSpecifier, node.importClause?.isTypeOnly === true, 'esm');
		else if (ts.isExportDeclaration(node))
			add(node.moduleSpecifier, node.isTypeOnly === true, 'esm');
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			add(node.moduleReference.expression, node.isTypeOnly === true, 'cjs');
		else if (ts.isImportTypeNode(node) && node.argument && ts.isLiteralTypeNode(node.argument))
			add(node.argument.literal, true, 'esm');
		else if (isImportCall(node)) add(node.arguments[0], false, 'esm');
		else if (isRequireCall(node, names)) add(node.arguments[0], false, 'cjs');
	});

	return loads;
}

/**
 * The property key a DESTRUCTURING reads, or null where the node is not one.
 *
 * WHY THIS IS A SEPARATE QUESTION FROM `namesRatherThanReferences`, which is the
 * defect round 8's review demonstrated. That function is right that a property key
 * is a name rather than a reference — `{ require: r }` does not REFER to anything
 * called `require`. It is a read of the property `require` OFF THE OBJECT BEING
 * DESTRUCTURED, which is the same fact as `module.require` written with different
 * punctuation, and the grammar reports that one. So `const { require: r } =
 * module; r.call(module, './lib/helper.cjs')` executed an unpinned helper with the
 * gate green: a BindingElement is neither a property access nor an element access,
 * and the identifier inside it was correctly classified as a name and therefore
 * never asked about.
 *
 * The two shapes are the two ways a destructuring reads a key:
 *
 *   - a `BindingElement` inside an `ObjectBindingPattern` — `const { require: r }
 *     = m`, `const { require } = m`, and every nesting and default of them, since
 *     the walk reaches each element wherever it sits;
 *   - a `PropertyAssignment` inside an object literal that is an ASSIGNMENT
 *     TARGET — `({ require: r } = module)`, which parses as an object literal
 *     rather than as a pattern.
 *
 * An array binding element has no key to read and is not one of these; neither is
 * an object literal built as a VALUE, where `{ require: x }` hands out nothing and
 * the interesting half is `x`, which the identifier rules already read. A
 * `ShorthandPropertyAssignment` is deliberately absent: `({ require } = m)` is
 * already reported through `namesRatherThanReferences`, which excepts exactly that
 * shape, and reporting it twice would put two findings behind one disclosure key.
 */
function destructuredKey(node) {
	if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent))
		return node.propertyName ?? node.name;
	if (
		ts.isPropertyAssignment(node) &&
		ts.isObjectLiteralExpression(node.parent) &&
		isAssignmentTarget(node.parent)
	)
		return node.name;
	return null;
}

/**
 * True where an expression is being ASSIGNED TO rather than evaluated — the left
 * of an `=`, or the binding half of a `for … in`/`for … of` — through any nesting
 * of object and array literals, which is how a destructuring assignment is
 * written. Anything else terminates the walk, so this answers no by default.
 */
function isAssignmentTarget(node) {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (ts.isBinaryExpression(parent))
			return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child;
		if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
			return parent.initializer === child;
		if (
			!ts.isParenthesizedExpression(parent) &&
			!ts.isObjectLiteralExpression(parent) &&
			!ts.isArrayLiteralExpression(parent) &&
			!ts.isPropertyAssignment(parent) &&
			!ts.isShorthandPropertyAssignment(parent) &&
			!ts.isSpreadAssignment(parent) &&
			!ts.isSpreadElement(parent)
		)
			return false;
	}
	return false;
}

/**
 * The text a key names, or null where it is computed from something this reading
 * cannot evaluate — which is the same answer `isLiteralKey` gives an element
 * access, for the same reason.
 */
function keyText(node) {
	if (ts.isComputedPropertyName(node)) return keyText(node.expression);
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
	return isLiteralKey(node) ? node.text : null;
}

/**
 * The LOCAL binding an `export { … }` clause hands out, or null where the node is
 * not one — the third place a tracked name is read without being referred to, and
 * the defect round 9's review demonstrated.
 *
 * WHY A RE-EXPORT IS A READ. `export { cr }` in a file that binds `cr` from
 * `createRequire` hands that loader to every importer of the file. It is the same
 * fact as `const alias = cr` — a tracked binding leaving this file for somewhere
 * this reading does not go — and the grammar reports that one. It did not report
 * this one, because an `ExportSpecifier` puts its local in the `name` slot, which
 * `namesRatherThanReferences` correctly classifies as a name for every OTHER
 * clause TypeScript builds that way. So `export { cr }` beside `import { cr } from
 * './lib/loader.mjs'; cr(import.meta.url)('./lib/helper.cjs')` in the importer ran
 * an unpinned helper with the gate green in both directions, and the same hole
 * carried `spawnSync` out of a file that had imported it legally.
 *
 * WHERE THE LOCAL SITS, which is the opposite of where an IMPORT puts it. For
 * `export { cr as makeLoader }` TypeScript records `propertyName: cr` — the local
 * binding, a genuine reference — and `name: makeLoader`, which is the name the
 * module hands out and refers to nothing. `import { a as b }` is the mirror: `a`
 * is the exported name of another module and `b` is a declaration. So this reads
 * `propertyName ?? name`, and only that one of the two.
 *
 * A CLAUSE WITH A MODULE SPECIFIER IS NOT THIS. `export { createRequire } from
 * 'node:module'` binds nothing locally — it is a load, and `loaderModule` already
 * reports it against the specifier, as it does `export * from 'node:module'`. That
 * is what closes the class at its origin rather than at each hop: a file can only
 * hand out a watched binding it first obtained, and every way of obtaining one is
 * either tracked here or reported there. A barrel that re-exports the re-exporter
 * needs no rule of its own, because the file underneath it is already red.
 *
 * A TYPE-ONLY EXPORT IS NOT THIS EITHER, in either spelling: `export type { cr }`
 * and `export { type cr }` are erased before anything runs, and a binding no
 * loader receives is not a binding handed anywhere.
 */
function exportedLocal(node) {
	if (!ts.isExportSpecifier(node.parent)) return null;
	const specifier = node.parent;
	const declaration = specifier.parent.parent;
	if (!ts.isExportDeclaration(declaration) || declaration.moduleSpecifier) return null;
	if (specifier.isTypeOnly || declaration.isTypeOnly) return null;
	return specifier.propertyName ?? specifier.name;
}

/**
 * An identifier that NAMES something rather than referring to a value: every
 * declaration's own name, every `x.NAME`, every `{ NAME: local }` key, every
 * label. TypeScript puts all of them in the parent's `name`, `propertyName` or
 * `label` slot, so one shape test replaces the list of twenty node types the
 * first draft of this carried — and cannot fall behind a TypeScript release that
 * adds a twenty-first.
 *
 * A key is still a name here, and `destructuredKey` above is what asks the second
 * question a DESTRUCTURING key raises: whether that name is also a read.
 * `exportedLocal` asks the third, for the clause where the `name` slot holds a
 * local binding on its way out of the file.
 */
function namesRatherThanReferences(node) {
	const parent = node.parent;
	if (!parent) return true;
	// `{ require }` is the one shorthand where the NAME slot is also a reference.
	if (ts.isShorthandPropertyAssignment(parent)) return false;
	// `export { cr }` and `export { cr as make }` REFER to a local binding, and it
	// is the propertyName wherever one is written and the name where none is.
	const exported = exportedLocal(node);
	if (exported !== null) return exported !== node;
	if (parent.name === node || parent.propertyName === node || parent.label === node) return true;
	return ts.isQualifiedName(parent) && parent.right === node;
}

/** True where the identifier sits inside a type, which no loader ever reads. */
function inTypePosition(node) {
	for (let parent = node.parent; parent; parent = parent.parent)
		if (ts.isTypeNode(parent)) return true;
	return false;
}

/**
 * The call a reported node HEADS, or null where it heads none — the call itself
 * for `import(x)` and `require(x)`, and the parent for the identifier or member in
 * `spawnSync(…)`, `new Worker(…)` and `process.dlopen(…)`.
 */
function headedCall(node) {
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node;
	const parent = node.parent;
	if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return null;
	return parent.expression === node ? parent : null;
}

/**
 * Every string a load or an execution site is WRITTEN to hand its facility, each
 * with the FRAME it is written in — which is the half that decides which file it
 * names.
 *
 * WHY THE CALLER NEEDS THEM, which is round 9's third finding. CON-5 lets a
 * disclosure NAME the repository paths its site executes, in `binds`, and admits
 * each of them to the closure to be pinned and walked. Nothing checked that the
 * paths named were the paths run: codex's fixture bound a pinned file while
 * `spawnSync(process.execPath, ['scripts/lib/decoy.mjs'])` literally executed a
 * different, unpinned one, and the control was green with the decoy rewritten
 * wholesale. A `binds` that names other files than the site's own text names is
 * the pin-a-decoy failure of round 7 moved into the declaration, and it reads as
 * coverage exactly as loudly.
 *
 * ANY DEPTH, because a path is written in more shapes than an argument slot.
 * `spawnSync(node, ['scripts/x.mjs'])` puts it in an array; `execFileSync(node,
 * [join(root, 'scripts/x.mjs')])` puts it inside another call; `new URL('../x.mjs',
 * import.meta.url)` puts it inside a constructor. All three are text at the site.
 * What this cannot see is a path that is not written here at all — a module-level
 * constant, an argv element, a name assembled from pieces — and the caller's rule
 * for that is stated where it is enforced: a `binds` is a claim about a target the
 * site names, and a target this reading cannot see is carried by the disclosure's
 * REASON rather than by a pin that cannot be checked against anything.
 *
 * WHY EACH ONE CARRIES ITS FRAME, which is round 11 and the second arrival of
 * round 10's lesson. The caller used to be handed a flat list of strings and it
 * resolved every one of them in BOTH frames it knows — the file's directory and
 * the child's working directory — so a word only one of them could name was
 * answered by the other. `const where = 'sub'; spawnSync(node, ['helper.mjs'], {
 * cwd: where })` reports an unreadable `cwd`, which is round 10 working exactly as
 * written; and the caller then resolved the raw child argument `'helper.mjs'`
 * against the GATE FILE's directory, found a real `scripts/helper.mjs` beside it,
 * and let a disclosure bind that pinned file while Node ran the unpinned
 * `sub/helper.mjs`. An unreadable base stopped being fail-closed because a second
 * base answered in its place. So provenance travels with the text: a word written
 * in the file's own frame — `new URL(…, import.meta.url)`, `join(__dirname, …)` —
 * is named by this file wherever its child runs, and a word handed to the child is
 * named by the child's working directory and by nothing else.
 *
 * THREE FRAMES, NOT TWO, for the same reason. `join(root, 'scripts/x.mjs')` with
 * `root` a name this reading cannot follow is written in a frame that HAS no value
 * here — neither the file's nor the child's — and answering either is the same
 * guess one level in. It comes back as `unknown`, which the caller reports.
 *
 * AND THE ROLE, which is round 11's second half. A string at a site is not one
 * kind of thing: argument 0 is the COMMAND — a command line where the facility
 * takes one, a file where it takes a file and a list — a value under `env` is an
 * ENVIRONMENT VARIABLE with a name that says what the child does with it, and
 * everything else is an argument or an option. The caller used to be told none of
 * that, so it had one rule for every string: treat each as a command line, and
 * treat each word that happens to name a directory as a base the others may be
 * resolved in. Both halves failed in both directions. `{ env: { PATH:
 * 'scripts/lib:/usr/bin' } }` is a LOOKUP PATH with two entries and the flat rule
 * saw no directory at all, so a bare command ran unpinned; `{ env: { LABEL_DIR:
 * 'scripts/lib', LABEL_FILE: 'helper.mjs' } }` beside `/usr/bin/true` names no
 * lookup path whatsoever and the same rule reported a repository file the child
 * never opens. A name is what tells those apart, and the name is here.
 *
 * The strings come back exactly as written, unresolved. Which directory a frame
 * stands for, and what a child does with a variable, is the caller's question —
 * the same division `runtimeLoads` draws for a specifier and its loader.
 */
function siteWords(node, composers) {
	const words = [];
	const seen = new Set();
	const add = (text, frame, role, key) => {
		const identity = JSON.stringify([role, key ?? null, frame, text]);
		if (seen.has(identity)) return;
		seen.add(identity);
		words.push({ text, frame, role, key: key ?? null });
	};
	const walk = (inner, role, key) => {
		// A path expression this reading CAN name is taken whole, in its own frame:
		// `new URL('./lib/x.mjs', import.meta.url)` is one word written in the file's
		// frame rather than a literal floating in the child's.
		const written = writtenPath(inner, composers);
		if (written) return add(written.path, written.from, role, key);
		// A path expression it cannot name puts every literal inside it in a frame
		// with no value, which is the fail-closed answer rather than a default.
		if (pathComposer(inner)) {
			eachNode(inner, (deeper) => {
				const text = staticSpecifier(deeper);
				if (text !== null) add(text, 'unknown', role, key);
			});
			return;
		}
		ts.forEachChild(inner, (child) => walk(child, role, key));
	};
	/** Every member of an object read as the environment variable it names. */
	const environment = (object) => {
		if (!ts.isObjectLiteralExpression(object)) return walk(object, 'env', null);
		for (const variable of object.properties) {
			const written = ts.isPropertyAssignment(variable) ? variable.initializer : variable;
			walk(written, 'env', optionKey(variable));
		}
	};

	// A write into this process's own environment is a site with one string in it:
	// the value, read as the variable it is written into — or no string at all,
	// where the write is one this reading cannot follow to a value (see
	// `assignedExecutionVariable`). Such a site is reported by `opensEnvironment`
	// whatever is declared for it, so it has nothing to hand a `binds`.
	const assigned = assignedExecutionVariable(node);
	if (assigned) {
		if (assigned.value) walk(assigned.value, 'env', assigned.name);
		return words;
	}

	const call = headedCall(node);
	if (!call?.arguments) return words;

	if (mutatesEnvironment(call)) {
		for (const argument of call.arguments.slice(1)) environment(argument);
		return words;
	}

	call.arguments.forEach((argument, index) => {
		if (index === 0) return walk(argument, 'command', null);
		if (!ts.isObjectLiteralExpression(argument)) return walk(argument, 'argument', null);
		for (const property of argument.properties) {
			const name = optionKey(property);
			const value = ts.isPropertyAssignment(property) ? property.initializer : null;
			// The one option whose members are named things rather than a bag of
			// values: every key under `env` is a variable a child reads by that name.
			if (name === 'env' && value) {
				environment(value);
				continue;
			}
			walk(value ?? property, 'option', null);
		}
	});
	return words;
}

/**
 * True where argument 0 is the interpreter this process is already running, which
 * is the one spelling of "node" that is not a literal anywhere at the site.
 *
 * THE CALLER NEEDS IT to know whose flags it is reading. `-e`, `-p` and
 * `--eval` name inline code to node and name something else entirely to `mkdir`
 * or to `grep`, so a rule that refuses them everywhere is a rule about a spelling
 * rather than about what runs. `process.execPath` and `process.argv[0]` are the
 * two ways a site says "this node"; a command spelled as a literal answers the
 * same question in the caller, out of the word itself.
 */
/** `process.env`, in either spelling of the member. */
const isProcessEnv = (node) =>
	Boolean(node) &&
	((ts.isPropertyAccessExpression(node) && node.name.text === 'env') ||
		(ts.isElementAccessExpression(node) &&
			isLiteralKey(node.argumentExpression) &&
			node.argumentExpression.text === 'env')) &&
	ts.isIdentifier(node.expression) &&
	node.expression.text === 'process';

/**
 * The write this node makes into the environment every child of this process
 * inherits, as `{ name, value }` — or null where it makes none.
 *
 * `name` is the variable for a write to one of `INHERITED_EXECUTION`, and null for
 * a write that replaces the whole environment, which this reading cannot
 * enumerate. `value` is the expression written, which is where the caller finds
 * the repository paths the variable names.
 *
 * A WRITE TO AN UNWATCHED VARIABLE IS NOT THIS. `process.env.CI = '1'` starts no
 * code, and reporting it would be a finding with no repair at an ordinary site —
 * which is how a list of disclosures stops being read. The line is the same one
 * `process.binding` sits on: a rule about a NAME costs whatever else in the tree is
 * spelled that way, and these five names are spelled nowhere else in it.
 *
 * EVERY OPERATOR THAT WRITES, which is round 12's fourth finding. This read two of
 * them — `=` and `+=` — and `??=`, `||=` and `&&=` are the same write with a
 * condition in front of it. Each ran an unpinned preload with the gate green, and
 * each is a direct write to the channel this function exists to watch. The set is
 * TypeScript's own assignment-operator range now rather than a list of two: a
 * spelling this reading has not thought of is a write it still reports, which is
 * the direction a rule about a channel has to fail in.
 *
 * A DESTRUCTURING IS THE SAME WRITE with the target moved inside a pattern —
 * `[process.env.NODE_OPTIONS] = flags`, `({ x: process.env.NODE_OPTIONS } = bag)` —
 * and the top of the assignment is then an array or object literal that names no
 * variable at all. So the target is looked for where it sits, and what it receives
 * is reported as UNREADABLE rather than guessed: which element of a pattern lands
 * in which target is a question about a value at run time, and answering it is the
 * flow-tracking this reading does not do. `opensEnvironment` turns that into a
 * finding the site cannot declare its way out of, which is the fail-closed answer
 * the review authorised for exactly this shape.
 */
function executionVariableTarget(node) {
	if (isProcessEnv(node)) return { name: null };
	const named = ts.isPropertyAccessExpression(node)
		? node.name.text
		: ts.isElementAccessExpression(node) && isLiteralKey(node.argumentExpression)
			? node.argumentExpression.text
			: null;
	if (named === null || !isProcessEnv(node.expression)) return null;
	return INHERITED_EXECUTION.has(named) ? { name: named } : null;
}

function assignedExecutionVariable(node) {
	if (ts.isBinaryExpression(node)) {
		if (!ts.isAssignmentExpression(node)) return null;
		const written = executionVariableTarget(node.left);
		return written ? { ...written, value: node.right } : null;
	}
	// The same write with its target inside a pattern. The direct left of an
	// assignment is excluded because the branch above has already reported it, and
	// reporting one write twice puts two findings behind one disclosure key.
	const written = executionVariableTarget(node);
	if (!written || !node.parent || ts.isBinaryExpression(node.parent)) return null;
	return isAssignmentTarget(node) ? { ...written, value: null } : null;
}

/**
 * True where a call MUTATES this process's environment through the object rather
 * than through a member of it — `Object.assign(process.env, …)` and the
 * `defineProperty` family. What it writes is not enumerated: an argument this
 * reading can open may still carry a computed key, so the site is reported and its
 * strings are read, and the disclosure's reason carries the rest.
 */
function mutatesEnvironment(node) {
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
	if (!['assign', 'defineProperty', 'defineProperties'].includes(node.expression.name.text))
		return false;
	return isProcessEnv(node.arguments[0]);
}

/**
 * Whether every execution variable a site writes for its child is one this reading
 * can name AND read.
 *
 * WHY THE QUESTION EXISTS AT ALL. Reporting the WRITE closes the channel only where
 * the write is legible. `spawnSync(node, args, { env: buildEnv() })` hands the child
 * an environment assembled somewhere else — which may carry a `NODE_OPTIONS` naming
 * a repository file — and every part of that is invisible here: the options bag is
 * readable, `cwd` is absent so the base is fine, and the site's literals contain no
 * path. Silence and permission are the same green, which is the property this whole
 * control exists to refuse, so an environment this reading cannot open is reported
 * rather than assumed empty. `{ env: { CI: 'true' } }` is fully open and says so.
 *
 * A KEY IS NOT ENOUGH FOR A WATCHED VARIABLE. `{ env: { NODE_OPTIONS: options } }`
 * names the channel and hides its value, which is exactly the case a `binds` cannot
 * be checked against. So a watched key whose value is not a readable string leaves
 * the environment unopened, while an unwatched key's value may be anything.
 *
 * A SITE THAT WRITES NO ENVIRONMENT is open by construction: the child inherits
 * this process's, which is the world rather than the tree, and the boundary this
 * grammar draws is at what the repository WRITES.
 *
 * AN ENVIRONMENT IS ONLY AS OPEN AS THE BAG IT ARRIVES IN, which is round 12's
 * fifth finding and the same defect one container out. This asked about `env`
 * inside object literals and walked past every other argument, so `const opts = {
 * env: { NODE_OPTIONS: '--import=./scripts/lib/preload.mjs' } }; spawn(child, [],
 * opts)` answered the same green as a site that writes no environment at all —
 * while `siteBase`, reading the identical argument for a `cwd`, has always called
 * it UNKNOWN. One shape, two answers, and the permissive one is the one nothing
 * checked. So the bag is held to the same test in both readings: an argument whose
 * shape cannot be options says nothing about the environment, and anything else
 * this reading cannot open leaves it unopened.
 */
function readableEnvironment(object) {
	if (!object || !ts.isObjectLiteralExpression(object)) return false;
	return object.properties.every((property) => {
		if (!ts.isPropertyAssignment(property)) return false;
		const key = optionKey(property);
		if (key === null) return false;
		return !INHERITED_EXECUTION.has(key) || staticSpecifier(property.initializer) !== null;
	});
}

function opensEnvironment(node) {
	const assigned = assignedExecutionVariable(node);
	if (assigned)
		return assigned.name === null
			? readableEnvironment(assigned.value)
			: staticSpecifier(assigned.value) !== null;
	const call = headedCall(node);
	if (!call?.arguments) return true;
	if (mutatesEnvironment(call)) return call.arguments.slice(1).every(readableEnvironment);
	for (const argument of call.arguments.slice(1)) {
		if (notAnOptionsBag(argument)) continue;
		if (!ts.isObjectLiteralExpression(argument)) return false;
		for (const property of argument.properties) {
			if (ts.isSpreadAssignment(property)) return false;
			const key = optionKey(property);
			if (key === null) return false;
			if (key !== 'env') continue;
			if (!ts.isPropertyAssignment(property)) return false;
			if (!readableEnvironment(property.initializer)) return false;
		}
	}
	return true;
}

function runsThisInterpreter(node) {
	const first = headedCall(node)?.arguments?.[0];
	if (!first) return false;
	if (ts.isPropertyAccessExpression(first))
		return (
			first.name.text === 'execPath' &&
			ts.isIdentifier(first.expression) &&
			first.expression.text === 'process'
		);
	if (ts.isElementAccessExpression(first))
		return (
			isLiteralKey(first.argumentExpression) &&
			first.argumentExpression.text === '0' &&
			ts.isPropertyAccessExpression(first.expression) &&
			first.expression.name.text === 'argv'
		);
	return false;
}

/**
 * The two answers a site can give about where its child resolves a relative
 * path, and the third that says it will not say.
 */
const PROCESS_BASE = Object.freeze({ from: 'process', path: '.' });
const UNKNOWN_BASE = Object.freeze({ from: 'unknown' });

/**
 * The modules that hand out a path composer, and the exports of each this reading
 * models. `node:path` builds a directory out of pieces; `node:url` turns the URL a
 * module knows itself by into one.
 *
 * The dialect sub-objects are the same module wearing a member's name: `path.posix`
 * and `path.win32` export the same two composers, and a reading that knew only the
 * bare namespace would answer `unknown` for a call that composes exactly as the
 * plain one does.
 */
const COMPOSER_MODULES = Object.freeze({
	path: new Set([
		'path',
		'node:path',
		'path/posix',
		'node:path/posix',
		'path/win32',
		'node:path/win32',
	]),
	url: new Set(['url', 'node:url']),
});
const MODELLED_COMPOSERS = Object.freeze({
	path: new Set(['join', 'resolve']),
	url: new Set(['fileURLToPath']),
});
const PATH_DIALECTS = new Set(['posix', 'win32']);

/** Which of the modules above a specifier names, or null for anything else. */
function composerModule(specifier) {
	if (specifier === null) return null;
	for (const [module_, specifiers] of Object.entries(COMPOSER_MODULES))
		if (specifiers.has(specifier)) return module_;
	return null;
}

/**
 * The names this file binds to the path composers above — `{ names, namespaces }`,
 * where `names` maps a local to the export it names and `namespaces` maps a local
 * to the module it holds — with `bound` beside them, so the reading below can ask
 * about `__dirname` and `__filename` the same way.
 *
 * WHY A CALLEE HAS TO BE PROVEN, which is round 12's first finding and the fourth
 * arrival of round 7's lesson: A LOADER'S BASE IS PART OF ITS MODEL, and here the
 * base IS the answer. `writtenPath` read any two-argument call or member spelled
 * `join` or `resolve` as `node:path`, and two things wear that name that are not it.
 * `['sub'].join(import.meta.dirname, 'ignored')` is `Array.prototype.join` — it
 * returns `sub` at run time, and the child ran `sub/helper.mjs` while this reading
 * named a file-framed `scripts/ignored`, bound the pinned `scripts/ignored/helper.mjs`
 * beside it and exited 0 with the real child rewritten wholesale. A locally declared
 * `join` does the same thing with a shorter fixture. Both are the decoy this control
 * exists to refuse, reached through a NAME rather than through a resolver.
 *
 * WHICH FORMS BIND ONE. A named import with or without an alias, a default or
 * namespace import, a `require('node:path')` held in a name, and the destructuring
 * of that require. What is deliberately NOT modelled is every form that hands the
 * module out through something this reading would then have to track — `import
 * path = require('node:path')`, a member reached off an object, a namespace passed
 * to a function — because an unproven composer is not a finding here: it is a frame
 * of `unknown`, which reports the words inside it and costs the site a `binds` it
 * can no longer check. Fail-closed is cheap, so the model may be small.
 */
function pathComposers(file) {
	const names = new Map();
	const namespaces = new Map();
	const declared = new Set();

	const bindNamespace = (name, module_) => {
		namespaces.set(name.text, module_);
		declared.add(name);
	};
	const bindExport = (local, exported, module_) => {
		if (exported === null || !MODELLED_COMPOSERS[module_].has(exported)) return;
		names.set(local.text, exported);
		declared.add(local);
	};

	eachNode(file, (node) => {
		if (ts.isImportDeclaration(node)) {
			const module_ = composerModule(staticSpecifier(node.moduleSpecifier));
			const clause = module_ && node.importClause;
			if (!clause) return;
			if (clause.name) bindNamespace(clause.name, module_);
			const bindings = clause.namedBindings;
			if (!bindings) return;
			if (ts.isNamespaceImport(bindings)) return bindNamespace(bindings.name, module_);
			for (const element of bindings.elements)
				if (ts.isIdentifier(element.name))
					bindExport(element.name, (element.propertyName ?? element.name).text, module_);
			return;
		}
		// `const path = require('node:path')`, which is how a CommonJS gate file spells
		// the same import — and its destructuring, which reads the same exports.
		if (!ts.isVariableDeclaration(node) || !node.initializer) return;
		const call = node.initializer;
		if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
		if (call.expression.text !== 'require') return;
		const module_ = composerModule(staticSpecifier(call.arguments[0]));
		if (!module_) return;
		if (ts.isIdentifier(node.name)) return bindNamespace(node.name, module_);
		if (!ts.isObjectBindingPattern(node.name)) return;
		for (const element of node.name.elements) {
			if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
			const key = element.propertyName ? keyText(element.propertyName) : element.name.text;
			bindExport(element.name, key, module_);
		}
	});

	// A name the file binds anywhere else is a name that means something else there,
	// and this reading has no scopes to tell where. The modelled import is itself one
	// binding, so a second one is the shadow.
	const bound = boundNames(file);
	for (const map of [names, namespaces])
		for (const name of [...map.keys()]) {
			const declarations = bound.get(name) ?? [];
			if (declarations.some((identifier) => !declared.has(identifier))) map.delete(name);
		}

	return { names, namespaces, bound };
}

/** The module a namespace expression holds, through the dialect members of it. */
function namespaceModule(expression, composers) {
	if (ts.isIdentifier(expression)) return composers.namespaces.get(expression.text) ?? null;
	if (!ts.isPropertyAccessExpression(expression) || !PATH_DIALECTS.has(expression.name.text))
		return null;
	return namespaceModule(expression.expression, composers) === 'path' ? 'path' : null;
}

/**
 * The composer a callee NAMES, proven to be an export of a module this file took
 * it from — or null, which is every other call in the tree.
 */
function composerCalled(callee, composers) {
	if (ts.isIdentifier(callee)) return composers.names.get(callee.text) ?? null;
	if (!ts.isPropertyAccessExpression(callee)) return null;
	const module_ = namespaceModule(callee.expression, composers);
	if (module_ === null) return null;
	const exported = callee.name.text;
	return MODELLED_COMPOSERS[module_].has(exported) ? exported : null;
}

/**
 * The path an expression NAMES, in the frame it is written in, or null where this
 * reading cannot name one.
 *
 * TWO FRAMES, because a path is written in two and the text does not say which.
 * `'sub'` is resolved by the process against its own working directory;
 * `new URL('..', import.meta.url)` and `join(__dirname, 'fixtures')` are resolved
 * against the FILE, and no working directory moves them. The caller knows both
 * and is told which one it is holding — the same division `runtimeLoads` draws
 * for a specifier and the loader that opens it.
 *
 * A DIRECTORY IS A PATH, which is why this answers for both. `siteBase` asks it
 * about a `cwd` and `siteWords` asks it about every word at the site; the syntax
 * that decides the frame is identical, and reading it twice is how the two halves
 * of one question drift apart.
 *
 * WHAT IS DELIBERATELY NOT FOLLOWED is a path held in a name. `const root =
 * …; spawnSync(node, [x], { cwd: root })` reads to this function as nothing, and
 * that is the same answer round 9 settled for a TARGET held in a constant: a
 * value declared far above is a value no reading can see at the call, and
 * following one would mean tracking assignment, shadowing and reassignment
 * through a file to decide which write reaches this read. A base and a target are
 * one question asked twice, and answering them differently is how a grammar stops
 * being closed. The discipline is the same in both directions: a site that means
 * its child's directory to be checkable writes it where the child is started.
 *
 * `join`/`resolve` NEED A SECOND ARGUMENT to be read as composing a path at all,
 * AND A CALLEE THIS FILE TOOK FROM `node:path`. `parts.join('/')` is
 * `Array.prototype.join` wearing the same name, and reading it as `path.join` would
 * name the directory `/` at a site that names no directory — a base invented out of
 * punctuation. One argument is not a composition, so it is not read as one; and a
 * two-argument call this file cannot show came from a path module is not one
 * either, which is what `pathComposers` above proves and what round 12's first
 * finding walked a child through. `__dirname` and `__filename` are held to the same
 * rule from the other side: a file that binds one of those names has said the word
 * means something else in it.
 */
function writtenPath(node, composers) {
	if (!node) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		return { from: 'process', path: node.text };
	if (ts.isIdentifier(node) && node.text === '__dirname')
		return composers.bound.has('__dirname') ? null : { from: 'file', path: '.' };
	if (importMeta(node, 'dirname')) return { from: 'file', path: '.' };
	if (
		ts.isNewExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'URL'
	) {
		const [specifier, base] = node.arguments ?? [];
		const written = staticSpecifier(specifier);
		return written !== null && namesThisFile(base, composers.bound)
			? { from: 'file', path: written }
			: null;
	}
	if (!ts.isCallExpression(node)) return null;
	const callee = composerCalled(node.expression, composers);
	if (callee === 'fileURLToPath') return writtenPath(node.arguments[0], composers);
	if (callee === null || node.arguments.length < 2) return null;
	const [first, ...rest] = node.arguments;
	const head = writtenPath(first, composers);
	if (!head) return null;
	const tail = rest.map((argument) => staticSpecifier(argument));
	// An absolute segment DISCARDS everything before it in `path.resolve`, so a
	// reading that joined them would name a directory the call does not.
	if (tail.some((segment) => segment === null || segment.startsWith('/'))) return null;
	return { from: head.from, path: [head.path, ...tail].join('/') };
}

/**
 * A call that COMPOSES a path out of a base and pieces — which is what makes the
 * frame of the literals inside it a question rather than a default.
 *
 * IT EXISTS FOR THE FAILING CASE. Where `writtenPath` reads one of these, the
 * whole expression comes back as a word in a named frame and the pieces are
 * accounted for. Where it cannot — `join(root, 'scripts/x.mjs')`, `new URL(spec,
 * somewhereElse)` — the pieces are still paths, written against a base this
 * reading has no value for, and taking them as bare child arguments would resolve
 * them in a directory the call does not name. So this recognises the shape by its
 * callee, and `siteWords` puts what is inside it in the `unknown` frame.
 *
 * WHICH IS WHY THIS ONE STAYS NAME-ONLY while `writtenPath` above stopped being.
 * The two answer opposite questions. A callee this reading cannot prove came from
 * `node:path` may not NAME a directory — that was round 12's decoy — but it may
 * very well BE a composition, and the words inside one are written against a base
 * that is not the child's working directory. Proving the callee here would move
 * those words back into the child's frame and resolve them there, which is the
 * guess this function exists to stop. So the strict reading decides what may be
 * named and the loose one decides what may not be assumed: `['sub'].join(dir, 'x')`
 * names nothing and puts `x` in the `unknown` frame, and both halves are the
 * fail-closed answer.
 */
function pathComposer(node) {
	if (
		ts.isNewExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'URL'
	)
		return true;
	if (!ts.isCallExpression(node)) return false;
	const callee = ts.isIdentifier(node.expression)
		? node.expression.text
		: ts.isPropertyAccessExpression(node.expression)
			? node.expression.name.text
			: null;
	if (callee === 'fileURLToPath' || callee === 'pathToFileURL') return true;
	return (callee === 'join' || callee === 'resolve') && node.arguments.length >= 2;
}

/**
 * Argument shapes that cannot be an options bag, so finding one says nothing
 * about where the site's child runs. Everything else in a position that could
 * hold options and is not an object literal this reading can read leaves the base
 * UNKNOWN, which is the fail-closed direction: a bag it cannot open may carry a
 * `cwd`, and assuming it does not is the guess this whole model exists to stop.
 */
function notAnOptionsBag(node) {
	return (
		ts.isArrayLiteralExpression(node) ||
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateExpression(node) ||
		ts.isNumericLiteral(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword
	);
}

/** The key an object literal's member reads, or null where no static read can. */
function optionKey(property) {
	const name = property.name;
	if (!name) return null;
	if (ts.isComputedPropertyName(name))
		return isLiteralKey(name.expression) ? name.expression.text : null;
	if (ts.isIdentifier(name)) return name.text;
	return isLiteralKey(name) ? name.text : null;
}

/**
 * The working directory a site is WRITTEN to start its child in — the base every
 * relative path it hands that child is resolved against.
 *
 * WHY THE READING OWES THE CALLER THIS, which is round 10. CON-5 resolved a site's
 * literals against the repository root and against the file, and an explicit
 * `cwd` moves the first of those to somewhere else entirely. So `spawnSync(node,
 * ['scripts/lib/helper.mjs'], { cwd: 'sub' })` executed `sub/scripts/lib/helper.mjs`
 * while a disclosure bound the root-spelled `scripts/lib/helper.mjs` — a real file,
 * pinned, hashed, and never run — and the control was green with the actual child
 * rewritten wholesale. That is round 7's decoy exactly, and the reason is the one
 * round 7 wrote down: A LOADER'S BASE IS PART OF ITS MODEL. `createRequire` has
 * this rule already, because a loader built on another directory opens another
 * file; a child process is the same fact with a bigger loader.
 *
 * It belongs here rather than in the caller because it is a question about SYNTAX
 * — which argument is the options bag, whether it carries a `cwd`, and which frame
 * that `cwd` is written in — and the caller is handed a flat list of strings in
 * which `'sub'` and `'scripts/lib/helper.mjs'` are indistinguishable.
 *
 * ARGUMENT 0 IS NEVER OPTIONS in any facility this grammar names — it is the
 * command, the module or the worker's URL — so the scan starts at 1 and every
 * later argument is either a shape that cannot be an options bag or an object
 * literal this reading opens. Two bags carrying a `cwd`, a spread, a key it cannot
 * read, a shorthand and a value `writtenPath` cannot name all answer UNKNOWN.
 */
function siteBase(node, composers) {
	const call = headedCall(node);
	if (!call?.arguments) return PROCESS_BASE;
	let written = null;
	for (const argument of call.arguments.slice(1)) {
		if (notAnOptionsBag(argument)) continue;
		if (!ts.isObjectLiteralExpression(argument)) return UNKNOWN_BASE;
		for (const property of argument.properties) {
			if (ts.isSpreadAssignment(property)) return UNKNOWN_BASE;
			const key = optionKey(property);
			if (key === null) return UNKNOWN_BASE;
			if (key !== 'cwd') continue;
			if (!ts.isPropertyAssignment(property)) return UNKNOWN_BASE;
			const directory = writtenPath(property.initializer, composers);
			if (!directory || written) return UNKNOWN_BASE;
			written = directory;
		}
	}
	return written ?? PROCESS_BASE;
}

/** A callee this grammar can name, which is the condition for reading the call. */
function nameableCallee(callee) {
	if (!callee) return false;
	if (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee))
		return nameableCallee(callee.expression);
	if (ts.isAsExpression(callee) || ts.isSatisfiesExpression(callee))
		return nameableCallee(callee.expression);
	return (
		ts.isIdentifier(callee) ||
		ts.isPropertyAccessExpression(callee) ||
		(ts.isElementAccessExpression(callee) && isLiteralKey(callee.argumentExpression)) ||
		ts.isFunctionExpression(callee) ||
		ts.isArrowFunction(callee) ||
		callee.kind === ts.SyntaxKind.ImportKeyword ||
		callee.kind === ts.SyntaxKind.SuperKeyword ||
		callee.kind === ts.SyntaxKind.ThisKeyword
	);
}

/**
 * Every load in this source that the reading above cannot follow to a file —
 * because the TARGET is computed, because the LOADER is a construction this
 * grammar does not model, or because the code does not run in this process at all
 * — as `{ expression, line, kind, detail, literals, base, execPath, environment }`,
 * where kind is `'computed'`, `'loader'` or `'execution'`, `literals` is every
 * string the site is written to hand its facility WITH THE FRAME AND ROLE OF EACH
 * (see `siteWords`), `base` is the working directory it is written to resolve the
 * child's own words in (see `siteBase`), `execPath` says whether the child is this
 * process's own interpreter (see `runsThisInterpreter`), and `environment` says
 * whether the execution variables it writes are ones this reading can read (see
 * `opensEnvironment`) — so a caller that lets a site DECLARE what it runs can check
 * the declaration against the site's own text, against the right file, which is
 * what the frame and the base decide together, and with the grammar the child
 * itself applies to each string.
 *
 * WHY THE SECOND HALF EXISTS. Round 7's review executed five helpers past a
 * reader that knew only the `import` keyword and a bare `require(…)`: `const r =
 * require; r('./lib/helper')`, `module.require(…)`, `eval("require('…')")`, `new
 * Function('require', …)(require)`, and a `createRequire(…)` binding. Each loaded
 * a real file at run time, and each produced neither an edge nor a finding — the
 * same green as a file that loads nothing. That is symptom A again with a
 * different spelling: silence and permission are indistinguishable from outside,
 * and a gate may not have that property. So the grammar is CLOSED. A load this
 * reading models is followed; anything else that reaches the module loader or the
 * evaluator is reported, and the caller decides whether a declared reason exists
 * for it.
 *
 * WHAT IT REJECTS, by construction rather than by example:
 *
 *   - a `require`-like name used anywhere but as a call or as `<name>.resolve`,
 *     which covers every alias, every hand-off and every stashed loader;
 *   - a PROPERTY named `require`, `createRequire`, `getBuiltinModule`, `eval` or
 *     `constructor`, which covers `module.require`, `globalThis.eval`, the
 *     `.constructor.constructor` route to `Function`, and `process.getBuiltinModule`
 *     — the second, equally named way of asking for the very modules above;
 *   - a DESTRUCTURING of any of those names — `const { require: r } = module`,
 *     `({ createRequire: c } = m)`, and every nesting and default of them, which is
 *     the same read as the property access written with other punctuation;
 *   - a RE-EXPORT of any tracked binding — `export { cr }`, `export { cr as make }`,
 *     `export { spawnSync }` — which hands a loader or an execution facility to
 *     every importer of the file, and `export … from` or `export * from` a watched
 *     module, which is the same hand-off without the local hop;
 *   - `eval` and `Function` as identifiers, in any position;
 *   - `globalThis` or `global` reached other than as `globalThis.<name>`, which
 *     covers `globalThis[key]` and `const g = globalThis` alike;
 *   - a call whose CALLEE this grammar cannot name — `handlers[key]()`, `f()()`,
 *     `(cond ? a : b)()` — since a callee it cannot name is a loader it cannot
 *     rule out;
 *   - importing `node:vm`, or `node:module` in any form but a named import of
 *     `createRequire`, which is the one loader construction modelled above;
 *   - every named Node facility that runs code this process did not load — a
 *     `spawn`/`exec`/`fork` bound from `node:child_process`, a `Worker` bound from
 *     `node:worker_threads`, either module taken in a form whose bindings cannot be
 *     named, `process.dlopen`, and `WebAssembly`;
 *   - a WRITE into one of `INHERITED_EXECUTION` — `process.env.NODE_OPTIONS = …`,
 *     the subscript and append spellings of it, a replacement of `process.env`
 *     itself, and `Object.assign(process.env, …)` — which loads code into every
 *     child this process starts without a call anywhere near the child.
 *
 * WHY THE LAST GROUP IS HERE, when round 7's version of this argued it out of
 * scope. That argument was that this reading covers code THIS process runs, so a
 * probe spawning `node` is ordinary and the child's closure belongs to the child.
 * Round 8's review answered it with a fact rather than a counter-argument: nobody
 * was walking the child. `spawnSync(process.execPath, ['scripts/lib/helper.mjs'])`
 * in a gate file ran an editable repository helper, the parent's content pin said
 * nothing about it, and CON-5 was green with the helper as written and green again
 * with it rewritten wholesale. So the boundary moved to where it can be defended:
 * these facilities have NAMES, a reader that watches names can watch them, and a
 * caller that needs one declares it — with the repository paths it runs, which
 * CON-5 then pins.
 *
 * WHERE IT STOPS, said plainly, because a closed grammar over NAMES is not a
 * closed grammar over BEHAVIOUR. It reads syntax, so it cannot see a loader
 * assembled without ever writing one of those names — `Reflect.get(x, key)`, a
 * member reached through an alias of an alias, a name built from string pieces and
 * applied to something that is not `globalThis`. That class is genuinely unbounded
 * and stays stated rather than closed.
 *
 * `process.binding` STAYS OUT, and round 9's review was right to ask whether
 * admitting `getBuiltinModule` had made that exclusion stale. It has not, and the
 * difference between the two is measurable rather than rhetorical. This grammar
 * watches NAMES, so the only cost that matters is what else in this tree is
 * spelled that way: `getBuiltinModule` appears nowhere in it, while `binding`
 * appears as a property access 33 times and as an object key 5 more — a probe's
 * `probe.binding` in `tests/messaging-realtime.test.mjs`, a file inside this
 * closure. A rule on that name is not a rule about Node's deprecated internal; it
 * is 38 findings about something else, with a disclosure as the only repair, which
 * is how a list of declarations stops being read. Telling those apart means asking
 * WHICH object carries the property, and that is the object-tracking this reading
 * does not do. The facility itself is inside the reflective residue above.
 *
 * What backs that residue is not this function: it is that every file CON-5 walks
 * is bound by a content hash, so any of those shapes has to arrive in a governance
 * diff, where the review is the control. That is the same argument the disclosure
 * list rests on, and it is not a claim that the class is closed.
 *
 * LINES ARE 1-BASED and are counted in the SOURCE THIS IS GIVEN. For a component
 * that is the script the caller extracted, not the file on disk; CON-5, which is
 * the caller that uses them, walks plain modules where the two are the same.
 */
export function unfollowableLoads(source) {
	const file = parsed(source);
	const { names, factories, modelled } = requireLike(file);
	const running = importedLocals(file, EXECUTION_MODULES, MODELLED_EXECUTION_EXPORTS);
	const composers = pathComposers(file);
	const found = [];
	const report = (node, kind, detail) =>
		found.push({
			expression: node.getText(file),
			line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
			kind,
			detail,
			literals: siteWords(node, composers),
			base: siteBase(node, composers),
			execPath: runsThisInterpreter(node),
			environment: opensEnvironment(node),
		});

	/**
	 * A named import whose every binding this reading can follow to its uses. The
	 * clause must bind nothing but named exports it models — a default or namespace
	 * import hands out the whole module object, and the local it produces is a name
	 * this grammar would then have to track through arbitrary member access.
	 */
	const bindsOnlyModelled = (node, exports_) => {
		const clause = ts.isImportDeclaration(node) ? node.importClause : null;
		const bindings = clause?.namedBindings;
		return Boolean(
			clause &&
			!clause.name &&
			bindings &&
			ts.isNamedImports(bindings) &&
			bindings.elements.every((element) =>
				exports_.has((element.propertyName ?? element.name).text)
			)
		);
	};

	const loaderModule = (node, specifier) => {
		if (EVALUATOR_MODULES.has(specifier))
			return report(node, 'loader', `imports ${specifier}, which evaluates text as code`);
		if (EXECUTION_MODULES.has(specifier)) {
			if (!bindsOnlyModelled(node, MODELLED_EXECUTION_EXPORTS))
				report(
					node,
					'execution',
					`takes ${specifier} in a form whose bindings this reading cannot name at their uses`
				);
			return;
		}
		if (!LOADER_MODULES.has(specifier)) return;
		if (!bindsOnlyModelled(node, MODELLED_LOADER_EXPORTS))
			report(
				node,
				'loader',
				`takes ${specifier} in a form that hands out a loader this reading cannot follow`
			);
	};

	eachNode(file, (node) => {
		// The channel that starts code with no call anywhere near it: a variable
		// written into this process's environment, which every child inherits.
		const assigned = assignedExecutionVariable(node);
		if (assigned)
			return report(
				node,
				'execution',
				assigned.name
					? `writes ${assigned.name} into this process's environment, which every child it starts ` +
							'loads before reaching its own entry point'
					: "replaces this process's environment, which every child it starts inherits"
			);
		if (mutatesEnvironment(node))
			return report(
				node,
				'execution',
				"mutates this process's environment through the object, so which execution variables it " +
					'writes is not something this reading enumerates'
			);

		if (isImportCall(node) || isRequireCall(node, names)) {
			const specifier = staticSpecifier(node.arguments[0]);
			if (specifier === null) report(node, 'computed', 'loads a module no static read can name');
			else loaderModule(node, specifier);
			return;
		}

		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const specifier = staticSpecifier(node.moduleSpecifier);
			if (specifier !== null) loaderModule(node, specifier);
			return;
		}

		const destructured = destructuredKey(node);
		if (destructured !== null) {
			const key = keyText(destructured);
			if (key !== null && LOADER_PROPERTIES.has(key))
				report(node, 'loader', `takes ${key} out of an object, which no static read follows`);
			else if (key !== null && EXECUTION_PROPERTIES.has(key))
				report(node, 'execution', `takes ${key} out of an object, which runs code off this walk`);
			return;
		}

		if (ts.isPropertyAccessExpression(node)) {
			const key = node.name.text;
			if (LOADER_PROPERTIES.has(key))
				report(node, 'loader', `reaches ${key} as a property, which no static read follows`);
			else if (EXECUTION_PROPERTIES.has(key))
				report(node, 'execution', `reaches ${key}, which loads and runs code no hash here binds`);
			return;
		}

		if (ts.isElementAccessExpression(node)) {
			const key = node.argumentExpression;
			if (!isLiteralKey(key)) return;
			if (LOADER_PROPERTIES.has(key.text))
				report(node, 'loader', `reaches ${key.text} by key, which no static read follows`);
			else if (EXECUTION_PROPERTIES.has(key.text))
				report(node, 'execution', `reaches ${key.text} by key, which runs code off this walk`);
			return;
		}

		if (
			(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
			!nameableCallee(node.expression)
		) {
			report(node, 'loader', 'calls something this reading cannot name, so it cannot be ruled out');
			return;
		}

		if (!ts.isIdentifier(node) || namesRatherThanReferences(node) || inTypePosition(node)) return;

		const parent = node.parent;
		const name = node.text;
		if (names.has(name)) {
			const called = ts.isCallExpression(parent) && parent.expression === node;
			const resolves =
				ts.isPropertyAccessExpression(parent) &&
				parent.expression === node &&
				parent.name.text === 'resolve';
			if (!called && !resolves)
				report(node, 'loader', 'hands a CommonJS loader somewhere this reading cannot follow');
			return;
		}
		if (factories.has(name)) {
			if (!modelled.has(node))
				report(node, 'loader', 'builds a CommonJS loader this reading cannot follow to its uses');
			return;
		}
		if (running.has(name)) {
			const invoked =
				(ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
			report(
				node,
				'execution',
				invoked
					? 'runs code in an execution context whose closure this walk does not reach'
					: 'hands out a way to run code somewhere this reading cannot follow'
			);
			return;
		}
		if (EXECUTION_GLOBALS.has(name)) {
			report(node, 'execution', 'compiles and runs code this module system never loaded');
			return;
		}
		if (EVALUATORS.has(name)) {
			report(node, 'loader', 'turns text into running code');
			return;
		}
		if (REALMS.has(name) && !(ts.isPropertyAccessExpression(parent) && parent.expression === node))
			report(node, 'loader', 'is reached other than by name, so its members cannot be read');
	});

	return found;
}

/**
 * A load whose target no static read can name — `import(<anything but a readable
 * literal>)` and the same shape spelled `require(…)` — returned as the CALL's
 * source text, so a finding quotes what is in the file.
 *
 * THE SEAM PROBES' PROJECTION of `unfollowableLoads`, and the narrower half of
 * it. They ask which components a file depends on, over every tracked source file
 * including vendored greater-components source this repository may not edit; a
 * loader-grammar finding there would be a rule about code whose only available
 * repair is an edit upstream. Their unfollowable-load question is answered a
 * second way besides, by `scripts/audit-seam-graph.mjs` reading the edges the
 * real Vite build resolves. CON-5 has no such second reading — its closure is
 * exactly this walk — so it takes the whole grammar.
 *
 * Taken by SUBTRACTION, as it was before: every such call that is not a plain
 * string or an un-interpolated template is unreadable. `import('$lib/agents/' +
 * name)` opens with a quote and is not a literal; `import(target)` names nothing
 * at all. A call with no argument is unreadable too and reports as `import()`.
 *
 * WHY THE WHOLE CALL AND NOT THE ARGUMENT. `require(name)` and `import(name)` are
 * one class — a dependency this reading cannot follow — and callers used to
 * assemble their offender line by wrapping the argument in the literal text
 * `import(…)`, which would have printed the wrong keyword for half the class.
 * The call text is what the next reader has to find, and quoting the source
 * rather than reconstructing it is the same rule `modulePath` states for a
 * specifier.
 *
 * The caller is expected to treat every return value as a finding. Resolving the
 * variable instead was considered and rejected: constant-folding one assignment
 * closes one spelling of an unresolvable import and leaves the rest, and the
 * property worth holding is that the graph is statically readable — not that
 * this walker is clever.
 */
export function computedImports(source) {
	return unfollowableLoads(source)
		.filter((load) => load.kind === 'computed')
		.map((load) => load.expression);
}

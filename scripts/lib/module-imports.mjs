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
 * The set is file-wide rather than scope-aware, which over-includes: a `require`
 * shadowed inside one function marks calls elsewhere too. That direction reports
 * more edges and more findings, which is the direction this reading fails in.
 */
function requireLike(file) {
	const names = new Set(['require']);
	const modelled = new Set();

	eachNode(file, (node) => {
		if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
		const initializer = node.initializer;
		if (!initializer || !ts.isCallExpression(initializer)) return;
		if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'createRequire')
			return;
		names.add(node.name.text);
		modelled.add(initializer.expression);
	});

	return { names, modelled };
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

/** Names that hand out a loader or an evaluator when they appear as a PROPERTY. */
const LOADER_PROPERTIES = new Set(['require', 'createRequire', 'eval', 'constructor']);

/** Identifiers that turn text into running code. */
const EVALUATORS = new Set(['eval', 'Function']);

/** The global object, whose members this grammar insists are reached BY NAME. */
const REALMS = new Set(['globalThis', 'global']);

/** Modules that hand out a loader, and the one export of them this reading models. */
const LOADER_MODULES = new Set(['module', 'node:module']);
const MODELLED_LOADER_EXPORTS = new Set(['createRequire']);

/** Modules that evaluate text as code. */
const EVALUATOR_MODULES = new Set(['vm', 'node:vm']);

const isLiteralKey = (node) =>
	Boolean(node) &&
	(ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node));

/**
 * An identifier that NAMES something rather than referring to a value: every
 * declaration's own name, every `x.NAME`, every `{ NAME: local }` key, every
 * label. TypeScript puts all of them in the parent's `name`, `propertyName` or
 * `label` slot, so one shape test replaces the list of twenty node types the
 * first draft of this carried — and cannot fall behind a TypeScript release that
 * adds a twenty-first.
 */
function namesRatherThanReferences(node) {
	const parent = node.parent;
	if (!parent) return true;
	// `{ require }` is the one shorthand where the NAME slot is also a reference.
	if (ts.isShorthandPropertyAssignment(parent)) return false;
	if (parent.name === node || parent.propertyName === node || parent.label === node) return true;
	return ts.isQualifiedName(parent) && parent.right === node;
}

/** True where the identifier sits inside a type, which no loader ever reads. */
function inTypePosition(node) {
	for (let parent = node.parent; parent; parent = parent.parent)
		if (ts.isTypeNode(parent)) return true;
	return false;
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
 * both because the TARGET is computed and because the LOADER is a construction
 * this grammar does not model — as `{ expression, line, kind, detail }`.
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
 *   - a PROPERTY named `require`, `createRequire`, `eval` or `constructor`, which
 *     covers `module.require`, `globalThis.eval` and the `.constructor.constructor`
 *     route to `Function`;
 *   - `eval` and `Function` as identifiers, in any position;
 *   - `globalThis` or `global` reached other than as `globalThis.<name>`, which
 *     covers `globalThis[key]` and `const g = globalThis` alike;
 *   - a call whose CALLEE this grammar cannot name — `handlers[key]()`, `f()()`,
 *     `(cond ? a : b)()` — since a callee it cannot name is a loader it cannot
 *     rule out;
 *   - importing `node:vm`, or `node:module` in any form but a named import of
 *     `createRequire`, which is the one loader construction modelled above.
 *
 * WHERE IT STOPS, said plainly, because a closed grammar over NAMES is not a
 * closed grammar over BEHAVIOUR. It reads syntax, so it cannot see a loader
 * assembled without ever writing one of those names — `Reflect.get(x, key)`,
 * a member reached through an alias of an alias, a name built from string pieces
 * and applied to something that is not `globalThis`. It is scoped to code this
 * process runs, so `node:child_process` and `node:worker_threads` are outside it:
 * a probe that spawns `node` is ordinary here, and the code that child runs is
 * the child's own closure rather than this file's. `process.dlopen` and
 * WebAssembly are outside it for the same reason as the first group — no name it
 * watches appears. What backs the residue is not this function: it is that every
 * file CON-5 walks is bound by a content hash, so any of those shapes has to
 * arrive in a governance diff, where the review is the control. That is the same
 * argument the disclosure list rests on, and it is not a claim that the class is
 * closed.
 *
 * LINES ARE 1-BASED and are counted in the SOURCE THIS IS GIVEN. For a component
 * that is the script the caller extracted, not the file on disk; CON-5, which is
 * the caller that uses them, walks plain modules where the two are the same.
 */
export function unfollowableLoads(source) {
	const file = parsed(source);
	const { names, modelled } = requireLike(file);
	const found = [];
	const report = (node, kind, detail) =>
		found.push({
			expression: node.getText(file),
			line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
			kind,
			detail,
		});

	const loaderModule = (node, specifier) => {
		if (EVALUATOR_MODULES.has(specifier))
			return report(node, 'loader', `imports ${specifier}, which evaluates text as code`);
		if (!LOADER_MODULES.has(specifier)) return;
		const clause = ts.isImportDeclaration(node) ? node.importClause : null;
		const bindings = clause?.namedBindings;
		const modelledOnly =
			clause &&
			!clause.name &&
			bindings &&
			ts.isNamedImports(bindings) &&
			bindings.elements.every((element) =>
				MODELLED_LOADER_EXPORTS.has((element.propertyName ?? element.name).text)
			);
		if (!modelledOnly)
			report(
				node,
				'loader',
				`takes ${specifier} in a form that hands out a loader this reading cannot follow`
			);
	};

	eachNode(file, (node) => {
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

		if (ts.isPropertyAccessExpression(node) && LOADER_PROPERTIES.has(node.name.text)) {
			report(
				node,
				'loader',
				`reaches ${node.name.text} as a property, which no static read follows`
			);
			return;
		}

		if (ts.isElementAccessExpression(node)) {
			const key = node.argumentExpression;
			if (isLiteralKey(key) && LOADER_PROPERTIES.has(key.text))
				report(node, 'loader', `reaches ${key.text} by key, which no static read follows`);
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
		if (name === 'createRequire') {
			if (!modelled.has(node))
				report(node, 'loader', 'builds a CommonJS loader this reading cannot follow to its uses');
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

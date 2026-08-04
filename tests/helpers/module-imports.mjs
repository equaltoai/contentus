/**
 * What a source file actually imports, read with the PARSERS THE TOOLCHAIN
 * ALREADY RUNS rather than with a pattern over its text. PROBE-ONLY.
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
 * `import(someExpression)` names a module no static read can resolve, and that
 * is a FINDING in every walked file, inside the face and outside it — see
 * `computedImports`. A module reached by something that is not an import at all
 * is outside any static reach and outside this module's claim.
 *
 * WHERE OVER-INCLUSION IS STILL DELIBERATE. A type-only import and an
 * `import('…')` in type position are not runtime edges, and both are reported.
 * Swapping a component behind a seam breaks a type that names it exactly as it
 * breaks a value that names it, so for a SEAM check they are dependencies. That
 * is the one place this module deliberately reports more than the module system
 * loads; everywhere else it reports what the compilers see, no more and no less.
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
 * The template reading it used to fall back to is gone with the patterns: markup
 * holds no import declaration, so there was never anything in it to find.
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

	return [ast.module, ast.instance]
		.filter(Boolean)
		.map((block) => source.slice(block.content.start, block.content.end))
		.join('\n');
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
 * Every module specifier a source depends on, in every form that reaches a file:
 * `import … from`, `export … from`, `export * from`, a side-effect `import '…'`,
 * `import x = require('…')`, a dynamic `import('…')` with a readable argument,
 * and `import('…')` in type position.
 *
 * Pass a component's source through `liveScript` first. This function reads what
 * it is given, and what it is given must be script.
 */
export function moduleSpecifiers(source) {
	const specifiers = new Set();
	const add = (node) => {
		const specifier = staticSpecifier(node);
		if (specifier) specifiers.add(specifier);
	};

	eachNode(parsed(source), (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			add(node.moduleReference.expression);
		else if (ts.isImportTypeNode(node) && node.argument && ts.isLiteralTypeNode(node.argument))
			add(node.argument.literal);
		else if (isImportCall(node)) add(node.arguments[0]);
	});

	return [...specifiers];
}

/**
 * `import(<anything but a readable literal>)` — a dependency no static read can
 * name, returned as the argument's source text so the finding names a place.
 *
 * Taken by SUBTRACTION, as it was before: every import call that is not a plain
 * string or an un-interpolated template is unreadable. `import('$lib/agents/' +
 * name)` opens with a quote and is not a literal; `import(target)` names nothing
 * at all. A call with no argument is unreadable too and reports as `import()`.
 *
 * The caller is expected to treat every return value as a finding. Resolving the
 * variable instead was considered and rejected: constant-folding one assignment
 * closes one spelling of an unresolvable import and leaves the rest, and the
 * property worth holding is that the face's dependency graph is statically
 * readable — not that this walker is clever.
 */
export function computedImports(source) {
	const file = parsed(source);
	const computed = [];

	eachNode(file, (node) => {
		if (!isImportCall(node)) return;
		const [argument] = node.arguments;
		if (staticSpecifier(argument) !== null) return;
		computed.push(argument ? argument.getText(file) : '');
	});

	return computed;
}

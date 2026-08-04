/**
 * What a source file actually imports, read from the code the module system
 * runs rather than from the text a pattern happens to match. PROBE-ONLY.
 *
 * WHY THIS IS A MODULE AND NOT A REGEX IN EACH PROBE. Two probes assert the
 * face-6 swap seams — `tests/agents-mobile.test.mjs` for the whole face and
 * `tests/agents-roster.test.mjs` for the interim roster pieces — and both used
 * to extract imports with their own line-anchored regex. Round 3 of this pull
 * request's adversarial review compiled four legal Svelte/ESM files that took a
 * cross-seam dependency and returned NOTHING from both scans:
 *
 *   1. a block comment before the import, on the same line as it
 *   2. a block comment between `from` and the specifier
 *   3. either of those two shapes on an `export … from` re-export
 *   4. `const target = '$lib/agents/CopyBlock.svelte'; import(target);`
 *
 * The first three are one defect wearing three hats: an anchored pattern was
 * asked to answer a question about syntax, and a comment is exactly the thing
 * that sits where a pattern expects whitespace. The answer is not a fourth
 * pattern — it is to stop the walker seeing comments at all, which is what
 * `stripScriptSource` does and why that reading lives beside the template one in
 * `scripts/lib/strip-comments.mjs` rather than being retyped here.
 *
 * The fourth is a different defect and is handled by `computedImports`: an
 * import whose target no static read can name is a FINDING in every walked file,
 * inside the face and outside it. See its header.
 *
 * A FIFTH form the same round's fixtures imply, closed here too: the old anchor
 * was `^[ \t]*import`, and a `const` declaration followed on the same line by an
 * import declaration is a legal module line whose import is not at the start of
 * it. The patterns below carry no line anchor, so a statement that precedes an
 * import on its own line no longer hides it.
 *
 * OVER-MATCHING IS THE SAFE DIRECTION and these patterns take it deliberately.
 * A specifier is returned as a SET per file, so a pattern that matches the same
 * import twice, or that reads `"an excerpt from 'the doc'"` as an import of `the
 * doc`, costs a caller a specifier that resolves to nothing outside the face and
 * is discarded. A pattern that matches too little costs the caller a dependency
 * it never sees. Every choice here is made in the first direction.
 */
import { stripComments, stripScriptSource } from '../../scripts/lib/strip-comments.mjs';

/**
 * The source a file's imports can live in, with the comments of that source's
 * own language removed.
 *
 * Svelte executes `<script>` and nothing else, so in a component that is what is
 * read. Skipping the template is a statement about Svelte rather than a
 * convenience: markup holds no import declaration, `<style>`'s `@import` is a
 * CSS rule and not a module edge, and reading template prose as script would
 * mean apostrophes opening string literals.
 *
 * A component with NO `<script>` is a template, and it gets the template reading
 * — the one `scripts/audit-renderer-authority.mjs` uses over the same files.
 * Nothing in that reading touches an import statement, so the seam probes'
 * planted one-liners are the same input to the caller either way, while an
 * import-shaped sentence inside `<!-- … -->` is the prose it looks like.
 *
 * An unterminated `<script>` runs to the end of the file, so a missing closing
 * tag scans more text rather than less.
 */
export function liveScript(file, source) {
	if (!/\.svelte$/i.test(file)) return stripScriptSource(source);
	const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script>|$)/gi)].map(
		([, body]) => body
	);
	return blocks.length ? stripScriptSource(blocks.join('\n')) : stripComments(source);
}

/**
 * Every module specifier a source depends on, in every form that reaches a file:
 * `import … from`, `export … from`, a side-effect `import '…'`, and a dynamic
 * `import('…')`.
 *
 * The gap between the keyword and `from` may hold neither `;` nor a backtick, so
 * a multi-line named import spanning several lines — which is how
 * `AgentMcpPanel` imports the mcp module — still matches, while a terminated
 * statement cannot run on and attribute the NEXT statement's specifier to
 * itself. Attribution is per file rather than per statement, so even that would
 * only duplicate a specifier the caller already has.
 *
 * Pass the source through `liveScript` first. This function reads what it is
 * given; handing it raw text hands it comments.
 */
export function moduleSpecifiers(source) {
	const specifiers = new Set();
	for (const pattern of [
		/(?<![\w$.])(?:import|export)\b[^;`]*?\bfrom\s*['"]([^'"]+)['"]/g,
		/(?<![\w$.])import\s*['"]([^'"]+)['"]/g,
		/(?<![\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	])
		for (const [, specifier] of source.matchAll(pattern)) specifiers.add(specifier);
	return [...specifiers];
}

/**
 * `import(<anything but a bare literal>)` — a dependency no static read can name.
 *
 * Matched by taking EVERY `import(…)` call and subtracting the ones whose whole
 * argument is a string literal, rather than by pattern-matching the shapes a
 * computed specifier can take. `import('$lib/agents/' + name)` opens with a
 * quote and closes with an identifier, and a rule that looked at the first
 * character would have called it a literal and moved on. `import(target)` names
 * nothing at all, which is the round-3 bypass: a walker that only reads the
 * expression's TEXT for a directory name reads no directory name and passes.
 *
 * The caller is expected to treat every return value as a finding. Resolving the
 * variable instead was considered and rejected: constant-folding one assignment
 * closes one spelling of an unresolvable import and leaves the rest, and the
 * property worth holding is that the face's dependency graph is statically
 * readable — not that this walker is clever.
 */
const IMPORT_CALL = /(?<![.\w$])import\s*\(/g;
const isLiteralArgument = (expression) => /^\s*(['"])[^'"]*\1\s*$/.test(expression);

/**
 * The call's argument, brackets balanced and quotes respected, so that
 * `import(resolve('x'))` is reported as what it is rather than truncated at the
 * first `)` into something the reader has to reconstruct. An unbalanced call is
 * not valid source; its first line is reported so the finding still names a
 * place.
 */
function readCallArgument(source, openIndex) {
	let depth = 0;
	let quote = null;
	for (let index = openIndex; index < source.length; index += 1) {
		const char = source[index];
		if (quote) {
			if (char === '\\') index += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') quote = char;
		else if (char === '(' || char === '[' || char === '{') depth += 1;
		else if (char === ')' || char === ']' || char === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(openIndex + 1, index);
		}
	}
	return null;
}

/**
 * `import(json: string): boolean` is a class member NAMED `import`, not a call —
 * vendored greater-components has one in `primitives/stores/preferences`, and
 * calling it a computed import would make the fail-closed rule above fire on
 * source this repository may not edit.
 *
 * The discriminator is the argument's own shape: a top-level `:` with no
 * top-level `?` is a parameter list and cannot be an expression. Every `:` a
 * real `import()` argument can contain is inside brackets (an object literal),
 * inside quotes (`'http://…'`), or paired with a `?` (a conditional) — so this
 * cannot be used the other way round to disguise a call as a declaration.
 */
function isParameterList(expression) {
	let depth = 0;
	let quote = null;
	let colon = false;
	let question = false;
	for (let index = 0; index < expression.length; index += 1) {
		const char = expression[index];
		if (quote) {
			if (char === '\\') index += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') quote = char;
		else if (char === '[' || char === '{' || char === '(') depth += 1;
		else if (char === ']' || char === '}' || char === ')') depth -= 1;
		else if (depth === 0 && char === ':') colon = true;
		else if (depth === 0 && char === '?') question = true;
	}
	return colon && !question;
}

export function computedImports(source) {
	const computed = [];
	for (const match of source.matchAll(IMPORT_CALL)) {
		const open = match.index + match[0].length - 1;
		const argument = readCallArgument(source, open) ?? source.slice(open + 1).split('\n')[0];
		if (isLiteralArgument(argument) || isParameterList(argument)) continue;
		computed.push(argument);
	}
	return computed;
}

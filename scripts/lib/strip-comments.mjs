/**
 * A source file with its comments removed, scanned LEFT TO RIGHT.
 *
 * THE ONE COPY. This routine decides what `scripts/audit-renderer-authority.mjs`
 * considers live template, so it decides what check 3 can catch. It lived in two
 * places — the gate and its regression test — and they were byte-identical,
 * which is exactly the state that ends with them not being: the test would go on
 * passing against its own copy while the gate scanned something else and went
 * green over a live sink. M5's own review found the same drift shape in the
 * messaging code; a gate whose regression tests a duplicate is not regressed at
 * all. So there is one module, the audit imports it, and the probes import the
 * same one.
 *
 * The token has to be ignored inside comments — several owned files, the audit
 * included, state the `{@html}` rule in prose, and a check that failed on its own
 * documentation would be measuring the wrong thing.
 *
 * WHY NOT A REGEX REPLACE, and this is the part worth reading. A global
 * `/<!--[\s\S]*?-->/` can REINTRODUCE a delimiter it did not have before: given
 * `<!<!-- -->-- {@html evil} -->`, removing the inner match leaves
 * `<!-- {@html evil} -->` — which a second pass then removes entirely, taking a
 * LIVE `{@html}` with it. That is the dangerous direction: the gate goes green
 * over a sink it should have caught.
 *
 * It is also the wrong answer. A parser reading that text finds its first `<!--`
 * at index 2, so the comment is `<!-- -->` and everything after it — including
 * the sink — is live template. This scan reproduces that reading: it walks
 * forward, consumes a comment atomically at the position it opens, and never
 * re-examines text it has already emitted, so it cannot create a delimiter that
 * was not there. On the nested case above it leaves the sink VISIBLE and the
 * audit FAILS, which is the safe direction and the correct one.
 *
 * An unterminated opener consumes the remainder of the file, which is also what
 * a parser does with one.
 *
 * Line comments are deliberately not stripped. `//` inside a string or a URL is
 * indistinguishable from a comment without parsing, and removing to end-of-line
 * on a false match could delete real code — including the very `{@html}` this is
 * looking for.
 *
 * (CodeQL flagged the regex form as `js/incomplete-multi-character-sanitization`,
 * CWE-116. The first fix attempted was the loop-until-stable that rule
 * recommends; it silences the rule and is wrong here for the reason above.)
 */

export const COMMENT_DELIMITERS = [
	['<!--', '-->'],
	['/*', '*/'],
];

export function stripComments(source) {
	let out = '';
	let index = 0;

	while (index < source.length) {
		const opener = COMMENT_DELIMITERS.find(([open]) => source.startsWith(open, index));
		if (opener) {
			const [open, close] = opener;
			const end = source.indexOf(close, index + open.length);
			index = end === -1 ? source.length : end + close.length;
			continue;
		}

		out += source[index];
		index += 1;
	}

	return out;
}

/* -------------------------------------------------------------------------
 * The script reading
 * ---------------------------------------------------------------------- */

/**
 * THE SECOND READING, and it is here rather than in a second module for the
 * reason the header gives: comment-stripping in this repository is one copy.
 *
 * `stripComments` above reads TEMPLATE text, where `'` is an apostrophe and
 * `<!--` opens a comment. `stripScriptSource` reads SCRIPT text, where `'` opens
 * a string literal and `<!--` is `< ! --`. Running either reading over the other
 * language is a fail-OPEN mistake in both directions, so they are separate
 * exports and the caller says which language it holds.
 *
 * The script reading exists because the face-6 seam check extracts imports by
 * pattern, and four legal ESM forms walked straight past those patterns: a block
 * comment before the import on the same line, a comment between `from` and the
 * specifier, the same two on a re-export, and — separately — a computed
 * `import()`. The first three are all "a comment sits where the pattern expected
 * whitespace", which is not a pattern problem; it is a reading problem.
 *
 * WHY STRING AND REGEX LITERALS ARE TRACKED. Stripping comments without knowing
 * where strings are is how a stripper INVENTS a comment: `accept="image/*"` is a
 * real attribute in this repository's own `MediaUpload.svelte`, and a naive scan
 * opens a block comment at that `/*` and swallows every line until a block-comment
 * CLOSER — which, in that file, never comes. Everything after it disappears from
 * the scan and the gate goes green over whatever was in it. That is the same
 * fail-open direction the header warns about for the regex form, arrived at from
 * the other side.
 *
 * Literals are EMITTED VERBATIM rather than blanked, and that choice is what
 * makes the tracking safe to get wrong. Mis-reading code as a literal can only
 * cause this routine to strip LESS — the text is still in the output, so an
 * import inside it is still visible to the caller, and a comment inside it is
 * reported rather than hidden. There is no input for which literal-tracking
 * hides a dependency; the worst it produces is a finding the reader has to
 * dismiss, which is the direction a gate should fail in.
 *
 * Line comments ARE stripped here, unlike in the template reading. The reason
 * that reading gives — `//` inside a string or a URL is indistinguishable from a
 * comment without parsing — is exactly what the literal tracking above removes,
 * and only there: a `//` still inside a template's unquoted attribute is not
 * this function's problem, because a template holds no imports.
 */
export const SCRIPT_COMMENT_DELIMITERS = [
	['/*', '*/', false],
	// The newline is the terminator, not part of the comment: consuming it would
	// join two lines into one and let a statement run on into the next one's text.
	['//', '\n', true],
];

/** A `'`/`"` string ends on its own line; a template literal may span lines. */
function readStringLiteral(source, start) {
	const quote = source[start];
	for (let index = start + 1; index < source.length; index += 1) {
		const char = source[index];
		if (char === '\\') {
			index += 1;
			continue;
		}
		if (char === quote) return source.slice(start, index + 1);
		if (char === '\n' && quote !== '`') return null;
	}
	return null;
}

/**
 * A regex literal, character classes included — `/[//]/` is a legal regex whose
 * body holds the line-comment delimiter, and reading it as code would strip the
 * rest of the line.
 */
function readRegexLiteral(source, start) {
	let inClass = false;
	for (let index = start + 1; index < source.length; index += 1) {
		const char = source[index];
		if (char === '\\') {
			index += 1;
			continue;
		}
		if (char === '\n') return null;
		if (inClass) {
			if (char === ']') inClass = false;
			continue;
		}
		if (char === '[') inClass = true;
		else if (char === '/') return source.slice(start, index + 1);
	}
	return null;
}

/**
 * Script source with its comments removed, scanned left to right, with string
 * and regex literals consumed atomically and emitted unchanged.
 *
 * The `/` ambiguity is resolved the way every tokenizer resolves it: a `/` that
 * follows a value (an identifier, a number, a `)`, a `]`, another literal) is
 * division; anywhere else it opens a regex. Comments are matched BEFORE this
 * runs, which is correct and not an ordering accident — no regex can begin `//`
 * (the empty regex is unwritable) or `/*` (a quantifier with nothing to repeat),
 * so those two openers are never a literal's first characters.
 */
export function stripScriptSource(source) {
	let out = '';
	let index = 0;
	let afterValue = false;

	while (index < source.length) {
		const opener = SCRIPT_COMMENT_DELIMITERS.find(([open]) => source.startsWith(open, index));
		if (opener) {
			const [open, close, keepClose] = opener;
			const end = source.indexOf(close, index + open.length);
			if (end === -1) index = source.length;
			else index = keepClose ? end : end + close.length;
			continue;
		}

		const char = source[index];
		const literal =
			char === "'" || char === '"' || char === '`'
				? readStringLiteral(source, index)
				: char === '/' && !afterValue
					? readRegexLiteral(source, index)
					: null;
		if (literal) {
			out += literal;
			index += literal.length;
			afterValue = true;
			continue;
		}

		out += char;
		index += 1;
		if (!/\s/.test(char)) afterValue = /[\w$)\]]/.test(char);
	}

	return out;
}

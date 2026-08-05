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
 *
 * THIS IS A TEMPLATE READING AND ONLY A TEMPLATE READING. A `stripScriptSource`
 * lived beside it for one round, so the face-6 seam probes could find imports a
 * pattern was missing because a comment sat where it expected whitespace. It is
 * gone, and the next reader should not re-add it: stripping a comment out of
 * SCRIPT text CONCATENATES the tokens it separated, so `import/* … *\/X` becomes
 * `importX` and the statement disappears from exactly the scan that was supposed
 * to find it. That is not a bug in the stripper — it is what stripping means.
 * Script is read by `typescript` now, in `./module-imports.mjs`,
 * where comments are trivia the tokenizer already accounts for.
 *
 * What survives here is the template reading, which has no such failure mode:
 * `{@html}` is a template construct, its absence is what the audit asserts, and
 * a comment removed from markup joins prose to prose.
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

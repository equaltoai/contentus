/**
 * The source files this repository actually carries, asked of git. PROBE-ONLY.
 *
 * WHY NOT `readdirSync`. The face-6 seam walks scan `src/` for every component
 * and module outside the face, and they used to do it by listing the directory.
 * A directory listing answers "what is on this disk right now", which is not the
 * question — and in this repository it is a question with a moving answer:
 * `tests/renderer-authority-audit.test.mjs` PLANTS `.svelte` and `.ts` files
 * inside `src/lib/compose`, runs the renderer-authority gate against them, and
 * removes them in a `finally`. `node --test` runs test files concurrently, so a
 * walk that lists the directory can read a fixture belonging to another test,
 * mid-flight, in a state that is deliberately malformed.
 *
 * That was always a race. It surfaced when the import reading started failing
 * closed on a component the Svelte compiler cannot parse — the planted nested
 * comment-delimiter fixture is exactly such a file — but a lenient reading only
 * hid it: the walk was scanning a file that is not part of this repository and
 * reporting on it either way.
 *
 * Tracked files are the honest set. They are what the repository ships, what a
 * reviewer sees, and what a fresh checkout contains; an untracked file exists on
 * one machine and cannot be a dependency of anything anyone else builds. This is
 * not a filter on the planted fixture's NAME — a name-based skip would be a
 * suppression, and the next transient fixture would need another one.
 *
 * A tracked path with no file on disk is skipped rather than raising. `git
 * ls-files` reports the index, and a file deleted from the working tree has no
 * content to scan and no import to hide — the deletion IS the removal of its
 * dependencies, so there is nothing here to fail closed about.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every suffix this build loads as a MODULE, which is the set the seam walks
 * have to read.
 *
 * WHY IT IS NOT `\.(svelte|ts)$`. That is what both walks matched, and round 5 of
 * this pull request's review compiled a tracked `agents.svelte.js` — a runes
 * module, ordinary source this build loads — that imported a component from
 * behind a seam. The reading was not the problem; the SET it was pointed at was
 * two suffixes wide, so the file was never opened. A check is only as honest as
 * the files it is given, and "the two extensions this repository happens to
 * carry today" is not a property anyone stated on purpose.
 *
 * So the set is stated by what the build can load: a component, and a module in
 * any of JavaScript's and TypeScript's suffixes. `.svelte.js` and `.svelte.ts`
 * fall out of it rather than being named — they are a `.js` and a `.ts` file —
 * and so does the `.mjs`/`.cjs`/`.mts`/`.cts` family, none of which is in `src/`
 * today and any of which could be tomorrow without a second review round.
 *
 * `.css`, `.json` and assets are outside it: they are not modules whose imports
 * this scan reads, and handing one to the TypeScript parser would only produce a
 * parse error for a file that never had an import.
 *
 * It lives here, exported, because BOTH walks need it and two copies of one
 * pattern is how the second survives the fix to the first — the same reason the
 * reading itself is shared (`../../scripts/lib/module-imports.mjs`).
 */
export const MODULE_SOURCE = /\.(svelte|[cm]?[jt]s)$/;

/**
 * Absolute paths of the tracked files under `directory`, repository-relative,
 * matching `pattern`.
 *
 * The git invocation is pinned to the repository root with `-C` and reads
 * NUL-separated names, so a path containing a space or a newline is one entry
 * rather than several.
 */
export function trackedSource(repoRoot, directory, pattern) {
	const listing = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', directory], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 64,
	});

	return listing
		.split('\0')
		.filter(Boolean)
		.filter((path) => pattern.test(path))
		.map((path) => join(repoRoot, path))
		.filter((path) => existsSync(path) && statSync(path).isFile())
		.sort();
}

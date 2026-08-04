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

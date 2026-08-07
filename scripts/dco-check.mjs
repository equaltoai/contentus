#!/usr/bin/env node
/**
 * DCO enforcement for a pull request's own commits.
 *
 * This logic used to live inline in `.github/workflows/dco.yml`, where the two
 * event-derived SHAs reached `git log` as shell words and the check itself ran as
 * `node -e` program text. Under the workflow scanner's appearance rule an
 * event-derived value may appear in a `run:` script only as argv to a script
 * pinned by content in `contentus-pinned-repo-contract.json`, or as an argument to
 * printf-style data emission. So the workflow now passes the two SHAs to this
 * file as argv and this file is pinned by SHA-256.
 *
 * The parsing below is the inline version verbatim, and `git log` runs through
 * `execFileSync` with an argument vector rather than through a shell, so no
 * spelling of either SHA is ever parsed as program text. A failing `git log` exits
 * with git's own status and message, as it did on the left of a pipeline under
 * `set -o pipefail`.
 *
 * One deliberate difference from the inline version, in the safe direction: an
 * absent SHA is refused rather than passed. `git log "..${HEAD_SHA}"` on an empty
 * `BASE_SHA` is a valid, usually empty revision range, so the inline check reported
 * success when the event payload had not supplied the value it was checking.
 */
import { execFileSync } from 'node:child_process';

const [baseSha, headSha] = process.argv.slice(2);
if (!baseSha || !headSha) {
	console.error('usage: dco-check.mjs <base-sha> <head-sha>');
	process.exit(2);
}

// A failing `git log` exits with git's own status and git's own message, as it did
// when this ran as the left side of a pipeline under `set -o pipefail`.
let log;
try {
	log = execFileSync(
		'git',
		['log', '--no-merges', '--format=%H%x00%B%x00', `${baseSha}..${headSha}`],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
	);
} catch (error) {
	process.exit(typeof error.status === 'number' ? error.status : 1);
}

const parts = log.split('\0');
const bad = [];
for (let i = 0; i + 1 < parts.length; i += 2) {
	const sha = parts[i];
	const body = parts[i + 1];
	if (sha && !/^Signed-off-by: .+ <[^>]+>$/im.test(body)) bad.push(sha);
}
if (bad.length) {
	console.error(`Missing Signed-off-by trailer: ${bad.join(', ')}`);
	process.exit(1);
}

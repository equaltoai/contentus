/**
 * Mutual exclusion for probes that MUTATE real source files while other
 * probes read or build them.
 *
 * WHY THIS EXISTS. `tests/renderer-authority-audit.test.mjs` (and the
 * release-binding probes) plant mutation fixtures OVER real files —
 * `PreviewBody.svelte`, `ReviewWorkspace.svelte`, vendored entries — for the
 * duration of an audit/verifier run, then restore them. Other test files run
 * CONCURRENTLY (node --test runs files in parallel): `review.test.mjs` reads
 * `PreviewBody.svelte`'s source, `act-as-banner.test.mjs` parses
 * `ReviewWorkspace.svelte`, `review-preview-render.test.mjs` compiles
 * `PreviewBody.svelte`, and `seam-graph.test.mjs` runs full vite builds over
 * the tree. When a read or build lands inside a mutation window, the reader
 * sees a fixture (a second `{@html}`, a planted statement, a removed import)
 * and fails for a reason that has nothing to do with the change under test.
 * The round-4 CI ran green by timing; the round-5 suite grew the mutation
 * windows' total span and the race started firing in CI.
 *
 * THE LOCK. A single exclusive lock, held by BOTH sides: the mutator holds
 * it across write → probe → restore, and every reader/build of a
 * probe-mutable file holds it across its read. `mkdir` is atomic, so the
 * lock is a directory creation; the wait loop blocks the thread
 * synchronously via `Atomics.wait` on a shared mailbox (no hot spin, no
 * async plumbing through the probe helpers). A holder that crashes leaves
 * the directory behind, so every acquire has a bounded deadline and FAILS
 * loudly on timeout — never a silent proceed, which would be the race
 * wearing a lock.
 *
 * The lock lives in the OS temp directory, never in the repository, so it
 * cannot dirty a worktree or collide with a build.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `Atomics` and `SharedArrayBuffer` are Node globals; the mailbox is a
// shared buffer so the wait loop blocks the thread without a hot spin.
const LOCK_DIRECTORY = join(tmpdir(), 'contentus-source-probe-lock');
// A single in-flight vite build can hold the lock for well over 30s under
// concurrent load, so the wait budget is generous; a holder that genuinely
// wedges makes the waiter fail loudly after this, never proceed unlocked.
const WAIT_MS = 120_000;
const RETRY_MS = 25;
const mailbox = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `fn` while holding the source-probe lock. Sync callers get a sync
 * result; an async `fn` keeps the lock until its promise settles.
 */
export function withSourceLock(fn) {
	acquire();
	try {
		const result = fn();
		if (result && typeof result.then === 'function') return result.finally(release);
		release();
		return result;
	} catch (error) {
		release();
		throw error;
	}
}

function acquire() {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			mkdirSync(LOCK_DIRECTORY);
			return;
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
			if (Date.now() > deadline)
				throw new Error(
					`source-probe lock: timed out after ${WAIT_MS}ms waiting for ${LOCK_DIRECTORY} — ` +
						'another probe holds it; refusing to read or mutate real source without mutual exclusion'
				);
			Atomics.wait(mailbox, 0, 0, RETRY_MS);
		}
	}
}

function release() {
	try {
		rmSync(LOCK_DIRECTORY, { recursive: true, force: true });
	} finally {
		Atomics.notify(mailbox, 0);
	}
}

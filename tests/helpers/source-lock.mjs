/**
 * Mutual exclusion for probes that MUTATE real source files while other
 * probes read or build them.
 *
 * WHY THIS EXISTS. `tests/renderer-authority-audit.test.mjs` and
 * `tests/greater-release-binding.test.mjs` plant mutation fixtures OVER real
 * files — `PreviewBody.svelte`, `ReviewWorkspace.svelte`, vendored entries,
 * files under `src/lib` — for the duration of an audit/verifier run, then
 * restore them. Other test files run CONCURRENTLY (node --test runs files in
 * parallel): `review.test.mjs` reads `PreviewBody.svelte`'s source,
 * `act-as-banner.test.mjs` parses `ReviewWorkspace.svelte`,
 * `review-preview-render.test.mjs` compiles `PreviewBody.svelte`, and
 * `seam-graph.test.mjs` / `drone-seams.test.mjs` run full vite builds over the
 * tree. When a read or build lands inside a mutation window, the reader sees a
 * fixture (a second `{@html}`, a planted statement, a removed import) and fails
 * for a reason that has nothing to do with the change under test. The round-4
 * CI ran green by timing; the round-5 suite grew the mutation windows' total
 * span and the race started firing in CI.
 *
 * THE LOCK. A cross-process read/write lock over a directory in the OS temp
 * directory (never in the repository, so it cannot dirty a worktree or collide
 * with a build):
 *
 *   /tmp/contentus-source-probe-lock/writers/  — the exclusive mutex. `mkdir`
 *       is atomic, so its creation is the writer's acquisition; an `owner.json`
 *       inside names the holding process.
 *   /tmp/contentus-source-probe-lock/readers/  — one marker file per active
 *       reader, so any number of readers can hold the lock at once.
 *
 * A MUTATOR holds the exclusive side across write → probe → restore. A READER
 * (a file read, a compile, a full vite build — all of which must never resolve
 * a fixture over a shipped file) holds the shared side across its read. The
 * two sides exclude each other: a writer waits for the last reader to drain,
 * and a reader waits for the active writer. Readers do NOT serialize against
 * each other, which is what keeps the suite from waiting minutes behind a
 * broad lock — the round-5 CI failure was a waiter behind a queue of long
 * holds, not behind any single one.
 *
 * The exclusion protocol is the create-then-recheck pair on both sides: a
 * writer creates the mutex dir and then re-checks for reader markers, and a
 * reader creates its marker and then re-checks for the mutex dir. If both
 * sides raced, whichever created its artifact first is seen by the other's
 * recheck and the other backs off; both backing off is just a retry. No
 * interleaving lets both proceed (the overlap would require each recheck to
 * have run before the other side's artifact existed, which contradicts the
 * create-before-check order on both sides).
 *
 * STALE-OWNER SAFETY. The wait loop blocks the thread synchronously via
 * `Atomics.wait` on a shared mailbox (no hot spin, no async plumbing through
 * the probe helpers) and polls the filesystem for cross-process state. A
 * holder that crashes — a killed CI runner, an OOM-killed test process —
 * leaves its marker behind, so before every acquisition attempt a waiter
 * sweeps both sides for markers whose owning pid is dead (or has been recycled
 * to a different process, checked via the process start time on Linux) and
 * removes them. A live holder is never removed by a third party, so exclusion
 * still holds. Every acquire has a bounded deadline and FAILS loudly on
 * timeout — never a silent proceed, which would be the race wearing a lock.
 *
 * REENTRANCY. All acquisitions in one process share one hold: a probe test
 * file that holds the lock for its whole body (before/after hooks) and also
 * calls a locked helper inside it nests without deadlock. A shared hold cannot
 * be upgraded to an exclusive one in the same process — that would wait on
 * itself.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `Atomics` and `SharedArrayBuffer` are Node globals; the mailbox is a
// shared buffer so the wait loop blocks the thread without a hot spin.
// The lock root is the OS temp directory by default; the env override lets a
// probe exercise stale-owner takeover against a scratch root without ever
// touching the live root another suite process may be holding.
const LOCK_ROOT = process.env.CONTENTUS_SOURCE_LOCK_ROOT
	? resolve(process.env.CONTENTUS_SOURCE_LOCK_ROOT)
	: join(tmpdir(), 'contentus-source-probe-lock');
const WRITERS_DIR = join(LOCK_ROOT, 'writers');
const READERS_DIR = join(LOCK_ROOT, 'readers');
// A single hold is short — a mutation window is an audit or verifier child run
// (a few seconds), a read/build hold is a compile or an in-memory vite build.
// Crashed holders are reclaimed by the stale sweep, so a wait that reaches
// this budget means a LIVE holder wedged for two minutes; failing loudly then
// is the point, never proceeding unlocked.
const WAIT_MS = 120_000;
const RETRY_MS = 25;
// The yield a holder leaves after releasing, so cross-process waiters can land
// in the gap. Without it, a probe file whose tests re-acquire the lock back to
// back (a mutator file runs every test under the lock) holds it continuously
// for the file's whole duration: release and re-acquire are adjacent
// synchronous calls, the gap is microseconds, and a waiter polling every
// RETRY_MS can miss every one — starving for minutes behind a lock nobody is
// actually using. The yield is larger than the poll interval, so a waiter's
// next poll always lands inside it.
const RELEASE_YIELD_MS = 30;
// A mutex dir whose `owner.json` was never written (the creating process died
// between the atomic mkdir and the marker write) is reclaimed after this long.
const OWNERLESS_STALE_MS = 10_000;
const mailbox = new Int32Array(new SharedArrayBuffer(4));

// Per-process reentrancy. `mode` is 'exclusive' or 'shared'; nested
// acquisitions of the same (or a weaker) mode just deepen the hold.
let depth = 0;
let mode = null;
let readerMarker = null;
let readerSeq = 0;

/** The process identity a marker records: pid plus Linux process start time. */
function ownerPayload() {
	return { pid: process.pid, boot: bootTimeOf(process.pid) };
}

/**
 * Publish a marker file atomically: write to a temp name, then rename over the
 * final path. A concurrent sweeper in another process then reads either no
 * file or a complete one — never a partial write it could mistake for a dead
 * owner and remove while the holder is live, which would break exclusion.
 */
function writeMarkerAtomic(path, payload) {
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(payload));
	rmSync(path, { force: true });
	renameSync(temp, path);
}

/** Field 22 (`starttime`, clock ticks since boot) of /proc/<pid>/stat. */
function bootTimeOf(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// `comm` (field 2) may itself contain spaces or parentheses, so the
		// numeric fields begin after the LAST `)`. Slicing past the `)` AND the
		// delimiter space puts field 3 at index 0 of the split, so field 22
		// (`starttime` — the stable identity of one process incarnation, which
		// is what distinguishes a live holder from a recycled pid) lands at
		// index 19. Field 23 (`vsize`) at index 20 CHANGES on every allocation,
		// so an off-by-one here silently marks every live holder dead.
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
	} catch {
		return null; // not Linux, or the process vanished mid-read
	}
}

/** Is the pid a live process AND (where verifiable) the same process? */
function isLive(owner) {
	if (!owner) return true; // unreadable is not provably dead — fail closed
	if (owner.unreadable) return true;
	if (!Number.isInteger(owner.pid)) return false;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return error?.code === 'EPERM'; // exists but owned by someone else
	}
	if (owner.boot == null) return true; // nothing to compare — trust pid liveness
	const boot = bootTimeOf(owner.pid);
	return boot == null || boot === owner.boot;
}

function readMarker(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		// A final marker is published atomically, so an unreadable one is not a
		// live holder mid-write; but it is also not provably dead, and sweeping
		// it away could remove a live holder — fail closed and leave it.
		return { unreadable: true };
	}
}

/**
 * Reclaim markers whose owner is dead or recycled. The caller then re-reads
 * the other side, so a removal here can never be the caller's own basis for
 * proceeding — it only makes the next check see the state as it is.
 */
function sweepStale() {
	if (existsSync(WRITERS_DIR)) {
		const ownerPath = join(WRITERS_DIR, 'owner.json');
		if (existsSync(ownerPath)) {
			if (!isLive(readMarker(ownerPath))) rmSync(WRITERS_DIR, { recursive: true, force: true });
		} else {
			try {
				if (Date.now() - statSync(WRITERS_DIR).mtimeMs > OWNERLESS_STALE_MS)
					rmSync(WRITERS_DIR, { recursive: true, force: true });
			} catch {
				// the dir vanished between the existence check and the stat — fine
			}
		}
	}
	if (existsSync(READERS_DIR)) {
		let names;
		try {
			names = readdirSync(READERS_DIR);
		} catch {
			// another sweep removed the empty dir between the check and the
			// read — nothing to sweep
			names = [];
		}
		for (const name of names) {
			const path = join(READERS_DIR, name);
			if (name.endsWith('.tmp')) {
				// A half-published marker: its owner is mid-write or crashed
				// between the write and the atomic rename. Age-bounded removal —
				// never by liveness, which the partial file cannot carry.
				try {
					if (Date.now() - statSync(path).mtimeMs > OWNERLESS_STALE_MS)
						rmSync(path, { force: true });
				} catch {
					// vanished mid-sweep — fine
				}
				continue;
			}
			if (!isLive(readMarker(path))) rmSync(path, { force: true });
		}
		// rmdir only removes an empty directory, so a marker another process
		// registered mid-sweep makes this fail harmlessly and stays intact.
		try {
			rmdirSync(READERS_DIR);
		} catch {
			// not empty (or already gone) — leave it for the next sweep
		}
	}
	try {
		rmdirSync(LOCK_ROOT);
	} catch {
		// not empty (or already gone) — leave it for the next sweep
	}
}

/** Reader markers other than ours that are live — i.e. genuinely held. */
function liveReaderCount() {
	if (!existsSync(READERS_DIR)) return 0;
	let names;
	try {
		names = readdirSync(READERS_DIR);
	} catch {
		return 0; // another sweep removed the empty dir between the check and the read
	}
	let count = 0;
	for (const name of names) {
		const marker = readMarker(join(READERS_DIR, name));
		if (isLive(marker)) count += 1;
	}
	return count;
}

function waitRetry() {
	Atomics.wait(mailbox, 0, 0, RETRY_MS);
}

function acquireExclusive() {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		sweepStale();
		if (!existsSync(WRITERS_DIR) && liveReaderCount() === 0) {
			try {
				// The atomic step is the writers-dir creation; the recursive root
				// creation beforehand is idempotent and gives that step a parent.
				mkdirSync(LOCK_ROOT, { recursive: true });
				mkdirSync(WRITERS_DIR); // atomic: exactly one contender succeeds
			} catch (error) {
				if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error;
				// EEXIST: lost the mutex race. ENOENT: a concurrent sweep removed
				// the empty root between the two mkdirs — recreate and retry.
				if (Date.now() > deadline)
					throw new Error(
						`source-probe lock: timed out after ${WAIT_MS}ms waiting for ${LOCK_ROOT} — ` +
							'another probe holds it; refusing to read or mutate real source without mutual exclusion'
					);
				waitRetry();
				continue;
			}
			writeMarkerAtomic(join(WRITERS_DIR, 'owner.json'), ownerPayload());
			// The recheck that makes the protocol safe: a reader may have
			// registered while the mutex dir was being created.
			if (liveReaderCount() === 0) return;
			rmSync(WRITERS_DIR, { recursive: true, force: true });
		}
		if (Date.now() > deadline)
			throw new Error(
				`source-probe lock: timed out after ${WAIT_MS}ms waiting for ${LOCK_ROOT} — ` +
					'another probe holds it; refusing to read or mutate real source without mutual exclusion'
			);
		waitRetry();
	}
}

function acquireShared() {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		sweepStale();
		if (!existsSync(WRITERS_DIR)) {
			mkdirSync(READERS_DIR, { recursive: true });
			readerMarker = join(READERS_DIR, `${process.pid}-${++readerSeq}.json`);
			try {
				writeMarkerAtomic(readerMarker, ownerPayload());
			} catch (error) {
				// A concurrent sweep rmdir'd the empty readers dir between our
				// mkdir and this write — retry the whole registration.
				readerMarker = null;
				if (error?.code !== 'ENOENT') throw error;
				continue;
			}
			// The recheck that makes the protocol safe: a writer may have taken
			// the mutex while our marker was being written.
			if (!existsSync(WRITERS_DIR)) return;
			rmSync(readerMarker, { force: true });
			readerMarker = null;
		}
		if (Date.now() > deadline)
			throw new Error(
				`source-probe lock: timed out after ${WAIT_MS}ms waiting for ${LOCK_ROOT} — ` +
					'another probe holds it; refusing to read or mutate real source without mutual exclusion'
			);
		waitRetry();
	}
}

/**
 * Acquire the source-probe lock. Exclusive by default (the mutator side);
 * pass `{ shared: true }` for a reader/build that must only exclude mutators,
 * not other readers. Pairs with `releaseSourceLock`. Reentrant within one
 * process: a shared hold cannot be upgraded to an exclusive one.
 */
export function acquireSourceLock({ shared = false } = {}) {
	if (depth > 0) {
		if (mode === 'exclusive' || shared) {
			depth += 1;
			return;
		}
		throw new Error(
			'source-probe lock: cannot upgrade a shared hold to an exclusive one in the same process'
		);
	}
	if (shared) acquireShared();
	else acquireExclusive();
	mode = shared ? 'shared' : 'exclusive';
	depth = 1;
}

/** Release one acquisition. The outermost release of a hold is what frees it. */
export function releaseSourceLock() {
	if (depth === 0)
		throw new Error('source-probe lock: releaseSourceLock() without a matching acquisition');
	depth -= 1;
	if (depth > 0) return;
	try {
		if (mode === 'exclusive') rmSync(WRITERS_DIR, { recursive: true, force: true });
		else if (readerMarker) rmSync(readerMarker, { force: true });
	} finally {
		readerMarker = null;
		mode = null;
		Atomics.notify(mailbox, 0);
		// Let cross-process waiters land before this process re-acquires. The
		// block is synchronous, so the next acquisition in this process cannot
		// start until the window has opened for every waiter's next poll.
		Atomics.wait(mailbox, 0, 0, RELEASE_YIELD_MS);
	}
}

/**
 * Run `fn` while holding the source-probe lock. Sync callers get a sync
 * result; an async `fn` keeps the lock until its promise settles. Exclusive
 * by default; pass `{ shared: true }` for a reader/build hold.
 */
export function withSourceLock(fn, { shared = false } = {}) {
	acquireSourceLock({ shared });
	try {
		const result = fn();
		if (result && typeof result.then === 'function') return result.finally(releaseSourceLock);
		releaseSourceLock();
		return result;
	} catch (error) {
		releaseSourceLock();
		throw error;
	}
}

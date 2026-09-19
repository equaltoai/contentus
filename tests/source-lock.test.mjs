import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { withSourceLock } from './helpers/source-lock.mjs';

/**
 * Focused concurrency probes for the source-probe lock itself.
 *
 * WHY THEY EXIST. The lock is what keeps one test's planted fixture from
 * answering for a shipped file in another test running concurrently. Round 5
 * proved the mechanism by failing: a `__r5_root_symlink__.ts` plant from the
 * release-binding probes was live while the renderer-authority audit walked
 * `src/lib`, and a waiter timed out behind a queue of serialized holds. These
 * probes drive the REAL lock helper across REAL processes — the same shape the
 * suite's parallel test files contend over — and assert the two properties the
 * suite depends on: a mutation window is invisible to concurrent readers, and
 * a crashed holder is reclaimed instead of waited out. They exercise the
 * production control; they do not re-implement it.
 *
 * The plants below live in the OS temp directory, never in `src/`, so these
 * probes cannot interfere with the suite's own tree plants even while they
 * hold the same lock.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HELPER_PATH = fileURLToPath(new URL('./helpers/source-lock.mjs', import.meta.url));

/** Run a worker script in a fresh process; its stdout is its report. */
function runChild(source, onData) {
	const dir = mkdtempSync(join(tmpdir(), 'contentus-source-lock-test-'));
	const file = join(dir, 'worker.mjs');
	writeFileSync(file, source, 'utf8');
	return new Promise((resolveChild) => {
		const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (chunk) => {
			output += chunk;
			if (onData) onData(String(chunk));
		});
		child.stderr.on('data', (chunk) => (output += chunk));
		child.on('close', (code) => {
			rmSync(dir, { recursive: true, force: true });
			resolveChild({ code, output, pid: child.pid });
		});
	});
}

test('a mutation window is invisible to concurrent readers (cross-process)', async () => {
	// The plant path is pid-unique so concurrent instances of this file (the
	// stress runs several at once) cannot observe or disturb each other's
	// windows — the same isolation the lock provides the suite's own plants.
	const plant = join(tmpdir(), `contentus-source-lock-plant-${process.pid}.txt`);
	rmSync(plant, { force: true });

	// The writer holds the EXCLUSIVE side for 1500ms with the plant live the
	// whole time, then removes it. Any reader that acquired the shared side
	// inside that window would see the plant and fail — and the timestamps
	// below prove every reader was blocked until the writer released. Readers
	// are only spawned once the writer reports W-ACQUIRE, so every reader
	// genuinely contends inside the window; a reader that acquired before the
	// writer could otherwise pass the timestamp check without having contended.
	const writer = `
		import { withSourceLock } from ${JSON.stringify(HELPER_PATH)};
		import { writeFileSync, rmSync } from 'node:fs';
		withSourceLock(() => {
			console.log('W-ACQUIRE ' + Date.now());
			writeFileSync(${JSON.stringify(plant)}, 'planted');
			const until = Date.now() + 1500;
			while (Date.now() < until) {}
			rmSync(${JSON.stringify(plant)});
			console.log('W-RELEASE ' + Date.now());
		});
	`;

	const reader = `
		import { withSourceLock } from ${JSON.stringify(HELPER_PATH)};
		import { existsSync } from 'node:fs';
		withSourceLock(() => {
			if (existsSync(${JSON.stringify(plant)}))
				throw new Error('READER SAW THE PLANT — mutual exclusion broken');
			console.log('R-ACQUIRE ' + Date.now());
		}, { shared: true });
	`;

	let writerStarted = false;
	const writerProcess = runChild(writer, (chunk) => {
		if (!writerStarted && chunk.includes('W-ACQUIRE')) writerStarted = true;
	});
	// Wait for the writer's exclusive hold to be live before spawning readers.
	while (!writerStarted) await new Promise((later) => setTimeout(later, 10));
	// Stagger the readers across the remaining window so at least one contends
	// from well inside it; all of them must block until the plant is gone.
	const readerProcesses = [0, 1, 2, 3].map((_, index) =>
		new Promise((later) => setTimeout(later, 100 * (index + 1))).then(() => runChild(reader))
	);

	const results = await Promise.all([writerProcess, ...readerProcesses]);
	const [writerResult, ...readerResults] = results;

	assert.equal(writerResult.code, 0, writerResult.output);
	const release = Number(/W-RELEASE (\d+)/.exec(writerResult.output)?.[1]);
	assert.ok(
		Number.isFinite(release),
		`writer must report its release time:\n${writerResult.output}`
	);

	for (const result of readerResults) {
		assert.equal(result.code, 0, result.output);
		assert.doesNotMatch(result.output, /READER SAW THE PLANT/);
		const acquired = Number(/R-ACQUIRE (\d+)/.exec(result.output)?.[1]);
		assert.ok(Number.isFinite(acquired), `reader must report its acquire time:\n${result.output}`);
		// The proof of exclusion: no reader acquired before the writer released.
		assert.ok(
			acquired >= release,
			`reader acquired at ${acquired} before the writer released at ${release} — ` +
				'it must have been blocked for the whole mutation window'
		);
	}

	// The writer's own cleanup ran: no residue in temp, no live hold anywhere.
	assert.ok(!existsSync(plant), 'the writer must remove its plant on release');
});

test('a crashed holder is taken over, not waited out', async () => {
	// A guaranteed-dead pid: a worker (same disclosed temp-file spawn shape as
	// every other child in this file) that exits immediately.
	const dead = await runChild('process.exit(0);');

	// A scratch lock root, so the fake residue cannot collide with a live hold
	// of the real suite lock. Plant the residue a crashed exclusive holder
	// leaves: the mutex dir with an owner marker naming the dead process.
	const scratch = join(tmpdir(), `contentus-source-lock-scratch-${process.pid}`);
	const writersDir = join(scratch, 'writers');
	mkdirSync(writersDir, { recursive: true });
	writeFileSync(join(writersDir, 'owner.json'), JSON.stringify({ pid: dead.pid, boot: null }));

	// A fresh process acquiring the scratch root must reclaim the stale holder
	// immediately, not wait out the 120s budget. The worker points the helper
	// at the scratch root before importing it (the helper reads the variable at
	// module evaluation).
	const started = Date.now();
	const result = await runChild(
		`
			process.env.CONTENTUS_SOURCE_LOCK_ROOT = ${JSON.stringify(scratch)};
			const { withSourceLock } = await import(${JSON.stringify(HELPER_PATH)});
			withSourceLock(() => { console.log('took over'); });
		`
	);
	const elapsed = Date.now() - started;

	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /took over/);
	assert.ok(elapsed < 10_000, `takeover took ${elapsed}ms; it must not wait the full budget`);

	// The takeover released cleanly: the mutex dir is gone and the root swept.
	rmSync(scratch, { recursive: true, force: true });
});

test('probe plants leave no residue in the real tree', () => {
	// Under the shared lock, so no mutator is mid-window while this looks: a
	// file matching the probe naming that is still on disk is leftover residue
	// from a crashed or skipped cleanup, not a live plant. (A live plant can
	// only exist inside an exclusive hold, which this shared hold excludes.)
	withSourceLock(
		() => {
			const leftovers = [];
			const walk = (directory) => {
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) {
						if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.git')
							continue;
						walk(path);
					} else if (/__r\d|__audit_|__renderer_audit_probe__|_probe__/.test(entry.name)) {
						leftovers.push(path.slice(repoRoot.length + 1));
					}
				}
			};
			walk(join(repoRoot, 'src'));
			assert.deepEqual(leftovers, [], 'planted probe files were left behind in src/');
		},
		{ shared: true }
	);
});

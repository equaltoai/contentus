import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	resolveDiskPath,
	sriOf,
	verifyRecordAgainstRelease,
} from '../gov-infra/verifiers/release-binding.mjs';

/**
 * F4 (round-1 attack): vendored-tree authenticity rests on self-declared
 * manifest state.
 *
 * THE FINDING. `greater doctor` verifies on-disk files against components.json
 * checksums, and CON-4 verifies the manifest's own version/ref/modified fields
 * against the pin — so an author who edits a vendored file AND its checksum
 * (keeping `modified` false) moved both gates at once. The round-1 report
 * independently refuted the CURRENT tree (every digest recomputed, byte-identity
 * with the pinned commit) and named the gap: the control's model, not this
 * artifact.
 *
 * THE FIX. CON-4 now re-derives every vendored file from the release's OWN
 * registry manifest (`registry/index.json` at the pinned commit, digest-pinned
 * in `contentus-pinned-repo-contract.json` under `greater.registry_index` with
 * a bound URL): the on-disk bytes and the recorded checksum must each match the
 * release's canonical bytes for the file's source path — or the digest-verified
 * greater CLI's documented import-transform of those bytes. A coordinated
 * file+checksum edit leaves the recorded checksum disagreeing with the release
 * manifest, and the real gate fails without consulting the manifest's own
 * fields.
 *
 * WHAT RUNS HERE. The synthetic half drives the decision core over hand-built
 * release data. The gate half runs the REAL verifier (`check-greater-pins.mjs`,
 * exactly as CON-4 does) against the REAL tree with a planted coordinated edit
 * — one untransformed file and one CLI-transformed file, each modified with its
 * manifest checksum updated to match — and restores both in `finally`. The tree
 * is asserted clean before the first plant and after the last, so a failing run
 * is evidence about the planted mutation and nothing else.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const componentsPath = join(repoRoot, 'components.json');

function runVerifier() {
	const result = spawnSync(process.execPath, ['gov-infra/verifiers/check-greater-pins.mjs'], {
		// The literal frame, spelled here rather than taken from `repoRoot`
		// above: CON-5 checks the `binds` on this site against the directory
		// this child resolves in, and a cwd held in a constant declared far
		// above is a base no reading can see at the call.
		cwd: fileURLToPath(new URL('..', import.meta.url)),
		encoding: 'utf8',
	});
	return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A transformed vendored file (the #112 Review surface) and an untransformed one. */
const TRANSFORMED_FILE = join(repoRoot, 'src/lib/components/Review/QueueCard.svelte');
const TRANSFORMED_VIRTUAL = 'lib/components/Review/QueueCard.svelte';
const UNTRANSFORMED_FILE = join(repoRoot, 'src/lib/greater/faces/blog/index.ts');
const UNTRANSFORMED_VIRTUAL = 'greater/faces/blog/index.ts';

function manifestChecksumFor(virtualPath) {
	const components = JSON.parse(readFileSync(componentsPath, 'utf8'));
	for (const entry of components.installed ?? []) {
		for (const checksumEntry of entry.checksums ?? []) {
			if (checksumEntry.path === virtualPath)
				return { entry: entry.name, checksum: checksumEntry.checksum };
		}
	}
	return null;
}

/* ---------------------------------------------------------------------------
 * The decision core, over synthetic release data
 * ------------------------------------------------------------------------ */

test('sriOf produces the greater CLI checksum spelling', () => {
	assert.equal(sriOf(Buffer.from('abc')), 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
});

test('resolveDiskPath maps a virtual path through the manifest aliases', () => {
	assert.equal(
		resolveDiskPath('lib/components/Review/QueueCard.svelte', { lib: 'src/lib' }),
		'src/lib/components/Review/QueueCard.svelte'
	);
	assert.equal(
		resolveDiskPath('greater/faces/blog/index.ts', { greater: 'src/lib/greater' }),
		'src/lib/greater/faces/blog/index.ts'
	);
	assert.equal(resolveDiskPath('shared/auth/index.ts', {}), null);
});

test('a file matching the release canonical bytes is bound', () => {
	const verdict = verifyRecordAgainstRelease({
		diskSri: sriOf(Buffer.from('release bytes')),
		recordedChecksum: sriOf(Buffer.from('release bytes')),
		candidates: [{ checksum: sriOf(Buffer.from('release bytes')) }],
	});
	assert.equal(verdict.status, 'canonical');
});

test('a CLI-transformed file is bound to the release through the transform', () => {
	const canonical = "import { Button } from '@equaltoai/greater-components-primitives';\n";
	const transformed = "import { Button } from '../greater/primitives';\n";
	const verdict = verifyRecordAgainstRelease({
		diskSri: sriOf(Buffer.from(transformed)),
		recordedChecksum: sriOf(Buffer.from(transformed)),
		candidates: [{ checksum: sriOf(Buffer.from(canonical)), sourceBytes: Buffer.from(canonical) }],
		transformSource: () => transformed,
	});
	assert.equal(verdict.status, 'transformed');
});

test('a coordinated file+checksum edit is unbound even when the manifest is consistent', () => {
	// The F4 attack shape, at the decision level: the on-disk bytes changed AND
	// the recorded checksum was updated to match them — the manifest is
	// self-consistent. The release's canonical bytes did not change, and no
	// legitimate transform produces the mutated bytes, so the record is unbound.
	const canonical = "import { Button } from '@equaltoai/greater-components-primitives';\n";
	const mutated = "import { Button } from '../greater/primitives';\n// attacker's change\n";
	const verdict = verifyRecordAgainstRelease({
		diskSri: sriOf(Buffer.from(mutated)),
		recordedChecksum: sriOf(Buffer.from(mutated)),
		candidates: [{ checksum: sriOf(Buffer.from(canonical)), sourceBytes: Buffer.from(canonical) }],
		transformSource: () => "import { Button } from '../greater/primitives';\n",
	});
	assert.equal(verdict.status, 'unbound');
});

/* ---------------------------------------------------------------------------
 * The real verifier, over the real tree with a planted coordinated edit
 * ------------------------------------------------------------------------ */

test('the real verifier passes on the untouched tree', () => {
	const { status, output } = runVerifier();
	assert.equal(status, 0, output);
	assert.ok(output.includes('RELEASE-BINDING'), output);
});

test('a coordinated vendored-file+checksum edit fails the real verifier on both file kinds', () => {
	// Plant: modify a vendored file AND update its components.json checksum to
	// the mutated bytes (keeping `modified: false`), so the manifest is fully
	// self-consistent. Both a CLI-transformed file (Review/QueueCard) and an
	// untransformed one (faces/blog/index.ts) are mutated; the release binding
	// must fail on each without ever consulting the manifest's own fields.
	const originals = { files: {}, entries: {} };

	// Snapshot everything that will change.
	for (const [key, file] of [
		['transformed', TRANSFORMED_FILE],
		['untransformed', UNTRANSFORMED_FILE],
	]) {
		originals.files[key] = readFileSync(file, 'utf8');
		originals.entries[key] = manifestChecksumFor(
			key === 'transformed' ? TRANSFORMED_VIRTUAL : UNTRANSFORMED_VIRTUAL
		);
	}
	const components = JSON.parse(readFileSync(componentsPath, 'utf8'));
	const componentsBackup = readFileSync(componentsPath, 'utf8');

	try {
		// The mutation must stay parseable in BOTH file kinds (a `.svelte`
		// template and a `.ts` module): the verifier runs for seconds while
		// other test files walk every tracked src file concurrently, and an
		// unparseable vendored file would fail THEIR parses instead of the
		// binding under test. A `//` line comment is text in Svelte markup and
		// a comment in TypeScript — valid in both, and still a mutation.
		const mutation = '// F4 coordinated-edit mutation probe\n';
		for (const [key, file] of [
			['transformed', TRANSFORMED_FILE],
			['untransformed', UNTRANSFORMED_FILE],
		]) {
			const mutated = `${originals.files[key]}${mutation}`;
			writeFileSync(file, mutated, 'utf8');
			const virtualPath = key === 'transformed' ? TRANSFORMED_VIRTUAL : UNTRANSFORMED_VIRTUAL;
			for (const entry of components.installed ?? []) {
				for (const checksumEntry of entry.checksums ?? []) {
					if (checksumEntry.path === virtualPath)
						checksumEntry.checksum = sriOf(Buffer.from(mutated));
				}
			}
		}
		writeFileSync(componentsPath, JSON.stringify(components, null, '\t') + '\n', 'utf8');

		const { status, output } = runVerifier();

		assert.equal(status, 1, `the coordinated edit must fail the real verifier:\n${output}`);
		assert.ok(
			output.includes(TRANSFORMED_VIRTUAL) && output.includes('neither the on-disk bytes'),
			`the transformed file's unbound state must be named:\n${output}`
		);
		assert.ok(
			output.includes(UNTRANSFORMED_VIRTUAL) && output.includes('neither the on-disk bytes'),
			`the untransformed file's unbound state must be named:\n${output}`
		);
	} finally {
		writeFileSync(TRANSFORMED_FILE, originals.files.transformed, 'utf8');
		writeFileSync(UNTRANSFORMED_FILE, originals.files.untransformed, 'utf8');
		writeFileSync(componentsPath, componentsBackup, 'utf8');
	}
});

test('the probes leave the tree exactly as they found it', () => {
	const { status, output } = runVerifier();
	assert.equal(status, 0, output);
});

/* ============================================================
   R2-4 — manifest/disk universe equality, both directions
   ============================================================ */

/**
 * The round-2 attack closed F4's coordinated-edit shape but proved the binding
 * still skipped two whole classes of mutation: a manifest-listed vendored file
 * deleted from disk (`!existsSync(…) continue`), and an executable file added
 * under a vendored root that no manifest entry lists. Both are now findings —
 * the manifest must exist on disk, and the disk must be inside the release
 * universe. These probes plant each mutation over the REAL tree and read the
 * REAL verifier's exit code.
 */
const MANIFESTED_FILE = join(repoRoot, 'src/lib/greater/icons/app.d.ts');
const MANIFESTED_VIRTUAL = 'greater/icons/app.d.ts';

test('a manifest-listed vendored file deleted from disk fails the real verifier (R2-4)', () => {
	const original = readFileSync(MANIFESTED_FILE, 'utf8');
	const moved = `${MANIFESTED_FILE}.r2-deleted`;
	writeFileSync(moved, original);

	try {
		// The file is gone from its manifest-listed path.
		writeFileSync(MANIFESTED_FILE, '');
		rmSync(MANIFESTED_FILE);

		const { status, output } = runVerifier();
		assert.equal(status, 1, `a deleted manifest-listed file must fail the verifier:\n${output}`);
		assert.ok(
			output.includes(MANIFESTED_VIRTUAL) && output.includes('absent from disk'),
			`the missing file must be named as absent:\n${output}`
		);
	} finally {
		writeFileSync(MANIFESTED_FILE, original);
		rmSync(moved, { force: true });
	}
});

test('an unlisted executable file under a vendored root fails the real verifier (R2-4)', () => {
	const relativePath = 'src/lib/components/__r2_unlisted_probe__.ts';
	const absolute = join(repoRoot, relativePath);
	writeFileSync(
		absolute,
		'export const unlisted = (el: HTMLElement, html: string) => {\n\tel.innerHTML = html;\n};\n'
	);

	try {
		const { status, output } = runVerifier();
		assert.equal(status, 1, `an unlisted vendored file must fail the verifier:\n${output}`);
		assert.ok(
			output.includes(relativePath) && output.includes('no manifest entry lists'),
			`the unlisted file must be named:\n${output}`
		);
	} finally {
		rmSync(absolute, { force: true });
	}
});

test('the probes leave the tree exactly as they found it (R2-4)', () => {
	const { status, output } = runVerifier();
	assert.equal(status, 0, output);
});

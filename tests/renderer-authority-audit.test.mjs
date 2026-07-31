import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Probes for the renderer-authority audit itself.
 *
 * Separate from `renderer-authority.test.mjs`, which probes the body gate: these
 * probe the GATE, by running `node scripts/audit-renderer-authority.mjs` exactly
 * as `pnpm validate` does and reading its exit code.
 *
 * WHY THEY EXIST. The audit's file walk recognized `ts|svelte|mjs|js`. An `.mts`
 * — a module node executes and vite compiles without comment — matched none of
 * them, so the walk never opened it: not for the forbidden-import scan, not for
 * the `{@html}` scan, and not for check 5, whose entire job is to notice source
 * nobody classified. The audit reported clean over a file it had never read. A
 * hand-run differential found it; this file is that differential kept, so the
 * next extension the walk cannot see fails a test instead of passing an audit.
 *
 * Each case PLANTS a fixture, runs the real audit, and removes the fixture in a
 * `finally`. The tree is asserted clean before the first plant and after the
 * last, so a failing run is evidence about the planted file and nothing else —
 * and so a probe that dirtied the repo would be caught by its own last
 * assertion.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** An unclassified directory: named in neither OWNED_SOURCE_DIRS nor VENDORED_*. */
const UNCLASSIFIED_DIR = 'src/lib/__renderer_audit_probe__';

/** A directory the audit is told contentus owns, so checks 2 and 3 scan it. */
const OWNED_DIR = 'src/lib/compose';

function runAudit() {
	const result = spawnSync(process.execPath, ['scripts/audit-renderer-authority.mjs'], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function plant(relativePath, contents) {
	const absolute = join(repoRoot, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
	return absolute;
}

/** Remove the planted file, and the probe directory when it was ours to make. */
function uproot(relativePath) {
	rmSync(join(repoRoot, relativePath), { force: true });
	rmSync(join(repoRoot, UNCLASSIFIED_DIR), { recursive: true, force: true });
}

test('the tree audits clean before anything is planted', () => {
	// The baseline every case below is a differential against. Without it, an
	// exit code of 1 would only prove the audit failed, not that it failed for
	// the reason planted.
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

test('an unclassified file fails the audit whatever its executable extension', () => {
	// The list is stated here rather than imported from the audit: a probe that
	// reads the script's own extension set could only ever agree with it. These
	// are the extensions this toolchain executes or compiles, asserted
	// independently — `.mts` is the one that was missed, `.svelte` the control
	// that was already caught.
	const extensions = ['mts', 'cts', 'cjs', 'tsx', 'jsx', 'ts', 'js', 'mjs', 'svelte'];

	for (const extension of extensions) {
		const relativePath = `${UNCLASSIFIED_DIR}/renderer.${extension}`;
		plant(relativePath, 'export const planted = true;\n');

		try {
			const { status, output } = runAudit();

			assert.equal(status, 1, `an unclassified .${extension} must fail the audit:\n${output}`);
			assert.ok(
				output.includes(`[owned-source coverage] ${relativePath} is scanned by neither`),
				`check 5 must name the .${extension} file it could not classify:\n${output}`
			);
		} finally {
			uproot(relativePath);
		}
	}
});

test('the widened walk feeds the import scan, not only the coverage check', () => {
	// Check 5 is the backstop; this is the thing it is a backstop FOR. A `.mts`
	// inside a directory contentus owns must be read by check 2, so a Markdown
	// renderer imported from one is a finding rather than a file nobody opened.
	const relativePath = `${OWNED_DIR}/__audit_probe__.mts`;
	plant(relativePath, "import { marked } from 'marked';\nexport const render = marked;\n");

	try {
		const { status, output } = runAudit();

		assert.equal(status, 1, output);
		assert.ok(
			output.includes(`[owned-source imports] ${relativePath} imports "marked"`),
			`the import scan must read owned .mts source:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

/* ============================================================
   Check 3, driven as a gate rather than as a function
   ============================================================ */

/**
 * The `{@html}` scan, planted and run.
 *
 * WHY THESE EXIST. The nested-delimiter case — the one that decided how comments
 * are stripped — was only ever exercised by calling a COPY of the routine from a
 * test file. The gate could have been repinned to a different scan and stayed
 * green, because nothing pointed the audit at a file containing the case. The
 * scanner is now one module (`scripts/lib/strip-comments.mjs`), and these plant
 * real Svelte files and read the audit's exit code, so what is asserted is the
 * gate's behaviour rather than a function's.
 *
 * Each case is a differential against the clean baseline above.
 */
const SINK_FIXTURE = `${OWNED_DIR}/__audit_sink_probe__.svelte`;

test('the audit scans with the shared module, not a copy of it', () => {
	// THE COUPLING, pinned. The cases below and the regression in
	// `tests/vendored-messaging-render.test.mjs` are only evidence about the gate
	// while the gate runs the same code they do. A second definition here is how
	// the two drift, and the drift is silent in the dangerous direction.
	const audit = readFileSync(join(repoRoot, 'scripts/audit-renderer-authority.mjs'), 'utf8');

	assert.match(
		audit,
		/import \{ stripComments \} from '\.\/lib\/strip-comments\.mjs'/,
		'the audit must import the shared comment scanner'
	);
	assert.ok(
		!/function stripComments\s*\(/.test(audit),
		'the audit has grown its own copy of the comment scanner again'
	);
});

test('a live {@html} in owned source fails the audit', () => {
	plant(SINK_FIXTURE, '<div>{@html planted}</div>\n');

	try {
		const { status, output } = runAudit();

		assert.equal(status, 1, `a live sink must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[owned-source {@html} sinks] ${SINK_FIXTURE} contains an {@html} sink`),
			`check 3 must name the file it found the sink in:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

test('a live sink hidden behind a nested comment delimiter still fails the audit', () => {
	// THE DANGEROUS DIRECTION, planted as a file. A parser reading this finds its
	// first `<!--` at index 2, so the comment is `<!-- -->` and the `{@html}`
	// after it is LIVE template. A regex strip — or the loop-until-stable that
	// CodeQL's rule recommends — deletes the whole thing and reports clean over
	// a sink that ships. This asserts the gate itself gets it right.
	plant(SINK_FIXTURE, '<!<!-- -->-- {@html planted} -->\n');

	try {
		const { status, output } = runAudit();

		assert.equal(
			status,
			1,
			`a sink after a nested delimiter is live template and must fail:\n${output}`
		);
		assert.ok(
			output.includes(`[owned-source {@html} sinks] ${SINK_FIXTURE} contains an {@html} sink`),
			`check 3 must catch the sink the nested delimiter did not comment out:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

test('a genuinely commented-out sink does not fail the audit', () => {
	// The other half, without which the two above could be satisfied by a scan
	// that never strips anything — and every owned file that EXPLAINS the
	// `{@html}` rule in prose would then be a finding.
	plant(SINK_FIXTURE, '<!-- contentus-owned templates must not contain {@html} -->\n<p>text</p>\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `a commented sink must not fail the audit:\n${output}`);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

test('the probes leave the tree exactly as they found it', () => {
	// Planting inside the real repo is the only way to run the audit as CI runs
	// it. This is the assertion that keeps that honest.
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

import { acquireSourceLock, releaseSourceLock, withSourceLock } from './helpers/source-lock.mjs';

/**
 * Every test in this file walks or plants the real `src/lib` tree: the
 * baselines run the audit over the shipped tree, and every case below plants a
 * fixture over it. Each plant would otherwise be visible to a concurrent
 * reader/build (seam-graph builds, review probes) for the whole audit run, and
 * the audit's own coverage walk would read a fixture another probe test
 * planted. So the whole file runs under the source-probe lock — acquired per
 * test, released in `afterEach` even when the test fails — and the two
 * helpers below nest through the lock's per-process reentrancy.
 */
beforeEach(() => {
	acquireSourceLock();
});

afterEach(() => {
	releaseSourceLock();
});

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
 * ROUND 1'S BYPASSES, KEPT AS PROBES. The adversarial review of #112 planted
 * three shapes that went green through the comment-stripped gate: a `/*` inside
 * a quoted template expression hiding a second computed `{@html}` sink (A), a
 * script-side reassignment of `preview.html` before the verbatim sink (B), and
 * alternate raw-HTML sinks — `.innerHTML` writes and `srcdoc` attributes (C).
 * Each is planted here against the REAL gate, which now reads owned source with
 * the Svelte compiler and TypeScript parser, and each must fail with a path and
 * a reason.
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

/** A directory the audit is told contentus owns, so checks 2, 3, and 7 scan it. */
const OWNED_DIR = 'src/lib/compose';

function runAudit() {
	const result = spawnSync(process.execPath, ['scripts/audit-renderer-authority.mjs'], {
		// SPELLED HERE rather than taken from `repoRoot` above, and that is a control
		// rather than a duplication. The audit's path is written as a literal at this
		// call so CON-5 can check the disclosure that BINDS it against the site — and
		// which file `'scripts/audit-renderer-authority.mjs'` names is decided by the
		// directory this child resolves it in. A cwd held in a constant declared far
		// above is a base no reading can see at the call, exactly as a target held in
		// one is, so the walk would have to guess the base to check the target. Both
		// halves of "the site names what it runs" are written where the child starts.
		cwd: fileURLToPath(new URL('..', import.meta.url)),
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
	const extensions = [
		'mts',
		'cts',
		'cjs',
		'tsx',
		'jsx',
		'ts',
		'js',
		'mjs',
		'svelte',
		'TS',
		'Js',
		'MJS',
		'cJs',
		'TSX',
		'JsX',
		'SVELTE',
	];

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

test('the import scan sees a dynamic renderer import a comment cannot excuse', () => {
	// Round-1's gate read `from 'marked'` with a regex, which a dynamic
	// `import('marked')` — a live loading of the renderer — did not match. The
	// TypeScript reading sees both imports and neither comments nor strings.
	const relativePath = `${OWNED_DIR}/__audit_dynamic_probe__.ts`;
	plant(
		relativePath,
		"// a comment mentioning `from 'marked'` is not an import\n" +
			"export const load = () => import('marked');\n"
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a dynamic renderer import must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[owned-source imports] ${relativePath} imports "marked"`),
			`the import scan must name the dynamic specifier it found:\n${output}`
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
 * WHY THESE EXIST. The gate previously scanned text with comments removed; the
 * round-1 review planted a quoted `/*` that a stripper read as a comment
 * opener, hiding a second computed sink, and the gate stayed green. The scan
 * is now the Svelte compiler's own reading (`scripts/lib/source-scan.mjs`),
 * and these probes plant real Svelte files and read the audit's exit code, so
 * what is asserted is the gate's behaviour rather than a function's.
 *
 * Each case is a differential against the clean baseline above.
 */
const SINK_FIXTURE = `${OWNED_DIR}/__audit_sink_probe__.svelte`;

test('the audit scans with the shared parser modules, not copies of them', () => {
	// THE COUPLING, pinned. The cases below are only evidence about the gate
	// while the gate runs the same code they do. A second definition inside the
	// audit is how the two drift, and the drift is silent in the dangerous
	// direction — a green regression over a gate that has stopped seeing live
	// sinks.
	const audit = readFileSync(join(repoRoot, 'scripts/audit-renderer-authority.mjs'), 'utf8');

	assert.match(
		audit,
		/import \{[\s\S]*\} from '\.\/lib\/source-scan\.mjs'/,
		'the audit must import the shared parser-based scanner'
	);
	assert.match(
		audit,
		/import \{[\s\S]*\} from '\.\/lib\/module-imports\.mjs'/,
		'the audit must import the shared TypeScript module reading'
	);
	assert.ok(
		!/function stripComments\s*\(/.test(audit) && !/function parseSvelte\s*\(/.test(audit),
		'the audit has grown its own copy of a scanner or parser again'
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

test('a sink hidden by quoted comment delimiters is still a live sink and fails (round-1 bypass A)', () => {
	// THE ROUND-1 SHAPE, planted as a file. A comment-stripping scan read the
	// `/*` inside `{'/*'}` as a comment opener and `*/` inside `{'*/'}` as its
	// close, and reported clean over a second, COMPUTED `{@html}` sink between
	// them. The Svelte compiler reads both strings as strings: the two tags are
	// live, and the gate fails on the count and on the non-verbatim binding.
	plant(
		SINK_FIXTURE,
		"<div>{'/*'} {@html planted.slice(0, 100) + '<p>injected</p>'} {'*/'}</div>\n"
	);

	try {
		const { status, output } = runAudit();

		assert.equal(
			status,
			1,
			`a sink hidden by quoted comment delimiters is live template and must fail:\n${output}`
		);
		assert.ok(
			output.includes(`[owned-source {@html} sinks] ${SINK_FIXTURE} contains an {@html} sink`),
			`check 3 must catch the sink the quoted delimiters did not comment out:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

test('a genuinely commented-out sink does not fail the audit', () => {
	// The other half, without which the two above could be satisfied by a scan
	// that never parses anything — and every owned file that EXPLAINS the
	// `{@html}` rule in prose would then be a finding. The compiler reads the
	// comment as a comment.
	plant(SINK_FIXTURE, '<!-- contentus-owned templates must not contain {@html} -->\n<p>text</p>\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `a commented sink must not fail the audit:\n${output}`);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

test('an unparseable owned template fails the audit instead of scanning clean', () => {
	// Fail-closed: a file the toolchain cannot parse is a file whose sinks this
	// gate cannot see, and silence over it is the round-1 failure shape. The
	// compiler throws; the audit turns the throw into a finding.
	plant(SINK_FIXTURE, '<!<!-- -->-- {@html planted} -->\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `an unparseable template must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[owned-source {@html} sinks] ${SINK_FIXTURE} could not be scanned`),
			`check 3 must name the file it could not read:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

/* ============================================================
   The preview display sink — the one exception, content-bound
   ============================================================ */

/**
 * Check 3 admits exactly one owned sink, `src/lib/review/PreviewBody.svelte`,
 * and check 6 binds its shape. These probes plant violations of the binding
 * OVER the real file (restoring it in `finally`) and read the audit's exit
 * code, so what is asserted is the gate's behaviour over the shipped sink,
 * not a copy of it. The clean baseline above already proves the shipped sink
 * passes — these prove the binding bites when it moves.
 */
const DISPLAY_SINK = 'src/lib/review/PreviewBody.svelte';

/** Plant a broken display sink, run the audit, restore the original. */
function withPlantedSink(contents, body) {
	// The whole mutation window — write, probe, restore — runs under the
	// source-probe lock, so concurrent readers/builders of PreviewBody.svelte
	// (review.test.mjs, review-preview-render.test.mjs) never see the fixture.
	withSourceLock(() => {
		const original = readFileSync(join(repoRoot, DISPLAY_SINK), 'utf8');
		writeFileSync(join(repoRoot, DISPLAY_SINK), contents);
		try {
			body();
		} finally {
			writeFileSync(join(repoRoot, DISPLAY_SINK), original);
		}
	});
}

const SINK_SCRIPT_OPEN =
	'<script lang="ts">\n' +
	"\timport type { DraftPreview } from '$lib/cms/review';\n" +
	'\tlet { preview }: { preview: DraftPreview } = $props();\n';

const SINK_TEMPLATE_OPEN = '</script>\n' + '{#if preview.success && preview.html}\n';

test('a second sink in the display component fails the binding', () => {
	withPlantedSink(
		SINK_SCRIPT_OPEN +
			SINK_TEMPLATE_OPEN +
			'\t{@html preview.html}\n{/if}\n' +
			'{@html preview.html}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a second sink must fail the audit:\n${output}`);
			assert.ok(
				output.includes(`[preview display sink binding] ${DISPLAY_SINK} carries 2 {@html} sinks`),
				`the binding check must count the sinks it admitted:\n${output}`
			);
		}
	);
});

test('a second computed sink hidden by quoted delimiters fails the binding (round-1 bypass A)', () => {
	// The exact round-1 probe over the shipped sink: the quoted `/*` and `*/`
	// delimiters make the FIRST sink computed and the count TWO. The compiler
	// sees both tags; the binding fails on both counts.
	withPlantedSink(
		SINK_SCRIPT_OPEN +
			SINK_TEMPLATE_OPEN +
			"\t{'/*'} {@html preview.html.slice(0, 100) + '<p>injected</p>'} {'*/'}\n" +
			'\t{@html preview.html}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a hidden computed sink must fail the audit:\n${output}`);
			assert.ok(
				output.includes(`carries 2 {@html} sinks`),
				`the binding check must count the computed sink the stripper could not:\n${output}`
			);
		}
	);
});

test('a sink bound to anything other than preview.html fails the binding', () => {
	withPlantedSink(
		SINK_SCRIPT_OPEN +
			'\tconst reshaped = preview.html;\n' +
			SINK_TEMPLATE_OPEN +
			'\t{@html reshaped}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a sink bound to a computed value must fail:\n${output}`);
			assert.ok(
				output.includes('no longer binds its sink to `preview.html` verbatim'),
				`the binding check must name the field the sink may display:\n${output}`
			);
		}
	);
});

test('a value import in the display component fails the binding', () => {
	withPlantedSink(
		'<script lang="ts">\n' +
			"\timport { sanitizeHtml } from '$lib/greater/utils';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\tlet { preview }: { preview: DraftPreview } = $props();\n</script>\n' +
			'{#if preview.success && preview.html}\n\t{@html preview.html}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a value import must fail the audit:\n${output}`);
			assert.ok(
				output.includes('carries a value import'),
				`the binding check must reject runtime-reachable imports:\n${output}`
			);
		}
	);
});

test('a transform named in live code fails the binding', () => {
	withPlantedSink(
		'<script lang="ts">\n\timport type { DraftPreview } from \'$lib/cms/review\';\n' +
			'\tlet { preview }: { preview: DraftPreview } = $props();\n' +
			'\tconst sanitizeHtml = (value: string) => value;\n</script>\n' +
			'{#if preview.success && preview.html}\n\t{@html preview.html}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a sanitizer in the live sink must fail:\n${output}`);
			assert.ok(
				output.includes('names "sanitizeHtml"'),
				`the binding check must reject a second sanitization:\n${output}`
			);
		}
	);
});

test('a script-side mutation of preview.html fails the binding (round-1 bypass B)', () => {
	// The round-1 shape: a `$effect` rewriting the preview value in place keeps
	// the sink verbatim — the old gate counted the sink and checked its text and
	// reported clean. The TypeScript reading sees the assignment to the preview
	// value and fails.
	withPlantedSink(
		'<script lang="ts">\n\timport type { DraftPreview } from \'$lib/cms/review\';\n' +
			'\tlet { preview }: { preview: DraftPreview } = $props();\n' +
			"\t$effect(() => { preview.html = preview.html.replace(/x/g, 'y'); });\n" +
			'</script>\n' +
			'{#if preview.success && preview.html}\n\t{@html preview.html}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a script-side mutation must fail the audit:\n${output}`);
			assert.ok(
				output.includes('assigns to the preview value'),
				`the binding check must reject a mutation of the value the sink reads:\n${output}`
			);
		}
	);
});

test('an aliasing statement before the sink fails the binding', () => {
	// An alias that does not itself name the forbidden tokens: `const p =
	// preview` and a rewrite THROUGH the alias still transforms lesser's bytes
	// before the sink, and any statement beyond the one `$props()` destructure
	// is the transform's hiding place.
	withPlantedSink(
		'<script lang="ts">\n\timport type { DraftPreview } from \'$lib/cms/review\';\n' +
			'\tlet { preview }: { preview: DraftPreview } = $props();\n' +
			'\tconst p = preview;\n' +
			'</script>\n' +
			'{#if preview.success && preview.html}\n\t{@html preview.html}\n{/if}\n',
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `an aliasing statement must fail the audit:\n${output}`);
			assert.ok(
				output.includes('declares a variable other than the `$props()` destructure'),
				`the binding check must reject a statement that can hold a transform:\n${output}`
			);
		}
	);
});

test('any other owned sink still fails, with the exception named', () => {
	// The exception admits ONE file. A sink planted anywhere else must still
	// fail check 3, and the finding must point at the pinned display sink as
	// the only permitted one.
	plant(SINK_FIXTURE, '<div>{@html planted}</div>\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, output);
		assert.ok(
			output.includes(`the only pinned display sink is ${DISPLAY_SINK}`),
			`check 3 must name the one exception it admits:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, SINK_FIXTURE), { force: true });
	}
});

/* ============================================================
   Check 7 — alternate raw-HTML sinks
   ============================================================ */

test('an .innerHTML write in owned script fails the audit (round-1 bypass C)', () => {
	const relativePath = `${OWNED_DIR}/__audit_innerhtml_probe__.ts`;
	plant(
		relativePath,
		"const el = document.querySelector('#body');\n" + 'el.innerHTML = preview.html;\n'
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `an innerHTML write must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} writes to .innerHTML`),
			`check 7 must name the alternate sink it found:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('a srcdoc attribute in owned markup fails the audit (round-1 bypass C)', () => {
	const relativePath = `${OWNED_DIR}/__audit_srcdoc_probe__.svelte`;
	plant(relativePath, '<iframe srcdoc={preview.html} title="preview"></iframe>\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a srcdoc attribute must fail the audit:\n${output}`);
		assert.ok(
			output.includes(
				`[alternate raw-HTML sinks] ${relativePath} <iframe srcdoc=…> renders raw HTML`
			),
			`check 7 must name the srcdoc element:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('comment delimiters in strings and comments stay legitimate (no false positives)', () => {
	// The parser reads strings and comments as what they are: `/*` inside a
	// string is a string, `{@html}` inside a comment is a comment, and neither
	// is a sink. This is the guard that keeps the parser-based gate honest in
	// the permissive direction.
	const tsPath = `${OWNED_DIR}/__audit_string_probe__.ts`;
	const sveltePath = `${OWNED_DIR}/__audit_string_probe__.svelte`;
	plant(
		tsPath,
		"export const delimiters = ['/*', '*/', '<!--', '-->'];\n" +
			"export const doc = 'a string naming {@html} is not a sink';\n"
	);
	plant(
		sveltePath,
		"<script lang=\"ts\">export const delimiters = ['/*', '*/'];</script>\n" +
			'<!-- contentus-owned templates must not contain {@html} -->\n' +
			"<p>{'/*'} still a string {'*/'}</p>\n"
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `strings and comments must not fail the audit:\n${output}`);
	} finally {
		rmSync(join(repoRoot, tsPath), { force: true });
		rmSync(join(repoRoot, sveltePath), { force: true });
	}
});

test('the probes leave the tree exactly as they found it', () => {
	// Planting inside the real repo is the only way to run the audit as CI runs
	// it. This is the assertion that keeps that honest.
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

/* ============================================================
   R2-1 — the preview value path, bound at the caller
   ============================================================ */

/**
 * The round-2 attack closed F1/F3 but proved the sink binding was not the whole
 * path: a parent transform planted in ReviewWorkspace.svelte — a `$derived`
 * that spreads `preview` and rewrites `preview.html` before
 * `<PreviewBody preview={shown} />` — passed every check that only read
 * PreviewBody.svelte. These probes plant the same shapes OVER the real files
 * (restoring them in `finally`) and read the real audit's exit code, so what is
 * asserted is the gate's behaviour over the shipped tree, not a copy of it.
 */
const REVIEW_WORKSPACE = 'src/lib/routes/ReviewWorkspace.svelte';
const PREVIEW_STATE_ANCHOR = 'let preview = $state<DraftPreview | null>(null);\n';
const PREVIEW_INVOCATION = '<PreviewBody {preview} />';

/** Plant a broken review workspace, run the audit, restore the original. */
function withPlantedWorkspace(mutate, body) {
	// Same mutual exclusion as withPlantedSink: ReviewWorkspace.svelte is read
	// by review.test.mjs / act-as-banner.test.mjs and built by seam-graph and
	// the production build, so the fixture must never be visible mid-window.
	withSourceLock(() => {
		const original = readFileSync(join(repoRoot, REVIEW_WORKSPACE), 'utf8');
		const mutated = mutate(original);
		writeFileSync(join(repoRoot, REVIEW_WORKSPACE), mutated);
		try {
			body();
		} finally {
			writeFileSync(join(repoRoot, REVIEW_WORKSPACE), original);
		}
	});
}

test('a parent $derived transform between loadDraftPreview and the sink fails the audit (round-2 R2-1)', () => {
	// THE ROUND-2 SHAPE, verbatim in spirit: a derived value that spreads the
	// preview and rewrites its html, then binds the sink to the derived value.
	withPlantedWorkspace(
		(source) =>
			source
				.replace(
					PREVIEW_STATE_ANCHOR,
					PREVIEW_STATE_ANCHOR +
						'\tconst shown = $derived(\n' +
						'\t\tpreview && preview.success\n' +
						"\t\t\t? { ...preview, html: preview.html.replace('<p>', '<p data-planted=\"1\">') }\n" +
						'\t\t\t: preview\n' +
						'\t)\n'
				)
				.replace(PREVIEW_INVOCATION, '<PreviewBody preview={shown} />'),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a parent transform must fail the audit:\n${output}`);
			assert.ok(
				output.includes('[preview value path]') &&
					output.includes('preview value must be the loadDraftPreview result verbatim'),
				`check 8 must name the transformed binding:\n${output}`
			);
		}
	);
});

test('a direct assignment of a reconstructed DraftPreview fails the audit (round-2 R2-1)', () => {
	// The same reconstruction without the $derived wrapper: `preview` itself is
	// reassigned from an object spread that rewrites html. The verbatim sink in
	// PreviewBody still reads `preview.html`, so a sink-only binding would pass.
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\t$effect(() => {\n' +
					"\t\tpreview = { ...preview, html: preview.html.replace(/x/g, 'y') };\n" +
					'\t});\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a reconstructed DraftPreview must fail the audit:\n${output}`);
			assert.ok(
				output.includes('preview value must be the loadDraftPreview result verbatim'),
				`check 8 must reject the object-literal binding:\n${output}`
			);
		}
	);
});

test('a write to preview.html in the calling file fails the audit (round-2 R2-1)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR + '\t$effect(() => { preview.html = preview.html.slice(0, 100); });\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a mutation of preview.html must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to preview.html'),
				`check 8 must name the mutated field:\n${output}`
			);
		}
	);
});

test('an object spread of the preview in the calling file fails the audit (round-2 R2-1)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR + '\tconst copy = { ...preview };\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `a spread reconstruction must fail the audit:\n${output}`);
			assert.ok(
				output.includes('spreads preview into a new object'),
				`check 8 must name the reconstruction:\n${output}`
			);
		}
	);
});

test('preview mutation APIs fail independently of direct property writes (round-4 F1)', () => {
	const mutations = [
		"Object.assign(preview, { html: '<p>planted</p>' });",
		"Reflect.set(preview, 'html', '<p>planted</p>');",
		"Object.defineProperty(preview, 'html', { value: '<p>planted</p>' });",
	];
	for (const mutation of mutations) {
		withPlantedWorkspace(
			(source) =>
				source.replace(
					PREVIEW_STATE_ANCHOR,
					PREVIEW_STATE_ANCHOR + `\t$effect(() => { ${mutation} });\n`
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `${mutation} must fail the production audit:\n${output}`);
				assert.match(output, /mutates preview through/);
			}
		);
	}
});

test('wrapper, dynamic-component, and store-mediated PreviewBody routes fail (round-4 F1)', () => {
	const wrapper = `${OWNED_DIR}/__r4_preview_wrapper__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\nimport PreviewBody from \'$lib/review/PreviewBody.svelte\';\nlet { p } = $props();\n</script>\n<PreviewBody preview={p} />\n'
	);
	try {
		let result = runAudit();
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /wrappers and cross-file forwarding/);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}

	for (const replacement of [
		'<svelte:component this={PreviewBody} preview={preview} />',
		'<PreviewBody preview={$pv} />',
	]) {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_STATE_ANCHOR,
						PREVIEW_STATE_ANCHOR +
							(replacement.includes('$pv')
								? '\tconst pv = { subscribe() {}, set() {}, update() {} };\n'
								: '')
					)
					.replace(PREVIEW_INVOCATION, replacement),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `${replacement} must fail the production audit:\n${output}`);
				assert.match(output, /dynamic component route|canonical invocation must pass/);
			}
		);
	}
});

test('$state.raw(null) is an authorized null initialization (round-4 F6 positive)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				'let preview = $state.raw<DraftPreview | null>(null);\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 0, output);
		}
	);
});

/* ============================================================
   R2-2 — the round-2 alternate sink / parser evasions
   ============================================================ */

/**
 * Each round-2 evasion shape, planted as an owned fixture and run against the
 * real audit. The shapes are the ones the standing attack planted and the old
 * gate stayed green for: computed element/member access, `Reflect.set`,
 * `Object.assign` to a DOM receiver, `createContextualFragment`, script-side
 * `frame.srcdoc`, iframe attribute spreads, an aliased document, and a
 * non-literal dynamic `import(pkg)`.
 */

test('a folded computed key targeting innerHTML fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_computed_key__.ts`;
	plant(
		relativePath,
		"export const p = (el: HTMLElement, html: string) => {\n\tel['inner' + 'HTML'] = html;\n};\n"
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a folded computed key must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} writes to .innerHTML`),
			`check 7 must fold the concatenated key:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('a computed key no static read can fold fails the audit, even on an unproven receiver (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_computed_dynamic__.ts`;
	plant(
		relativePath,
		'export const p = (el: HTMLElement, html: string, key: string) => {\n\tel[key] = html;\n};\n'
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a dynamic computed key must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} writes through a computed key`),
			`check 7 must fail closed on the unresolvable key:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('Reflect.set with a raw-HTML property fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_reflect_set__.ts`;
	plant(
		relativePath,
		"export const p = (el: HTMLElement, html: string) => {\n\tReflect.set(el, 'innerHTML', html);\n};\n"
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `Reflect.set must fail the audit:\n${output}`);
		assert.ok(
			output.includes(
				`[alternate raw-HTML sinks] ${relativePath} calls Reflect.set with 'innerHTML'`
			),
			`check 7 must name the Reflect.set target:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('Object.assign with a raw-HTML key fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_object_assign__.ts`;
	plant(
		relativePath,
		'export const p = (el: HTMLElement, html: string) => {\n\tObject.assign(el, { innerHTML: html });\n};\n'
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `Object.assign must fail the audit:\n${output}`);
		assert.ok(
			output.includes(
				`[alternate raw-HTML sinks] ${relativePath} calls Object.assign with 'innerHTML'`
			),
			`check 7 must name the dangerous key:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('createContextualFragment fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_range__.ts`;
	plant(
		relativePath,
		'export const p = (html: string) => {\n\tdocument.createRange().createContextualFragment(html);\n};\n'
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `createContextualFragment must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} calls .createContextualFragment`),
			`check 7 must name the method:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('a script-side frame.srcdoc write fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_srcdoc_write__.ts`;
	plant(
		relativePath,
		"export const p = (html: string) => {\n\tconst frame = document.createElement('iframe');\n\tframe.srcdoc = html;\n};\n"
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a srcdoc write must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} writes to .srcdoc`),
			`check 7 must catch the script-side srcdoc write:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('an iframe attribute spread fails the audit, in Svelte markup and JSX (R2-2)', () => {
	const sveltePath = `${OWNED_DIR}/__r2_iframe_spread__.svelte`;
	plant(
		sveltePath,
		'<script lang="ts">\n\tconst frameProps: Record<string, string> = { srcdoc: \'<p>planted</p>\' };\n</script>\n\n<iframe {...frameProps}></iframe>\n'
	);
	const tsxPath = `${OWNED_DIR}/__r2_iframe_spread__.tsx`;
	plant(tsxPath, 'export const p = (props: Record<string, string>) => <iframe {...props} />;\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `an iframe spread must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`${sveltePath} <iframe {...spread}> spreads its attributes`),
			`check 7 must catch the Svelte spread:\n${output}`
		);
		assert.ok(
			output.includes(`${tsxPath} spreads attributes onto an <iframe>`),
			`check 7 must catch the JSX spread:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, sveltePath), { force: true });
		rmSync(join(repoRoot, tsxPath), { force: true });
	}
});

test('an aliased document write fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_doc_alias__.ts`;
	plant(
		relativePath,
		'export const p = (html: string) => {\n\tconst d = globalThis.document;\n\td.write(html);\n};\n'
	);

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `an aliased document write must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`[alternate raw-HTML sinks] ${relativePath} calls document.write`),
			`check 7 must follow the alias to the document:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('a non-literal dynamic import fails the audit (R2-2)', () => {
	const relativePath = `${OWNED_DIR}/__r2_dynamic_pkg__.ts`;
	plant(relativePath, 'export const load = (pkg: string) => import(pkg);\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `a computed dynamic import must fail the audit:\n${output}`);
		assert.ok(
			output.includes(
				`[owned-source imports] ${relativePath} loads a module no static read can name`
			),
			`check 2 must fail closed on the computed specifier:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('legitimate non-sink shapes stay clean (R2-2 negative controls)', () => {
	// The strengthened scan must not become a text token search: process-stream
	// writes, store-state Object.assign merges, and container computed writes
	// are all legitimate owned-code shapes, and each must stay clean.
	const tsPath = `${OWNED_DIR}/__r2_legit__.ts`;
	const sveltePath = `${OWNED_DIR}/__r2_legit__.svelte`;
	plant(
		tsPath,
		"export const a = () => process.stdout.write('x');\n" +
			'export const b = (state: any, partial: any) => { Object.assign(state, partial); };\n' +
			'export const c = (lower: string, value: string) => {\n' +
			'\tconst headers: Record<string, string> = {};\n' +
			'\theaders[lower] = value;\n' +
			'};\n' +
			'export const d = (key: string, value: string) => { const state = $state({}); state[key] = value; };\n' +
			"export const e = (key: string, value: string) => { const data = JSON.parse('{}'); data[key] = value; };\n"
	);
	plant(sveltePath, '<p>no sinks here</p>\n');

	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `legitimate shapes must not fail the audit:\n${output}`);
	} finally {
		rmSync(join(repoRoot, tsPath), { force: true });
		rmSync(join(repoRoot, sveltePath), { force: true });
	}
});

test('round-4 alternate sink laundering forms fail the production audit (F2)', () => {
	const attacks = [
		"Object.defineProperty(el, 'innerHTML', { value: html });",
		"Object.defineProperty(frame, 'srcdoc', { value: html });",
		'Object.defineProperties(el, { innerHTML: { value: html } });',
		"frame.setAttribute('srcdoc', html);",
		"frame.setAttributeNS(null, 'srcdoc', html);",
		'Range.prototype.createContextualFragment.call(range, html);',
		'document.write.call(document, html);',
		'Element.prototype.insertAdjacentHTML.call(el, "beforeend", html);',
		'const { write } = document; write(html);',
		"new DOMParser().parseFromString(html, 'text/html');",
	];
	for (let index = 0; index < attacks.length; index += 1) {
		const relativePath = `${OWNED_DIR}/__r4_sink_${index}__.ts`;
		plant(
			relativePath,
			`export const attack = (el: any, frame: any, range: any, html: string) => { ${attacks[index]} };\n`
		);
		try {
			const { status, output } = runAudit();
			assert.equal(status, 1, `${attacks[index]} must fail the production audit:\n${output}`);
			assert.ok(output.includes(`[alternate raw-HTML sinks] ${relativePath}`), output);
		} finally {
			rmSync(join(repoRoot, relativePath), { force: true });
		}
	}
});

/* ============================================================
   R5-1 — the authorized VALUE, bound across aliases, helpers,
   wrappers, and dynamic routes
   ============================================================ */

/**
 * The round-5 review planted six shapes that left the R2-1 reading green
 * while lesser's bytes were still replaced before the sink: a declaration
 * alias writing `p1.html`, a cross-file helper (`manglePreview(preview)`), a
 * local helper whose parameter is written, parenthesized/non-null receivers,
 * an assignment alias laundered into `Object.assign`, and a compile-valid
 * DYNAMIC route with no static import at all. Each is planted over the real
 * canonical file and must fail the real audit; the attack shapes — closures,
 * helper returns, arrays/maps, runes, destructuring via a holder — are
 * planted beside them; and the paired positives (a read-only helper, an
 * optional-chained read) must stay clean.
 */
const PREVIEW_IMPORT = "import PreviewBody from '$lib/review/PreviewBody.svelte';\n";

test('a declaration alias writing p1.html fails the audit (R5-1 #1)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR + "\tconst p1 = preview; if (p1) p1.html = '<img src=x onerror=1>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the declaration-alias write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to p1.html'),
				`check 8 must follow the alias to the write:\n${output}`
			);
		}
	);
});

test('a call of the value into an imported helper fails the audit (R5-1 #2)', () => {
	// The helper module is PLANTED on disk beside the workspace mutation, so the
	// probe stays build-valid while it is live — an import from a module that
	// does not exist would break any build running concurrently with this test.
	const helper = `${OWNED_DIR}/__r5_mangle_helper__.ts`;
	plant(
		helper,
		'export function manglePreview(p: { html: string } | null) {\n' +
			"\tif (p) p.html = '<img onerror=1>';\n" +
			'}\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source.replace(
					PREVIEW_STATE_ANCHOR,
					PREVIEW_STATE_ANCHOR +
						`\timport { manglePreview } from '$lib/compose/__r5_mangle_helper__';\n` +
						'\tmanglePreview(preview);\n'
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the cross-file helper call must fail the audit:\n${output}`);
				assert.ok(
					output.includes('passes the preview value to manglePreview(…)'),
					`check 8 must fail closed on the imported callee:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, helper), { force: true });
	}
});

test('a local helper whose parameter is written fails the audit (R5-1 #3)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tfunction applyPreviewPatch(p: DraftPreview) {\n' +
					"\t\tif (p) p.html = '<img onerror=1>';\n" +
					'\t}\n' +
					'\tapplyPreviewPatch(preview);\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the local helper call must fail the audit:\n${output}`);
			assert.ok(
				output.includes('whose parameter is written'),
				`check 8 must analyze the helper's own parameter writes:\n${output}`
			);
		}
	);
});

test('wrapper-node receivers on the preview write fail the audit (R5-1 #4)', () => {
	for (const write of [
		"(preview).html = '<img onerror=1>';",
		"preview!.html = '<img onerror=1>';",
		"(preview as DraftPreview).html = '<img onerror=1>';",
	]) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + `\t${write}\n`),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `${write} must fail the audit:\n${output}`);
				assert.ok(
					output.includes('writes to preview.html'),
					`check 8 must unwrap the wrapper node:\n${output}`
				);
			}
		);
	}
});

test('an assignment alias laundered into Object.assign fails the audit (R5-1 #5)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tlet forwarded; forwarded = preview;\n' +
					"\tObject.assign(forwarded, { html: '<img onerror=1>' });\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the assignment-alias mutation must fail the audit:\n${output}`);
			assert.ok(
				output.includes('mutates forwarded through Object.assign'),
				`check 8 must follow the assignment form of the alias:\n${output}`
			);
		}
	);
});

test('a dynamic import plus svelte:component route fails the audit with no static import (R5-1 #6)', () => {
	// The plant: drop the canonical static import, load the sink module with a
	// dynamic import, and invoke it through <svelte:component> — a route no
	// static reading could previously prove, and one that left the check silent.
	// The `.then` spelling (rather than a top-level `await import(…)`) keeps the
	// plant BUILD-valid, so this probe cannot break a concurrent build the way
	// the finding's literal `await` spelling would (Svelte rejects top-level
	// await in a component); the audit's reading catches the dynamic specifier
	// and the dynamic component route either way.
	withPlantedWorkspace(
		(source) =>
			source
				.replace(PREVIEW_IMPORT, '')
				.replace(
					PREVIEW_STATE_ANCHOR,
					"const previewSink = import('$lib/review/PreviewBody.svelte').then((m) => m.default);\n" +
						PREVIEW_STATE_ANCHOR
				)
				.replace(PREVIEW_INVOCATION, '<svelte:component this={previewSink} {preview} />'),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the dynamic route must fail the audit:\n${output}`);
			assert.ok(
				output.includes('dynamically imports the PreviewBody module'),
				`check 8 must not go silent without a static import:\n${output}`
			);
			assert.ok(
				output.includes('svelte:component'),
				`check 8 must reject the dynamic component route:\n${output}`
			);
		}
	);
});

test('a closure returning the preview and a write through the returned value fail (R5-1 helper returns)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst getP = () => preview;\n' +
					"\tconst p2 = getP();\n\tp2.html = '<img onerror=1>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the helper-return write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to p2.html'),
				`check 8 must bind a preview-returning helper's result:\n${output}`
			);
		}
	);
});

test('a holder-object destructure laundering the preview fails (R5-1 destructuring)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst holder = { preview };\n' +
					"\tconst p3 = holder.preview;\n\tp3.html = '<img onerror=1>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the holder destructure must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to p3.html'),
				`check 8 must follow the value through the container property:\n${output}`
			);
		}
	);
});

test('an array-mediated write fails (R5-1 arrays) and a Map-set write fails (R5-1 maps)', () => {
	const shapes = [
		{
			name: 'array',
			plant: "\tconst arr = [preview];\n\tarr[0].html = '<img onerror=1>';\n",
			match: /entered a local container/,
		},
		{
			name: 'map',
			plant:
				'\tconst m = new Map<string, DraftPreview>();\n' +
				"\tm.set('p', preview);\n" +
				"\tm.get('p')!.html = '<img onerror=1>';\n",
			match: /entered a local container/,
		},
	];
	for (const shape of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + shape.plant),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${shape.name}-mediated write must fail the audit:\n${output}`);
				assert.match(output, shape.match);
			}
		);
	}
});

test('a $state wrapper of the preview is a same-reference alias (R5-1 runes)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR + "\tconst pv = $state(preview);\n\tpv.html = '<img onerror=1>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the rune-wrapped write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to pv.html'),
				`check 8 must treat $state(preview) as the same reference:\n${output}`
			);
		}
	);
});

test('multiple PreviewBody invocations fail the canonical-route count (R5-1 multiple invocations)', () => {
	withPlantedWorkspace(
		(source) => source.replace(PREVIEW_INVOCATION, `${PREVIEW_INVOCATION}\n${PREVIEW_INVOCATION}`),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `two invocations must fail the audit:\n${output}`);
			assert.ok(
				output.includes('2 static PreviewBody invocations'),
				`check 8 must count every invocation:\n${output}`
			);
		}
	);
});

test('a read-only helper and an optional-chained read stay clean (R5-1 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst titleOf = (p: DraftPreview) => p.title;\n' +
					'\tconst t = titleOf(preview);\n' +
					'\tconst firstError = preview?.errors?.[0];\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 0, `read-only shapes must stay clean:\n${output}`);
		}
	);
});

/* ============================================================
   R5-4 — alternate sink laundering
   ============================================================ */

/**
 * The round-5 review planted four laundering shapes the round-4 gate stayed
 * green for: a destructured, RENAMED dangerous method off a DOM receiver; an
 * identifier-laundered Object.assign source; case-insensitive srcdoc
 * attributes in Svelte; and `document.execCommand('insertHTML', …)`. Each is
 * planted as owned source and must fail the real audit; the adjacent shapes
 * (document aliases, benign destructures, execCommand('copy')) must behave
 * exactly as planted.
 */
test('a destructured renamed insertAdjacentHTML on a DOM receiver fails (R5-4)', () => {
	const relativePath = `${OWNED_DIR}/__r5_destructure__.ts`;
	plant(
		relativePath,
		'export const a = (html: string) => {\n' +
			'\tconst { insertAdjacentHTML: inject } = document.body;\n' +
			"\tinject('afterbegin', html);\n" +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the renamed destructure must fail the audit:\n${output}`);
		assert.ok(
			output.includes(
				`[alternate raw-HTML sinks] ${relativePath} destructures .insertAdjacentHTML`
			),
			`check 7 must name the destructured method:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('a destructured dangerous method off an UNKNOWN receiver fails closed (R5-4)', () => {
	const relativePath = `${OWNED_DIR}/__r5_destructure_unknown__.ts`;
	plant(
		relativePath,
		'export const a = (el: any, html: string) => {\n' +
			'\tconst { insertAdjacentHTML } = el;\n' +
			"\tinsertAdjacentHTML('beforeend', html);\n" +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `an unproven-receiver destructure must fail closed:\n${output}`);
		assert.ok(
			output.includes('cannot prove is not a DOM object'),
			`check 7 must fail closed on the unproven receiver:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('an identifier-laundered Object.assign source carrying srcdoc fails (R5-4)', () => {
	const relativePath = `${OWNED_DIR}/__r5_assign_launder__.ts`;
	plant(
		relativePath,
		'export const a = (frame: any, html: string) => {\n' +
			'\tconst payload = { srcdoc: html };\n' +
			'\tObject.assign(frame, payload);\n' +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the laundered source must fail the audit:\n${output}`);
		assert.ok(
			output.includes('carried by payload'),
			`check 7 must see the dangerous key through the name:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('case-insensitive srcdoc attributes in Svelte markup fail (R5-4)', () => {
	for (const [index, attribute] of ['SRCDOC={html}', 'srcDoc={html}'].entries()) {
		const relativePath = `${OWNED_DIR}/__r5_srcdoc_case_${index}__.svelte`;
		plant(relativePath, `<iframe ${attribute}></iframe>\n`);
		try {
			const { status, output } = runAudit();
			assert.equal(status, 1, `<iframe ${attribute}> must fail the audit:\n${output}`);
			assert.ok(
				output.includes(`<iframe srcdoc=…> renders raw HTML`),
				`check 7 must match the attribute case-insensitively:\n${output}`
			);
		} finally {
			rmSync(join(repoRoot, relativePath), { force: true });
		}
	}
});

test('document.execCommand("insertHTML") fails; execCommand("copy") stays clean (R5-4)', () => {
	const sink = `${OWNED_DIR}/__r5_exec_insert__.ts`;
	plant(
		sink,
		"export const a = (html: string) => { document.execCommand('insertHTML', false, html); };\n"
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `execCommand('insertHTML') must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`calls .execCommand('insertHTML'`),
			`check 7 must name the legacy insertion primitive:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, sink), { force: true });
	}

	const copy = `${OWNED_DIR}/__r5_exec_copy__.ts`;
	plant(copy, "export const a = () => { document.execCommand('copy'); };\n");
	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `execCommand('copy') is not an HTML insertion:\n${output}`);
	} finally {
		rmSync(join(repoRoot, copy), { force: true });
	}
});

test('setAttribute with a case-shifted srcdoc name fails (R5-4 adjacent)', () => {
	const relativePath = `${OWNED_DIR}/__r5_setattr_case__.ts`;
	plant(
		relativePath,
		"export const a = (frame: any, html: string) => { frame.setAttribute('SRCDOC', html); };\n"
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `setAttribute('SRCDOC') must fail the audit:\n${output}`);
		assert.ok(
			output.includes(`calls .setAttribute(…) with 'SRCDOC'`),
			`check 7 must lowercase the attribute name:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('legitimate destructures and object sources stay clean (R5-4 negatives)', () => {
	const relativePath = `${OWNED_DIR}/__r5_launder_neg__.ts`;
	plant(
		relativePath,
		'export const a = (state: any, partial: any, html: string) => {\n' +
			'\tconst { insertAdjacentHTML } = { insertAdjacentHTML: html };\n' +
			'\tconst payload = { text: html };\n' +
			'\tObject.assign(state, payload);\n' +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `benign destructures and sources must stay clean:\n${output}`);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

/* ============================================================
   R5-5 — $state.raw container recognition
   ============================================================ */

test('$state.raw(<object/array literal>) is a legitimate container (R5-5 positive)', () => {
	const relativePath = `${OWNED_DIR}/__r5_stateraw_pos__.ts`;
	plant(
		relativePath,
		'export const a = (k: string, v: string) => {\n' +
			'\tconst s = $state.raw({ a: 1 });\n' +
			'\ts[k] = v;\n' +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `$state.raw of a provable container must stay clean:\n${output}`);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

test('$state.raw(<unprovable receiver>) fails closed on a computed write (R5-5 negative)', () => {
	const relativePath = `${OWNED_DIR}/__r5_stateraw_neg__.ts`;
	plant(
		relativePath,
		'export const a = (k: string, v: string, seed: unknown) => {\n' +
			'\tconst s = $state.raw(seed);\n' +
			'\ts[k] = v;\n' +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `$state.raw of an unprovable receiver must fail closed:\n${output}`);
		assert.ok(
			output.includes('writes through a computed key'),
			`check 7 must fail closed on the unproven receiver:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});

/* ============================================================
   R6-1 — the cross-file preview route (component/value flow)
   ============================================================ */

/**
 * The round-6 review planted a SECOND preview route built from parts the
 * per-file reading could not see together: the canonical file hands the
 * PreviewBody COMPONENT and the preview VALUE to a wrapper through props, and
 * the wrapper invokes them via `<svelte:component this={body} preview={value}/>`
 * with no PreviewBody import of its own — so `previewReach` stayed false in
 * the wrapper and the dynamic route scanned clean. Each plant below must fail
 * the real audit, and the paired positives (unrelated props, benign
 * svelte:component use) must stay green.
 */

test('a component-as-prop forwarded to a svelte:component route fails (R6-1 exact plant)', () => {
	const wrapper = `${OWNED_DIR}/__r6_forward_plant__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			'\tlet { body, value } = $props();\n' +
			"\t$effect(() => { value.html = '<img src=x onerror=alert(1)>'; });\n" +
			'</script>\n' +
			'<svelte:component this={body} preview={value} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT +
							"\timport PreviewForwardPlant from '$lib/compose/__r6_forward_plant__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<PreviewForwardPlant body={PreviewBody} value={preview} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the forwarded dynamic route must fail the audit:\n${output}`);
				assert.match(
					output,
					/svelte:component this=\{body\}> with a preview attribute/,
					`the wrapper's own dynamic route must fail closed:\n${output}`
				);
				assert.match(
					output,
					/forwards the PreviewBody component through the body prop/,
					`the canonical file must not hand the component out:\n${output}`
				);
				assert.match(
					output,
					/passes `preview` through the value prop/,
					`the canonical file must not hand the value out:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('a renamed wrapper prop forwarding PreviewBody fails (R6-1 adjacent renamed)', () => {
	const wrapper = `${OWNED_DIR}/__r6_renamed_wrapper__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			"import PreviewBody from '$lib/review/PreviewBody.svelte';\n" +
			'\tlet { body, p } = $props();\n' +
			'</script>\n' +
			'<PreviewBody preview={p} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT +
							"\timport RenamedWrapper from '$lib/compose/__r6_renamed_wrapper__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<RenamedWrapper body={PreviewBody} p={preview} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the renamed wrapper route must fail the audit:\n${output}`);
				assert.match(
					output,
					/forwards the PreviewBody component through the body prop/,
					`the component-escape must be named:\n${output}`
				);
				assert.match(
					output,
					/passes `preview` through the p prop/,
					`the renamed prop flow must be followed:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('a spread onto a preview-forwarding wrapper fails (R6-1 adjacent spread)', () => {
	const wrapper = `${OWNED_DIR}/__r6_spread_wrapper__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			'\tlet { body } = $props();\n' +
			'\tlet rest = $props();\n' +
			'</script>\n' +
			'<svelte:component this={body} {...rest} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT +
							"\timport SpreadWrapper from '$lib/compose/__r6_spread_wrapper__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<SpreadWrapper body={PreviewBody} {...{ preview }} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the spread route must fail the audit:\n${output}`);
				// Round-7 reads the spread object rather than flagging it blind:
				// `{ preview }` resolves to its key, and the wrapper's forwarded
				// `preview` prop is what fails — together with the dynamic
				// `<svelte:component this={body}>` route the wrapper hosts.
				assert.match(
					output,
					/passes `preview` through the preview prop of SpreadWrapper/,
					`the spread's resolved preview key into a forwarding wrapper must fail closed:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('a multi-hop wrapper chain forwarding the preview fails (R6-1 adjacent multi-hop)', () => {
	const hop3 = `${OWNED_DIR}/__r6_hop3__.svelte`;
	const hop2 = `${OWNED_DIR}/__r6_hop2__.svelte`;
	plant(
		hop3,
		'<script lang="ts">\n' +
			'\tlet { body, value } = $props();\n' +
			'</script>\n' +
			'<svelte:component this={body} preview={value} />\n'
	);
	plant(
		hop2,
		'<script lang="ts">\n' +
			"\timport Hop3 from '$lib/compose/__r6_hop3__.svelte';\n" +
			'\tlet { body, value } = $props();\n' +
			'</script>\n' +
			'<Hop3 body={body} value={value} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT + "\timport Hop2 from '$lib/compose/__r6_hop2__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<Hop2 body={PreviewBody} value={preview} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the multi-hop route must fail the audit:\n${output}`);
				assert.match(
					output,
					/forwards to a preview route/,
					`each hop into a preview-reaching wrapper must fail:\n${output}`
				);
				assert.match(
					output,
					/svelte:component this=\{body\}> with a preview attribute/,
					`the terminal dynamic route must fail closed:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, hop3), { force: true });
		rmSync(join(repoRoot, hop2), { force: true });
	}
});

test('a svelte:component with a preview attribute and an unbound this fails anywhere (R6-1 adjacent)', () => {
	const wrapper = `${OWNED_DIR}/__r6_dynamic_route__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			'\tlet { body, value } = $props();\n' +
			'</script>\n' +
			'<svelte:component this={body} preview={value} />\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the dynamic route must fail the audit:\n${output}`);
		assert.match(
			output,
			/svelte:component this=\{body\}> with a preview attribute/,
			`the unresolved this must fail closed:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('legitimate unrelated props and benign dynamic components stay green (R6-1 positives)', () => {
	const benign = `${OWNED_DIR}/__r6_benign_wrapper__.svelte`;
	const comp = `${OWNED_DIR}/__r6_benign_comp__.svelte`;
	const use = `${OWNED_DIR}/__r6_sveltecomp_use__.svelte`;
	plant(benign, '<script lang="ts">\n\tlet { title } = $props();\n</script>\n<h2>{title}</h2>\n');
	plant(comp, '<script lang="ts">\n\tlet { label } = $props();\n</script>\n<span>{label}</span>\n');
	plant(
		use,
		'<script lang="ts">\n' +
			"\timport BenignComp from '$lib/compose/__r6_benign_comp__.svelte';\n" +
			'</script>\n' +
			'<svelte:component this={BenignComp} label="static" />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT +
							"\timport BenignWrapper from '$lib/compose/__r6_benign_wrapper__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<BenignWrapper title={review?.title} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(
					status,
					0,
					`unrelated props and benign components must stay green:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, benign), { force: true });
		rmSync(join(repoRoot, comp), { force: true });
		rmSync(join(repoRoot, use), { force: true });
	}
});

/* ============================================================
   R6-2 — non-identifier preview identity bindings
   ============================================================ */

/**
 * The round-6 review planted four bindings that carry the preview reference
 * without ever naming it in a form check 8 recognized: a destructured
 * container, an accessor, a class constructor, and a loop binding. Each is
 * planted over the real canonical file and must fail the real audit; the
 * adjacent forms (assignment patterns, array rest, callbacks, catch bindings)
 * fail beside them; the paired positives (read-only destructures, a clean
 * constructor, a getter returning a string) stay clean.
 */
test('a destructured container binding is the preview value (R6-2 #1)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst holder = { body: preview };\n' +
					"\tconst { body: shadow } = holder;\n\tshadow.html = '<img src=x onerror=alert(1)>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the destructured-container write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to shadow.html'),
				`check 8 must follow the value through the destructure:\n${output}`
			);
		}
	);
});

test('an accessor returning the preview is a value carrier (R6-2 #2)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst box = { get body() { return preview; } };\n' +
					"\tbox.body.html = '<img src=x onerror=alert(1)>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the accessor write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to .html on box.body'),
				`check 8 must follow the getter to the value:\n${output}`
			);
		}
	);
});

test('an accessor whose return cannot be proven direct fails closed (R6-2 #2 adjacent)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst inner = { get body() { return preview; } };\n' +
					'\tconst out = { get body() { return inner.body; } };\n' +
					"\tout.body.html = '<img src=x onerror=alert(1)>';\n"
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the indirect accessor write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to .html on out.body'),
				`check 8 must follow the getter chain conservatively:\n${output}`
			);
		}
	);
});

test('a class constructor receiving the preview fails (R6-2 #3)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tclass Mangler {\n' +
					'\t\tconstructor(p: DraftPreview | null) {\n' +
					"\t\t\tif (p) p.html = '<img src=x onerror=alert(1)>';\n" +
					'\t\t}\n' +
					'\t}\n' +
					'\tnew Mangler(preview);\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the constructor write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('its constructor writes the value'),
				`check 8 must analyze the constructor's parameter writes:\n${output}`
			);
		}
	);
});

test('a for-of binding over the preview array fails (R6-2 #4)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tfor (const alias of [preview]) {\n' +
					"\t\tif (alias) alias.html = '<img src=x onerror=alert(1)>';\n" +
					'\t}\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the loop-binding write must fail the audit:\n${output}`);
			assert.ok(
				output.includes('writes to alias.html'),
				`check 8 must follow the loop binding:\n${output}`
			);
		}
	);
});

test('assignment-pattern, array-rest, callback, and catch bindings fail (R6-2 adjacent)', () => {
	const shapes = [
		{
			name: 'assignment destructure',
			plant:
				'\tconst holder = { body: preview };\n' +
				'\tlet shadow: DraftPreview | null = null;\n' +
				'\t({ body: shadow } = holder);\n' +
				"\tshadow.html = '<img src=x onerror=alert(1)>';\n",
			match: /writes to shadow\.html/,
		},
		{
			name: 'array rest',
			plant:
				'\tconst arr = [null, preview];\n' +
				'\tconst [first, ...rest] = arr;\n' +
				"\trest[0].html = '<img src=x onerror=alert(1)>';\n",
			match: /entered a local container/,
		},
		{
			name: 'iteration callback',
			plant:
				"\t[preview].forEach((alias) => { if (alias) alias.html = '<img src=x onerror=alert(1)>'; });\n",
			match: /writes to alias\.html/,
		},
		{
			name: 'catch binding',
			plant:
				'\ttry { throw preview; } catch (caught) {\n' +
				"\t\tif (caught) caught.html = '<img src=x onerror=alert(1)>';\n" +
				'\t}\n',
			match: /writes to caught\.html/,
		},
	];
	for (const shape of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + shape.plant),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${shape.name} write must fail the audit:\n${output}`);
				assert.match(output, shape.match, output);
			}
		);
	}
});

test('read-only destructures, a clean constructor, and a string getter stay clean (R6-2 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst holder = { body: preview, title: "x" };\n' +
					'\tconst { body } = holder;\n' +
					'\tconst t = body?.title;\n' +
					'\tclass Reader {\n' +
					'\t\tconstructor(p: DraftPreview | null) {\n' +
					"\t\t\tthis.label = p?.title ?? '';\n" +
					'\t\t}\n' +
					'\t}\n' +
					'\tconst r = new Reader(preview);\n' +
					"\tconst box = { get title() { return 'static'; } };\n" +
					"\tbox.title = 'x';\n" +
					'\tfor (const alias of [preview]) { console.log(alias?.success); }\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 0, `read-only identity shapes must stay clean:\n${output}`);
		}
	);
});

/* ============================================================
   R6-3 — alternate-sink callee and payload laundering
   ============================================================ */

/**
 * The round-6 review planted five laundering shapes the round-5 gate stayed
 * green for: aliases of dangerous built-in callees (Object.assign,
 * Object.defineProperty, document.execCommand), call-result payloads
 * (`Object.assign(frame, payload())`), and rest/spread payload arrays
 * (`Object.assign(frame, ...spreads)`). Each must fail the real audit; the
 * adjacent routes (.call/.apply/.bind, destructured extractions) fail beside
 * them; and the legitimate shapes — execCommand('copy'), container receivers
 * with call-result or spread payloads, known-clean destructures — stay clean.
 */
test('aliased dangerous builtins and laundered payloads fail (R6-3 exact plants)', () => {
	const attacks = [
		'const A = Object.assign;\n\tA(frame, { srcdoc: html });',
		"const D = Object.defineProperty;\n\tD(el, 'innerHTML', { value: html });",
		"const ex = document.execCommand;\n\tex('insertHTML', false, html);",
		'const payload = () => ({ srcdoc: html });\n\tObject.assign(frame, payload());',
		'const spreads = [{ srcdoc: html }];\n\tObject.assign(frame, ...spreads);',
	];
	for (let index = 0; index < attacks.length; index += 1) {
		const relativePath = `${OWNED_DIR}/__r6_sink_${index}__.ts`;
		plant(
			relativePath,
			`export const a = (frame: any, el: any, html: string) => {\n\t${attacks[index]}\n};\n`
		);
		try {
			const { status, output } = runAudit();
			assert.equal(status, 1, `${attacks[index]} must fail the production audit:\n${output}`);
			assert.ok(output.includes(`[alternate raw-HTML sinks] ${relativePath}`), output);
		} finally {
			rmSync(join(repoRoot, relativePath), { force: true });
		}
	}
});

test('.call/.apply/.bind and destructured builtin routes fail (R6-3 adjacent)', () => {
	const attacks = [
		'const { assign } = Object;\n\tassign.call(null, frame, { srcdoc: html });',
		'const A = Object.assign.bind(null);\n\tA(frame, { srcdoc: html });',
		'Object.assign.call(null, frame, { srcdoc: html });',
		"const { execCommand } = document;\n\texecCommand('insertHTML', false, html);",
		'const payload = { srcdoc: html };\n\tconst get = () => payload;\n\tObject.assign(frame, get());',
		'Object.assign(frame, ...[{ srcdoc: html }]);',
	];
	for (let index = 0; index < attacks.length; index += 1) {
		const relativePath = `${OWNED_DIR}/__r6_adjacent_${index}__.ts`;
		plant(
			relativePath,
			`export const a = (frame: any, html: string) => {\n\t${attacks[index]}\n};\n`
		);
		try {
			const { status, output } = runAudit();
			assert.equal(status, 1, `${attacks[index]} must fail the production audit:\n${output}`);
			assert.ok(output.includes(`[alternate raw-HTML sinks] ${relativePath}`), output);
		} finally {
			rmSync(join(repoRoot, relativePath), { force: true });
		}
	}
});

test('setHTMLUnchecked and JSX dangerouslySetInnerHTML fail (R6-3 residuals)', () => {
	const method = `${OWNED_DIR}/__r6_sethtmlunchecked__.ts`;
	plant(method, 'export const a = (el: any, html: string) => { el.setHTMLUnchecked(html); };\n');
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `setHTMLUnchecked must fail the audit:\n${output}`);
		assert.ok(output.includes('calls .setHTMLUnchecked'), output);
	} finally {
		rmSync(join(repoRoot, method), { force: true });
	}

	const jsx = `${OWNED_DIR}/__r6_dangerously_set__.tsx`;
	plant(
		jsx,
		'export const p = (html: string) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `dangerouslySetInnerHTML must fail the audit:\n${output}`);
		assert.ok(output.includes('dangerouslySetInnerHTML attribute'), output);
	} finally {
		rmSync(join(repoRoot, jsx), { force: true });
	}
});

test('legitimate callee aliases and payloads stay clean (R6-3 positives)', () => {
	const relativePath = `${OWNED_DIR}/__r6_launder_pos__.ts`;
	plant(
		relativePath,
		'export const a = (state: any, html: string) => {\n' +
			"\tconst ex = document.execCommand;\n\tex('copy');\n" +
			'\tconst payload = () => ({ text: html });\n\tObject.assign(state, payload());\n' +
			'\tconst spreads = [{ text: html }];\n\tObject.assign(state, ...spreads);\n' +
			'\tconst { assign } = Object;\n\tassign(state, { text: html });\n' +
			"\tconst s = $state({ text: '' });\n\tObject.assign(s, payload());\n" +
			'};\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `benign callees and payloads must stay clean:\n${output}`);
	} finally {
		rmSync(join(repoRoot, relativePath), { force: true });
	}
});
/* ============================================================
   Round 7 — R7-1: prop/unbound component callees and markup-spread
   forwarding
   ============================================================ */

/**
 * The round-7 review planted a type-correct second route that stayed green
 * through every round-6 control: an owned wrapper whose callee is a PROP
 * (`<Comp preview={shown}/>`) fed from the canonical file by a markup spread
 * (`<PreviewSlot {...{ Comp: PreviewBody, value: preview }} />`). The
 * cross-file flow skipped every callee it could not resolve to an owned
 * component, and it counted spreads without reading them. These probes keep
 * the plant and its adjacent forms; each must now fail with a reason.
 */
const R7_PREVIEW_SLOT = 'src/lib/review/__r7_preview_slot__.svelte';

test('a prop-named component fed through a markup spread fails the audit (R7-1 exact plant)', () => {
	plant(
		R7_PREVIEW_SLOT,
		'<script lang="ts">\n' +
			"\timport type { Component } from 'svelte';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tComp: Component<{ preview: DraftPreview }>;\n' +
			'\t\tvalue: DraftPreview;\n' +
			'\t}\n' +
			'\n' +
			'\tlet { Comp, value }: Props = $props();\n' +
			"\tconst shown = { ...value, html: (value.html ?? '') + '<img src=x>' };\n" +
			'</script>\n' +
			'\n' +
			'<Comp preview={shown} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT + "\timport PreviewSlot from '$lib/review/__r7_preview_slot__.svelte';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<PreviewSlot {...{ Comp: PreviewBody, value: preview }} />`
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the prop-callee route must fail the audit:\n${output}`);
				// The wrapper's own invocation: a prop-supplied callee with a
				// preview-flowing value fails closed.
				assert.match(
					output,
					/prop-supplied component `Comp`/,
					`the wrapper's prop-named callee must fail closed:\n${output}`
				);
				// The canonical spread is READ: both folded keys are findings.
				assert.match(
					output,
					/passes `preview` through the value prop of PreviewSlot/,
					`the spread's value key must be read and fail:\n${output}`
				);
				assert.match(
					output,
					/names the PreviewBody component in its markup outside the canonical invocation/,
					`the spread's component key must be seen in the canonical markup:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, R7_PREVIEW_SLOT), { force: true });
	}
});

test('a prop-supplied namespace member callee fails the audit (R7-1 adjacent member)', () => {
	const wrapper = `${OWNED_DIR}/__r7_member_slot__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			'\tinterface Props {\n' +
			'\t\tMod: { default: unknown };\n' +
			'\t\tvalue: unknown;\n' +
			'\t}\n' +
			'\tlet { Mod, value }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<Mod.default preview={value} />\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the member callee route must fail the audit:\n${output}`);
		assert.match(
			output,
			/member component `Mod\.default`/,
			`a dotted callee supplied through props is never a trusted owned component:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('aliased and computed-key markup spreads fail the audit (R7-1 adjacent spread reading)', () => {
	const wrapper = `${OWNED_DIR}/__r7_spread_alias_slot__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			"\timport type { Component } from 'svelte';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tComp: Component<{ preview: DraftPreview }>;\n' +
			'\t\tvalue: DraftPreview;\n' +
			'\t}\n' +
			'\tlet { Comp, value }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<Comp preview={value} />\n'
	);
	try {
		withPlantedWorkspace(
			(source) =>
				source
					.replace(
						PREVIEW_IMPORT,
						PREVIEW_IMPORT +
							"\timport SpreadAliasSlot from '$lib/compose/__r7_spread_alias_slot__.svelte';\n"
					)
					.replace(
						"\tconst isMarkdownSource = $derived(review?.contentFormat === 'MARKDOWN');",
						"\tconst isMarkdownSource = $derived(review?.contentFormat === 'MARKDOWN');\n" +
							'\tconst slotProps = { Comp: PreviewBody, value: preview };\n' +
							"\tconst kk = 'value';\n"
					)
					.replace(
						PREVIEW_INVOCATION,
						`${PREVIEW_INVOCATION}\n\t\t\t\t\t\t<SpreadAliasSlot {...slotProps} />\n` +
							"\t\t\t\t\t\t<SpreadAliasSlot {...{ ['Comp']: PreviewBody, [kk]: preview }} />"
					),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the aliased spread route must fail the audit:\n${output}`);
				// The alias resolves through the script binding; the computed
				// keys fold through the constant string.
				assert.match(
					output,
					/passes `PreviewBody` through the Comp prop of SpreadAliasSlot/,
					`an aliased spread object must be read through its binding:\n${output}`
				);
				assert.match(
					output,
					/passes `preview` through the value prop of SpreadAliasSlot/,
					`a computed spread key folding to 'value' must be read:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

test('a prop-named component with provably non-preview props stays green (R7-1 positive)', () => {
	const wrapper = `${OWNED_DIR}/__r7_icon_slot__.svelte`;
	plant(
		wrapper,
		'<script lang="ts">\n' +
			"\timport type { Component } from 'svelte';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tIcon: Component<{ name: string }>;\n' +
			'\t\tlabel: string;\n' +
			'\t}\n' +
			'\tlet { Icon, label }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<Icon name={label} />\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 0, `a prop component with non-preview props must stay clean:\n${output}`);
	} finally {
		rmSync(join(repoRoot, wrapper), { force: true });
	}
});

/* ============================================================
   Round 7 — R7-2: executable source outside the classified roots
   ============================================================ */

/**
 * The round-7 review planted a root-level Svelte module importing PreviewBody,
 * reconstructing the preview bytes, and rendering them, reached from an owned
 * component through a relative import — green through every control, because
 * check 5 classifies only what the `src/` walk opens. The universe check
 * derives coverage from reachability; each plant below must now fail it.
 */

test('executable source outside the classified roots fails when owned code loads it (R7-2 exact plant)', () => {
	const shim = '__r7_root_shim__.svelte';
	const route = 'src/lib/review/__r7_root_route__.svelte';
	plant(
		shim,
		'<script lang="ts">\n' +
			"\timport PreviewBody from '$lib/review/PreviewBody.svelte';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tpreview: DraftPreview;\n' +
			'\t}\n' +
			'\tlet { preview }: Props = $props();\n' +
			"\tconst shown: DraftPreview = { ...preview, html: (preview.html ?? '') + '<img src=x>' };\n" +
			'</script>\n' +
			'\n' +
			'<PreviewBody preview={shown} />\n'
	);
	plant(
		route,
		'<script lang="ts">\n' +
			"\timport RootShim from '../../../__r7_root_shim__.svelte';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tpreview: DraftPreview;\n' +
			'\t}\n' +
			'\tlet { preview }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<RootShim {preview} />\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the root shim route must fail the audit:\n${output}`);
		assert.match(
			output,
			/\[executable source universe\] __r7_root_shim__\.svelte is executable source outside the classified owned\/vendored roots/,
			`the universe check must name the outsider and its loader:\n${output}`
		);
		assert.match(
			output,
			/src\/lib\/review\/__r7_root_route__\.svelte loads it/,
			`the universe check must name the owned file that loads the outsider:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('dynamic, globbed, multi-hop, and extensionless outsider loads fail (R7-2 adjacent)', () => {
	const shim = '__r7_root_shim__.svelte';
	const helper = '__r7_root_helper__.svelte';
	const tsModule = '__r7_root_module__.ts';
	const route = 'src/lib/review/__r7_root_route__.svelte';
	const plantRoute = (script) => plant(route, `<script lang="ts">\n${script}</script>\n`);
	try {
		// dynamic import with a query suffix
		plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
		plantRoute("\tconst loaded = await import('../../../__r7_root_shim__.svelte?svelte');\n");
		let result = runAudit();
		assert.equal(result.status, 1, `a query-suffixed outsider load must fail:\n${result.output}`);
		assert.match(
			result.output,
			/loads it \("\.\.\/\.\.\/\.\.\/__r7_root_shim__\.svelte\?svelte"\)/,
			`the query suffix must not hide the load:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });

		// Vite glob import
		plantRoute("\tconst modules = import.meta.glob('../../../__r7_root_*.svelte');\n");
		result = runAudit();
		assert.equal(result.status, 1, `a glob reaching an outsider must fail:\n${result.output}`);
		assert.match(result.output, /globs it/, `the glob pattern must be matched:\n${result.output}`);
		rmSync(join(repoRoot, route), { force: true });

		// multi-hop outsider chain: owned -> shim -> helper
		plant(helper, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
		plant(
			shim,
			'<script lang="ts">\n' +
				"\timport Helper from './__r7_root_helper__.svelte';\n" +
				'\texport const planted = Helper;\n' +
				'</script>\n' +
				'<p>x</p>\n'
		);
		plantRoute("\timport Shim from '../../../__r7_root_shim__.svelte';\n");
		result = runAudit();
		assert.equal(result.status, 1, `a multi-hop outsider chain must fail:\n${result.output}`);
		assert.match(
			result.output,
			/__r7_root_helper__\.svelte is executable source outside the classified owned\/vendored roots/,
			`the second hop must be named too:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, helper), { force: true });

		// extensionless .ts module at the root
		plant(tsModule, 'export const planted = true;\n');
		plantRoute("\timport { planted } from '../../../__r7_root_module__';\n");
		result = runAudit();
		assert.equal(result.status, 1, `an extensionless outsider load must fail:\n${result.output}`);
		assert.match(
			result.output,
			/__r7_root_module__\.ts is executable source outside the classified owned\/vendored roots/,
			`extensionless resolution must still reach the outsider:\n${result.output}`
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, helper), { force: true });
		rmSync(join(repoRoot, tsModule), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('an outsider module nothing loads stays clean (R7-2 positive)', () => {
	const tsModule = '__r7_root_module__.ts';
	plant(tsModule, 'export const planted = true;\n');
	try {
		const { status, output } = runAudit();
		assert.equal(
			status,
			0,
			`an unreachable outsider module is not part of the executable universe:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, tsModule), { force: true });
	}
});

/* ============================================================
   Round 7 — R7-3: late-populated and derived preview containers
   ============================================================ */

test('late-populated containers and derived carriers fail the audit (R7-3 exact plants)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst stash = $state<{ body: DraftPreview | null }>({ body: null });\n' +
					'\tstash.body = preview;\n' +
					'\tif (stash.body) stash.body.html = "<img src=x>";\n' +
					'\tconst arr = [preview];\n' +
					'\tconst ys = arr.map((p) => p);\n' +
					'\tys[0].html = "<img src=x>";\n' +
					'\tconst holder = { body: preview };\n' +
					"\tholder['body'].html = '<img src=x>';\n" +
					'\tfor (const k in holder) holder[k].html = "<img src=x>";\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the late-container plants must fail the audit:\n${output}`);
			assert.match(output, /writes to \.html on stash\.body/, `late $state population:\n${output}`);
			assert.match(
				output,
				/writes to \.html on a value that entered a local container/,
				`an identity-preserving map result:\n${output}`
			);
			assert.match(
				output,
				/writes to \.html on holder\['body'\]/,
				`folded element access:\n${output}`
			);
			assert.match(output, /writes to \.html on holder\[k\]/, `for-in element route:\n${output}`);
		}
	);
});

test('setters, inherited constructors, generators, and scalar finds fail (R7-3 adjacent)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst box: { body: DraftPreview | null } = {\n' +
					'\t\tset body(v: DraftPreview | null) { (v as DraftPreview).html = "x"; },\n' +
					'\t};\n' +
					'\tbox.body = preview;\n' +
					'\tclass Base { constructor(p: DraftPreview | null) { if (p) p.html = "x"; } }\n' +
					'\tclass Wrap extends Base {}\n' +
					'\tnew Wrap(preview);\n' +
					'\tfunction* stream() { yield preview; }\n' +
					'\tfor (const g of stream()) { if (g) g.html = "x"; }\n' +
					'\tconst holder2 = { body: preview };\n' +
					'\tfor (const v of Object.values(holder2)) { if (v) v.html = "x"; }\n' +
					'\tconst found = [preview].find((x) => Boolean(x));\n' +
					'\tif (found) found.html = "x";\n' +
					'\tconst holder3 = { body: preview };\n' +
					"\tconst kk = 'html';\n" +
					'\tholder3.body[kk] = "x";\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 1, `the adjacent container plants must fail the audit:\n${output}`);
			assert.match(
				output,
				/writes to v\.html/,
				`the setter parameter / Object.values binding:\n${output}`
			);
			assert.match(
				output,
				/passes the preview value to new Wrap\(…\) — its inherited constructor/,
				`an inherited constructor cannot be proven clean:\n${output}`
			);
			assert.match(output, /writes to g\.html/, `a generator yield binding:\n${output}`);
			assert.match(output, /writes to found\.html/, `a scalar find result:\n${output}`);
			assert.match(
				output,
				/writes to \.html on holder3\.body/,
				`a constant-folded computed key is a .html write:\n${output}`
			);
		}
	);
});

test('$state.raw data containers and reductions stay clean (R7-3 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst rawBox = $state.raw<{ note: string | null }>({ note: null });\n' +
					"\trawBox.note = 'hello';\n" +
					'\tconst sizes = [preview].map((p) => p?.renderedBytes ?? 0);\n' +
					'\tconst total = sizes.reduce((a, b) => a + b, 0);\n' +
					"\tconst meta = { title: 'x', at: 'y' };\n" +
					'\tconst { title, at } = meta;\n' +
					"\tconst plain = { a: 'one', b: 'two' };\n" +
					'\tfor (const v of Object.values(plain)) v.toUpperCase();\n' +
					'\tvoid total; void title; void at;\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`non-preview containers and provably-fresh transforms must stay clean:\n${output}`
			);
		}
	);
});

/* ============================================================
   Round 7 — R7-4: alternate sink laundering
   ============================================================ */

const R7_SINK_PROBE = `${OWNED_DIR}/__r7_sink_probe__.ts`;

test('descriptor setters, bound copies, folded keys, Reflect dispatch, and setHTML fail (R7-4 exact plants)', () => {
	plant(
		R7_SINK_PROBE,
		'export function launder(host: HTMLElement, html: string): void {\n' +
			"\tObject.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set?.call(host, html);\n" +
			'\tconst m = host.insertAdjacentHTML;\n' +
			'\tconst inj = m.bind(host);\n' +
			"\tinj('afterbegin', html);\n" +
			"\tconst key = 'innerHTML';\n" +
			'\tObject.assign(host, { [key]: html });\n' +
			'\tReflect.apply(Object.assign, null, [host, { innerHTML: html }]);\n' +
			'\thost.setHTML?.(html);\n' +
			'}\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the laundering plants must fail the audit:\n${output}`);
		assert.match(
			output,
			/invokes a property-descriptor setter for 'innerHTML' through \.call\(…\)/,
			`descriptor setter extraction:\n${output}`
		);
		assert.match(output, /insertAdjacentHTML/, `the two-step method bind:\n${output}`);
		assert.match(
			output,
			/calls Object\.assign with 'innerHTML' in a source object/,
			`the computed assign key folds through the constant string:\n${output}`
		);
		assert.match(output, /calls \.setHTML\(…\)/, `the Sanitizer-API setter:\n${output}`);
	} finally {
		rmSync(join(repoRoot, R7_SINK_PROBE), { force: true });
	}
});

test('prototype aliases, extracted setters, and Reflect dispatch variants fail (R7-4 adjacent)', () => {
	plant(
		R7_SINK_PROBE,
		'export function launder(host: HTMLElement, html: string): void {\n' +
			'\tconst S = Element.prototype.setHTML;\n' +
			'\tS.call(host, html);\n' +
			"\tconst d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');\n" +
			'\tconst s = d?.set;\n' +
			'\ts?.call(host, html);\n' +
			'\tReflect.construct(class { constructor(p: string) { void p; } }, [html]);\n' +
			'\tconst args = [host, { innerHTML: html }];\n' +
			'\tReflect.apply(Object.assign, null, args);\n' +
			'}\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(status, 1, `the adjacent laundering plants must fail the audit:\n${output}`);
		assert.match(
			output,
			/invokes \.setHTML through \.call\(…\)/,
			`a prototype-namespace alias through .call:\n${output}`
		);
		assert.match(
			output,
			/'innerHTML' descriptor setter/,
			`an extracted descriptor setter bound to a local:\n${output}`
		);
		assert.match(
			output,
			/Reflect\.construct with a constructor this reading cannot prove benign/,
			`Reflect.construct fails closed on an unproven constructor:\n${output}`
		);
		assert.match(
			output,
			/Reflect\.apply with an argument array this reading cannot expand/,
			`Reflect.apply fails closed on a non-literal argument array:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, R7_SINK_PROBE), { force: true });
	}
});

test('benign descriptor keys, benign constructors, and safe reducers stay clean (R7-4 positives)', () => {
	plant(
		R7_SINK_PROBE,
		'export function legitimate(host: HTMLElement): string {\n' +
			"\tconst title = Object.getOwnPropertyDescriptor(host, 'title')?.get?.call(host);\n" +
			"\tconst err = Reflect.construct(Error, ['message']);\n" +
			"\tconst copy = Object.assign({}, { id: 'x' });\n" +
			'\treturn `${title ?? ""} ${err.message} ${copy.id}`;\n' +
			'}\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(
			status,
			0,
			`benign descriptor keys, constructors, and payloads must stay clean:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, R7_SINK_PROBE), { force: true });
	}
});

/* ============================================================
   Round 8 — R8-1: the bundler's resolve.alias route (C-1)
   ============================================================

   The round-8 attack planted a second preview route the round-7 universe
   check could not see: a root-level shim that imports PreviewBody and
   rewrites `preview.html`, loaded through an owned file's `import AliasShim
   from '@shim'`, with the ONLY thing naming `@shim` sitting in the bundler's
   alias table in `vite.config.ts`. The audit greened it AND the build shipped
   it. The gate now parses `resolve.alias` from the governed root modules,
   routes alias-resolved specifiers through the universe closure and the
   component-callee resolution, and fails closed on an alias entry it cannot
   read or a bare specifier no alias and no installed package answers for. */

const VITE_CONFIG = 'vite.config.ts';
const ALIAS_ANCHOR = "{ find: '$lib', replacement: path.resolve(root, 'src/lib') },";

/** Plant a mutated vite.config.ts, run the body, restore the original. */
function withPlantedViteConfig(mutate, body) {
	// The config is build input the audit now parses; the same lock discipline
	// as the workspace plants keeps the mutation window private to this test.
	withSourceLock(() => {
		const original = readFileSync(join(repoRoot, VITE_CONFIG), 'utf8');
		writeFileSync(join(repoRoot, VITE_CONFIG), mutate(original));
		try {
			body();
		} finally {
			writeFileSync(join(repoRoot, VITE_CONFIG), original);
		}
	});
}

/** The round-8 C-1 shim: imports PreviewBody, rewrites html, renders. */
function r8ShimSource(marker) {
	return (
		'<script lang="ts">\n' +
		"\timport PreviewBody from '$lib/review/PreviewBody.svelte';\n" +
		"\timport type { DraftPreview } from '$lib/cms/review';\n" +
		'\n' +
		'\tinterface Props {\n' +
		'\t\tpreview: DraftPreview;\n' +
		'\t}\n' +
		'\tlet { preview }: Props = $props();\n' +
		`\tconst shown: DraftPreview = { ...preview, html: (preview.html ?? '') + '<img src=x data-plant=${marker}>' };\n` +
		'</script>\n' +
		'\n' +
		'<PreviewBody preview={shown} />\n'
	);
}

test('a root shim loaded through a resolve alias fails the audit (R8-1 exact plant)', () => {
	// THE ROUND-8 C-1 SHAPE: root shim + owned route importing `@shim` + the
	// alias entry in vite.config.ts naming the target. At c2a0d7f this audited
	// clean AND bundled; the gate must now fail it on BOTH readings — the
	// universe names the outsider and its alias route, and the value-path
	// reading refuses a preview-flowing prop into a callee only an alias
	// resolves.
	const shim = '__r8_alias_shim__.svelte';
	const route = 'src/lib/review/__r8_alias_route__.svelte';
	plant(shim, r8ShimSource('r8c1'));
	plant(
		route,
		'<script lang="ts">\n' +
			"\timport AliasShim from '@shim';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tpreview: DraftPreview;\n' +
			'\t}\n' +
			'\tlet { preview }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<AliasShim {preview} />\n'
	);
	try {
		withPlantedViteConfig(
			(source) => {
				if (!source.includes(ALIAS_ANCHOR))
					throw new Error('the alias anchor moved — re-anchor the R8-1 probes');
				return source.replace(
					ALIAS_ANCHOR,
					"{ find: '@shim', replacement: path.resolve(root, '__r8_alias_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the alias route must fail the audit:\n${output}`);
				assert.match(
					output,
					/\[executable source universe\] __r8_alias_shim__\.svelte is executable source outside the classified owned\/vendored roots/,
					`the universe check must name the aliased outsider:\n${output}`
				);
				assert.match(
					output,
					/src\/lib\/review\/__r8_alias_route__\.svelte loads it through a resolve alias \("@shim"\)/,
					`the universe check must name the alias route:\n${output}`
				);
				assert.match(
					output,
					/\[preview value path\] src\/lib\/review\/__r8_alias_route__\.svelte passes `preview` through the preview prop of `AliasShim`/,
					`the value-path reading must refuse the alias-resolved callee:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('regex-find aliases and unreadable alias entries fail the audit (R8-1 adjacent)', () => {
	const shim = '__r8_alias_shim__.svelte';
	const route = 'src/lib/review/__r8_alias_route__.svelte';
	plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
	plant(
		route,
		'<script lang="ts">\n' +
			"\timport Shim from '@r8rx/anything';\n" +
			'\tconst s = Shim;\n' +
			'</script>\n'
	);
	try {
		// A whole-specifier regex find routing the import to the root shim.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: /^@r8rx\\/.*$/, replacement: path.resolve(root, '__r8_alias_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a regex-find alias route must fail:\n${output}`);
				assert.match(
					output,
					/__r8_alias_shim__\.svelte is executable source outside the classified owned\/vendored roots/,
					`the regex alias must reach the outsider:\n${output}`
				);
			}
		);

		// An alias entry the fold cannot read fails closed on its own.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@unreadable', replacement: computeAliasTarget() },\n\t\t\t\t\t" + ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an unreadable alias entry must fail:\n${output}`);
				assert.match(
					output,
					/a resolve\.alias entry the scan cannot read could route any specifier to any module/,
					`the unreadable entry must be named:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('the object alias spelling and bare specifiers without packages fail (R8-1 adjacent)', () => {
	const shim = '__r8_alias_shim__.svelte';
	const route = 'src/lib/review/__r8_alias_route__.svelte';
	plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
	try {
		// The OBJECT spelling: rewrite the whole alias table as a find->target
		// mapping. The array's exact byte span is located at run time so the
		// probe follows the config's formatting rather than assuming it.
		plant(
			route,
			'<script lang="ts">\n' +
				"\timport Shim from '@r8obj';\n" +
				'\tconst s = Shim;\n' +
				'</script>\n'
		);
		withPlantedViteConfig(
			(source) => {
				const start = source.indexOf('alias: [');
				const end = source.indexOf('\n\t\t\t],', start);
				if (start === -1 || end === -1)
					throw new Error('the alias table moved — re-anchor the R8-1 object probe');
				return (
					source.slice(0, start) +
					"alias: { '@r8obj': path.resolve(root, '__r8_alias_shim__.svelte') }," +
					source.slice(end + '\n\t\t\t],'.length)
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the object-spelling alias route must fail:\n${output}`);
				assert.match(
					output,
					/__r8_alias_shim__\.svelte is executable source outside the classified owned\/vendored roots/,
					`the object alias must reach the outsider:\n${output}`
				);
			}
		);
		rmSync(join(repoRoot, route), { force: true });

		// A bare specifier no alias claims and no installed package answers for
		// is a route no static read can prove.
		plant(
			route,
			'<script lang="ts">\n' +
				"\timport { x } from '@nonexistent-r8-package';\n" +
				'\tconst s = x;\n' +
				'</script>\n'
		);
		const { status, output } = runAudit();
		assert.equal(status, 1, `a bare specifier with no alias and no package must fail:\n${output}`);
		assert.match(
			output,
			/loads "@nonexistent-r8-package" — the specifier matches no resolve alias and no installed package/,
			`the fail-closed bare-specifier rule must name it:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('aliases into the classified roots and installed packages stay clean (R8-1 positives)', () => {
	const route = 'src/lib/review/__r8_alias_route__.svelte';
	plant(
		route,
		'<script lang="ts">\n' +
			"\timport { absentRenderer } from '@r8stub';\n" +
			"\timport { writable } from 'svelte/store';\n" +
			'\tconst s = `${absentRenderer} ${writable}`;\n' +
			'</script>\n'
	);
	try {
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@r8stub', replacement: path.resolve(root, 'src/lib/build/absent-renderer-module.ts') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(
					status,
					0,
					`an alias into the owned roots and an installed package must stay clean:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, route), { force: true });
	}
});

/* ============================================================
   Round 8 — R8-2: local-function return laundering (H-1)
   ============================================================

   At c2a0d7f a local relay receiving the preview as a parameter laundered
   the identity clean in five shapes: the parameter never joined the value
   names, so `return p` never marked the callee preview-returning and no read
   of the result ever bound. The gate now binds callee parameters at call
   sites that hand the value in, so every shape below fails. */

test('local relays laundering the preview fail the audit (R8-2 exact plants)', () => {
	const shapes = [
		[
			'sync declaration read',
			'\tfunction relaySync(p: DraftPreview): DraftPreview { return p; }\n' +
				"\tif (preview) { const v = relaySync(preview); v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'sync inline read',
			'\tfunction relaySync(p: DraftPreview): DraftPreview { return p; }\n' +
				"\tif (preview) relaySync(preview).html = '<img src=x>';\n",
			/writes to \.html on a value returned by a preview-returning helper/,
		],
		[
			'async await declaration read',
			'\tasync function relayAsync(p: DraftPreview): Promise<DraftPreview> { return p; }\n' +
				"\tif (preview) { const w = await relayAsync(preview); w.html = '<img src=x>'; }\n",
			/writes to w\.html/,
		],
		[
			'async inline await read',
			'\tasync function relayAsync(p: DraftPreview): Promise<DraftPreview> { return p; }\n' +
				"\tif (preview) (await relayAsync(preview)).html = '<img src=x>';\n",
			/writes to \.html on/,
		],
		[
			'.then callback on the relay result',
			'\tasync function relayAsync(p: DraftPreview): Promise<DraftPreview> { return p; }\n' +
				"\tif (preview) relayAsync(preview).then((p) => { p.html = '<img src=x>'; });\n",
			/writes to p\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} relay must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} relay must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} relay must name the write:\n${output}`);
			}
		);
	}
});

test('multi-hop chains and generator relays fail the audit (R8-2 adjacent)', () => {
	const shapes = [
		[
			'multi-hop local chain',
			'\tfunction hopA(p: DraftPreview): DraftPreview { return hopB(p); }\n' +
				'\tfunction hopB(q: DraftPreview): DraftPreview { return q; }\n' +
				"\tif (preview) { const v = hopA(preview); v.html = '<img src=x>'; }\n",
		],
		[
			'generator relay',
			'\tfunction* genRelay(p: DraftPreview) { yield p; }\n' +
				"\tif (preview) for (const g of genRelay(preview)) g.html = '<img src=x>';\n",
		],
		[
			'.then on Promise.resolve stays caught (round-7 control)',
			"\tif (preview) Promise.resolve(preview).then((p) => { p.html = '<img src=x>'; });\n",
		],
	];
	for (const [label, plantText] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} shape must be a value-path finding:\n${output}`
				);
			}
		);
	}
});

test('read-only local helpers stay clean (R8-2 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tfunction htmlLength(p: DraftPreview): number { return p.html.length; }\n' +
					'\tfunction double(n: number): number { return n * 2; }\n' +
					'\tconst planted = double(2);\n' +
					'\tif (preview) console.log(htmlLength(preview), planted);\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`read-only helpers over the preview and plain locals must stay clean:\n${output}`
			);
		}
	);
});

/* ============================================================
   Round 8 — R8-3: import.meta.glob template and array spellings (H-2)
   ============================================================

   At c2a0d7f the glob reading collected only string-literal first
   arguments; the bundler also accepts a no-substitution template literal and
   an array of patterns, and both spellings of the committed R7-2 glob plant
   sailed through. Every position is collected now, and any non-literal
   position fails closed. */

test('template-literal and array glob spellings reaching an outsider fail (R8-3 exact plants)', () => {
	const shim = '__r8_glob_shim__.svelte';
	const route = 'src/lib/review/__r8_glob_route__.svelte';
	plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
	const plantRoute = (script) => plant(route, `<script lang="ts">\n${script}</script>\n`);
	try {
		plantRoute('\tconst modules = import.meta.glob(`../../../__r8_glob_shim__.svelte`);\n');
		let result = runAudit();
		assert.equal(result.status, 1, `a template-literal glob must fail:\n${result.output}`);
		assert.match(
			result.output,
			/globs it \("\.\.\/\.\.\/\.\.\/__r8_glob_shim__\.svelte"\)/,
			`the template-literal pattern must be matched:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });

		plantRoute("\tconst modules = import.meta.glob(['../../../__r8_glob_shim__.svelte']);\n");
		result = runAudit();
		assert.equal(result.status, 1, `an array glob must fail:\n${result.output}`);
		assert.match(
			result.output,
			/globs it \("\.\.\/\.\.\/\.\.\/__r8_glob_shim__\.svelte"\)/,
			`the array element pattern must be matched:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });

		// A mixed array: one literal, one identifier the scan cannot enumerate.
		plantRoute(
			"\tconst other: string = 'x';\n" +
				"\tconst modules = import.meta.glob(['../../../__r8_glob_shim__.svelte', other]);\n"
		);
		result = runAudit();
		assert.equal(result.status, 1, `a mixed-literal array glob must fail:\n${result.output}`);
		assert.match(
			result.output,
			/an argument no static read can enumerate/,
			`the non-literal element must fail closed:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });

		// A computed first argument: no static read can enumerate it.
		plantRoute(
			"\tconst pattern = '../../../__r8_glob_shim__.svelte';\n" +
				'\tconst modules = import.meta.glob(pattern);\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `a computed glob argument must fail:\n${result.output}`);
		assert.match(
			result.output,
			/an argument no static read can enumerate/,
			`the computed argument must fail closed:\n${result.output}`
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('globs that stay inside the classified roots stay clean (R8-3 positives)', () => {
	const route = 'src/lib/review/__r8_glob_route__.svelte';
	const plantRoute = (script) => plant(route, `<script lang="ts">\n${script}</script>\n`);
	try {
		plantRoute('\tconst modules = import.meta.glob(`./**/*.svelte`);\n');
		let result = runAudit();
		assert.equal(
			result.status,
			0,
			`a template-literal glob inside the owned roots must stay clean:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });

		plantRoute("\tconst modules = import.meta.glob(['./**/*.svelte', './sub/**/*.svelte']);\n");
		result = runAudit();
		assert.equal(
			result.status,
			0,
			`an array glob inside the owned roots must stay clean:\n${result.output}`
		);
	} finally {
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('the tree audits clean after every round-8 plant is uprooted', () => {
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

/* ============================================================
   Round 9 — R9-1: routes into EXCLUDED roots fail closed
   ============================================================

   The round-9 attack proved silence: every route spelling into an excluded
   root — an alias to `build/`, to `docs/`, to a planted `node_modules`
   package, a relative or root-relative import into `build/`, a glob over it
   with and without `{ eager: true }` — resolved to a base no candidate
   matched, and the round-8 closure recorded only HITS. The walk never opens
   the excluded roots, so no candidate existed to match, and the routes
   dropped without findings. The closure now classifies every base it cannot
   match: only a provably benign resolution — a classified root, a governed
   root module, a non-executable path, or a `node_modules` package
   `package.json` declares and installs — stays clean. */

const R9_ROUTE = 'src/lib/review/__r9_route__.svelte';

/** Plant an executable marker the excluded-root routes resolve into. */
function plantExcluded(relativePath) {
	const absolute = join(repoRoot, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, 'export const planted = true;\n');
	return absolute;
}

test('routes into excluded roots fail closed in every spelling (R9-1 exact plants)', () => {
	const route = R9_ROUTE;
	const uprootAll = () => {
		rmSync(join(repoRoot, route), { force: true });
		rmSync(join(repoRoot, 'build/__r9_x__.js'), { force: true });
		rmSync(join(repoRoot, 'docs/__r9_x__.mjs'), { force: true });
		rmSync(join(repoRoot, 'node_modules/__r9_pkg__'), { recursive: true, force: true });
	};
	try {
		plantExcluded('build/__r9_x__.js');
		plantExcluded('docs/__r9_x__.mjs');
		plantExcluded('node_modules/__r9_pkg__/index.js');

		// 1. alias -> build/ (side-effect import, the round-9 A1 plant).
		plant(route, '<script lang="ts">\n\timport "@xshim";\n\tconst q = 1;\n</script>\n<p>{q}</p>\n');
		withPlantedViteConfig(
			(source) => {
				if (!source.includes(ALIAS_ANCHOR))
					throw new Error('the alias anchor moved — re-anchor the R9-1 probes');
				return source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'build/__r9_x__.js') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an alias route into build/ must fail:\n${output}`);
				assert.match(
					output,
					/routes through a resolve alias "@xshim" — the route resolves into the excluded root "build"/,
					`the alias route into build/ must be classified:\n${output}`
				);
			}
		);

		// 2. alias -> docs/ (the round-9 A2 plant).
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'docs/__r9_x__.mjs') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an alias route into docs/ must fail:\n${output}`);
				assert.match(
					output,
					/the route resolves into the excluded root "docs"/,
					`the alias route into docs/ must be classified:\n${output}`
				);
			}
		);

		// 3. alias -> a PLANTED node_modules package no declaration answers for.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'node_modules/__r9_pkg__/index.js') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an alias route into an undeclared package must fail:\n${output}`);
				assert.match(
					output,
					/the route resolves into the node_modules package "__r9_pkg__"/,
					`the undeclared package route must be classified:\n${output}`
				);
				assert.match(
					output,
					/no package\.json declaration answers for it/,
					`the missing declaration must be named:\n${output}`
				);
			}
		);

		// 4. spelled relative import into build/ (the round-9 A8 plant).
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\timport { planted } from "../../../build/__r9_x__.js";\n' +
				'\tconst q = planted;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		let result = runAudit();
		assert.equal(result.status, 1, `a relative route into build/ must fail:\n${result.output}`);
		assert.match(
			result.output,
			/routes "\.\.\/\.\.\/\.\.\/build\/__r9_x__\.js" — the route resolves into the excluded root "build"/,
			`the relative route must be classified:\n${result.output}`
		);

		// 5. root-relative spelling into build/.
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\timport { planted } from "/build/__r9_x__.js";\n' +
				'\tconst q = planted;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		result = runAudit();
		assert.equal(
			result.status,
			1,
			`a root-relative route into build/ must fail:\n${result.output}`
		);
		assert.match(
			result.output,
			/routes "\/build\/__r9_x__\.js" — the route resolves into the excluded root "build"/,
			`the root-relative route must be classified:\n${result.output}`
		);

		// 6. glob spellings over build/, with and without options (the C1 plant).
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\tconst m = import.meta.glob("../../../build/__r9_x__.js");\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `a glob into build/ must fail:\n${result.output}`);
		assert.match(
			result.output,
			/globs "\.\.\/\.\.\/\.\.\/build\/__r9_x__\.js" — the route resolves into the excluded root "build"/,
			`the glob pattern must be classified:\n${result.output}`
		);
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\tconst m = import.meta.glob("../../../build/__r9_x__.js", { eager: true });\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `an eager glob into build/ must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves into the excluded root "build"/,
			`the eager glob must be classified:\n${result.output}`
		);

		// 7. dynamic import into docs/.
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\tconst m = await import("../../../docs/__r9_x__.mjs");\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `a dynamic import into docs/ must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves into the excluded root "docs"/,
			`the dynamic import must be classified:\n${result.output}`
		);
	} finally {
		uprootAll();
	}
});

test('aliased globs, escape routes, and unplaced patterns fail closed (R9-1 adjacent)', () => {
	const route = R9_ROUTE;
	const uprootAll = () => {
		rmSync(join(repoRoot, route), { force: true });
		rmSync(join(repoRoot, 'build/__r9_x__.js'), { force: true });
		rmSync(join(repoRoot, '__r9_shim__.svelte'), { force: true });
	};
	try {
		plantExcluded('build/__r9_x__.js');

		// A glob pattern routed THROUGH the alias table into the excluded root.
		plant(
			route,
			'<script lang="ts">\n\tconst m = import.meta.glob("@xshim/*");\n\tconst q = m;\n</script>\n'
		);
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'build') },\n\t\t\t\t\t" + ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an aliased glob into build/ must fail:\n${output}`);
				assert.match(
					output,
					/globs "@xshim\/\*" — the route resolves into the excluded root "build"/,
					`the aliased glob must be classified:\n${output}`
				);
			}
		);

		// An alias CHAIN whose first hop resolves to a specifier, not a path.
		rmSync(join(repoRoot, route), { force: true });
		plant(route, '<script lang="ts">\n\timport Shim from "@r9a";\n\tconst s = Shim;\n</script>\n');
		plant(
			'__r9_shim__.svelte',
			'<script lang="ts">export const planted = true;</script>\n<p>x</p>\n'
		);
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@r9a', replacement: '@r9b' },\n\t\t\t\t\t" +
						"{ find: '@r9b', replacement: path.resolve(root, '__r9_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an alias chain's first hop must fail closed:\n${output}`);
				assert.match(
					output,
					/routes through a resolve alias "@r9a" — the route resolves to "@r9b", which no candidate, classified root, or declared package answers for/,
					`the chained alias route must be classified:\n${output}`
				);
			}
		);

		// A relative route that ESCAPES the repository root.
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				'\timport { x } from "../../../../outside-repo.js";\n' +
				'\tconst q = x;\n' +
				'</script>\n<p>x</p>\n'
		);
		let result = runAudit();
		assert.equal(result.status, 1, `a route escaping the root must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves outside the repository root/,
			`the escape must be classified:\n${result.output}`
		);

		// A glob pattern no relative, root-relative, or alias reading can place.
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n\tconst m = import.meta.glob("r9unplaced/**/*.js");\n\tconst q = m;\n</script>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `an unplaced glob pattern must fail:\n${result.output}`);
		assert.match(
			result.output,
			/no static read can place the pattern/,
			`the unplaced pattern must be named:\n${result.output}`
		);
	} finally {
		uprootAll();
	}
});

test('routes into declared packages stay clean (R9-1 positives)', () => {
	const route = R9_ROUTE;
	plant(
		route,
		'<script lang="ts">\n' +
			'\timport { readable } from "@r9declared";\n' +
			'\tconst q = readable;\n' +
			'</script>\n<p>x</p>\n'
	);
	try {
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					// `svelte` is declared in package.json and installed — a route
					// INTO it is the provably-benign exclusion, screened by SEC-3,
					// never contentus-owned source.
					"{ find: '@r9declared', replacement: path.resolve(root, 'node_modules/svelte/src/runtime/store/shared.js') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(
					status,
					0,
					`an alias route into a declared, installed package must stay clean:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, route), { force: true });
	}
});

/* ============================================================
   Round 9 — R9-2: the alias table is distrusted where the
   runtime can override the declaration
   ============================================================

   The round-9 attack shipped three lies the round-8 parser trusted: an
   entry whose declared replacement was benign while its `customResolver`
   returned a root shim (the resolver's return IS the resolution), a second
   `alias` declaration the runtime keeps and a sequential reader never met,
   and a table naming one find twice where the winner is runtime semantics.
   All three audited green at 1f48630. The reading now fails closed on any
   entry property the model does not consume, on more than one `alias`
   declaration per config, and on any duplicate find in one table. */

/** The round-9 A4 shim: imports PreviewBody, rewrites html, renders. */
function r9ShimSource(marker) {
	return (
		'<script lang="ts">\n' +
		"\timport PreviewBody from '$lib/review/PreviewBody.svelte';\n" +
		"\timport type { DraftPreview } from '$lib/cms/review';\n" +
		'\n' +
		'\tinterface Props {\n' +
		'\t\tpreview: DraftPreview;\n' +
		'\t}\n' +
		'\tlet { preview }: Props = $props();\n' +
		`\tconst shown: DraftPreview = { ...preview, html: (preview.html ?? '') + '<img src=x data-plant=${marker}>' };\n` +
		'</script>\n' +
		'\n' +
		'<PreviewBody preview={shown} />\n'
	);
}

test('an alias entry with an unconsumed property fails closed (R9-2 exact plant)', () => {
	const shim = '__r9_shim__.svelte';
	const route = R9_ROUTE;
	plant(shim, r9ShimSource('r92'));
	plant(
		route,
		'<script lang="ts">\n' +
			"\timport Shim from '@xshim';\n" +
			"\timport type { DraftPreview } from '$lib/cms/review';\n" +
			'\n' +
			'\tinterface Props {\n' +
			'\t\tpreview: DraftPreview;\n' +
			'\t}\n' +
			'\tlet { preview }: Props = $props();\n' +
			'</script>\n' +
			'\n' +
			'<Shim {preview} />\n'
	);
	try {
		// THE ROUND-9 A4 SHAPE: the declared replacement names a benign owned
		// component; the `customResolver` — which the runtime calls and OBEYS —
		// returns the root shim. The scan must refuse the entry outright.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'src/lib/review/VerdictPanel.svelte'), customResolver: () => path.resolve(root, '__r9_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a customResolver entry must fail the audit:\n${output}`);
				assert.match(output, /customResolver/, `the unreadable entry must be shown:\n${output}`);
				assert.match(
					output,
					/a resolve\.alias entry the scan cannot read could route any specifier to any module/,
					`the unreadable entry must fail closed:\n${output}`
				);
			}
		);

		// A benign-LOOKING extra property is the same class of lie: the model
		// consumes find and replacement only, so any other key is unreadable.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'src/lib/review/VerdictPanel.svelte'), order: 'pre' },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `an entry with any extra property must fail:\n${output}`);
				assert.match(
					output,
					/a resolve\.alias entry the scan cannot read could route any specifier to any module/,
					`the extra-property entry must fail closed:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('a second alias declaration fails closed (R9-2 exact plant)', () => {
	const shim = '__r9_shim__.svelte';
	const route = R9_ROUTE;
	plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
	plant(route, '<script lang="ts">\n\timport Shim from "@xshim";\n\tconst s = Shim;\n</script>\n');
	try {
		// THE DIVERGENT SHAPE: the FIRST table (the one a sequential reader
		// meets) claims @xshim benignly, so a first-wins scan clears it; the
		// SECOND `alias` property is the one the runtime keeps, and it routes
		// to the root shim. The config is ambiguous and unreadable.
		withPlantedViteConfig(
			(source) => {
				if (!source.includes(ALIAS_ANCHOR))
					throw new Error('the alias anchor moved — re-anchor the R9-2 probes');
				const benigned = source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'src/lib/review/VerdictPanel.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				);
				const start = benigned.indexOf('alias: [');
				const end = benigned.indexOf('\n\t\t\t],', start);
				if (start === -1 || end === -1)
					throw new Error('the alias table moved — re-anchor the R9-2 probes');
				const close = end + '\n\t\t\t],'.length;
				return (
					benigned.slice(0, close) +
					'\n\t\t\talias: [{ find: "@xshim", replacement: path.resolve(root, "__r9_shim__.svelte") }],' +
					benigned.slice(close)
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a second alias declaration must fail:\n${output}`);
				assert.match(
					output,
					/declares resolve\.alias 2 times — the runtime keeps the LAST declaration/,
					`the duplicate declaration must be named:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

test('duplicate finds in one table fail closed (R9-2 adjacent)', () => {
	const shim = '__r9_shim__.svelte';
	const route = R9_ROUTE;
	plant(shim, '<script lang="ts">export const planted = true;</script>\n<p>x</p>\n');
	plant(route, '<script lang="ts">\n\timport Shim from "@xshim";\n\tconst s = Shim;\n</script>\n');
	const objectTable =
		'alias: {\n' +
		"\t\t\t\t'@xshim': path.resolve(root, 'src/lib/review/VerdictPanel.svelte'),\n" +
		"\t\t\t\t'@xshim': path.resolve(root, '__r9_shim__.svelte'),\n" +
		"\t\t\t\t'$lib': path.resolve(root, 'src/lib'),\n" +
		"\t\t\t\t'$app/environment': path.resolve(root, 'src/facetheory/shims/app-environment.ts'),\n" +
		"\t\t\t\t'$app/paths': path.resolve(root, 'src/facetheory/shims/app-paths.ts'),\n" +
		'\t\t\t},';
	try {
		// The OBJECT spelling with one key twice — JS keeps the LAST value and
		// a sequential reader meets the first.
		withPlantedViteConfig(
			(source) => {
				const start = source.indexOf('alias: [');
				const end = source.indexOf('\n\t\t\t],', start);
				if (start === -1 || end === -1)
					throw new Error('the alias table moved — re-anchor the R9-2 probes');
				return source.slice(0, start) + objectTable + source.slice(end + '\n\t\t\t],'.length);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a duplicated object key must fail:\n${output}`);
				assert.match(
					output,
					/declares the alias find "@xshim" more than once in one table/,
					`the duplicate key must be named:\n${output}`
				);
			}
		);

		// The ARRAY spelling with one find twice.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '@xshim', replacement: path.resolve(root, 'src/lib/review/VerdictPanel.svelte') },\n\t\t\t\t\t" +
						"{ find: '@xshim', replacement: path.resolve(root, '__r9_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a duplicated array find must fail:\n${output}`);
				assert.match(
					output,
					/declares the alias find "@xshim" more than once in one table/,
					`the duplicate find must be named:\n${output}`
				);
			}
		);

		// A CONDITIONAL table — the scan cannot tell which branch ships.
		withPlantedViteConfig(
			(source) => {
				const start = source.indexOf('alias: [');
				const end = source.indexOf('\n\t\t\t],', start);
				if (start === -1 || end === -1)
					throw new Error('the alias table moved — re-anchor the R9-2 probes');
				return (
					source.slice(0, start) +
					"alias: (command === 'build' ? [{ find: '@xshim', replacement: './src/lib' }] : [])," +
					source.slice(end + '\n\t\t\t],'.length)
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `a conditional alias table must fail:\n${output}`);
				assert.match(
					output,
					/a resolve\.alias entry the scan cannot read could route any specifier to any module/,
					`the conditional table must fail closed:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	}
});

/* ============================================================
   Round 9 — R9-3: relay launderings the round-8 binding missed
   ============================================================

   At 1f48630 six relay spellings laundered the preview identity clean: a
   default-parameter initializer reading the value (no argument at the call
   site, so call-site binding never fired); a rest parameter whose ELEMENT
   READ carried nothing; `await Promise.all([preview])` destructured;
   `Promise.all([preview]).then(([p]) => …)`; a second `.then` hop whose
   receiver is the first `.then` CALL; and an inline IIFE returning the
   value. The reading now binds default initializers, records rest
   parameters as containers, models `Promise.all`/`Promise.allSettled` and
   `.then`/`.catch`/`.finally` results as carriers, and reads inline IIFEs
   as relays. */

test('default-parameter and rest-parameter relays fail the audit (R9-3 exact plants)', () => {
	const shapes = [
		[
			'default-parameter capture',
			'\tfunction relayDef(p: DraftPreview = preview): DraftPreview { return p; }\n' +
				"\tif (preview) { const v = relayDef(); v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'default-parameter capture via explicit undefined',
			'\tfunction relayUndef(p: DraftPreview = preview): DraftPreview { return p; }\n' +
				"\tif (preview) { const v = relayUndef(undefined); v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'rest-parameter element read',
			'\tfunction relayRest(...rest: DraftPreview[]): DraftPreview { return rest[0]; }\n' +
				"\tif (preview) { const v = relayRest(preview); v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} relay must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} relay must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} relay must name the write:\n${output}`);
			}
		);
	}
});

test('Promise.all spellings laundering the preview fail the audit (R9-3 exact plants)', () => {
	const shapes = [
		[
			'awaited Promise.all destructure',
			"\tasync function r9All() { if (!preview) return; const [p] = await Promise.all([preview]); p.html = '<img src=x>'; }\n" +
				'\tif (preview) void r9All();\n',
			/writes to p\.html/,
		],
		[
			'Promise.all .then destructure',
			"\tif (preview) Promise.all([preview]).then(([p]) => { p.html = '<img src=x>'; });\n",
			/writes to p\.html/,
		],
		[
			'Promise.allSettled .then destructure',
			"\tif (preview) Promise.allSettled([preview]).then(([p]) => { p.html = '<img src=x>'; });\n",
			/writes to p\.html/,
		],
		[
			'Promise.all over a carrier identifier',
			'\tconst r9Arr = [preview];\n' +
				"\tif (preview) Promise.all(r9Arr).then(([p]) => { p.html = '<img src=x>'; });\n",
			/writes to p\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} shape must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} shape must name the write:\n${output}`);
			}
		);
	}
});

test('multi-hop .then results and IIFE relays fail the audit (R9-3 exact plants)', () => {
	const shapes = [
		[
			'second-hop .then receiver',
			'\tasync function relayAsync9(p: DraftPreview): Promise<DraftPreview> { return p; }\n' +
				"\tif (preview) relayAsync9(preview).then((p) => p).then((q) => { q.html = '<img src=x>'; });\n",
			/writes to q\.html/,
		],
		[
			'.finally pass-through',
			'\tasync function relayFin(p: DraftPreview): Promise<DraftPreview> { return p; }\n' +
				"\tif (preview) relayFin(preview).finally(() => undefined).then((q) => { q.html = '<img src=x>'; });\n",
			/writes to q\.html/,
		],
		[
			'IIFE over the value',
			"\tif (preview) { const v = (() => preview)(); v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'awaited async IIFE',
			"\tasync function r9Iife() { if (!preview) return; const v = await (async () => preview)(); v.html = '<img src=x>'; }\n" +
				'\tif (preview) void r9Iife();\n',
			/writes to v\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} shape must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} shape must name the write:\n${output}`);
			}
		);
	}
});

test('fresh IIFEs, fresh combinators, and read-only relays stay clean (R9-3 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tconst r9Fresh = (() => 42)();\n' +
					'\tfunction r9ReadRest(...rest: DraftPreview[]): number { return rest.length; }\n' +
					'\tasync function r9FreshAll() {\n' +
					'\t\tconst [a] = await Promise.all([Promise.resolve(1)]);\n' +
					'\t\treturn a;\n' +
					'\t}\n' +
					'\tasync function r9Len(p: DraftPreview): Promise<number> { return p.html.length; }\n' +
					'\tif (preview) {\n' +
					'\t\tconsole.log(r9Fresh, r9ReadRest(preview));\n' +
					'\t\tvoid r9FreshAll();\n' +
					'\t\tr9Len(preview).then((n) => n + 1);\n' +
					'\t}\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`fresh IIFEs, fresh combinators, and read-only relays must stay clean:\n${output}`
			);
		}
	);
});

test('the tree audits clean after every round-9 plant is uprooted', () => {
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

/* ============================================================
   Round 10 — R10-1: un-normalized route bases fail closed
   ============================================================

   The round-10 attack proved the round-9 classifier trusted a prefix the
   runtime never serves: `resolveUniverseSpecifier` folded `..` only for the
   `./`/`../` spellings, so a `$lib/x/../../build/y.js`, a root-relative
   `/src/x/../../build/y.js`, or a regex-alias path carrying `..` kept the
   un-normalized segments, matched nothing, and classified clean under the
   OWNED prefix it still wore. The bundler normalizes alias-replaced paths
   before it resolves them — the marker compiled into the client bundle at
   69587aa — so the gate normalizes EVERY resolved base, in every spelling,
   before candidate matching and classification. */

const R10_ROUTE = 'src/lib/review/__r10_route__.svelte';

/** Plant an executable marker the round-10 routes resolve into. */
function plantR10Excluded(relativePath) {
	const absolute = join(repoRoot, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, 'export const planted = true;\n');
	return absolute;
}

const r10RouteImport = (specifier) =>
	'<script lang="ts">\n' +
	`\timport { planted } from "${specifier}";\n` +
	'\tconst q = planted;\n' +
	'</script>\n<p>{q}</p>\n';

test('un-normalized dotdot routes fail closed in every spelling (R10-1 exact plants)', () => {
	const uprootAll = () => {
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		rmSync(join(repoRoot, 'build/__r10_x__.js'), { force: true });
		rmSync(join(repoRoot, 'docs/__r10_x__.mjs'), { force: true });
	};
	try {
		plantR10Excluded('build/__r10_x__.js');
		plantR10Excluded('docs/__r10_x__.mjs');

		// 1. $lib spelling into build/ — the round-10 CRITICAL plant, audited
		// green AND bundled at 69587aa.
		plant(R10_ROUTE, r10RouteImport('$lib/review/../../../build/__r10_x__.js'));
		let result = runAudit();
		assert.equal(result.status, 1, `the $lib dotdot route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/routes through a resolve alias "\$lib\/review\/\.\.\/\.\.\/\.\.\/build\/__r10_x__\.js" — the route resolves into the excluded root "build"/,
			`the $lib route must classify by its NORMALIZED base:\n${result.output}`
		);

		// 2. the COMMITTABLE variant into docs/ (docs/ is git-tracked).
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(R10_ROUTE, r10RouteImport('$lib/review/../../../docs/__r10_x__.mjs'));
		result = runAudit();
		assert.equal(result.status, 1, `the docs/ variant must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves into the excluded root "docs"/,
			`the docs/ route must be classified:\n${result.output}`
		);

		// 3. the bare spelling through the legit `/^src\//` regex alias — the
		// bundler normalizes alias-replaced paths, the round-9 gate did not.
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(R10_ROUTE, r10RouteImport('src/lib/review/../../../build/__r10_x__.js'));
		result = runAudit();
		assert.equal(result.status, 1, `the bare regex-alias route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves outside the repository root/,
			`the regex-alias route must normalize to the escape:\n${result.output}`
		);

		// 4. dynamic-import spelling into build/.
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(
			R10_ROUTE,
			'<script lang="ts">\n' +
				'\tconst m = await import("$lib/review/../../../build/__r10_x__.js");\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `the dynamic-import route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves into the excluded root "build"/,
			`the dynamic import must be classified:\n${result.output}`
		);

		// 5. glob spelling into build/.
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(
			R10_ROUTE,
			'<script lang="ts">\n' +
				'\tconst m = import.meta.glob("$lib/review/../../../build/__r10_x__.js");\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `the glob route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/globs "\$lib\/review\/\.\.\/\.\.\/\.\.\/build\/__r10_x__\.js" — the route resolves into the excluded root "build"/,
			`the glob pattern must be classified:\n${result.output}`
		);
	} finally {
		uprootAll();
	}
});

test('root-absolute dotdot spellings fail closed as unplaced routes (R10-1 adjacent)', () => {
	// The round-10 report names these as CLAIM FALSIFICATIONS rather than
	// shippable loads: rolldown refuses URL-absolute import spellings, so the
	// bundle proof ran against the $lib/relative/regex forms above. The gate
	// still fails closed on them — an unclassified base is a base nothing
	// answers for, whatever the bundler would do with it.
	const uprootAll = () => {
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		rmSync(join(repoRoot, 'build/__r10_x__.js'), { force: true });
	};
	try {
		plantR10Excluded('build/__r10_x__.js');
		plant(R10_ROUTE, r10RouteImport('/src/lib/review/../../build/__r10_x__.js'));
		let result = runAudit();
		assert.equal(result.status, 1, `the root-absolute route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/routes "\/src\/lib\/review\/\.\.\/\.\.\/build\/__r10_x__\.js" — the route resolves to "src\/build\/__r10_x__\.js", which no candidate, classified root, or declared package answers for/,
			`the root-absolute route must classify by its normalized base:\n${result.output}`
		);

		// The dynamic-import form of the same spelling.
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(
			R10_ROUTE,
			'<script lang="ts">\n' +
				'\tconst m = await import("/src/lib/review/../../build/__r10_x__.js");\n' +
				'\tconst q = m;\n' +
				'</script>\n<p>x</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `the root-absolute dynamic import must fail:\n${result.output}`);
		assert.match(
			result.output,
			/which no candidate, classified root, or declared package answers for/,
			`the root-absolute dynamic import must be classified:\n${result.output}`
		);
	} finally {
		uprootAll();
	}
});

test('dotdot routes that normalize INTO the classified roots stay clean (R10-1 positives)', () => {
	plant(
		R10_ROUTE,
		'<script lang="ts">\n' +
			"\timport { toDraftPreview } from '$lib/cms/../cms/review';\n" +
			"\timport type { DraftPreview } from '$lib/review/../cms/review';\n" +
			"\timport { sanitizeHtml } from '$lib/greater/../greater/utils';\n" +
			"\timport { sanitizeHtml as viaDotdotDir } from '$lib/../lib/greater/utils';\n" +
			`\tconst q = \`\${toDraftPreview} \${sanitizeHtml} \${viaDotdotDir}\`;` +
			'\n\tconst t: DraftPreview | null = null;\n\tvoid t;\n' +
			'</script>\n<p>{q}</p>\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(
			status,
			0,
			`dotdot routes normalizing into owned/vendored roots must stay clean:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
	}
});

/* ============================================================
   Round 10 — R10-2: the alias table is consulted for every
   specifier spelling, and redirects of scanned modules fail
   ============================================================

   The round-10 attack aliased `$lib/review/PreviewBody.svelte` ITSELF to a
   root shim: the runtime's alias matching runs first-match-wins on every raw
   specifier — not only bare ones — so the shim replaced the sink module in
   the shipped bundle while the gate scanned the real component, audited
   green, and built green at 69587aa (marker verified in build/client). The
   closure now consults the table for every spelling, and an alias match
   redirecting a module the audit scans somewhere else is a finding. */

/** The round-10 hijack shim: a root-level sink replacement. */
function r10ShimSource(marker) {
	return (
		'<script lang="ts">\n' +
		"\timport type { DraftPreview } from '$lib/cms/review';\n" +
		'\tinterface Props { preview: DraftPreview; }\n' +
		'\tlet { preview }: Props = $props();\n' +
		`\tconst shown: string = (preview.html ?? '') + '<img src=x data-plant=${marker}>';\n` +
		'</script>\n\n{@html shown}\n'
	);
}

test('an alias of $lib/review/PreviewBody.svelte onto a root shim fails (R10-2 exact plant)', () => {
	const shim = '__r10_shim__.svelte';
	plant(shim, r10ShimSource('r102'));
	try {
		withPlantedViteConfig(
			(source) => {
				if (!source.includes(ALIAS_ANCHOR))
					throw new Error('the alias anchor moved — re-anchor the R10-2 probes');
				return source.replace(
					ALIAS_ANCHOR,
					"{ find: '$lib/review/PreviewBody.svelte', replacement: path.resolve(root, '__r10_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				);
			},
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the sink-module hijack must fail the audit:\n${output}`);
				assert.match(
					output,
					/redirecting the scanned module "src\/lib\/review\/PreviewBody\.svelte" to "__r10_shim__\.svelte"/,
					`the redirect of the scanned module must be named:\n${output}`
				);
				assert.match(
					output,
					/\[executable source universe\] __r10_shim__\.svelte is executable source outside the classified owned\/vendored roots/,
					`the shim outsider must be named too:\n${output}`
				);
			}
		);
	} finally {
		rmSync(join(repoRoot, shim), { force: true });
	}
});

test('hijacks of other owned modules and regex finds fail (R10-2 adjacent)', () => {
	const shim = '__r10_shim__.svelte';
	const tsShim = '__r10_alias_ts__.ts';
	const route = R10_ROUTE;
	const uprootAll = () => {
		rmSync(join(repoRoot, shim), { force: true });
		rmSync(join(repoRoot, tsShim), { force: true });
		rmSync(join(repoRoot, route), { force: true });
	};
	try {
		plant(shim, r10ShimSource('r102adj'));
		plant(tsShim, 'export const planted = true;\n');

		// A regex FIND capturing the owned sink specifier — first match wins.
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: /^\\$lib\\/review\\/PreviewBody\\.svelte$/, replacement: path.resolve(root, '__r10_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the regex-find hijack must fail:\n${output}`);
				assert.match(
					output,
					/redirecting the scanned module "src\/lib\/review\/PreviewBody\.svelte"/,
					`the regex redirect must be named:\n${output}`
				);
			}
		);

		// A hijack of a plain TS module another owned file imports.
		plant(
			route,
			'<script lang="ts">\n' +
				"\timport { toDraftPreview } from '$lib/cms/review';\n" +
				'\tconst q = toDraftPreview;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '$lib/cms/review', replacement: path.resolve(root, '__r10_alias_ts__.ts') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the TS-module hijack must fail:\n${output}`);
				assert.match(
					output,
					/redirecting the scanned module "src\/lib\/cms\/review" to "__r10_alias_ts__\.ts"/,
					`the TS-module redirect must be named:\n${output}`
				);
			}
		);
		// A hijack of a VENDORED module specifier — the scan judges the
		// vendored path, the runtime would load the shim.
		rmSync(join(repoRoot, route), { force: true });
		plant(
			route,
			'<script lang="ts">\n' +
				"\timport { sanitizeHtml } from '$lib/greater/utils';\n" +
				'\tconst q = sanitizeHtml;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		withPlantedViteConfig(
			(source) =>
				source.replace(
					ALIAS_ANCHOR,
					"{ find: '$lib/greater/utils', replacement: path.resolve(root, '__r10_shim__.svelte') },\n\t\t\t\t\t" +
						ALIAS_ANCHOR
				),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the vendored-module hijack must fail:\n${output}`);
				assert.match(
					output,
					/redirecting the scanned module "src\/lib\/greater\/utils"/,
					`the vendored redirect must be named:\n${output}`
				);
			}
		);
	} finally {
		uprootAll();
	}
});

test('an alias resolving to the same module stays clean (R10-2 positive)', () => {
	withPlantedViteConfig(
		(source) =>
			source.replace(
				ALIAS_ANCHOR,
				"{ find: '$lib/review/PreviewBody.svelte', replacement: path.resolve(root, 'src/lib/review/PreviewBody.svelte') },\n\t\t\t\t\t" +
					ALIAS_ANCHOR
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`an alias resolving to the SAME scanned module is no redirect:\n${output}`
			);
		}
	);
});

/* ============================================================
   Round 10 — R10-3: binding-element defaults, method defaults,
   and allSettled wrapper reads
   ============================================================

   The round-10 attack laundered the identity through three shapes the
   round-9 model did not bind: a destructured binding-element default
   (`function f({ x = preview } = {}) { return x; }; f()`), an object-method
   default (`const o = { m(p = preview) { return p; } }; o.m()`), and the
   allSettled wrapper's `.value` member read (`Promise.allSettled([preview])
   .then((rs) => { rs[0].value.html = … })`). All three audited green at
   69587aa with live writes. */

test('binding-element and method defaults bind at call positions (R10-3 exact plants)', () => {
	const shapes = [
		[
			'destructured binding-element default',
			'\tfunction r10de({ x = preview }: { x?: DraftPreview | null } = {}): DraftPreview | null { return x; }\n' +
				"\tif (preview) { const v = r10de(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'binding-element default with an empty-object argument',
			'\tfunction r10de2({ x = preview }: { x?: DraftPreview | null } = {}): DraftPreview | null { return x; }\n' +
				"\tif (preview) { const v = r10de2({}); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'object-method default',
			'\tconst r10obj = { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } };\n' +
				"\tif (preview) { const v = r10obj.m(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'allSettled wrapper .value write',
			"\tif (preview) void Promise.allSettled([preview]).then((rs) => { (rs[0] as PromiseFulfilledResult<DraftPreview>).value.html = '<img src=x>'; });\n",
			/writes to \.html on/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} relay must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} relay must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} relay must name the write:\n${output}`);
			}
		);
	}
});

test('class methods, awaited wrappers, and nested defaults fail (R10-3 adjacent)', () => {
	const shapes = [
		[
			'class-instance method default',
			'\tclass R10Class { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tconst r10inst = new R10Class();\n' +
				"\tif (preview) { const v = r10inst.m(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'awaited allSettled wrapper write',
			"\tasync function r10settled() { if (!preview) return; const rs = await Promise.allSettled([preview]); (rs[0] as PromiseFulfilledResult<DraftPreview>).value.html = '<img src=x>'; }\n" +
				'\tif (preview) void r10settled();\n',
			/writes to \.html on/,
		],
		[
			'allSettled .then destructure wrapper .value write',
			"\tif (preview) void Promise.allSettled([preview]).then(([w]) => { (w as PromiseFulfilledResult<DraftPreview>).value.html = '<img src=x>'; });\n",
			/writes to \.html on/,
		],
		[
			'nested binding-element default',
			'\tfunction r10nested({ a: { x = preview } = {} }: { a?: { x?: DraftPreview | null } } = {}): DraftPreview | null { return x; }\n' +
				"\tif (preview) { const v = r10nested(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'computed member call on an object with value-default methods',
			'\tconst r10cm = { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } };\n' +
				"\tconst r10key = 'm';\n" +
				'\tif (preview) r10cm[r10key]();\n',
			/a computed member call on an object whose method defaults read the preview value/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} shape must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} shape must be named:\n${output}`);
			}
		);
	}
});

test('member dispatch and settled iteration fail the audit (R10-3 adjacent, self-attack)', () => {
	const shapes = [
		[
			'.call dispatch of a method default',
			'\tconst r10c = { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } };\n' +
				"\tif (preview) { const v = r10c.m.call(r10c); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'.apply dispatch of a method default',
			'\tconst r10ap = { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } };\n' +
				"\tif (preview) { const v = r10ap.m.apply(r10ap, []); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'for-of over the settled array writing .value',
			"\tasync function r10fo() { if (!preview) return; const rs = await Promise.allSettled([preview]); for (const w of rs) (w as PromiseFulfilledResult<DraftPreview>).value.html = '<img src=x>'; }\n" +
				'\tif (preview) void r10fo();\n',
			/writes to \.html on/,
		],
		[
			'a bound wrapper element writing .value',
			"\tasync function r10bw() { if (!preview) return; const rs = await Promise.allSettled([preview]); const w = rs[0]; (w as PromiseFulfilledResult<DraftPreview>).value.html = '<img src=x>'; }\n" +
				'\tif (preview) void r10bw();\n',
			/writes to \.html on/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.match(output, message, `the ${label} shape must name the write:\n${output}`);
			}
		);
	}
	// The paired positive: a local method proven never to write its parameter
	// keeps a value-carrying member call clean.
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					"\tconst r10ro = { len(p: DraftPreview | null): number { return (p?.html ?? '').length; } };\n" +
					'\tif (preview) console.log(r10ro.len(preview));\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`a read-only local method receiving the value must stay clean:\n${output}`
			);
		}
	);
});

test('allSettled reads that never touch the value stay clean (R10-3 positives)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tif (preview) void Promise.allSettled([preview]).then((rs) => { console.log(rs[0].status); });\n' +
					'\tif (preview) void Promise.allSettled([preview]).then((rs) => { const wrapped = (rs[0] as PromiseFulfilledResult<DraftPreview>).value; console.log(wrapped === preview); });\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`status reads and write-free .value reads of allSettled wrappers must stay clean:\n${output}`
			);
		}
	);
});

/* ============================================================
   Round 10 — R10-4: container-returning helpers
   ============================================================

   The round-10 attack laundered through a tracked NON-MUTATING helper whose
   return is a container holding the reference — `function box(v) { return
   [v]; }; const [p] = box(preview); p.html = …` — audited green at 69587aa.
   The closure now reads literal container returns of local helpers, so a
   destructure of the call result, and element/property reads of it, bind the
   identity. */

test('container-returning helper destructures fail the audit (R10-4 exact plants)', () => {
	const shapes = [
		[
			'array-container helper destructure',
			'\tfunction r10box(v: DraftPreview): DraftPreview[] { return [v]; }\n' +
				"\tif (preview) { const [p] = r10box(preview); p.html = '<img src=x>'; }\n",
			/writes to p\.html/,
		],
		[
			'object-container helper destructure',
			'\tfunction r10boxO(v: DraftPreview): { body: DraftPreview } { return { body: v }; }\n' +
				"\tif (preview) { const { body } = r10boxO(preview); body.html = '<img src=x>'; }\n",
			/writes to body\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.match(output, message, `the ${label} shape must name the write:\n${output}`);
			}
		);
	}
});

test('direct reads into a container helper result fail (R10-4 adjacent)', () => {
	const shapes = [
		[
			'element read of the call result',
			'\tfunction r10boxE(v: DraftPreview): DraftPreview[] { return [v]; }\n' +
				"\tif (preview) r10boxE(preview)[0].html = '<img src=x>';\n",
			/writes to \.html on a value that entered a local container/,
		],
		[
			'property read of the call result',
			'\tfunction r10boxP(v: DraftPreview): { body: DraftPreview } { return { body: v }; }\n' +
				"\tif (preview) r10boxP(preview).body.html = '<img src=x>';\n",
			/writes to \.html on/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} shape must fail the audit:\n${output}`);
				assert.match(output, message, `the ${label} shape must name the write:\n${output}`);
			}
		);
	}
});

test('container helpers over non-preview values stay clean (R10-4 positive)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					'\tfunction r10plain(n: number): number[] { return [n, 1]; }\n' +
					'\tconst [r10a] = r10plain(2);\n' +
					'\tif (preview) console.log(r10a);\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(
				status,
				0,
				`a container helper carrying no preview value must stay clean:\n${output}`
			);
		}
	);
});

/* ============================================================
   Round 10 — R10-5: tagged templates and manual generators
   ============================================================

   The round-10 report's LOW shapes: a tagged template carrying the value
   (`tag`${preview}``) and a manual generator read (`gen().next().value`).
   The gate binds a tagged template's interpolations to the tag's parameters
   (after the leading template-strings position) and judges the tag like any
   local callee; a generator's `.next()` result is a wrapper whose `.value`
   read carries, and its iterator object is iterable like the call. */

test('tagged-template and manual-generator relays fail the audit (R10-5 exact plants)', () => {
	const shapes = [
		[
			'tagged-template relay',
			'\tfunction r10tag(_s: TemplateStringsArray, ...vals: unknown[]): unknown { return vals[0]; }\n' +
				"\tif (preview) { const v = r10tag`${preview}` as DraftPreview; v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'manual generator .next().value relay',
			'\tfunction* r10gen(): Generator<DraftPreview> { yield preview as DraftPreview; }\n' +
				"\tif (preview) { const w = r10gen().next().value; w.html = '<img src=x>'; }\n",
			/writes to w\.html/,
		],
		[
			'for-of over the generator iterator object',
			'\tfunction* r10gen2(): Generator<DraftPreview> { yield preview as DraftPreview; }\n' +
				"\tif (preview) { const it = r10gen2(); for (const g of it) g.html = '<img src=x>'; }\n",
			/writes to g\.html/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} relay must fail the audit:\n${output}`);
				assert.match(output, message, `the ${label} relay must name the write:\n${output}`);
			}
		);
	}
});

test('a scalar-returning tag stays clean (R10-5 positive)', () => {
	withPlantedWorkspace(
		(source) =>
			source.replace(
				PREVIEW_STATE_ANCHOR,
				PREVIEW_STATE_ANCHOR +
					"\tfunction r10lentag(_s: TemplateStringsArray, ...vals: unknown[]): number { return String(vals[0] ?? '').length; }\n" +
					'\tif (preview) { const n = r10lentag`${preview}`; console.log(n); }\n'
			),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 0, `a read-only tag over the value must stay clean:\n${output}`);
		}
	);
});

/* ============================================================
   Round 10 — R10-6: post-literal alias mutations fail closed
   ============================================================

   The round-10 attack mutated the table after the literal the scan reads —
   `cfg.resolve.alias.push({…})` and `cfg.resolve.alias = […]` — audited
   green at 69587aa while the runtime honored the mutation. Any write or
   mutating call whose target names `resolve.alias` makes the table
   unreadable: the scan would judge the dead literal while the runtime
   resolves with the mutation. */

/** Wrap the config's returned object in a variable so a mutation can follow. */
function r10ConfigWithMutation(mutation) {
	const source = readFileSync(join(repoRoot, VITE_CONFIG), 'utf8');
	if (!source.includes('\treturn {'))
		throw new Error('the config return anchor moved — re-anchor the R10-6 probes');
	const head = source.replace('\treturn {', '\tconst r10cfg = {');
	const cut = head.lastIndexOf('\t};');
	if (cut === -1) throw new Error('the config tail anchor moved — re-anchor the R10-6 probes');
	return `${head.slice(0, cut)}\t};\n\t${mutation}\n\treturn r10cfg;${head.slice(cut + '\t};'.length)}`;
}

test('post-literal alias mutations fail closed (R10-6 exact plants)', () => {
	const evilEntry = "{ find: '@r10evil', replacement: path.resolve(root, 'build/__r10_x__.js') }";
	const shapes = [
		['push mutation', `(r10cfg.resolve.alias as unknown[]).push(${evilEntry});`],
		['reassignment mutation', `r10cfg.resolve.alias = [${evilEntry}];`],
		['splice mutation', `(r10cfg.resolve.alias as unknown[]).splice(0, 0, ${evilEntry});`],
		['unshift mutation', `(r10cfg.resolve.alias as unknown[]).unshift(${evilEntry});`],
		['element-write mutation', `(r10cfg.resolve.alias as unknown[])[0] = ${evilEntry};`],
	];
	for (const [label, mutation] of shapes) {
		withPlantedViteConfig(
			() => r10ConfigWithMutation(mutation),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} of resolve.alias must fail:\n${output}`);
				assert.match(
					output,
					/mutates resolve\.alias after the declaration/,
					`the ${label} must be named as a mutation:\n${output}`
				);
			}
		);
	}
});

/* ============================================================
   Round 10 — R10-7: new URL literals join the closure
   ============================================================

   `new URL('<literal>', import.meta.url)` targets are bundled by Vite as
   assets or workers, and the round-10 review proved routes into excluded
   roots dropped silently. Literal targets are collected and judged as
   routes; directory anchors (`new URL('.', import.meta.url)`) and
   non-executable targets stay clean. */

test('new URL routes into excluded roots fail closed (R10-7 exact plants)', () => {
	const uprootAll = () => {
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		rmSync(join(repoRoot, 'build/__r10_x__.js'), { force: true });
	};
	try {
		plantR10Excluded('build/__r10_x__.js');

		// A relative target escaping into build/.
		plant(
			R10_ROUTE,
			'<script lang="ts">\n' +
				"\tconst u = new URL('../../../build/__r10_x__.js', import.meta.url);\n" +
				'\tconst q = u.href;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		let result = runAudit();
		assert.equal(result.status, 1, `a new URL route into build/ must fail:\n${result.output}`);
		assert.match(
			result.output,
			/routes "new URL\('\.\.\/\.\.\/\.\.\/build\/__r10_x__\.js', import\.meta\.url\)" — the route resolves into the excluded root "build"/,
			`the new URL route must be classified:\n${result.output}`
		);

		// A root-absolute target into build/.
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
		plant(
			R10_ROUTE,
			'<script lang="ts">\n' +
				"\tconst u = new URL('/build/__r10_x__.js', import.meta.url);\n" +
				'\tconst q = u.href;\n' +
				'</script>\n<p>{q}</p>\n'
		);
		result = runAudit();
		assert.equal(result.status, 1, `a root-absolute new URL route must fail:\n${result.output}`);
		assert.match(
			result.output,
			/the route resolves into the excluded root "build"/,
			`the root-absolute new URL route must be classified:\n${result.output}`
		);
	} finally {
		uprootAll();
	}
});

test('new URL anchors, owned targets, and non-executables stay clean (R10-7 positives)', () => {
	plant(
		R10_ROUTE,
		'<script lang="ts">\n' +
			"\tconst dir = new URL('.', import.meta.url);\n" +
			"\tconst owned = new URL('./preview-state-helpers.ts', import.meta.url);\n" +
			"\tconst note = new URL('./__r10_note__.md', import.meta.url);\n" +
			'\tconst q = `${dir.href} ${owned.href} ${note.href}`;\n' +
			'</script>\n<p>{q}</p>\n'
	);
	try {
		const { status, output } = runAudit();
		assert.equal(
			status,
			0,
			`directory anchors, owned targets, and non-executable new URL targets must stay clean:\n${output}`
		);
	} finally {
		rmSync(join(repoRoot, R10_ROUTE), { force: true });
	}
});

/* ============================================================
   Round 11 — R11-1: alias-table escapes fail closed
   ============================================================

   The round-10 mutation reading matched the table's NAME textually, so the
   round-11 attack mutated it wherever the literal's textual reach ended —
   `Reflect.set(cfg.resolve, 'alias', …)`, `Object.defineProperty` on the
   resolve object, a `push` through the identifier a destructure binds, and
   an element write inside a helper the table is handed to. All four spellings
   audited green at 34683b1, and under two of them `vite build` resolved the
   `svelte` import to the planted shim — a runtime-hijacked bundle over a
   green audit. Any write, mutation, or escape of the alias state — the
   table, its `resolve` object, an identifier derived from either, or the
   config object — makes the table unreadable and fails the audit. */

const R11_EVIL_ENTRY = "{ find: 'svelte', replacement: path.resolve(root, 'build/__r11_x__.js') }";

test('alias-table escapes fail closed (R11-1 exact plants)', () => {
	const shapes = [
		[
			'Reflect.set naming the resolve object',
			`Reflect.set(r10cfg.resolve, 'alias', [${R11_EVIL_ENTRY}]);`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'Object.defineProperty naming the resolve object',
			`Object.defineProperty(r10cfg.resolve, 'alias', { value: [${R11_EVIL_ENTRY}] });`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'push through a destructured alias identifier',
			`const { alias } = r10cfg.resolve;\n\t(alias as unknown[]).push(${R11_EVIL_ENTRY});`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'element write inside a helper handed the table',
			`function r11w(t: unknown[]) { t[0] = ${R11_EVIL_ENTRY}; }\n\tr11w(r10cfg.resolve.alias as unknown[]);`,
			/hands the resolve\.alias state to code the scan cannot read/,
		],
	];
	for (const [label, mutation, message] of shapes) {
		withPlantedViteConfig(
			() => r10ConfigWithMutation(mutation),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} escape must fail:\n${output}`);
				assert.match(output, message, `the ${label} escape must be named:\n${output}`);
			}
		);
	}
});

test('alias-table escape adjacents fail closed (R11-1 adjacent)', () => {
	const shapes = [
		[
			'computed-key element write through a derived identifier',
			`const { alias: r11alias } = r10cfg.resolve;\n\tconst r11k = 0;\n\t(r11alias as unknown[])[r11k] = ${R11_EVIL_ENTRY};`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'splice through a derived identifier',
			`const { alias: r11a2 } = r10cfg.resolve;\n\t(r11a2 as unknown[]).splice(0, 0, ${R11_EVIL_ENTRY});`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'push inside a nested helper',
			`function r11w2(t: unknown[]) { (t as unknown[]).push(${R11_EVIL_ENTRY}); }\n\tr11w2(r10cfg.resolve.alias as unknown[]);`,
			/hands the resolve\.alias state to code the scan cannot read/,
		],
		[
			'Function.prototype.call handed the table',
			`Array.prototype.push.call(r10cfg.resolve.alias, ${R11_EVIL_ENTRY});`,
			/hands the resolve\.alias state to code the scan cannot read/,
		],
		[
			'Reflect.defineProperty naming the resolve object',
			`Reflect.defineProperty(r10cfg.resolve, 'alias', { value: [${R11_EVIL_ENTRY}] });`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'Object.defineProperty naming the config object itself',
			`Object.defineProperty(r10cfg, 'resolve', { value: (globalThis as { __r11?: unknown }).__r11 });`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'write to the resolve property of the config object',
			`r10cfg.resolve = (globalThis as { __r11?: unknown }).__r11;`,
			/mutates resolve\.alias after the declaration/,
		],
		[
			'spread of the resolve object',
			`const r11r = { ...r10cfg.resolve };`,
			/hands the resolve\.alias state to code the scan cannot read/,
		],
		[
			'spread of the config object',
			`const r11c = { ...r10cfg };`,
			/hands the resolve\.alias state to code the scan cannot read/,
		],
	];
	for (const [label, mutation, message] of shapes) {
		withPlantedViteConfig(
			() => r10ConfigWithMutation(mutation),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} escape must fail:\n${output}`);
				assert.match(output, message, `the ${label} escape must be named:\n${output}`);
			}
		);
	}
});

test('the wrapped config shape without a mutation stays clean (R11-1 positive)', () => {
	// The escape readings judge the declaration's textual reach, not the
	// wrapped shape itself: a config bound to a variable and returned stays
	// clean while the real table reads exactly as it does unwrapped.
	withPlantedViteConfig(
		() => r10ConfigWithMutation(''),
		() => {
			const { status, output } = runAudit();
			assert.equal(status, 0, `the wrapped config without mutation must stay clean:\n${output}`);
		}
	);
});

/* ============================================================
   Round 11 — R11-2: the heritage chase for member calls
   ============================================================

   The round-10 method readings keyed `owner.method` by the DECLARING owner,
   so an instance whose class merely EXTENDS the declarer never matched —
   `class A { m(p = preview) { return p } } class B extends A {}` then
   `b.m()` audited green at 34683b1 with a live `v.html` write. Member
   resolution now chases the extends clause to the declaring base, and a
   method that cannot be proven after the chase fails closed. */

test('inherited method relays fail closed (R11-2 exact plants)', () => {
	const shapes = [
		[
			'single-hop heritage relay',
			'\tclass R11A { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tclass R11B extends R11A {}\n' +
				'\tconst r11b = new R11B();\n' +
				"\tif (preview) { const v = r11b.m(); if (v) v.html = '<img src=x>'; }\n",
		],
		[
			'two-hop heritage relay',
			'\tclass R11A2 { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tclass R11M2 extends R11A2 {}\n' +
				'\tclass R11B2 extends R11M2 {}\n' +
				'\tconst r11b2 = new R11B2();\n' +
				"\tif (preview) { const v = r11b2.m(); if (v) v.html = '<img src=x>'; }\n",
		],
		[
			'class-expression base relay',
			'\tconst R11A3 = class {\n' +
				'\t\tm(p: DraftPreview | null = preview): DraftPreview | null { return p; }\n' +
				'\t};\n' +
				'\tclass R11B3 extends R11A3 {}\n' +
				'\tconst r11b3 = new R11B3();\n' +
				"\tif (preview) { const v = r11b3.m(); if (v) v.html = '<img src=x>'; }\n",
		],
		[
			'class expression WITH heritage relay',
			'\tclass R11A3b { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tconst R11B3b = class extends R11A3b {};\n' +
				'\tconst r11b3b = new R11B3b();\n' +
				"\tif (preview) { const v = r11b3b.m(); if (v) v.html = '<img src=x>'; }\n",
		],
	];
	for (const [label, plantText] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} must be a value-path finding:\n${output}`
				);
				assert.match(output, /writes to v\.html/, `the ${label} must name the write:\n${output}`);
			}
		);
	}
});

test('inherited relay adjacents fail closed (R11-2 adjacent)', () => {
	const shapes = [
		[
			'inherited getter relay',
			'\tclass R11GA {\n' +
				'\t\tget g(): DraftPreview | null { return preview; }\n' +
				'\t}\n' +
				'\tclass R11GB extends R11GA {}\n' +
				'\tconst r11gb = new R11GB();\n' +
				"\tif (preview) { const v = r11gb.g; if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'inherited async method relay',
			'\tclass R11AA {\n' +
				'\t\tasync am(p: DraftPreview | null = preview): Promise<DraftPreview | null> { return p; }\n' +
				'\t}\n' +
				'\tclass R11BA extends R11AA {}\n' +
				'\tconst r11ba = new R11BA();\n' +
				"\tif (preview) { const v = r11ba.am(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'inherited generator method relay',
			'\tclass R11GMA {\n' +
				'\t\t*gm(p: DraftPreview | null = preview): Generator<never, DraftPreview | null, unknown> { return p; }\n' +
				'\t}\n' +
				'\tclass R11GMB extends R11GMA {}\n' +
				'\tconst r11gmb = new R11GMB();\n' +
				"\tif (preview) { const v = r11gmb.gm(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'interface-only heritage fails closed',
			'\tinterface R11I { m(p?: DraftPreview | null): DraftPreview | null; }\n' +
				'\tclass R11B4 implements R11I {}\n' +
				'\tconst r11b4 = new R11B4();\n' +
				"\tif (preview) { const v = r11b4.m(); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'inherited .call dispatch relay',
			'\tclass R11CCA { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tclass R11CCB extends R11CCA {}\n' +
				'\tconst r11ccb = new R11CCB();\n' +
				"\tif (preview) { const v = r11ccb.m.call(r11ccb); if (v) v.html = '<img src=x>'; }\n",
			/writes to v\.html/,
		],
		[
			'inherited mutating method receiving the value',
			"\tclass R11MA { wm(p: DraftPreview | null): void { if (p) p.html = '<img src=x>'; } }\n" +
				'\tclass R11MB extends R11MA {}\n' +
				'\tconst r11mb = new R11MB();\n' +
				'\tif (preview) r11mb.wm(preview);\n',
			/writes to p\.html/,
		],
		[
			'computed call over inherited value-default methods',
			'\tclass R11KA { m(p: DraftPreview | null = preview): DraftPreview | null { return p; } }\n' +
				'\tclass R11KB extends R11KA {}\n' +
				'\tconst r11kb = new R11KB();\n' +
				"\tconst r11key = 'm';\n" +
				'\tif (preview) r11kb[r11key]();\n',
			/a computed member call on an object whose method defaults read the preview value/,
		],
	];
	for (const [label, plantText, message] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 1, `the ${label} must fail the audit:\n${output}`);
				assert.ok(
					output.includes('[preview value path]'),
					`the ${label} must be a value-path finding:\n${output}`
				);
				assert.match(output, message, `the ${label} must be named:\n${output}`);
			}
		);
	}
});

test('inherited read-only members stay clean (R11-2 positives)', () => {
	const shapes = [
		[
			'an inherited read-only method receiving the value',
			"\tclass R11PA { len(p: DraftPreview | null): number { return (p?.html ?? '').length; } }\n" +
				'\tclass R11PB extends R11PA {}\n' +
				'\tconst r11pb = new R11PB();\n' +
				'\tif (preview) console.log(r11pb.len(preview));\n',
		],
		[
			'an inherited getter returning a fresh literal',
			"\tclass R11GA2 { get g(): string { return 'x'; } }\n" +
				'\tclass R11GB2 extends R11GA2 {}\n' +
				'\tconst r11gb2 = new R11GB2();\n' +
				'\tif (preview) console.log(r11gb2.g.length);\n',
		],
		[
			'a member call on a non-local instance',
			'\tconst r11d = new Date();\n' +
				'\tif (preview) console.log(r11d.getTime(), r11d.toISOString());\n',
		],
		[
			'a static method call on the class name',
			'\tclass R11S { static make(): number { return 1; } }\n' +
				'\tif (preview) console.log(R11S.make());\n',
		],
	];
	for (const [label, plantText] of shapes) {
		withPlantedWorkspace(
			(source) => source.replace(PREVIEW_STATE_ANCHOR, PREVIEW_STATE_ANCHOR + plantText),
			() => {
				const { status, output } = runAudit();
				assert.equal(status, 0, `${label} must stay clean:\n${output}`);
			}
		);
	}
});

test('the tree audits clean after every round-10 and round-11 plant is uprooted', () => {
	const { status, output } = runAudit();
	assert.equal(status, 0, output);
});

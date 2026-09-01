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
	const original = readFileSync(join(repoRoot, DISPLAY_SINK), 'utf8');
	writeFileSync(join(repoRoot, DISPLAY_SINK), contents);
	try {
		body();
	} finally {
		writeFileSync(join(repoRoot, DISPLAY_SINK), original);
	}
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
	const original = readFileSync(join(repoRoot, REVIEW_WORKSPACE), 'utf8');
	const mutated = mutate(original);
	writeFileSync(join(repoRoot, REVIEW_WORKSPACE), mutated);
	try {
		body();
	} finally {
		writeFileSync(join(repoRoot, REVIEW_WORKSPACE), original);
	}
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

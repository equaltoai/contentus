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

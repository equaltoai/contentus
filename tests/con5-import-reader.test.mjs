import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The regression matrix for the reading CON-5's executable closure is built on.
 *
 * WHAT THIS FILE IS FOR. CON-5 pins the CONTENT of everything a guarded
 * package.json script executes: each `node <path>` target, each file a glob
 * expands to, and each relative module those files import, transitively. The
 * closure is only ever as wide as the reading that walks it, and that reading was
 * four regular expressions over the file's raw text. Two defects came out of it,
 * and they are one defect:
 *
 *   A. `import { value } from /* a comment *\/ './lib/helper.mjs';` is legal ESM
 *      — a comment sits exactly where the pattern required whitespace before a
 *      quote — so the import was not seen. The helper never entered the closure,
 *      needed no pin, and could be rewritten wholesale with the control green.
 *      An unbound executable inside a gate's own reach is the failure CON-5
 *      exists to prevent, one level in.
 *
 *   B. `'./lib/helper.mjs?raw'` addresses a file that exists, and the reader
 *      compared the specifier VERBATIM — so it resolved to nothing and was
 *      reported as an unresolvable import in a gate. A probe that needed the form
 *      had to spell its specifier as a computed constant to keep the rubric green
 *      beside the check it was testing.
 *
 * Matching by the text that is written rather than by the path it addresses
 * misses edges that are there (A) and invents edges that are not (B). Both
 * directions are regressed below, because a fix for one is where the other gets
 * introduced.
 *
 * HOW THE GATE IS RUN. Against a synthetic repository in a temp directory, not
 * against this one. CON-5 takes its root from `process.cwd()` and reads
 * `package.json` and the pinned contract from it, so a tree of three files and a
 * contract is the whole harness — and the verifier under test is this
 * repository's, at its current bytes, which a `git archive` of HEAD would not be.
 * Nothing here touches the working tree: `node --test` runs test files
 * concurrently and `pnpm build` may be running beside this.
 *
 * EVERY GREEN HERE IS PAIRED WITH A RED. A control that passes because the gate
 * never reached the file is indistinguishable from one that passes because the
 * file is bound, so each case that must be silent is run again with the pin
 * removed or corrupted, and the gate must name the file.
 */

const VERIFIER = fileURLToPath(
	new URL('../gov-infra/verifiers/check-package-scripts.mjs', import.meta.url)
);

/** The helper every fixture reaches, and the executable symptom A left unbound. */
const HELPER = 'scripts/lib/helper.mjs';
const HELPER_SOURCE = "export const value = 'the helper as written';\n";

/**
 * Run CON-5 over a synthetic tree.
 *
 * `pinned` is the exact set of paths the contract binds — exact because CON-5
 * fails a pin no command reaches as well as a target no pin binds, so a test
 * cannot quietly over-pin its way to green. `corrupt` moves one pin off the
 * file's real content, which is how a case proves the walk REACHED a file rather
 * than merely tolerating it.
 */
function runCon5({
	files,
	entry = 'scripts/gate.mjs',
	pinned = [],
	corrupt = null,
	contract = {},
}) {
	const directory = mkdtempSync(join(tmpdir(), 'contentus-con5-'));
	try {
		const write = (path, source) => {
			const absolute = join(directory, path);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, source, 'utf8');
		};

		const scripts = { gate: `node ${entry}` };
		write(
			'package.json',
			JSON.stringify({ name: 'con5-fixture', private: true, scripts }, null, 2)
		);
		for (const [path, source] of Object.entries(files)) write(path, source);

		const sha256 = {};
		for (const path of pinned)
			sha256[path] =
				path === corrupt
					? createHash('sha256').update('not this file', 'utf8').digest('hex')
					: createHash('sha256').update(files[path], 'utf8').digest('hex');

		write(
			'gov-infra/planning/contentus-pinned-repo-contract.json',
			JSON.stringify(
				{
					package_scripts: { expected: scripts },
					executable_targets: {
						unpinned_import_roots: [],
						allowed_globs: [],
						sha256,
						...contract,
					},
				},
				null,
				2
			)
		);

		const run = spawnSync(process.execPath, [VERIFIER], { cwd: directory, encoding: 'utf8' });
		return { status: run.status, output: `${run.stdout}${run.stderr}` };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/* -------------------------------------------------------------------------
 * Symptom A — the comment that hid an executable
 * ---------------------------------------------------------------------- */

test('symptom A: the reported repro now fails at step 2', () => {
	// The repro, verbatim. 1: a helper the gate file really loads, imported with a
	// comment between `from` and its specifier. 2: update the gate file's own pin.
	// It used to PASS with no mention of the helper; it must now name it.
	const files = {
		'scripts/gate.mjs':
			"import { value } from /* a comment */ './lib/helper.mjs';\nconsole.log(value);\n",
		[HELPER]: HELPER_SOURCE,
	};

	const step2 = runCon5({ files, pinned: ['scripts/gate.mjs'] });
	assert.equal(step2.status, 1, 'an unpinned executable inside the closure must fail the control');
	assert.match(step2.output, /scripts\/lib\/helper\.mjs has no pinned sha256/);

	// 3: rewrite the helper's contents entirely. It used to stay PASS, which is the
	// whole consequence — an executable in a gate's closure, unbound and freely
	// editable. The finding must be identical, because the file is unbound either way.
	const rewritten = {
		...files,
		[HELPER]: "export const value = 'something else entirely';\nprocess.exitCode = 0;\n",
	};
	const step3 = runCon5({ files: rewritten, pinned: ['scripts/gate.mjs'] });
	assert.equal(step3.status, 1);
	assert.equal(step3.output, step2.output, 'rewriting an unbound helper cannot change the answer');

	// 4: the control. Deleting just the comment used to be what made the gate see
	// the import at all. It must now make no difference whatsoever.
	const withoutComment = {
		...files,
		'scripts/gate.mjs': "import { value } from './lib/helper.mjs';\nconsole.log(value);\n",
	};
	const step4 = runCon5({ files: withoutComment, pinned: ['scripts/gate.mjs'] });
	assert.equal(step4.output, step2.output, 'the comment is trivia, and the reading treats it so');
});

test('symptom A: the helper is genuinely bound, not merely always reported', () => {
	// The pairing. A finding that never goes away is not a binding, so the same
	// tree with the helper pinned must pass — and with the pin moved off its
	// content must fail on the CONTENT, which is what proves the walk opened it.
	const files = {
		'scripts/gate.mjs':
			"import { value } from /* a comment */ './lib/helper.mjs';\nconsole.log(value);\n",
		[HELPER]: HELPER_SOURCE,
	};
	const pinned = ['scripts/gate.mjs', HELPER];

	const bound = runCon5({ files, pinned });
	assert.equal(bound.status, 0, bound.output);
	assert.match(bound.output, /2 executable targets in the closure match their pinned SHA-256/);

	const moved = runCon5({ files, pinned, corrupt: HELPER });
	assert.equal(moved.status, 1);
	assert.match(moved.output, /scripts\/lib\/helper\.mjs: content does not match its pin/);
});

test('a comment binds nothing wherever it legally sits', () => {
	// The class, not the instance. Round 4 of the seam review taught that the next
	// bypass is only ever the next place a comment may sit, which is why the
	// reading is a parser: to a tokenizer every one of these is trivia between two
	// tokens, and none of them is a question this file has to keep answering.
	const placements = {
		'between from and the specifier': "import { value } from /* c */ './lib/helper.mjs';",
		'before the import keyword': "/* c */ import { value } from './lib/helper.mjs';",
		'inside the import clause': "import /* c */ { value } /* c */ from './lib/helper.mjs';",
		'in a re-export': "export /* c */ { value } from './lib/helper.mjs';",
		'a line comment above the statement': "// c\nimport { value } from './lib/helper.mjs';",
		'a line comment before from': "import { value }\n// c\nfrom './lib/helper.mjs';",
		'a comment inside the specifier position of a side-effect import':
			"import /* c */ './lib/helper.mjs';",
	};

	for (const [where, statement] of Object.entries(placements)) {
		const files = { 'scripts/gate.mjs': `${statement}\n`, [HELPER]: HELPER_SOURCE };

		const unpinned = runCon5({ files, pinned: ['scripts/gate.mjs'] });
		assert.equal(unpinned.status, 1, `a comment ${where} must not hide the import`);
		assert.match(unpinned.output, /scripts\/lib\/helper\.mjs has no pinned sha256/);

		const pinned = runCon5({ files, pinned: ['scripts/gate.mjs', HELPER] });
		assert.equal(
			pinned.status,
			0,
			`a comment ${where} must not invent one either: ${pinned.output}`
		);
	}
});

/* -------------------------------------------------------------------------
 * Symptom B — the query that invented an unresolvable import
 * ---------------------------------------------------------------------- */

test('symptom B: a specifier is matched by the path it addresses', () => {
	// Every query form the seam probes plant, asked of a gate file this time. The
	// bundler resolves the same path and reads the same file whatever the query
	// alters about what the importer receives, so the pin is the file's.
	for (const query of ['?raw', '?url', '?raw&inline', '#anchor', '?url#anchor']) {
		const files = {
			'scripts/gate.mjs': `import { value } from './lib/helper.mjs${query}';\nconsole.log(value);\n`,
			[HELPER]: HELPER_SOURCE,
		};

		const bound = runCon5({ files, pinned: ['scripts/gate.mjs', HELPER] });
		assert.equal(
			bound.status,
			0,
			`${query} must resolve to the file it addresses: ${bound.output}`
		);

		// And the pairing: the query does not excuse the file from being pinned.
		const unpinned = runCon5({ files, pinned: ['scripts/gate.mjs'] });
		assert.equal(unpinned.status, 1, `${query} must still bind the file it names`);
		assert.match(unpinned.output, /scripts\/lib\/helper\.mjs has no pinned sha256/);
	}
});

test('a query does not make an unresolvable import resolvable', () => {
	// The other direction of the same fix. Stripping the query must widen what a
	// specifier is MATCHED against, not what the control accepts — an import of a
	// file that is not there is still an unscanned one, and the finding quotes the
	// specifier as written, query and all, because that is what is in the file.
	const missing = runCon5({
		files: { 'scripts/gate.mjs': "import { value } from './lib/missing.mjs?raw';\n" },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(missing.status, 1);
	assert.match(missing.output, /relative import "\.\/lib\/missing\.mjs\?raw" resolves to no file/);
});

/* -------------------------------------------------------------------------
 * What executes, and what only type-checks
 * ---------------------------------------------------------------------- */

test('a type-only declaration binds nothing, because nothing runs it', () => {
	// THE JUDGEMENT, recorded because it is one. `import type … from` is erased by
	// `--experimental-strip-types` and by `tsc` before anything runs, so the file
	// it names is not code a guarded command executes and pinning its bytes would
	// bind content no command opens. The seam probes take the opposite reading of
	// the same walk, and their header says why: a swap behind a seam breaks a type
	// that names a component exactly as it breaks a value that names it.
	//
	// The fixtures are `.mts`, because that is where these forms can legally sit.
	for (const statement of [
		"import type { value } from './lib/helper.mjs';",
		"export type { value } from './lib/helper.mjs';",
		"import type value = require('./lib/helper.mjs');",
		"type X = import('./lib/helper.mjs').value;",
	]) {
		const erased = runCon5({
			files: { 'scripts/gate.mts': `${statement}\n`, [HELPER]: HELPER_SOURCE },
			entry: 'scripts/gate.mts',
			pinned: ['scripts/gate.mts'],
		});
		assert.equal(erased.status, 0, `${statement} opens no file at run time: ${erased.output}`);
	}

	// The differential, three ways. A value import of the same file binds it; a
	// type-only SPECIFIER inside a value import is not a type-only DECLARATION —
	// the module is still loaded — and a side-effect import loads it for nothing
	// but its side effects, which is the strongest reason of all to pin it.
	for (const statement of [
		"import { value } from './lib/helper.mjs';",
		"import { type value, other } from './lib/helper.mjs';",
		"import './lib/helper.mjs';",
	]) {
		const loaded = runCon5({
			files: { 'scripts/gate.mts': `${statement}\n`, [HELPER]: HELPER_SOURCE },
			entry: 'scripts/gate.mts',
			pinned: ['scripts/gate.mts'],
		});
		assert.equal(loaded.status, 1, `${statement} loads the module and must bind it`);
		assert.match(loaded.output, /scripts\/lib\/helper\.mjs has no pinned sha256/);
	}
});

test('a literal require is CommonJS’s import and binds like one', () => {
	// The form the previous raw-text reader DID match. A parser that dropped it
	// would have closed symptom A by opening a hole beside it, and CON-5 resolves
	// `.cjs` among its module extensions, so the hole would have been reachable.
	const files = {
		'scripts/gate.cjs': "const { value } = require('./lib/helper.cjs');\nconsole.log(value);\n",
		'scripts/lib/helper.cjs': "module.exports = { value: 'the helper as written' };\n",
	};

	const unpinned = runCon5({ files, entry: 'scripts/gate.cjs', pinned: ['scripts/gate.cjs'] });
	assert.equal(unpinned.status, 1);
	assert.match(unpinned.output, /scripts\/lib\/helper\.cjs has no pinned sha256/);

	const bound = runCon5({
		files,
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs', 'scripts/lib/helper.cjs'],
	});
	assert.equal(bound.status, 0, bound.output);
});

/* -------------------------------------------------------------------------
 * Failing closed on what no reading can follow
 * ---------------------------------------------------------------------- */

test('a load no static read can name is a finding unless it is disclosed', () => {
	// The previous reader was not permissive about these; it could not see them.
	// Silence and permission are the same green from outside, which is the property
	// a gate may not have — so the site is named, and the disclosure carries the
	// reason where a reviewer reads it.
	const computed = {
		'scripts/gate.mjs': 'const target = process.argv[2];\nawait import(target);\n',
	};

	const undisclosed = runCon5({ files: computed, pinned: ['scripts/gate.mjs'] });
	assert.equal(undisclosed.status, 1);
	assert.match(undisclosed.output, /import\(target\) loads a module no static read can name/);

	const disclosed = runCon5({
		files: computed,
		pinned: ['scripts/gate.mjs'],
		contract: {
			computed_imports_disclosed: [
				{ file: 'scripts/gate.mjs', expression: 'import(target)', reason: 'the fixture’s point' },
			],
		},
	});
	assert.equal(disclosed.status, 0, disclosed.output);

	// A disclosure is exact on both sides: the file, and the call as written.
	const mismatched = runCon5({
		files: computed,
		pinned: ['scripts/gate.mjs'],
		contract: {
			computed_imports_disclosed: [
				{ file: 'scripts/gate.mjs', expression: 'import(other)', reason: 'not this call' },
			],
		},
	});
	assert.equal(mismatched.status, 1);
	assert.match(mismatched.output, /import\(target\) loads a module no static read can name/);
	assert.match(mismatched.output, /declares import\(other\) in scripts\/gate\.mjs/);

	// `require(<expression>)` is the same class and reports as itself, rather than
	// as an `import(` line assembled around someone else's argument.
	const required = runCon5({
		files: { 'scripts/gate.mjs': 'const name = process.argv[2];\nrequire(name);\n' },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(required.status, 1);
	assert.match(required.output, /require\(name\) loads a module no static read can name/);
});

test('a disclosure of nothing is a finding, like a pin of nothing', () => {
	// The same rule the pin map already holds itself to. A disclosure whose site is
	// gone reads as a permission the tree still needs, and the next computed load
	// written into that file would land on it silently.
	const stale = runCon5({
		files: { 'scripts/gate.mjs': "console.log('nothing computed here');\n" },
		pinned: ['scripts/gate.mjs'],
		contract: {
			computed_imports_disclosed: [
				{ file: 'scripts/gate.mjs', expression: 'import(gone)', reason: 'removed last week' },
			],
		},
	});
	assert.equal(stale.status, 1);
	assert.match(
		stale.output,
		/declares import\(gone\) in scripts\/gate\.mjs, which the closure does not/
	);
});

test('a gate file the reading cannot parse fails closed', () => {
	// An unreadable file and a file with no imports must not answer the same green.
	// The reading throws rather than recovering, and the control reports the file.
	const unreadable = runCon5({
		files: { 'scripts/gate.mjs': 'import X from ; const y = ((;\n' },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(unreadable.status, 1);
	assert.match(unreadable.output, /scripts\/gate\.mjs: this file's imports cannot be read/);
});

/* -------------------------------------------------------------------------
 * What a specifier is not
 * ---------------------------------------------------------------------- */

test('a specifier inside a string is a value, not an import', () => {
	// The third symptom of the raw-text reading, and the one that shaped source
	// this repository still carries: a probe planting an import as a FIXTURE was
	// read as taking that import itself, so `tests/seam-graph.test.mjs` and
	// `tests/agents-roster.test.mjs` had to hold their specifiers in constants and
	// interpolate them to keep the rubric green beside the check under test. To a
	// parser a string literal is a value in an expression, and there is no import
	// declaration anywhere in this fixture.
	const fixture = runCon5({
		files: {
			'scripts/gate.mjs':
				'const planted = "import X from \'./lib/nowhere.mjs\';";\nconsole.log(planted);\n',
		},
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(fixture.status, 0, fixture.output);

	// And a comment naming one is prose. This header names several.
	const prose = runCon5({
		files: {
			'scripts/gate.mjs': "// see import X from './lib/nowhere.mjs'\nexport const ok = 1;\n",
		},
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(prose.status, 0, prose.output);
});

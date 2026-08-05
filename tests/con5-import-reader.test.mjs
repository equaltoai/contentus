import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** The helper every fixture reaches, and the executable symptom A left unbound. */
const HELPER = 'scripts/lib/helper.mjs';
const HELPER_SOURCE = "export const value = 'the helper as written';\n";

/** The same helper in the dialect `require` can open. */
const CJS_HELPER = 'scripts/lib/helper.cjs';
const CJS_HELPER_SOURCE = "module.exports = { value: 'the helper as written' };\n";

/**
 * Run CON-5 over a synthetic tree.
 *
 * `pinned` is the exact set of paths the contract binds — exact because CON-5
 * fails a pin no command reaches as well as a target no pin binds, so a test
 * cannot quietly over-pin its way to green. `corrupt` moves one pin off the
 * file's real content, which is how a case proves the walk REACHED a file rather
 * than merely tolerating it. `links` plants a symlink, which is the one member of
 * a closure whose path and content can be parted without an edit to either.
 */
function runCon5({
	files,
	entry = 'scripts/gate.mjs',
	pinned = [],
	corrupt = null,
	contract = {},
	links = {},
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
		for (const [path, target] of Object.entries(links)) {
			const absolute = join(directory, path);
			mkdirSync(dirname(absolute), { recursive: true });
			symlinkSync(join(directory, target), absolute);
		}

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

		// THE VERIFIER'S PATH IS SPELLED AT THE CALL, and that is a control rather
		// than a style. This site is disclosed in the pinned contract, and its
		// declaration BINDS the verifier — so those bytes are pinned like every
		// other file a guarded command executes. What makes the declaration
		// checkable is that the path is a literal here: CON-5 resolves the literals
		// a site is written to hand `spawnSync` and requires `binds` to name exactly
		// those repository files. A path held in a constant declared far above is a
		// path no reading can see at the call, and a `binds` beside it would be an
		// unverifiable claim of coverage — the decoy shape the rule refuses.
		const run = spawnSync(
			process.execPath,
			[fileURLToPath(new URL('../gov-infra/verifiers/check-package-scripts.mjs', import.meta.url))],
			{ cwd: directory, encoding: 'utf8' }
		);
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
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'import(target)',
					reason: 'the fixture’s point',
				},
			],
		},
	});
	assert.equal(disclosed.status, 0, disclosed.output);

	// A disclosure is exact on every side: the file, the line, and the call as
	// written. Each of the three alone is enough to leave the site undeclared.
	for (const [what, entry] of [
		['the call', { expression: 'import(other)' }],
		['the line', { line: 3 }],
		['the file', { file: 'scripts/other.mjs' }],
	]) {
		const mismatched = runCon5({
			files: computed,
			pinned: ['scripts/gate.mjs'],
			contract: {
				unfollowable_loads_disclosed: [
					{
						file: 'scripts/gate.mjs',
						line: 2,
						expression: 'import(target)',
						reason: 'not this call',
						...entry,
					},
				],
			},
		});
		assert.equal(mismatched.status, 1, `a disclosure that misses ${what} declares nothing`);
		assert.match(mismatched.output, /scripts\/gate\.mjs:2: import\(target\) loads a module/);
		assert.match(mismatched.output, /which the closure does not contain/);
	}

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
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 1,
					expression: 'import(gone)',
					reason: 'removed last week',
				},
			],
		},
	});
	assert.equal(stale.status, 1);
	assert.match(
		stale.output,
		/declares import\(gone\) at scripts\/gate\.mjs:1, which the closure does not/
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

/* -------------------------------------------------------------------------
 * Which file a specifier opens, which is the loader's answer and not the text's
 * ---------------------------------------------------------------------- */

test('an extensionless require is resolved the way CommonJS resolves it', () => {
	// THE REPRO, from round 7. A gate that requires `./lib/helper` beside BOTH a
	// `helper.mjs` and a `helper.js`. The walk applied one invented extension order
	// to every load, beginning at `.mjs`, so it pinned the `.mjs` — a file `require`
	// cannot open at all — while Node executed the `.js` that no pin bound.
	// Rewriting that `.js` wholesale left the control green.
	const gate = "const { value } = require('./lib/helper');\nconsole.log(value);\n";
	const js = "module.exports = { value: 'the .js CommonJS opens' };\n";
	const mjs = "export const value = 'the .mjs require cannot open';\n";

	const decoy = runCon5({
		files: { 'scripts/gate.cjs': gate, 'scripts/lib/helper.js': js, 'scripts/lib/helper.mjs': mjs },
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(decoy.status, 1, 'two files under one stem is a decoy whichever one is pinned');
	assert.match(decoy.output, /names more than one file/);
	assert.match(decoy.output, /require\(\) opens scripts\/lib\/helper\.js/);
	assert.match(decoy.output, /scripts\/lib\/helper\.mjs sits under the same stem/);

	// Alone, the `.js` is the file CommonJS opens — and it is bound, which is what
	// pinning the `.mjs` never was. The pairing runs both directions: unpinned it
	// must be named, pinned it must pass, and moved off its content it must fail on
	// the CONTENT, which is what proves the walk opened this file and not another.
	const files = { 'scripts/gate.cjs': gate, 'scripts/lib/helper.js': js };
	const unpinned = runCon5({ files, entry: 'scripts/gate.cjs', pinned: ['scripts/gate.cjs'] });
	assert.equal(unpinned.status, 1);
	assert.match(unpinned.output, /scripts\/lib\/helper\.js has no pinned sha256/);

	const pinned = ['scripts/gate.cjs', 'scripts/lib/helper.js'];
	const bound = runCon5({ files, entry: 'scripts/gate.cjs', pinned });
	assert.equal(bound.status, 0, bound.output);

	const moved = runCon5({
		files,
		entry: 'scripts/gate.cjs',
		pinned,
		corrupt: 'scripts/lib/helper.js',
	});
	assert.equal(moved.status, 1);
	assert.match(moved.output, /scripts\/lib\/helper\.js: content does not match its pin/);

	// And alone, the `.mjs` is not reachable by that specifier at all: `require`
	// adds `.js`, `.json` and `.node`, and Node answers MODULE_NOT_FOUND. Reporting
	// it as an edge would pin a file the command never opens.
	const unreachable = runCon5({
		files: { 'scripts/gate.cjs': gate, 'scripts/lib/helper.mjs': mjs },
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(unreachable.status, 1);
	assert.match(unreachable.output, /require\(\) adds only \.js, \.json and \.node/);
});

test('a required directory is its index, and an imported one is nothing', () => {
	// CommonJS reads `<dir>/index.js`; ES module resolution reads no directory at
	// all and answers ERR_UNSUPPORTED_DIR_IMPORT. One walk cannot answer both.
	const index = "module.exports = { value: 'the index CommonJS opens' };\n";

	const required = {
		'scripts/gate.cjs': "const { value } = require('./lib');\nconsole.log(value);\n",
		'scripts/lib/index.js': index,
	};
	const unpinned = runCon5({
		files: required,
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(unpinned.status, 1);
	assert.match(unpinned.output, /scripts\/lib\/index\.js has no pinned sha256/);

	const bound = runCon5({
		files: required,
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs', 'scripts/lib/index.js'],
	});
	assert.equal(bound.status, 0, bound.output);

	// A directory carrying a package.json resolves through its "main", which this
	// walk does not model — and an unmodelled resolution is a finding, not a guess.
	const packaged = runCon5({
		files: {
			...required,
			'scripts/lib/package.json': JSON.stringify({ main: 'index.js' }),
		},
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(packaged.status, 1);
	assert.match(packaged.output, /resolution through its "main" is not modelled/);

	// The ESM half. Neither the directory nor an extensionless file resolves, and
	// the pairing is the explicit specifier beside it, which does.
	for (const [specifier, expected] of [
		['./lib', /no directory index/],
		['./lib/helper', /adds no extension/],
	]) {
		const missing = runCon5({
			files: { 'scripts/gate.mjs': `import '${specifier}';\n`, [HELPER]: HELPER_SOURCE },
			pinned: ['scripts/gate.mjs'],
		});
		assert.equal(missing.status, 1, `${specifier} is not a module ESM opens`);
		assert.match(missing.output, expected);
	}

	const explicit = runCon5({
		files: { 'scripts/gate.mjs': `import '${'./lib/helper.mjs'}';\n`, [HELPER]: HELPER_SOURCE },
		pinned: ['scripts/gate.mjs', HELPER],
	});
	assert.equal(explicit.status, 0, explicit.output);
});

test('a specifier that names the wrong extension resolves to nothing', () => {
	// The confirmed-good direction of the same rule, kept under regression because
	// a fix for a false negative is where the false positive gets introduced.
	// `./lib/helper.js` beside a `helper.mjs` is TypeScript's habit and Node's
	// error: no loader rewrites one extension into another.
	const mismatch = runCon5({
		files: { 'scripts/gate.mjs': "import './lib/helper.js';\n", [HELPER]: HELPER_SOURCE },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(mismatch.status, 1);
	assert.match(mismatch.output, /relative import "\.\/lib\/helper\.js" resolves to no file/);

	// Dot segments are normalised, because they address the same file.
	const roundabout = runCon5({
		files: {
			'scripts/gate.mjs': "import { value } from './lib/../lib/helper.mjs';\nconsole.log(value);\n",
			[HELPER]: HELPER_SOURCE,
		},
		pinned: ['scripts/gate.mjs', HELPER],
	});
	assert.equal(roundabout.status, 0, roundabout.output);
});

test('a symlinked target fails closed, however it was reached', () => {
	// The one closure member whose path and content can be parted without editing
	// either: the pin binds the path, and the link re-points it somewhere else.
	const linked = runCon5({
		files: {
			'scripts/gate.mjs': "import { value } from './lib/helper.mjs';\nconsole.log(value);\n",
			'scripts/lib/real.mjs': HELPER_SOURCE,
		},
		links: { [HELPER]: 'scripts/lib/real.mjs' },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(linked.status, 1);
	assert.match(
		linked.output,
		/scripts\/lib\/helper\.mjs: executable target reached from .* is a symlink/
	);
});

/* -------------------------------------------------------------------------
 * Which loader, which is a question about the file rather than about a call
 * ---------------------------------------------------------------------- */

test('the loader shapes round 7 executed are each a finding', () => {
	// FIVE SHAPES, each demonstrated loading a real helper at run time while the
	// reader saw neither an edge nor a finding — the same green as a file that
	// loads nothing. A grammar that knows only the `import` keyword and a bare
	// `require(…)` is not closed, and an unclosed grammar is silence sold as
	// permission. Each fixture below is executable: `node` runs it and the helper
	// prints. The control must name the site.
	const shapes = {
		'an aliased require': [
			'scripts/gate.cjs',
			"const r = require;\nconst { value } = r('./lib/helper.cjs');\nconsole.log(value);\n",
			/scripts\/gate\.cjs:1: require hands a CommonJS loader/,
		],
		'a require reached as a property': [
			'scripts/gate.cjs',
			"const { value } = module.require('./lib/helper.cjs');\nconsole.log(value);\n",
			/scripts\/gate\.cjs:1: module\.require reaches require as a property/,
		],
		'a require inside eval': [
			'scripts/gate.cjs',
			'const { value } = eval("require(\'./lib/helper.cjs\')");\nconsole.log(value);\n',
			/scripts\/gate\.cjs:1: eval turns text into running code/,
		],
		'a require through new Function': [
			'scripts/gate.cjs',
			"const load = new Function('require', \"return require('./lib/helper.cjs')\");\n" +
				'const { value } = load(require);\nconsole.log(value);\n',
			/scripts\/gate\.cjs:1: Function turns text into running code/,
		],
		'a createRequire handed straight to a call': [
			'scripts/gate.mjs',
			"import { createRequire } from 'node:module';\n" +
				"const { value } = createRequire(import.meta.url)('./lib/helper.cjs');\nconsole.log(value);\n",
			/scripts\/gate\.mjs:2: createRequire builds a CommonJS loader/,
		],
	};

	for (const [what, [entry, source, expected]] of Object.entries(shapes)) {
		const found = runCon5({
			files: { [entry]: source, [CJS_HELPER]: CJS_HELPER_SOURCE },
			entry,
			pinned: [entry],
		});
		assert.equal(found.status, 1, `${what} must not load a helper past this control`);
		assert.match(found.output, expected, `${what} must be named where it sits`);
	}

	// The pairing, and the reason this is a grammar rather than a blocklist: the
	// modelled spelling of the same load is FOLLOWED, so the helper it opens is
	// bound rather than merely mentioned.
	const modelled = {
		'scripts/gate.cjs': "const { value } = require('./lib/helper.cjs');\nconsole.log(value);\n",
		[CJS_HELPER]: CJS_HELPER_SOURCE,
	};
	const unpinned = runCon5({
		files: modelled,
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(unpinned.status, 1);
	assert.match(unpinned.output, /scripts\/lib\/helper\.cjs has no pinned sha256/);

	const bound = runCon5({
		files: modelled,
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs', CJS_HELPER],
	});
	assert.equal(bound.status, 0, bound.output);
});

test('a createRequire binding is read as the loader it is', () => {
	// The one loader construction this grammar MODELS, because an ESM file that
	// needs a package's own resolution has no other spelling of it and
	// `scripts/build-stylesheet.mjs` is such a file. Modelling it means the edge is
	// followed: the helper the binding opens must be pinned like any other, which a
	// disclosure would never have achieved.
	const files = {
		'scripts/gate.mjs':
			"import { createRequire } from 'node:module';\n" +
			'const require_ = createRequire(import.meta.url);\n' +
			"const { value } = require_('./lib/helper.cjs');\n" +
			"console.log(value, require_.resolve('some-package'));\n",
		[CJS_HELPER]: CJS_HELPER_SOURCE,
	};

	const unpinned = runCon5({ files, pinned: ['scripts/gate.mjs'] });
	assert.equal(unpinned.status, 1, 'a load through the binding is a load');
	assert.match(unpinned.output, /scripts\/lib\/helper\.cjs has no pinned sha256/);

	const bound = runCon5({ files, pinned: ['scripts/gate.mjs', CJS_HELPER] });
	assert.equal(bound.status, 0, bound.output);

	// `resolve` on either spelling names a path without opening it, so it binds
	// nothing — the confirmed-good behaviour of the previous round, kept.
	const resolves = runCon5({
		files: {
			'scripts/gate.cjs': "console.log(require.resolve('./lib/helper.cjs'));\n",
			[CJS_HELPER]: CJS_HELPER_SOURCE,
		},
		entry: 'scripts/gate.cjs',
		pinned: ['scripts/gate.cjs'],
	});
	assert.equal(resolves.status, 0, resolves.output);
});

test('the module loader and the evaluator are reached by name or not at all', () => {
	// The rest of the grammar, each case paired with the spelling that passes. A
	// rule that only ever says no is not a rule about syntax; it is a ban.
	const cases = [
		[
			"import module from 'node:module';\nconsole.log(module);\n",
			"import { createRequire } from 'node:module';\n" +
				'const require_ = createRequire(import.meta.url);\n' +
				"console.log(require_.resolve('some-package'));\n",
			/takes node:module in a form that hands out a loader/,
		],
		[
			"import { registerHooks } from 'node:module';\nconsole.log(registerHooks);\n",
			"import { createRequire } from 'node:module';\n" +
				'const require_ = createRequire(import.meta.url);\n' +
				"console.log(require_.resolve('some-package'));\n",
			/takes node:module in a form that hands out a loader/,
		],
		[
			"import vm from 'node:vm';\nconsole.log(vm);\n",
			"import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n",
			/imports node:vm, which evaluates text as code/,
		],
		[
			'const name = process.argv[2];\nconsole.log(globalThis[name]);\n',
			'console.log(globalThis.fetch);\n',
			/globalThis is reached other than by name/,
		],
		[
			'const realm = globalThis;\nconsole.log(realm);\n',
			'console.log(globalThis.fetch);\n',
			/globalThis is reached other than by name/,
		],
		[
			'const handlers = {};\nconst key = process.argv[2];\nhandlers[key]();\n',
			'const handlers = [() => 1];\nhandlers[0]();\n',
			/calls something this reading cannot name/,
		],
		[
			'const make = () => () => 1;\nmake()();\n',
			'const make = () => 1;\nmake();\n',
			/calls something this reading cannot name/,
		],
		[
			'const it = {};\nconsole.log(it.constructor.constructor);\n',
			'const it = {};\nconsole.log(Object.getPrototypeOf(it));\n',
			/reaches constructor as a property/,
		],
		[
			"console.log(globalThis['eval']);\n",
			'console.log(globalThis.fetch);\n',
			/reaches eval by key/,
		],
	];

	for (const [rejected, accepted, expected] of cases) {
		const found = runCon5({
			files: { 'scripts/gate.mjs': rejected },
			pinned: ['scripts/gate.mjs'],
		});
		assert.equal(found.status, 1, `an unmodelled loader shape must be named: ${rejected}`);
		assert.match(found.output, expected);

		const clean = runCon5({
			files: { 'scripts/gate.mjs': accepted },
			pinned: ['scripts/gate.mjs'],
		});
		assert.equal(clean.status, 0, `the modelled spelling must pass: ${accepted}\n${clean.output}`);
	}
});

test('an unmodelled loader is disclosable, on its line, with its reason', () => {
	// The repair. A grammar with no repair but a weakening teaches the next author
	// to weaken it, so the same channel the computed loads use is open to these —
	// and it is exact in the same way, which is what keeps it from becoming a
	// blanket permission.
	const files = {
		'scripts/gate.mjs':
			"// a probe that needs a resolve hook\nimport { registerHooks } from 'node:module';\n",
	};
	const entry = {
		file: 'scripts/gate.mjs',
		line: 2,
		expression: "import { registerHooks } from 'node:module';",
		reason: 'the fixture’s point',
	};

	const disclosed = runCon5({
		files,
		pinned: ['scripts/gate.mjs'],
		contract: { unfollowable_loads_disclosed: [entry] },
	});
	assert.equal(disclosed.status, 0, disclosed.output);

	const wrongLine = runCon5({
		files,
		pinned: ['scripts/gate.mjs'],
		contract: { unfollowable_loads_disclosed: [{ ...entry, line: 1 }] },
	});
	assert.equal(wrongLine.status, 1);
	assert.match(wrongLine.output, /scripts\/gate\.mjs:2: import \{ registerHooks \}/);
	assert.match(wrongLine.output, /which the closure does not contain/);
});

/* -------------------------------------------------------------------------
 * One declaration, one load
 * ---------------------------------------------------------------------- */

test('a disclosure binds one occurrence and not the next one like it', () => {
	// THE REPRO. Two computed loads, identical text, one declaration — and the
	// declarations were a SET, so the second site was covered by the first site's
	// reason. The second call can name a different module for a different reason
	// behind identical text, and a reader of the contract sees one hole where the
	// tree has two.
	const files = {
		'scripts/gate.mjs':
			'const target = process.argv[2];\nawait import(target);\nawait import(target);\n',
	};
	const first = {
		file: 'scripts/gate.mjs',
		line: 2,
		expression: 'import(target)',
		reason: 'the first site',
	};

	const half = runCon5({
		files,
		pinned: ['scripts/gate.mjs'],
		contract: { unfollowable_loads_disclosed: [first] },
	});
	assert.equal(half.status, 1, 'one declaration cannot excuse two loads');
	assert.match(half.output, /scripts\/gate\.mjs:3: import\(target\) loads a module/);

	const both = runCon5({
		files,
		pinned: ['scripts/gate.mjs'],
		contract: {
			unfollowable_loads_disclosed: [first, { ...first, line: 3, reason: 'the second site' }],
		},
	});
	assert.equal(both.status, 0, both.output);
	assert.match(both.output, /disclosed one by one with a reason: 2/);
});

test('two identical loads on one line cannot hide behind one declaration', () => {
	// The corner the line does not tell apart. It fails closed rather than
	// quietly covering both, and the repair is a newline.
	const crowded = runCon5({
		files: {
			'scripts/gate.mjs':
				'const target = process.argv[2];\nawait import(target); await import(target);\n',
		},
		pinned: ['scripts/gate.mjs'],
		contract: {
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'import(target)',
					reason: 'the first of two',
				},
			],
		},
	});
	assert.equal(crowded.status, 1);
	assert.match(crowded.output, /a second import\(target\) shares this line with a disclosed one/);
});

test('a declaration written twice is rejected rather than collapsed', () => {
	// A Map keyed by the declaration silently discarded the second reason, so a
	// contract could carry two reasons for one load and a reader could believe
	// either. The control refuses to start instead.
	const repeated = runCon5({
		files: { 'scripts/gate.mjs': 'const target = process.argv[2];\nawait import(target);\n' },
		pinned: ['scripts/gate.mjs'],
		contract: {
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'import(target)',
					reason: 'the reason a reader would read',
				},
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'import(target)',
					reason: 'the reason that used to win in silence',
				},
			],
		},
	});
	assert.equal(repeated.status, 1);
	assert.match(repeated.output, /declares import\(target\) at scripts\/gate\.mjs:2 twice/);
});

/* -------------------------------------------------------------------------
 * Round 8 — the three shapes that walked past the closed grammar
 * ---------------------------------------------------------------------- */

test('an aliased createRequire is the same loader under a different name', () => {
	// THE REPRO. The two halves of one model were reading two different names.
	// `unfollowableLoads` ACCEPTS `import { createRequire as cr }` — it asks which
	// EXPORT the specifier names, and an alias does not change that — while
	// `requireLike` asked whether a callee is spelled `createRequire`, which `cr`
	// is not. So the import was modelled, the binding it produced was invisible,
	// and `cr(import.meta.url)('./lib/helper.cjs')` ran an unpinned file green.
	const files = {
		'scripts/gate.mjs':
			"import { createRequire as cr } from 'node:module';\n" +
			'const load = cr(import.meta.url);\n' +
			"const { value } = load('./lib/helper.cjs');\nconsole.log(value);\n",
		[CJS_HELPER]: CJS_HELPER_SOURCE,
	};

	// Accepting the form means CARRYING it: the helper is an edge, not a finding.
	const unpinned = runCon5({ files, pinned: ['scripts/gate.mjs'] });
	assert.equal(unpinned.status, 1, 'a load through an aliased factory is a load');
	assert.match(unpinned.output, /scripts\/lib\/helper\.cjs has no pinned sha256/);

	const bound = runCon5({ files, pinned: ['scripts/gate.mjs', CJS_HELPER] });
	assert.equal(bound.status, 0, bound.output);

	// The pairing, and the whole consequence: a name is not a binding. Rewriting the
	// helper the alias opens must turn this control red on its CONTENT.
	const rewritten = runCon5({
		files,
		pinned: ['scripts/gate.mjs', CJS_HELPER],
		corrupt: CJS_HELPER,
	});
	assert.equal(rewritten.status, 1);
	assert.match(rewritten.output, /scripts\/lib\/helper\.cjs: content does not match its pin/);
});

test('a loader is modelled only where it resolves the way this walk resolves', () => {
	// The base is part of the model, for the reason round 7 established about
	// `require`: a loader resolves against a BASE, and a reading that ignores the
	// base pins a file the loader never opens. `createRequire('/elsewhere/x.js')`
	// opens `/elsewhere/lib/helper.cjs` while this walk would pin the helper beside
	// the GATE — round 7's decoy in a new spelling — so an unmodellable base leaves
	// the factory call unmodelled, which reports it.
	const elsewhere = runCon5({
		files: {
			'scripts/gate.mjs':
				"import { createRequire } from 'node:module';\n" +
				"const load = createRequire('/elsewhere/x.js');\n" +
				"load('./lib/helper.cjs');\n",
			[CJS_HELPER]: CJS_HELPER_SOURCE,
		},
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(elsewhere.status, 1, 'a loader with a base elsewhere resolves elsewhere');
	assert.match(elsewhere.output, /scripts\/gate\.mjs:2: createRequire builds a CommonJS loader/);

	// And the bite check in the other direction, because a fix for a false positive
	// is where the false negative gets introduced: the base that names this file is
	// still modelled, in both dialects.
	for (const [entry, base] of [
		['scripts/gate.mjs', 'import.meta.url'],
		['scripts/gate.cjs', '__filename'],
	]) {
		const modelled = runCon5({
			files: {
				[entry]:
					"import { createRequire } from 'node:module';\n" +
					`const load = createRequire(${base});\n` +
					"const { value } = load('./lib/helper.cjs');\nconsole.log(value);\n",
				[CJS_HELPER]: CJS_HELPER_SOURCE,
			},
			entry,
			pinned: [entry, CJS_HELPER],
		});
		assert.equal(modelled.status, 0, `${base} names this file\n${modelled.output}`);
	}
});

test('a loader taken out of an object by destructuring is a read of it', () => {
	// THE REPRO. `namesRatherThanReferences` is right that a property key is a name
	// rather than a reference — `{ require: r }` refers to nothing called `require`.
	// It is a READ of that property off the object being destructured, which is the
	// same fact as `module.require` with different punctuation, and the grammar
	// reports that one. A BindingElement is neither a property access nor an element
	// access, so `const { require: r } = module; r.call(module, './lib/helper.cjs')`
	// ran an unpinned helper green.
	const shapes = {
		'a renamed binding': [
			'scripts/gate.cjs',
			'const { require: r } = module;\n' +
				"const { value } = r.call(module, './lib/helper.cjs');\nconsole.log(value);\n",
			/scripts\/gate\.cjs:1: require: r takes require out of an object/,
		],
		'a shorthand binding': [
			'scripts/gate.cjs',
			'const { require: outer } = module;\nconst { createRequire } = outer("node:module");\n',
			/scripts\/gate\.cjs:1: require: outer takes require out of an object/,
		],
		'a nested binding': [
			'scripts/gate.cjs',
			'const { constructor: { require: r } } = module;\nconsole.log(r);\n',
			/scripts\/gate\.cjs:1: constructor: \{ require: r \} takes constructor out of an object/,
		],
		'a binding with a default': [
			'scripts/gate.cjs',
			'const { require: r = null } = module;\nconsole.log(r);\n',
			/scripts\/gate\.cjs:1: require: r = null takes require out of an object/,
		],
		'a quoted key': [
			'scripts/gate.cjs',
			"const { 'require': r } = module;\nconsole.log(r);\n",
			/takes require out of an object/,
		],
		'a computed key spelled as a literal': [
			'scripts/gate.cjs',
			"const { ['require']: r } = module;\nconsole.log(r);\n",
			/takes require out of an object/,
		],
		'a destructuring ASSIGNMENT rather than a declaration': [
			'scripts/gate.cjs',
			'let r;\n({ require: r } = module);\nconsole.log(r);\n',
			/scripts\/gate\.cjs:2: require: r takes require out of an object/,
		],
		'a destructuring assignment nested in an array pattern': [
			'scripts/gate.cjs',
			'let r;\n[{ require: r }] = [module];\nconsole.log(r);\n',
			/scripts\/gate\.cjs:2: require: r takes require out of an object/,
		],
		'a createRequire lifted off a namespace': [
			'scripts/gate.cjs',
			'const { createRequire: make } = someNamespace;\nconsole.log(make);\n',
			/scripts\/gate\.cjs:1: createRequire: make takes createRequire out of an object/,
		],
		'an evaluator lifted off a realm': [
			'scripts/gate.cjs',
			'const { eval: run } = globalThis;\nconsole.log(run);\n',
			/scripts\/gate\.cjs:1: eval: run takes eval out of an object/,
		],
	};

	for (const [what, [entry, source, expected]] of Object.entries(shapes)) {
		const found = runCon5({
			files: { [entry]: source, [CJS_HELPER]: CJS_HELPER_SOURCE },
			entry,
			pinned: [entry],
		});
		assert.equal(found.status, 1, `${what} must not reach a loader past this control`);
		assert.match(found.output, expected, `${what} must be named where it sits`);
	}

	// THE OTHER DIRECTION, because excusing a case excuses every rule and a fix for
	// a false positive is where the false negative gets introduced. A destructuring
	// that reads an ordinary key is ordinary; so is an object literal BUILT with one
	// of these names as a key, where the key hands out nothing and the interesting
	// half is the value the identifier rules already read.
	const ordinary = {
		'an unrelated key': 'const { value } = process.env;\nconsole.log(value);\n',
		'an array pattern, which reads no key at all':
			'const [first] = process.argv;\nconsole.log(first);\n',
		'an object literal built as a value':
			'const options = { require: false };\nconsole.log(options);\n',
		'a method named for one of them':
			'const it = { require() { return 1; } };\nconsole.log(it.require);\n',
	};
	for (const [what, source] of Object.entries(ordinary)) {
		const clean = runCon5({ files: { 'scripts/gate.mjs': source }, pinned: ['scripts/gate.mjs'] });
		assert.equal(
			clean.status,
			what === 'a method named for one of them' ? 1 : 0,
			`${what}\n${clean.output}`
		);
	}
});

test('the named execution facilities are findings, and a repository file they run binds', () => {
	// THE REPRO, and the boundary that moved. Round 7's reader said
	// `node:child_process` was outside a reading scoped to this process, because a
	// child's closure is the child's own. That is true and was not an answer: nobody
	// was walking the child. `spawnSync(process.execPath, ['scripts/lib/helper.mjs'])`
	// ran an editable repository helper, and this control was green with the helper
	// as written and green again with it rewritten wholesale.
	const shapes = {
		'a spawn of the node binary': [
			"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['scripts/lib/helper.mjs']);\n",
			/scripts\/gate\.mjs:2: spawnSync runs code in an execution context/,
		],
		'a spawn bound under an alias': [
			"import { spawnSync as run } from 'node:child_process';\n" +
				"run(process.execPath, ['scripts/lib/helper.mjs']);\n",
			/scripts\/gate\.mjs:2: run runs code in an execution context/,
		],
		'a fork': [
			"import { fork } from 'node:child_process';\nfork('./lib/helper.mjs');\n",
			/scripts\/gate\.mjs:2: fork runs code in an execution context/,
		],
		'a spawn stashed rather than called': [
			"import { spawn } from 'node:child_process';\nconst run = spawn;\nconsole.log(run);\n",
			/scripts\/gate\.mjs:2: spawn hands out a way to run code/,
		],
		'the module taken as a namespace': [
			"import cp from 'node:child_process';\ncp.spawnSync('x');\n",
			/takes node:child_process in a form whose bindings this reading cannot name/,
		],
		'the module required rather than imported': [
			"const cp = require('node:child_process');\ncp.spawnSync('x');\n",
			/takes node:child_process in a form whose bindings this reading cannot name/,
		],
		'a worker thread': [
			"import { Worker } from 'node:worker_threads';\nnew Worker('./lib/helper.mjs');\n",
			/scripts\/gate\.mjs:2: Worker runs code in an execution context/,
		],
		'a native module': ['process.dlopen(module, path);\n', /reaches dlopen, which loads and runs/],
		WebAssembly: [
			'const wasm = await WebAssembly.instantiate(bytes);\nconsole.log(wasm);\n',
			/WebAssembly compiles and runs code this module system never loaded/,
		],
	};

	for (const [what, [source, expected]] of Object.entries(shapes)) {
		const found = runCon5({
			files: { 'scripts/gate.mjs': source, [HELPER]: HELPER_SOURCE },
			pinned: ['scripts/gate.mjs'],
		});
		assert.equal(found.status, 1, `${what} must not run code past this control`);
		assert.match(found.output, expected, `${what} must be named where it sits`);
	}

	// The pairing. A file that reaches none of these names is silent, so the rule
	// bites on the facility rather than on being a gate file.
	const clean = runCon5({
		files: {
			'scripts/gate.mjs': "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n",
		},
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(clean.status, 0, clean.output);
});

test('a disclosed execution site binds the repository files it names', () => {
	// "Bind or report", with the choice written down. Reporting alone would leave
	// the helper editable behind a declared reason, which is the hole with a note
	// attached — so a declaration may name the repository paths its site runs, and
	// they enter the closure exactly as an import does.
	const files = {
		'scripts/gate.mjs':
			"import { spawnSync } from 'node:child_process';\n" +
			"spawnSync(process.execPath, ['scripts/lib/helper.mjs']);\n",
		[HELPER]: HELPER_SOURCE,
	};
	const declaration = {
		file: 'scripts/gate.mjs',
		line: 2,
		expression: 'spawnSync',
		reason: 'the fixture’s point',
	};

	// Declared with the path it runs, that path is a closure member like any other.
	const named = { unfollowable_loads_disclosed: [{ ...declaration, binds: [HELPER] }] };
	const unpinned = runCon5({ files, pinned: ['scripts/gate.mjs'], contract: named });
	assert.equal(unpinned.status, 1, 'a bound child is a target that needs a pin');
	assert.match(unpinned.output, /scripts\/lib\/helper\.mjs has no pinned sha256/);

	const bound = runCon5({ files, pinned: ['scripts/gate.mjs', HELPER], contract: named });
	assert.equal(bound.status, 0, bound.output);

	// THE CONSEQUENCE, which is the whole difference between binding and mentioning:
	// rewriting the helper the site runs turns this control red.
	const rewritten = runCon5({
		files,
		pinned: ['scripts/gate.mjs', HELPER],
		contract: named,
		corrupt: HELPER,
	});
	assert.equal(rewritten.status, 1);
	assert.match(rewritten.output, /scripts\/lib\/helper\.mjs: content does not match its pin/);

	// A site that runs nothing this repository holds omits `binds` and says so. That
	// is a report rather than a binding, and it is allowed to be — but it cannot be
	// silent, which is what it was before this round.
	const declaredOnly = runCon5({
		files: {
			'scripts/gate.mjs':
				"import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);\n",
		},
		pinned: ['scripts/gate.mjs'],
		contract: {
			unfollowable_loads_disclosed: [{ ...declaration, expression: 'execFileSync' }],
		},
	});
	assert.equal(declaredOnly.status, 0, declaredOnly.output);
});

test('a binds that pins no bytes is a finding, like a pin of nothing', () => {
	// The same rule the rest of this contract keeps: a declaration that reads as
	// coverage has to BE coverage. A path under a declared unpinned root is bound by
	// nothing, and naming it there would read as a binding that is not one.
	const hollow = runCon5({
		files: {
			'scripts/gate.mjs':
				"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['build/server/handler.mjs']);\n",
		},
		pinned: ['scripts/gate.mjs'],
		contract: {
			unpinned_import_roots: ['build/'],
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'spawnSync',
					reason: 'the fixture’s point',
					binds: ['build/server/handler.mjs'],
				},
			],
		},
	});
	assert.equal(hollow.status, 1);
	assert.match(
		hollow.output,
		/binds build\/server\/handler\.mjs, which is under a declared unpinned root/
	);

	// And a `binds` this control cannot read at all is a hard stop, like every other
	// shape failure in the contract: half a declaration is not a declaration.
	for (const binds of [[], 'scripts/lib/helper.mjs', ['/etc/passwd'], ['../outside.mjs']]) {
		const shapeless = runCon5({
			files: {
				'scripts/gate.mjs':
					"import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['x']);\n",
			},
			pinned: ['scripts/gate.mjs'],
			contract: {
				unfollowable_loads_disclosed: [
					{
						file: 'scripts/gate.mjs',
						line: 2,
						expression: 'spawnSync',
						reason: 'the fixture’s point',
						binds,
					},
				],
			},
		});
		assert.equal(shapeless.status, 1, `${JSON.stringify(binds)} is not a set of repository paths`);
		assert.match(shapeless.output, /carries a `binds` that is not a non-empty array/);
	}
});

test('a disclosure without the line it sits on is not a disclosure', () => {
	// The shape check, which is a hard stop rather than a finding: a contract this
	// control cannot read is not a contract it may read halfway.
	const shapeless = runCon5({
		files: { 'scripts/gate.mjs': 'const target = process.argv[2];\nawait import(target);\n' },
		pinned: ['scripts/gate.mjs'],
		contract: {
			unfollowable_loads_disclosed: [
				{ file: 'scripts/gate.mjs', expression: 'import(target)', reason: 'no line' },
			],
		},
	});
	assert.equal(shapeless.status, 1);
	assert.match(
		shapeless.output,
		/must carry a non-empty file, expression and reason, and the positive/
	);
});

/* -------------------------------------------------------------------------
 * Round 9 — a name that left the file, a second door with the same name, and a
 * declaration that named the wrong file
 * ---------------------------------------------------------------------- */

test('a re-exported loader is a finding where the file hands it out', () => {
	// THE REPRO. A file may take `createRequire` legally — a named import of the one
	// modelled export is the shape this grammar accepts — and then hand the binding
	// to every importer with `export { cr }`. The importer's own walk then sees an
	// ordinary local it has never heard of, so `cr(import.meta.url)('./lib/helper.cjs')`
	// ran an unpinned helper with the control green in BOTH directions.
	//
	// The class closes at the ORIGIN rather than at each hop: a file can only hand
	// out a watched binding it first obtained, and every way of obtaining one is
	// either tracked in the file that does it or reported at the specifier. So a
	// rename, a barrel and a chain of them need no rules of their own — the file
	// underneath is already red.
	const importer =
		"import { cr } from './lib/loader.mjs';\n" +
		'const load = cr(import.meta.url);\n' +
		"const { value } = load('./lib/helper.cjs');\nconsole.log(value);\n";

	const files = {
		'scripts/gate.mjs': importer,
		'scripts/lib/loader.mjs':
			"import { createRequire as cr } from 'node:module';\nexport { cr };\n",
		[CJS_HELPER]: CJS_HELPER_SOURCE,
	};
	const pinned = ['scripts/gate.mjs', 'scripts/lib/loader.mjs'];

	const found = runCon5({ files, pinned });
	assert.equal(found.status, 1, 'a re-export carries the loader out of this reading');
	assert.match(found.output, /scripts\/lib\/loader\.mjs:2: cr builds a CommonJS loader/);

	// THE CONSEQUENCE, which is what makes it a hole rather than a wording problem:
	// the helper it opens is unbound, so rewriting it wholesale changed nothing.
	const rewritten = runCon5({
		files: { ...files, [CJS_HELPER]: "module.exports = { value: 'something else' };\n" },
		pinned,
	});
	assert.equal(rewritten.status, 1);
	assert.equal(rewritten.output, found.output, 'the finding is about the hand-off, not the helper');

	// THE SWEEP. Every spelling of the same hand-off, each named where it sits.
	const shapes = {
		'a renamed re-export': [
			"import { createRequire as cr } from 'node:module';\nexport { cr as makeLoader };\n",
			/scripts\/lib\/loader\.mjs:2: cr builds a CommonJS loader/,
		],
		'a re-exported execution facility': [
			"import { spawnSync } from 'node:child_process';\nexport { spawnSync };\n",
			/scripts\/lib\/loader\.mjs:2: spawnSync hands out a way to run code/,
		],
		'a renamed re-exported execution facility': [
			"import { spawnSync } from 'node:child_process';\nexport { spawnSync as run };\n",
			/scripts\/lib\/loader\.mjs:2: spawnSync hands out a way to run code/,
		],
		'a re-export straight off the watched module': [
			"export { createRequire as cr } from 'node:module';\n",
			/takes node:module in a form that hands out a loader/,
		],
		'a wildcard re-export of the watched module': [
			"export * from 'node:module';\n",
			/takes node:module in a form that hands out a loader/,
		],
		'a wildcard re-export of the watched execution module': [
			"export * from 'node:child_process';\n",
			/takes node:child_process in a form whose bindings this reading cannot name/,
		],
	};

	for (const [what, [loader, expected]] of Object.entries(shapes)) {
		const caught = runCon5({
			files: { ...files, 'scripts/lib/loader.mjs': loader },
			pinned,
		});
		assert.equal(caught.status, 1, `${what} must not carry a loader past this control`);
		assert.match(caught.output, expected, `${what} must be named where it sits`);
	}

	// A BARREL adds a hop and no cover, because the hop is not where the rule is.
	const barrel = runCon5({
		files: {
			'scripts/gate.mjs': importer.replace('./lib/loader.mjs', './lib/barrel.mjs'),
			'scripts/lib/barrel.mjs': "export * from './loader.mjs';\n",
			'scripts/lib/loader.mjs':
				"import { createRequire as cr } from 'node:module';\nexport { cr };\n",
			[CJS_HELPER]: CJS_HELPER_SOURCE,
		},
		pinned: ['scripts/gate.mjs', 'scripts/lib/barrel.mjs', 'scripts/lib/loader.mjs'],
	});
	assert.equal(barrel.status, 1, 'an intermediate file is not a place the rule stops');
	assert.match(barrel.output, /scripts\/lib\/loader\.mjs:2: cr builds a CommonJS loader/);
});

test('an ordinary re-export is ordinary, and a type-only one runs nothing', () => {
	// THE OTHER DIRECTION, because excusing a case excuses every rule and a fix for a
	// false negative is where the false positive gets introduced. The rule bites on
	// the tracked NAME leaving the file, not on the export clause: a module that
	// re-exports its own helpers is what every barrel in this repository is.
	const ordinary = {
		'a local of its own': 'export const value = 1;\nconst other = 2;\nexport { other };\n',
		'a renamed local of its own': 'const other = 2;\nexport { other as value };\n',
		'a binding from an unwatched module':
			"import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
		'a re-export from an unwatched module': "export { readFileSync } from 'node:fs';\n",
		'a wildcard re-export of an unwatched module': "export * from 'node:fs';\n",
	};
	for (const [what, source] of Object.entries(ordinary)) {
		const clean = runCon5({ files: { 'scripts/gate.mjs': source }, pinned: ['scripts/gate.mjs'] });
		assert.equal(clean.status, 0, `${what} hands out no loader\n${clean.output}`);
	}

	// And a TYPE-only re-export is erased before anything runs, in both spellings, so
	// the binding it names reaches no loader — the same judgement `import type` gets.
	for (const clause of ['export type { cr };', 'export { type cr };']) {
		const erased = runCon5({
			files: {
				'scripts/gate.mts': `import { createRequire as cr } from 'node:module';\n${clause}\n`,
			},
			entry: 'scripts/gate.mts',
			pinned: ['scripts/gate.mts'],
		});
		assert.equal(erased.status, 0, `${clause} hands out nothing at run time: ${erased.output}`);
	}
});

test('the second door to a builtin module has the same name and the same rule', () => {
	// THE REPRO. `process.getBuiltinModule('node:child_process')` returns the module
	// object the import form returns, and every import form of it was watched while
	// this one was not — so the fixture spawned a helper and rewrote it with the
	// control green. Which module comes back is not modelled, for the reason the
	// namespace import is not: the local is an object whose members this reading
	// would have to track through arbitrary access.
	const files = {
		'scripts/gate.mjs':
			"const cp = process.getBuiltinModule('node:child_process');\n" +
			"cp.spawnSync(process.execPath, ['scripts/lib/helper.mjs']);\n",
		[HELPER]: HELPER_SOURCE,
	};

	const found = runCon5({ files, pinned: ['scripts/gate.mjs'] });
	assert.equal(found.status, 1, 'a named door to node:child_process is a named door');
	assert.match(
		found.output,
		/scripts\/gate\.mjs:1: process\.getBuiltinModule reaches getBuiltinModule/
	);

	const rewritten = runCon5({
		files: { ...files, [HELPER]: "console.log('something else entirely');\n" },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(rewritten.status, 1);
	assert.equal(rewritten.output, found.output, 'the helper is unbound either way');

	// THE SWEEP, which is every way this grammar already reads a watched property.
	const shapes = {
		'destructured off process': [
			'const { getBuiltinModule } = process;\ngetBuiltinModule("node:vm");\n',
			/takes getBuiltinModule out of an object/,
		],
		'reached by key': [
			"const cp = process['getBuiltinModule']('node:child_process');\nconsole.log(cp);\n",
			/reaches getBuiltinModule by key/,
		],
		'reached through the realm': [
			"const cp = globalThis.process.getBuiltinModule('node:child_process');\nconsole.log(cp);\n",
			/reaches getBuiltinModule as a property/,
		],
	};
	for (const [what, [source, expected]] of Object.entries(shapes)) {
		const caught = runCon5({ files: { 'scripts/gate.mjs': source }, pinned: ['scripts/gate.mjs'] });
		assert.equal(caught.status, 1, `${what} must be named`);
		assert.match(caught.output, expected, `${what} must be named where it sits`);
	}

	// The pairing. The rule bites on the facility's name and not on reaching
	// `process` at all, which a gate file does for ordinary reasons.
	const clean = runCon5({
		files: { 'scripts/gate.mjs': 'console.log(process.execPath, process.argv, process.cwd());\n' },
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(clean.status, 0, clean.output);
});

test('a binds is checked against the file its own site is written to run', () => {
	// THE REPRO. `binds` was admitted at its word: whatever it named was pinned, and
	// nothing asked whether the site ran it. So a declaration bound a pinned file
	// while the `spawnSync` on the very line it declared executed a different,
	// unpinned one — and the control was green with that decoy rewritten wholesale.
	// A pin pointed away from the file that runs is round 7's failure in the
	// contract, and it reads as coverage more loudly there because a human wrote the
	// path down.
	const decoy = {
		'scripts/gate.mjs':
			"import { spawnSync } from 'node:child_process';\n" +
			"spawnSync(process.execPath, ['scripts/lib/decoy.mjs']);\n",
		'scripts/lib/bound.mjs': "export const value = 'the file the disclosure binds';\n",
		'scripts/lib/decoy.mjs': "export const value = 'the file the site actually runs';\n",
	};
	const declaration = {
		file: 'scripts/gate.mjs',
		line: 2,
		expression: 'spawnSync',
		reason: 'the fixture’s point',
	};

	const pointed = runCon5({
		files: decoy,
		pinned: ['scripts/gate.mjs', 'scripts/lib/bound.mjs'],
		contract: {
			unfollowable_loads_disclosed: [{ ...declaration, binds: ['scripts/lib/bound.mjs'] }],
		},
	});
	assert.equal(pointed.status, 1, 'a binds that names another file binds nothing here');
	assert.match(
		pointed.output,
		/spawnSync runs scripts\/lib\/decoy\.mjs, which its disclosure does not bind/
	);
	assert.match(
		pointed.output,
		/binds scripts\/lib\/bound\.mjs, which this site is not written to run/
	);

	// The honest form of the same site, and the pairing that proves it BINDS rather
	// than merely satisfies: rewriting the file the site runs turns the control red.
	const named = {
		unfollowable_loads_disclosed: [{ ...declaration, binds: ['scripts/lib/decoy.mjs'] }],
	};
	const bound = runCon5({
		files: decoy,
		pinned: ['scripts/gate.mjs', 'scripts/lib/decoy.mjs'],
		contract: named,
	});
	assert.equal(bound.status, 0, bound.output);

	const moved = runCon5({
		files: decoy,
		pinned: ['scripts/gate.mjs', 'scripts/lib/decoy.mjs'],
		contract: named,
		corrupt: 'scripts/lib/decoy.mjs',
	});
	assert.equal(moved.status, 1);
	assert.match(moved.output, /scripts\/lib\/decoy\.mjs: content does not match its pin/);

	// A site that runs a repository file and declares NO binds is the same hole with
	// the declaration left blank. "Bind or report" is enforced now rather than
	// trusted: reporting alone is for a site that runs nothing this repository holds.
	const silent = runCon5({
		files: decoy,
		pinned: ['scripts/gate.mjs'],
		contract: { unfollowable_loads_disclosed: [declaration] },
	});
	assert.equal(silent.status, 1, 'a declared site still has to bind what it runs');
	assert.match(
		silent.output,
		/spawnSync runs scripts\/lib\/decoy\.mjs, which its disclosure does not bind/
	);
});

test('a binds cannot excuse a target no reading can see', () => {
	// The edge of the rule above, made to bite rather than left stated. Where the
	// path is an argv element, a constant declared elsewhere or a name assembled
	// from pieces, there is no literal to check the declaration against — so a
	// `binds` there is an unverifiable claim of coverage and is refused as one. The
	// site is carried by its REASON, which is a sentence a reviewer reads.
	const files = {
		'scripts/gate.mjs':
			"import { spawnSync } from 'node:child_process';\n" +
			'spawnSync(process.execPath, [process.argv[2]]);\n',
		[HELPER]: HELPER_SOURCE,
	};
	const declaration = {
		file: 'scripts/gate.mjs',
		line: 2,
		expression: 'spawnSync',
		reason: 'the fixture’s point',
	};

	const claimed = runCon5({
		files,
		pinned: ['scripts/gate.mjs', HELPER],
		contract: { unfollowable_loads_disclosed: [{ ...declaration, binds: [HELPER] }] },
	});
	assert.equal(claimed.status, 1, 'a pin nothing can be checked against is not coverage');
	assert.match(
		claimed.output,
		/binds scripts\/lib\/helper\.mjs, which this site is not written to run/
	);

	// And the same site declared honestly — a reason and no `binds` — passes, which
	// is what keeps this a rule about claims rather than a ban on the shape.
	const honest = runCon5({
		files: { 'scripts/gate.mjs': files['scripts/gate.mjs'] },
		pinned: ['scripts/gate.mjs'],
		contract: { unfollowable_loads_disclosed: [declaration] },
	});
	assert.equal(honest.status, 0, honest.output);
});

test('a path is one path however the spelling arrives', () => {
	// The second half of the same finding: everything here is compared as TEXT, and
	// `./x`, `x` and `a/../x` are three texts for one file. A leading `./` walked
	// straight past the unpinned-root refusal, and admitted a second closure member
	// for a file already in it — which then failed as an unpinned target while its
	// real pin failed as a pin nothing reaches. Two findings about punctuation.
	const spelled = runCon5({
		files: {
			'scripts/gate.mjs':
				"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['scripts/lib/helper.mjs']);\n",
			[HELPER]: HELPER_SOURCE,
		},
		pinned: ['scripts/gate.mjs', HELPER],
		contract: {
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'spawnSync',
					reason: 'the same file, spelled with a leading dot segment',
					binds: ['./scripts/lib/./helper.mjs'],
				},
			],
		},
	});
	assert.equal(spelled.status, 0, `a dot segment addresses the same file\n${spelled.output}`);

	// And the refusal it used to walk past: an unpinned root is an unpinned root in
	// every spelling, so a `binds` cannot reach generated output by punctuation.
	const dressed = runCon5({
		files: {
			'scripts/gate.mjs':
				"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['build/server/handler.mjs']);\n",
		},
		pinned: ['scripts/gate.mjs'],
		contract: {
			unpinned_import_roots: ['build/'],
			unfollowable_loads_disclosed: [
				{
					file: 'scripts/gate.mjs',
					line: 2,
					expression: 'spawnSync',
					reason: 'the fixture’s point',
					binds: ['./build/server/handler.mjs'],
				},
			],
		},
	});
	assert.equal(dressed.status, 1);
	assert.match(dressed.output, /which is under a declared unpinned root/);

	// The same rule at the other end of the walk: a guarded command's own target.
	const entry = runCon5({
		files: { 'scripts/gate.mjs': "console.log('the entry, spelled with a dot segment');\n" },
		entry: './scripts/gate.mjs',
		pinned: ['scripts/gate.mjs'],
	});
	assert.equal(entry.status, 0, entry.output);
});

test('a site that runs a file it computes for itself binds it too', () => {
	// The shape this control's own probe is written in, and the reason a literal is
	// resolved against the file as well as against the repository root: a path a
	// file computes for itself — `new URL('../lib/x.mjs', import.meta.url)`,
	// `join(__dirname, 'lib/x.mjs')` — is written in the file's own frame, while a
	// `spawn` argument is resolved by the child against its cwd. Both are text at
	// the site, so both are checked.
	const files = {
		'scripts/gate.mjs':
			"import { spawnSync } from 'node:child_process';\n" +
			"import { fileURLToPath } from 'node:url';\n" +
			'spawnSync(process.execPath, [\n' +
			"\tfileURLToPath(new URL('./lib/helper.mjs', import.meta.url)),\n" +
			']);\n',
		[HELPER]: HELPER_SOURCE,
	};
	const declaration = {
		file: 'scripts/gate.mjs',
		line: 3,
		expression: 'spawnSync',
		reason: 'the fixture’s point',
	};

	const undeclared = runCon5({
		files,
		pinned: ['scripts/gate.mjs', HELPER],
		contract: { unfollowable_loads_disclosed: [declaration] },
	});
	assert.equal(undeclared.status, 1, 'a computed-for-itself path is still written down');
	assert.match(
		undeclared.output,
		/spawnSync runs scripts\/lib\/helper\.mjs, which its disclosure does not bind/
	);

	const bound = runCon5({
		files,
		pinned: ['scripts/gate.mjs', HELPER],
		contract: { unfollowable_loads_disclosed: [{ ...declaration, binds: [HELPER] }] },
	});
	assert.equal(bound.status, 0, bound.output);

	const moved = runCon5({
		files,
		pinned: ['scripts/gate.mjs', HELPER],
		contract: { unfollowable_loads_disclosed: [{ ...declaration, binds: [HELPER] }] },
		corrupt: HELPER,
	});
	assert.equal(moved.status, 1, 'binding it means rewriting it turns this red');
	assert.match(moved.output, /scripts\/lib\/helper\.mjs: content does not match its pin/);
});

test('a literal that names no repository file demands nothing', () => {
	// The pairing for the whole rule, because a check that fires on every string is
	// a check nobody can satisfy. Only a literal that names a file THIS repository
	// holds is a target a `binds` could pin: an executable on PATH, a subcommand,
	// a flag and a file under a declared unpinned root are all carried by the reason.
	const cases = {
		'a system binary and its arguments': [
			"import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status', '-z']);\n",
			{},
		],
		'a target under a declared unpinned root': [
			"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['build/server/handler.mjs']);\n",
			{ unpinned_import_roots: ['build/'] },
		],
		'a path that leaves the tree': [
			"import { spawnSync } from 'node:child_process';\n" +
				"spawnSync(process.execPath, ['../elsewhere/helper.mjs']);\n",
			{},
		],
	};

	for (const [what, [source, extra]] of Object.entries(cases)) {
		const clean = runCon5({
			files: { 'scripts/gate.mjs': source },
			pinned: ['scripts/gate.mjs'],
			contract: {
				...extra,
				unfollowable_loads_disclosed: [
					{
						file: 'scripts/gate.mjs',
						line: 2,
						expression: source.includes('execFileSync') ? 'execFileSync' : 'spawnSync',
						reason: 'the fixture’s point',
					},
				],
			},
		});
		assert.equal(clean.status, 0, `${what} is carried by the reason\n${clean.output}`);
	}
});

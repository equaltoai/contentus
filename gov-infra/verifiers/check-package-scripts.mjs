#!/usr/bin/env node
/**
 * CON-5 — bind the package.json scripts the rubric's exit codes rest on, and the
 * code those scripts actually execute.
 *
 * QUA-1, QUA-2, QUA-3, CON-1, CON-2, SEC-4, and SEC-5 are all `pnpm run <name>`
 * invocations whose evidence is an exit code. `package.json` is editable in the
 * same pull request as the change being gated, so a script rewritten to `true`
 * turns seven controls green without touching anything the rubric inspects. That
 * is not a hypothetical failure mode; it is the cheapest one available.
 *
 * This control asserts each guarded script matches, byte for byte, the value
 * pinned in contentus-pinned-repo-contract.json — and, because a pinned parent
 * that delegates to an unpinned child is the same hole one level down, that
 * every script a pinned script reaches through `pnpm run` is itself pinned.
 *
 * Pinning command *text* is not pinning behaviour. `validate:csp` is pinned to
 * `node scripts/audit-csp.mjs`; that pin holds perfectly while the file it names
 * is emptied to nothing, and SEC-4 then exits 0 with no audit having run. The pin
 * has to reach the bytes, so the second half of this control walks the executable
 * closure of every guarded command — each `node <path>` target, each file a glob
 * argument expands to, and each relative module those files import, transitively —
 * and asserts a SHA-256 content hash for every one of them. A target with no pin
 * is a finding; a pin with no reachable target is a finding too, so the map stays
 * exactly the closure rather than drifting into a wish list.
 *
 * Two roots are deliberately outside the closure and declared as such in the
 * contract: the application source the probes are written *against*, and the
 * generated build output. Hashing the subject under test would freeze the
 * application under governance and invert the relationship — the probe is the
 * gate, the module is what it judges.
 *
 * The walk is only ever as honest as the READING that feeds it, and this one
 * used to scan raw text with four patterns of its own. A comment between `from`
 * and its specifier is legal ESM and hid an executable inside a gate's own reach
 * from that scan entirely; a `?raw` on a specifier that resolves perfectly well
 * was reported as an import resolving to no file. So the reading is now
 * `scripts/lib/module-imports.mjs` — the same parser extraction the seam probes
 * use — and every question about a path is asked of the path the specifier
 * ADDRESSES rather than of the text it is written as. `relativeImports` carries
 * the detail.
 *
 * A reading that names a file still has to name the RIGHT file, and which file a
 * specifier names is the loader's answer rather than the text's. CommonJS adds
 * `.js`, `.json` and `.node` to an extensionless specifier and reads a
 * directory's index; ES module resolution adds nothing and reads no directory.
 * This walk used to apply one invented order to both, beginning at `.mjs` — so a
 * `require('./lib/helper')` beside a `helper.mjs` and a `helper.js` pinned the
 * `.mjs`, which `require` cannot open, while Node executed the unpinned `.js`.
 * The load's KIND now travels with its specifier and `resolveRelativeImport`
 * resolves by the rules of the loader that opens it.
 *
 * What no static reading can follow is a load whose TARGET is computed, or whose
 * LOADER is a construction the reading does not model — an aliased `require`,
 * `module.require`, `eval`, `new Function`, a `node:vm` import. This control says
 * so out loud in both directions: the grammar of loads it follows is closed, and
 * anything outside it inside the closure must be declared in the contract, on its
 * line, with its reason, or it is a finding. What binds the declared ones is that
 * the files holding them are pinned, so a load cannot appear or move without a
 * governance edit.
 *
 * What this is still not: a cryptographic binding of the *pin*. An author who
 * edits both an artifact and its hash still moves the gate. What it buys is that
 * the edit has to happen in gov-infra/planning, in the same diff, where it is the
 * review's subject rather than a line in an application file. The control it
 * composes with is the cross-client adversarial review of the gov-infra diff.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { modulePath, runtimeLoads, unfollowableLoads } from '../../scripts/lib/module-imports.mjs';
import { readStrictJson } from './strict-json.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const findings = [];
const root = resolve(process.cwd());
const printHashes = process.argv.includes('--print-hashes');

function load(path, label) {
	try {
		return readStrictJson(path, label);
	} catch (error) {
		console.error(`${label} is missing or unparseable: ${error.message}`);
		process.exit(1);
	}
}

const pkg = load('package.json', 'package.json');
const contract = load(CONTRACT, CONTRACT);

const expected = contract.package_scripts?.expected;
if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
	console.error(`${CONTRACT}: package_scripts.expected must be an object of script -> command`);
	process.exit(1);
}
if (Object.keys(expected).length === 0) {
	console.error(`${CONTRACT}: package_scripts.expected is empty; CON-5 would assert nothing`);
	process.exit(1);
}

const scripts = pkg.scripts ?? {};
for (const [name, command] of Object.entries(expected)) {
	if (typeof command !== 'string' || command.length === 0) {
		findings.push(`${CONTRACT}: pinned script "${name}" must be a non-empty string`);
		continue;
	}
	const actual = scripts[name];
	if (actual === undefined) findings.push(`package.json: guarded script "${name}" is missing`);
	else if (actual !== command)
		findings.push(
			`package.json: guarded script "${name}" does not match its pin\n` +
				`    pinned: ${command}\n` +
				`    actual: ${actual}`
		);
}

// A pinned script that shells out to an unpinned one moves the hole rather than
// closing it: `build` is pinned, but `build:client` rewritten to `true` makes it
// vacuous again. Every delegation target must be pinned too.
const delegation = /(?:^|[\s;&|(])pnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;
const pnpmSubcommands = new Set([
	'install',
	'add',
	'remove',
	'exec',
	'dlx',
	'audit',
	'why',
	'store',
	'list',
	'outdated',
	'update',
	'publish',
	'pack',
	'link',
	'config',
	'rebuild',
	'prune',
	'licenses',
	'setup',
]);
for (const [name, command] of Object.entries(expected)) {
	if (typeof command !== 'string') continue;
	for (const [, target] of command.matchAll(delegation)) {
		if (pnpmSubcommands.has(target)) continue;
		if (!Object.hasOwn(expected, target))
			findings.push(
				`${CONTRACT}: pinned script "${name}" delegates to "${target}", which is not pinned; ` +
					'an unpinned delegate is the same bypass one level down'
			);
	}
}

// --- The executable closure -------------------------------------------------
//
// Everything below answers a different question from the pins above: not "is the
// command the one we pinned" but "is the code that command runs the code we
// pinned". They are separate holes and the first does nothing about the second.

const targets = contract.executable_targets ?? {};
const pinnedHashes = targets.sha256;
const allowedGlobs = targets.allowed_globs ?? [];
const unpinnedRoots = targets.unpinned_import_roots ?? [];
if (!pinnedHashes || typeof pinnedHashes !== 'object' || Array.isArray(pinnedHashes)) {
	console.error(`${CONTRACT}: executable_targets.sha256 must be an object of path -> sha256`);
	console.error('Without it CON-5 binds command text and nothing the command executes.');
	process.exit(1);
}
if (!Array.isArray(allowedGlobs) || !Array.isArray(unpinnedRoots)) {
	console.error(
		`${CONTRACT}: executable_targets.allowed_globs and .unpinned_import_roots must be arrays`
	);
	process.exit(1);
}

/**
 * The loads inside the closure this walk cannot follow to a file, declared one by
 * one with the reason each is there.
 *
 * THREE KINDS SHARE THE LIST because they are one fact. A COMPUTED target —
 * `import(<expression>)`, `require(<expression>)` — is a load whose file no
 * static read can name. An unmodelled LOADER — an aliased `require`,
 * `module.require`, a destructured `{ require: r }`, `eval`, `new Function`, a
 * `node:vm` import — is a load whose mechanism this reading does not follow. An
 * EXECUTION facility — `spawn`, `fork`, a `Worker`, `process.dlopen`,
 * `WebAssembly` — starts code running that this process never loaded at all. Every
 * one of them is a place the walk stops with something unpinned beyond it.
 * `unfollowableLoads` in the shared reader draws the line and its header states
 * exactly where the grammar's reach ends.
 *
 * WHY THE THIRD KIND ARRIVED IN ROUND 8, having been argued out of scope in round
 * 7. The reader's header then said `node:child_process` was outside a reading
 * scoped to this process, because the child's closure is the child's own. Round
 * 8's review answered with a demonstration rather than an argument:
 * `spawnSync(process.execPath, ['scripts/lib/helper.mjs'])` inside a gate file ran
 * an editable repository helper, and this control was green with the helper as
 * written and green again with it rewritten wholesale. Nobody was walking the
 * child. The parent's pin binds the parent's bytes and says nothing about what the
 * parent starts.
 *
 * WHICH IS WHAT `binds` IS FOR. A declaration may name the repository paths its
 * site executes, and every one of them is admitted to the closure exactly as an
 * import is: pinned, hashed, and walked for its own imports in turn. So a site
 * that runs a repository file has a repair that BINDS it — rewriting that file
 * turns this control red — and a site that runs something no hash can bind, a
 * system binary or a build artifact, says so by declaring no paths and giving the
 * reason. That is the "bind or report" the review asked for, with the choice
 * written down where a reviewer reads it rather than inferred from silence.
 *
 * WHY DECLARED RATHER THAN IGNORED. This control's claim is that every file a
 * guarded command executes is bound by a content hash. A load the walk cannot
 * follow is a hole in exactly that claim, and the previous reader did not merely
 * permit them — it could not see them at all. Silence and permission look
 * identical from the outside, which is the property a gate may not have.
 *
 * WHY NOT SIMPLY A FINDING. Legitimate sites exist that cannot be written
 * statically: they load a build artifact, or a file the probe itself has just
 * written to a temp directory. Failing on them would leave the control red with
 * no repair available, which teaches the next author to weaken the rule rather
 * than to disclose. So this follows the shape the rest of this contract already
 * uses for a limit that cannot be closed — `unpinned_import_roots`,
 * `pnpmfile_disclosed`, `only_built_dependencies_disclosed`: state it, with the
 * reason, where a reviewer reads it.
 *
 * ONE DECLARATION BINDS ONE OCCURRENCE, which is the half round 7's review found
 * missing. The declarations were a SET keyed by file and expression TEXT, and a
 * set answers "is this permitted" rather than "how many of these did we agree
 * to": two `await import(target)` calls in one file shared a key, so one entry
 * excused both — and the second call can name a different module, for a different
 * reason, behind identical text. Two identical entries collapsed the same way,
 * and the second reason was discarded in silence. So a declaration carries the
 * LINE its load sits on, a repeated declaration is rejected outright, and a
 * declaration is consumed by the first occurrence that matches it: a second load
 * with the same file, line and text is undeclared, like any other. The line costs
 * nothing the pin does not already cost — the file's own hash has to move in the
 * same diff whenever the line does.
 *
 * The declaration is exact on both sides. An undisclosed site is a finding, and a
 * disclosure that matches no site in the closure is a finding too, so this list
 * stays the truth about the tree instead of drifting into a blanket permission.
 * It is not a hash: what binds these sites is that the files containing them are
 * themselves pinned, so a load cannot appear, move or change without a governance
 * edit in the same diff.
 */
const loadDisclosures = targets.unfollowable_loads_disclosed ?? [];
if (!Array.isArray(loadDisclosures)) {
	console.error(`${CONTRACT}: executable_targets.unfollowable_loads_disclosed must be an array`);
	process.exit(1);
}
const disclosedLoads = (() => {
	const declared = new Map();
	const consumed = new Set();
	const identify = (file, line, expression) => `${file}\u0000${line}\u0000${expression}`;
	for (const entry of loadDisclosures) {
		const shaped =
			entry &&
			typeof entry === 'object' &&
			!Array.isArray(entry) &&
			['file', 'expression', 'reason'].every(
				(key) => typeof entry[key] === 'string' && entry[key].length > 0
			) &&
			Number.isInteger(entry.line) &&
			entry.line > 0;
		if (!shaped) {
			console.error(
				`${CONTRACT}: every executable_targets.unfollowable_loads_disclosed entry must carry a ` +
					'non-empty file, expression and reason, and the positive integer line it sits on'
			);
			process.exit(1);
		}
		// `binds` is optional — a site may genuinely run nothing this repository
		// holds — but where it is present each path must be one this walk could
		// admit, so a declaration cannot reach outside the tree it is pinning.
		if (entry.binds !== undefined) {
			const bindable =
				Array.isArray(entry.binds) &&
				entry.binds.length > 0 &&
				entry.binds.every(
					(target) =>
						typeof target === 'string' &&
						target.length > 0 &&
						!target.startsWith('/') &&
						!target.split('/').includes('..')
				);
			if (!bindable) {
				console.error(
					`${CONTRACT}: executable_targets.unfollowable_loads_disclosed at ${entry.file}:${entry.line} ` +
						'carries a `binds` that is not a non-empty array of repository-relative paths. Omit it ' +
						'where the site runs nothing this repository holds, and say so in the reason.'
				);
				process.exit(1);
			}
		}
		const key = identify(entry.file, entry.line, entry.expression);
		if (declared.has(key)) {
			console.error(
				`${CONTRACT}: executable_targets.unfollowable_loads_disclosed declares ${entry.expression} ` +
					`at ${entry.file}:${entry.line} twice. One declaration binds one load, so a repeat adds no ` +
					'permission and discards a reason.'
			);
			process.exit(1);
		}
		declared.set(key, entry);
	}
	return {
		// `declared` the first time a site matches, with the paths that declaration
		// binds; `repeated` for a second load with the same file, line and text;
		// `undeclared` for anything else.
		take(file, line, expression) {
			const key = identify(file, line, expression);
			const entry = declared.get(key);
			if (!entry) return { status: 'undeclared' };
			if (consumed.has(key)) return { status: 'repeated' };
			consumed.add(key);
			return { status: 'declared', binds: entry.binds ?? [] };
		},
		unmatched: () => [...declared].filter(([key]) => !consumed.has(key)).map(([, entry]) => entry),
		count: declared.size,
	};
})();

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const repoRelative = (path) => relative(root, path).split(sep).join(posix.sep);
const underUnpinnedRoot = (path) =>
	unpinnedRoots.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix));

/**
 * Split a shell command into segments the way the pinned scripts are actually
 * written — `&&`, `||`, `;`, `|`, and newlines — respecting quotes so a separator
 * inside an argument is not a boundary. The pinned commands are a small, known
 * vocabulary; anything richer than this is rejected as an unmodelled shape rather
 * than guessed at.
 */
function shellSegments(command) {
	const segments = [];
	let current = '';
	let quote = null;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === '&&' || pair === '||') {
			segments.push(current);
			current = '';
			index += 1;
			continue;
		}
		if (char === ';' || char === '|' || char === '\n') {
			segments.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Tokenize one segment, stripping the quotes that only mattered for splitting. */
function shellTokens(segment) {
	const tokens = [];
	let current = '';
	let quote = null;
	let started = false;
	for (const char of segment) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started || current) tokens.push(current);
			current = '';
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started || current) tokens.push(current);
	return tokens;
}

// `node -e '<code>'` and its relatives run code that lives nowhere on disk, so no
// content hash can bind them. A guarded script may not smuggle one in.
const inlineCodeFlags = new Set(['-e', '--eval', '-p', '--print', '--input-type']);

/** Expand a single-`*` filename glob. `**` and brace expansion are not modelled. */
function expandGlob(pattern) {
	if (pattern.includes('**')) return { error: 'recursive `**` globs are not modelled' };
	const slash = pattern.lastIndexOf('/');
	const directory = slash < 0 ? '.' : pattern.slice(0, slash);
	const filePattern = slash < 0 ? pattern : pattern.slice(slash + 1);
	if (/[*?]/.test(directory)) return { error: 'globs in directory position are not modelled' };
	const matcher = new RegExp(
		`^${filePattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '[^/]*')
			.replace(/\?/g, '[^/]')}$`
	);
	const base = resolve(root, directory);
	if (!existsSync(base)) return { matches: [] };
	return {
		matches: readdirSync(base)
			.filter((name) => matcher.test(name))
			.map((name) => (directory === '.' ? name : `${directory}/${name}`))
			.sort(),
	};
}

/**
 * Static relative module specifiers a gate file LOADS. Bare specifiers are
 * packages, not targets.
 *
 * THIS USED TO BE FOUR PATTERNS OVER THE TEXT, and both of the defects that
 * replaced them were the same mistake: a pattern was asked a question about
 * SYNTAX, and answered by matching characters.
 *
 *   1. `from /* a comment *\/ './lib/helper.mjs'` is legal ESM — a comment sits
 *      exactly where the pattern required whitespace-then-quote — so the import
 *      was not seen, the file it names never entered the closure, and an
 *      EXECUTABLE inside a gate's own reach was left unpinned and freely
 *      editable. A pin updated for the importing file passed with no mention of
 *      it, and rewriting the helper's contents wholesale changed nothing. This is
 *      the failure this control exists to prevent, one level in.
 *
 *   2. `'./lib/agent-seams.mjs?raw'` is a legal Vite specifier addressing a file
 *      that exists, and the reader compared the specifier VERBATIM — so it
 *      resolved to nothing and was reported as an unresolvable import in a gate.
 *      A probe that needed the form had to spell it as a computed constant to
 *      keep the rubric green beside the check it was testing.
 *
 * One root cause, two directions: matching by the text that is written rather
 * than by the path it addresses misses edges that are there and invents edges
 * that are not. So the reading is `scripts/lib/module-imports.mjs` — the parser
 * extraction the seam probes already use, sharpened by six rounds of review that
 * found six ways a pattern can be walked past — and every question about a path
 * is asked of `modulePath(specifier)`, the specifier with its query and fragment
 * removed. A specifier is still REPORTED as written; a query is not part of the
 * path and is part of what the next reader has to find in the file.
 *
 * `runtimeLoads` rather than `moduleSpecifiers` is the projection this control
 * wants, for two reasons. `import type … from './x'` is erased by
 * `--experimental-strip-types` and by `tsc` before anything runs, so the file it
 * names is not code any guarded command executes, and pinning its bytes would
 * bind content no command opens; a type-only SPECIFIER inside a value import
 * still loads the module and still binds. And each load arrives with the LOADER
 * it is handed to, which is what decides the file an extensionless or directory
 * specifier opens — see `resolveRelativeImport`. The seam probes ask the other
 * projection of the same walk, for reasons their own header states.
 */
function relativeImports(source) {
	return runtimeLoads(source).filter(({ specifier }) => {
		const target = modulePath(specifier);
		return target.startsWith('./') || target.startsWith('../');
	});
}

/**
 * What each loader adds to a specifier that does not name a file outright.
 * CommonJS tries `.js`, `.json` and `.node`, in that order, and then a
 * directory's `index` in the same three; ES module resolution adds NOTHING and
 * reads no directory — Node answers `ERR_MODULE_NOT_FOUND` and
 * `ERR_UNSUPPORTED_DIR_IMPORT` rather than guessing. `.mjs` and `.cjs` are in
 * neither list: both loaders require those to be spelled out.
 */
const CJS_EXTENSIONS = ['.js', '.json', '.node'];
const CJS_INDEXES = ['index.js', 'index.json', 'index.node'];

/** Extensions a loader never adds, and so a stem that carries one is not loaded. */
const NEVER_ADDED = ['.mjs', '.cjs', '.mts', '.cts', '.ts', '.tsx', '.jsx'];

const isFile = (path) => existsSync(path) && statSync(path).isFile();
const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();
const siblings = (base, names) => names.map((name) => `${base}${name}`).filter(isFile);

/**
 * The file a specifier opens, resolved BY THE LOADER THAT OPENS IT.
 *
 * THIS USED TO BE ONE INVENTED ORDER for both loaders — `''`, `.mjs`, `.js`,
 * `.mts`, `.ts`, `.cjs`, `/index.mjs`, `/index.js` — and round 7's review walked
 * an executable straight through the gap between that list and Node's. A
 * `gate.cjs` doing `require('./lib/helper')` beside both a `helper.mjs` and a
 * `helper.js` was pinned to the `.mjs`: a file CommonJS cannot open at all, since
 * `require` adds `.js`, `.json` and `.node` and never `.mjs`. Node executed the
 * `.js`, which no pin bound, and rewriting it wholesale left CON-5 green. The pin
 * named a decoy — precisely the failure this control exists to prevent, dressed
 * as coverage.
 *
 * So resolution asks the loader. `kind` comes from the reading rather than from
 * the file's extension, because the syntax is what selects the loader: a
 * `require(…)` resolves as CommonJS wherever it is written, and a static or
 * dynamic `import` resolves as ESM.
 *
 * AMBIGUITY FAILS CLOSED, on top of resolving correctly. Where an extensionless
 * CommonJS specifier resolves to one file while a same-stem sibling the loader
 * never reaches sits beside it, this reports rather than picks: two files under
 * one stem, one executed and one not, is a decoy in the tree whether or not this
 * gate resolves it correctly today, and the repair — spell the extension — costs
 * a keystroke. Nothing in this repository's closure writes an extensionless
 * relative specifier at all.
 */
function resolveRelativeImport(fromFile, specifier, kind) {
	const base = resolve(root, dirname(fromFile), specifier);

	if (kind !== 'cjs') {
		if (isFile(base)) return { path: repoRelative(base) };
		if (isDirectory(base))
			return {
				error:
					'ES module resolution has no directory index — Node answers ERR_UNSUPPORTED_DIR_IMPORT',
			};
		return {
			error: `ES module resolution adds no extension, so ${repoRelative(base)} is what Node opens and it is not there`,
		};
	}

	if (isFile(base)) return { path: repoRelative(base) };

	if (isDirectory(base)) {
		if (existsSync(join(base, 'package.json')))
			return {
				error:
					'this directory carries a package.json, and resolution through its "main" is not modelled',
			};
		const [index, ...also] = CJS_INDEXES.map((name) => join(base, name)).filter(isFile);
		if (!index)
			return { error: 'a required directory resolves through index.js, index.json or index.node' };
		if (also.length)
			return {
				conflict:
					`require() opens ${repoRelative(index)}, while ${also.map(repoRelative).join(' and ')} sits ` +
					'beside it; name the file so the pin cannot bind the index that does not run',
			};
		return { path: repoRelative(index) };
	}

	const [found, ...shadowed] = siblings(base, CJS_EXTENSIONS);
	const unreachable = siblings(base, NEVER_ADDED).map(repoRelative);
	if (!found)
		return {
			error: unreachable.length
				? `require() adds only .js, .json and .node, so ${unreachable.join(' and ')} beside this stem is not what Node opens`
				: 'require() adds .js, .json and .node, and none of them is there',
		};
	if (shadowed.length || unreachable.length)
		return {
			conflict:
				`require() opens ${repoRelative(found)}, while ${[...shadowed.map(repoRelative), ...unreachable].join(' and ')} ` +
				'sits under the same stem; spell the extension so the pin cannot name the file that does not run',
		};
	return { path: repoRelative(found) };
}

/**
 * Everything the guarded commands execute, as repository-relative paths. Starts
 * at each `node` invocation's targets and closes over their relative imports.
 */
function executableClosure() {
	const reachable = new Set();
	const queue = [];
	const admit = (path, origin) => {
		if (underUnpinnedRoot(path)) return;
		if (reachable.has(path)) return;
		reachable.add(path);
		queue.push({ path, origin });
	};

	for (const [name, command] of Object.entries(expected)) {
		if (typeof command !== 'string') continue;
		for (const segment of shellSegments(command)) {
			const tokens = shellTokens(segment);
			if (tokens[0] !== 'node') continue;
			for (const token of tokens.slice(1)) {
				if (token.startsWith('-')) {
					if (inlineCodeFlags.has(token.split('=')[0]))
						findings.push(
							`package.json: guarded script "${name}" runs inline code (${token}); ` +
								'inline code has no file to hash and cannot be pinned'
						);
					continue;
				}
				if (/[*?]/.test(token)) {
					if (!allowedGlobs.includes(token)) {
						findings.push(
							`${CONTRACT}: guarded script "${name}" passes glob ${JSON.stringify(token)} to node, ` +
								'which is not listed in executable_targets.allowed_globs'
						);
						continue;
					}
					const { matches, error } = expandGlob(token);
					if (error) {
						findings.push(`${CONTRACT}: glob ${JSON.stringify(token)} is unsupported — ${error}`);
						continue;
					}
					for (const match of matches) admit(match, `${name} -> ${token}`);
					continue;
				}
				admit(token.split(sep).join(posix.sep), name);
			}
		}
	}

	while (queue.length) {
		const { path, origin } = queue.shift();
		const absolute = resolve(root, path);
		if (!existsSync(absolute)) {
			findings.push(`${path}: executable target reached from ${origin} does not exist`);
			continue;
		}
		if (lstatSync(absolute).isSymbolicLink()) {
			findings.push(
				`${path}: executable target reached from ${origin} is a symlink; ` +
					'a link re-points a pinned path at other content without changing the path'
			);
			continue;
		}
		if (!statSync(absolute).isFile()) continue;

		let loads;
		let unfollowable;
		try {
			const source = readFileSync(absolute, 'utf8');
			loads = relativeImports(source);
			unfollowable = unfollowableLoads(source);
		} catch (error) {
			// A file the reading cannot parse is not a file with no imports, and
			// answering the same green for both is the fail-open direction. The gate
			// that cannot read its own subject says so.
			findings.push(
				`${path}: this file's imports cannot be read, so its closure is unknown — ${error.message}`
			);
			continue;
		}

		for (const { expression, line, kind, detail } of unfollowable) {
			const declaration = disclosedLoads.take(path, line, expression);
			if (declaration.status === 'declared') {
				for (const target of declaration.binds) {
					if (underUnpinnedRoot(target)) {
						findings.push(
							`${CONTRACT}: the disclosure of ${expression} at ${path}:${line} binds ${target}, which ` +
								'is under a declared unpinned root and so is bound by nothing; a `binds` that pins ' +
								'no bytes reads as coverage and is not'
						);
						continue;
					}
					admit(target, `${path}:${line}, declared`);
				}
				continue;
			}
			if (declaration.status === 'repeated') {
				findings.push(
					`${path}:${line}: a second ${expression} shares this line with a disclosed one, and one ` +
						'declaration binds one load; put them on separate lines so each carries its own reason'
				);
				continue;
			}
			findings.push(
				`${path}:${line}: ${expression} ${detail}, and it is not disclosed in ${CONTRACT}; ` +
					(kind === 'computed'
						? 'a target this walk cannot reach is a target no hash binds'
						: kind === 'execution'
							? 'code this walk never opens is code no hash binds — disclose it, and name the ' +
								'repository paths it runs in `binds` so they are pinned'
							: 'a loader this walk cannot follow reaches targets no hash binds')
			);
		}

		for (const { specifier, kind } of loads) {
			const target = modulePath(specifier);
			const lexical = repoRelative(resolve(root, dirname(path), target));
			if (underUnpinnedRoot(lexical)) continue;
			const { path: resolved, error, conflict } = resolveRelativeImport(path, target, kind);
			if (conflict) {
				findings.push(
					`${path}: relative import ${JSON.stringify(specifier)} names more than one file — ${conflict}; ` +
						'a pin on the wrong one of them reads as coverage and is not'
				);
				continue;
			}
			if (!resolved) {
				findings.push(
					`${path}: relative import ${JSON.stringify(specifier)} resolves to no file — ${error}; ` +
						'an unresolvable import in a gate is an unscanned one'
				);
				continue;
			}
			admit(resolved, `${path}`);
		}
	}
	return reachable;
}

const closure = executableClosure();

// SEC-6's inventory carries its own hashes (they are the probes' own binding).
// A path in both maps must agree; two hashes for one file is a pin that can drift.
const inventoryHashes = new Map();
for (const entry of contract.security_tests?.expected ?? [])
	if (typeof entry?.file === 'string' && typeof entry?.sha256 === 'string')
		inventoryHashes.set(entry.file, entry.sha256);

const verified = [];
for (const path of [...closure].sort()) {
	const pinned = pinnedHashes[path] ?? inventoryHashes.get(path);
	if (typeof pinned !== 'string' || !/^[0-9a-f]{64}$/.test(pinned)) {
		findings.push(
			`${CONTRACT}: executable target ${path} has no pinned sha256; ` +
				'a `node` target the rubric runs but does not bind is command text pretending to be a gate'
		);
		continue;
	}
	if (
		pinnedHashes[path] &&
		inventoryHashes.has(path) &&
		pinnedHashes[path] !== inventoryHashes.get(path)
	) {
		findings.push(
			`${CONTRACT}: ${path} is pinned to two different hashes (executable_targets vs security_tests)`
		);
		continue;
	}
	const actual = sha256(resolve(root, path));
	if (actual !== pinned)
		findings.push(
			`${path}: content does not match its pin\n` +
				`    pinned: ${pinned}\n` +
				`    actual: ${actual}`
		);
	else verified.push(path);
}

for (const path of Object.keys(pinnedHashes))
	if (!closure.has(path))
		findings.push(
			`${CONTRACT}: executable_targets.sha256 pins ${path}, which no guarded command reaches; ` +
				'a pin that binds nothing reads as coverage and is not'
		);

// The same rule for the other declaration. A disclosure whose site is gone reads
// as a permission the tree still needs, and the next unfollowable load written
// into that file would land on it silently.
for (const entry of disclosedLoads.unmatched())
	findings.push(
		`${CONTRACT}: executable_targets.unfollowable_loads_disclosed declares ${entry.expression} at ` +
			`${entry.file}:${entry.line}, which the closure does not contain; a disclosure of nothing ` +
			'reads as coverage and is not'
	);

if (printHashes) {
	const block = {};
	for (const path of [...closure].sort())
		if (!inventoryHashes.has(path)) block[path] = sha256(resolve(root, path));
	console.log(JSON.stringify(block, null, 2));
	process.exit(0);
}

if (findings.length) {
	console.error(findings.join('\n'));
	console.error('');
	console.error('Repair the script or the file, or — if it legitimately changed — move the pin in');
	console.error(`${CONTRACT} in the same commit, with the reason. Never the pin alone.`);
	console.error('`node gov-infra/verifiers/check-package-scripts.mjs --print-hashes` prints the');
	console.error('current closure so a legitimate move is mechanical rather than hand-computed.');
	process.exit(1);
}

console.log(`${Object.keys(expected).length} guarded package.json scripts match their pins.`);
for (const name of Object.keys(expected).sort()) console.log(`  = ${name}: ${expected[name]}`);
console.log('');
console.log('Every `pnpm run` delegation from a pinned script resolves to another pinned script.');
console.log(`${verified.length} executable targets in the closure match their pinned SHA-256:`);
for (const path of verified)
	console.log(`  # ${path}: ${(pinnedHashes[path] ?? inventoryHashes.get(path)).slice(0, 16)}…`);
console.log('');
console.log(`Outside the closure by declaration: ${unpinnedRoots.join(', ') || 'nothing'}`);
console.log(
	`Loads inside it this walk cannot follow, disclosed one by one with a reason: ${
		disclosedLoads.count || 'none'
	}`
);
console.log('PASS here means the rubric is invoking the commands it believes it is invoking,');
console.log('and those commands are running the code this repository pinned.');

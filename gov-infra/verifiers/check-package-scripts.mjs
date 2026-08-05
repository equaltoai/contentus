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
 * The one thing no static reading can follow is a load whose target is computed,
 * and this control now says so out loud: an `import(<expression>)` or
 * `require(<expression>)` inside the closure must be declared in the contract
 * with its reason, or it is a finding. Three exist, all loading a build artifact
 * or a file a probe has just written; what binds them is that the files holding
 * them are pinned, so the call cannot appear or move without a governance edit.
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

import {
	computedImports,
	modulePath,
	runtimeSpecifiers,
} from '../../scripts/lib/module-imports.mjs';
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
 * The `import(<expression>)` and `require(<expression>)` sites inside the closure
 * whose target no static read can name, declared with the reason each one is
 * there.
 *
 * WHY DECLARED RATHER THAN IGNORED. This control's claim is that every file a
 * guarded command executes is bound by a content hash. A computed load is a hole
 * in exactly that claim — the walk cannot follow it, so nothing downstream of it
 * is pinned — and the previous reader did not merely permit them, it could not
 * see them at all. Silence and permission look identical from the outside, which
 * is the property a gate may not have.
 *
 * WHY NOT SIMPLY A FINDING. Three legitimate sites exist and none can be written
 * statically: they load a build artifact, or a file the probe itself has just
 * written to a temp directory. Failing on them would leave the control red with
 * no repair available, which teaches the next author to weaken the rule rather
 * than to disclose. So this follows the shape the rest of this contract already
 * uses for a limit that cannot be closed — `unpinned_import_roots`,
 * `pnpmfile_disclosed`, `only_built_dependencies_disclosed`: state it, with the
 * reason, where a reviewer reads it.
 *
 * The declaration is exact on both sides. An undisclosed site is a finding, and a
 * disclosure that matches no site in the closure is a finding too, so this list
 * stays the truth about the tree instead of drifting into a blanket permission.
 * It is not a hash: what binds these three is that the files containing them are
 * themselves pinned, so the call cannot appear, move or change without a
 * governance edit in the same diff.
 */
const computedDisclosures = targets.computed_imports_disclosed ?? [];
if (!Array.isArray(computedDisclosures)) {
	console.error(`${CONTRACT}: executable_targets.computed_imports_disclosed must be an array`);
	process.exit(1);
}
const disclosedComputed = (() => {
	const declared = new Map();
	const matched = new Set();
	for (const entry of computedDisclosures) {
		const shaped =
			entry &&
			typeof entry === 'object' &&
			!Array.isArray(entry) &&
			['file', 'expression', 'reason'].every(
				(key) => typeof entry[key] === 'string' && entry[key].length > 0
			);
		if (!shaped) {
			console.error(
				`${CONTRACT}: every executable_targets.computed_imports_disclosed entry must carry a ` +
					'non-empty file, expression and reason'
			);
			process.exit(1);
		}
		declared.set(`${entry.file}\u0000${entry.expression}`, entry);
	}
	return {
		take(file, expression) {
			const key = `${file}\u0000${expression}`;
			if (!declared.has(key)) return false;
			matched.add(key);
			return true;
		},
		unmatched: () => [...declared].filter(([key]) => !matched.has(key)).map(([, entry]) => entry),
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
 * `runtimeSpecifiers` rather than `moduleSpecifiers` is the projection this
 * control wants: `import type … from './x'` is erased by
 * `--experimental-strip-types` and by `tsc` before anything runs, so the file it
 * names is not code any guarded command executes, and pinning its bytes would
 * bind content no command opens. A type-only SPECIFIER inside a value import
 * still loads the module and still binds. The seam probes ask the other
 * projection of the same walk, for reasons their own header states.
 */
function relativeImports(source) {
	return runtimeSpecifiers(source).filter((specifier) => {
		const target = modulePath(specifier);
		return target.startsWith('./') || target.startsWith('../');
	});
}

const moduleExtensions = ['', '.mjs', '.js', '.mts', '.ts', '.cjs', '/index.mjs', '/index.js'];

function resolveRelativeImport(fromFile, specifier) {
	const base = resolve(root, dirname(fromFile), specifier);
	for (const extension of moduleExtensions) {
		const candidate = `${base}${extension}`;
		if (existsSync(candidate) && statSync(candidate).isFile()) return repoRelative(candidate);
	}
	return null;
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

		let specifiers;
		let computed;
		try {
			const source = readFileSync(absolute, 'utf8');
			specifiers = relativeImports(source);
			computed = computedImports(source);
		} catch (error) {
			// A file the reading cannot parse is not a file with no imports, and
			// answering the same green for both is the fail-open direction. The gate
			// that cannot read its own subject says so.
			findings.push(
				`${path}: this file's imports cannot be read, so its closure is unknown — ${error.message}`
			);
			continue;
		}

		for (const call of computed) {
			if (disclosedComputed.take(path, call)) continue;
			findings.push(
				`${path}: ${call} loads a module no static read can name, and it is not disclosed in ` +
					`${CONTRACT}; a target this walk cannot reach is a target no hash binds`
			);
		}

		for (const specifier of specifiers) {
			const target = modulePath(specifier);
			const lexical = repoRelative(resolve(root, dirname(path), target));
			if (underUnpinnedRoot(lexical)) continue;
			const resolved = resolveRelativeImport(path, target);
			if (!resolved) {
				findings.push(
					`${path}: relative import ${JSON.stringify(specifier)} resolves to no file; ` +
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
// as a permission the tree still needs, and the next computed load written into
// that file would land on it silently.
for (const entry of disclosedComputed.unmatched())
	findings.push(
		`${CONTRACT}: executable_targets.computed_imports_disclosed declares ${entry.expression} in ` +
			`${entry.file}, which the closure does not contain; a disclosure of nothing reads as ` +
			'coverage and is not'
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
	`Computed loads inside it, disclosed with a reason: ${disclosedComputed.count || 'none'}`
);
console.log('PASS here means the rubric is invoking the commands it believes it is invoking,');
console.log('and those commands are running the code this repository pinned.');

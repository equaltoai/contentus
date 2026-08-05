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
 * A base is the other half of that same sentence, and it is where this walk was
 * wrong for the third time. Which file `'scripts/lib/helper.mjs'` names depends on
 * the DIRECTORY it is resolved in, an execution site may write its own with `cwd`,
 * and this walk resolved every literal against the repository root — so
 * `spawnSync(node, ['scripts/lib/helper.mjs'], { cwd: 'sub' })` ran an unpinned
 * `sub/scripts/lib/helper.mjs` while its disclosure bound the root-spelled file,
 * which is real, pinned, hashed and never executed. `siteRepositoryTargets`
 * resolves in the base the site writes, in the frame it writes it, and reports
 * rather than guesses where that base cannot be read.
 *
 * A base is not the only thing between a literal and the file that opens: there is
 * also the GRAMMAR the child applies to the string, and the ORDER it searches. Round
 * 12 walked executables through both. `node scripts/lib/$1`, `node ~/helper.mjs`,
 * `node h[ae]lper.mjs` and a here-document each build a word when they run, and this
 * reading produced the words it could see and called the site read; `PATH=scripts/lib
 * helper.mjs` puts the lookup path in front of the command, and a reading that took
 * token 0 as the command took the assignment instead; and `sh -c '<code>'` carries a
 * whole command line at an ARGUMENT position, where no shell grammar was applied at
 * all. Those are `shellConstructs` and `siteWords` now. The search itself is
 * `siteRepositoryTargets`: execvp runs the FIRST entry of a lookup path that holds
 * the name, and a walk that collected a match from every entry at once let a later
 * repository file answer for an earlier directory it cannot see into.
 *
 * A GRAMMAR IS READ THROUGH WHATEVER RUNS THE CHILD, which is round 13 and the
 * same sentence one word further along. `exec sh -c '<code>'`, `env FOO=1 sh -c …`,
 * `command sh -c …` and `nohup sh -c …` each put the shell behind a TRANSPARENT
 * wrapper, and a reading scoped to the first word of a line saw `exec` and applied
 * no shell grammar to the payload at all; `env PATH=scripts/lib helper.mjs` moves
 * the lookup path and the name searched on it one word along in exactly the same
 * way. `runChain` walks the exec chain through the wrappers it models, reads a
 * `-c` by where a shell's NAME stands rather than by which word came first, and
 * reports the wrapper option it cannot place instead of guessing which word the
 * operand is.
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

import {
	INHERITED_EXECUTION,
	modulePath,
	runtimeLoads,
	unfollowableLoads,
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
 * A WRITE IS THE FOURTH, and it is round 11's. `process.env.NODE_OPTIONS =
 * '--require=./scripts/lib/helper.cjs'` starts that helper in every child this
 * process goes on to spawn, and the spawn itself carries no literal at all — so the
 * site with something to bind was not the site the reading was looking at, and this
 * control was green with the helper rewritten wholesale. The variable has a name,
 * this repository writes it, and the write lives in a file a hash binds; what is
 * NOT reported is the environment this process inherits, which is the world rather
 * than the tree.
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
 * AND WHAT A `binds` HAS TO BE ABOUT, which is round 9. The list was admitted at
 * its word: whatever it named was pinned, and nothing asked whether the site ran
 * it. So a declaration bound a pinned file while `spawnSync(process.execPath,
 * ['scripts/lib/decoy.mjs'])` on the very line it declared executed a different,
 * unpinned one — and this control was green with that decoy rewritten wholesale.
 * A pin pointed away from the file that runs is round 7's failure exactly, moved
 * out of the resolver and into the contract, and it reads as coverage more loudly
 * there because a human wrote the path down.
 *
 * So the declaration is now held to the site's own text, both ways. The reading
 * reports the literals each call is written to hand its facility; this control
 * resolves them (`siteRepositoryTargets`) and requires the repository files among
 * them to be exactly what `binds` names. A file the site runs and the declaration
 * misses is a finding, and a file the declaration names and the site does not run
 * is a finding too.
 *
 * AND WHERE THAT CLAIM IS RESOLVED, which is round 10 and the same defect in the
 * last of the three places a path gets decided. The reading reported the literals
 * and this control resolved them — against the repository root, always, because
 * that is where a guarded command starts. An execution site may write its own
 * working directory, and one that did ran `sub/scripts/lib/helper.mjs` while its
 * declaration bound the root-spelled `scripts/lib/helper.mjs`: a real file, pinned,
 * hashed, walked, and never executed. The check held the declaration to the site's
 * text and then resolved that text in the wrong directory, which is a decoy the
 * contract cannot be blamed for. So the site's own `cwd` is part of the reading now
 * (`siteBase` there, `siteRepositoryTargets` here), and a `cwd` no static read can
 * name leaves the site's targets UNDETERMINED — reported, because resolving them
 * against the root anyway is the guess that pinned the decoy, and dropping them
 * silently would retire a pin this control demanded yesterday.
 *
 * WHAT A `binds` CANNOT DO, stated because the rule above has an edge and silence
 * about it would be the same defect one level up: it cannot excuse a target no
 * reading can see. Where a site's path is an argv element, a module-level constant
 * or a name assembled from pieces, there is no literal to check a declaration
 * against — so a `binds` there would be an unverifiable claim of coverage, and it
 * is refused as one. Such a site is carried by its REASON, which is a sentence a
 * reviewer reads, rather than by a pin nothing compares to anything. The practical
 * consequence is a discipline rather than a prohibition: a site that means to bind
 * what it runs writes the path where it runs it.
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

/**
 * One repository-relative spelling of a path, whatever spelling it arrived in.
 *
 * IT IS A CONTROL, not tidiness. Everything this walk compares — a closure member
 * against a pin, a declared `binds` against an unpinned root, a bound path against
 * the target its site names — is compared as TEXT, and `./scripts/lib/helper.mjs`,
 * `scripts/lib/helper.mjs` and `scripts/lib/../lib/helper.mjs` are three texts for
 * one file. Round 9's review found the consequence in the `binds` list, where a
 * leading `./` walked straight past `underUnpinnedRoot` — so `binds:
 * ["./build/server/handler.mjs"]` declared a binding on generated output the rule
 * beside it exists to refuse — and the same spelling admitted a second closure
 * member for a file already in it, which then failed as an unpinned target while
 * its real pin failed as a pin nothing reaches. Two findings, both about
 * punctuation, neither about the tree. So every path entering the closure or being
 * matched against one comes through here first.
 */
const normalizePath = (path) => repoRelative(resolve(root, path));

const underUnpinnedRoot = (path) =>
	unpinnedRoots.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix));

/**
 * Split a shell command into segments the way the pinned scripts are actually
 * written — `&&`, `||`, `;`, `|`, and newlines — respecting quotes AND backslash
 * escapes so a separator inside an argument is not a boundary. The pinned commands
 * are a small, known vocabulary; anything richer than this is rejected by
 * `shellConstructs` rather than guessed at.
 */
function shellSegments(command) {
	const segments = [];
	let current = '';
	let quote = null;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		// A backslash outside single quotes takes the next character with it, and
		// both are kept: the escape is the TOKENIZER's to interpret, and losing it
		// here would hand that reading a word the shell never builds.
		if (char === '\\' && quote !== "'" && index + 1 < command.length) {
			current += char + command[index + 1];
			index += 1;
			continue;
		}
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

/**
 * Tokenize one segment, stripping the quotes and escapes that only mattered for
 * splitting.
 *
 * THE ESCAPE IS A WORD BOUNDARY THAT IS NOT ONE, and round 11's review walked an
 * executable through the gap. `execSync('node scripts/lib/my\\ helper.mjs')` runs
 * a repository file whose name contains a space; a tokenizer that splits on
 * whitespace and knows nothing of `\` produced `scripts/lib/my\` and `helper.mjs`,
 * neither of which names any file, and the helper was executed with this control
 * green and green again with it rewritten wholesale. A word the shell builds is a
 * word this reading has to build, or the reading is about a different command.
 */
function shellTokens(segment) {
	const tokens = [];
	let current = '';
	let quote = null;
	let started = false;
	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index];
		if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
			const escaped = segment[index + 1];
			// Inside double quotes a backslash is literal except before the four
			// characters that would otherwise mean something there; outside them it
			// escapes whatever follows, which is how a space joins two words into one.
			if (quote === '"' && !['"', '\\', '$', '`', '\n'].includes(escaped)) current += char;
			current += escaped;
			started = true;
			index += 1;
			continue;
		}
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

/**
 * Shell syntax this reading does not model, found in a string a shell parses.
 *
 * WHY REJECTING IS THE ANSWER RATHER THAN PARSING. A tokenizer answers "which
 * words is this", and `node $(echo scripts/lib/helper.mjs)` has no answer until
 * the shell has run something. The same is true of a parameter expansion, a
 * process substitution and a backtick: each is a word DECIDED AT RUN TIME, and a
 * reading that quietly produced the words it can see would report `node` and call
 * the site read. Round 11's review executed a repository helper through exactly
 * that gap. So the construct is named and the site's targets are undetermined,
 * with the repair being the form a `binds` can be checked against: a file and an
 * argument list of literal paths.
 *
 * A `cd` BELONGS HERE for the reason round 10 established: it moves the frame the
 * following words resolve in, so a reading that kept resolving them against the
 * site's own `cwd` would name files the child never opens.
 *
 * QUOTES DECIDE WHETHER THERE IS A CONSTRUCT AT ALL — `'$HOME'` is three literal
 * characters and `"$HOME"` is an expansion — so this walks the string with the
 * same quote and escape rules the tokenizer does rather than scanning for text.
 *
 * WHAT ROUND 12 ADDED, and each of them ran a repository helper past round 11's
 * version of this reading. A `$` was an expansion only in front of a LETTER, so
 * `set -- helper.mjs; node scripts/lib/$1` built its target out of a positional
 * parameter and this walk saw the word `scripts/lib/$1`, which names no file and
 * demanded nothing. `~` is the same fact with the value coming out of the
 * environment instead of the argument list. A `[…]` is a glob that carries neither
 * of the two characters this looked for. And `<<EOF` feeds a whole program to a
 * child on its standard input, where there is no word for any reading to see at
 * all. So the rule is the grammar rather than the examples: a `$` in front of
 * anything a shell expands, a `~` where a word begins, a redirection in either
 * direction, and a bracket among the glob characters.
 */
const UNMODELLED_BUILTINS = new Set(['cd', 'pushd', 'popd', 'chdir', 'eval', 'source']);

/**
 * What a `$` may begin: a name, a brace, a positional or special parameter, and
 * the two quoting forms that build a word out of one.
 */
const EXPANSION_STARTS = /[A-Za-z_{(0-9@*#?$!\-'"]/;

/** The characters that make a word a pattern rather than a name. */
const GLOB_CHARACTERS = /[*?[]/;

function shellConstructs(text) {
	const found = new Set();
	let quote = null;
	// `~` is a home directory only where a WORD begins and only unquoted, so this
	// tracks that as well as which quote it is inside.
	let wordStart = true;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const begins = wordStart;
		wordStart = false;
		if (char === '\\' && quote !== "'" && index + 1 < text.length) {
			index += 1;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (quote === '"' && char === '"') {
			quote = null;
			continue;
		}
		if (!quote && (char === '"' || char === "'")) {
			quote = char;
			continue;
		}
		if (!quote && (/\s/.test(char) || ';|&('.includes(char))) {
			wordStart = true;
			continue;
		}
		const pair = text.slice(index, index + 2);
		if (char === '`') found.add('a command substitution in backticks');
		else if (pair === '$(') found.add('a command substitution `$(…)`');
		else if (pair === '<(' || pair === '>(') found.add('a process substitution');
		else if (char === '$' && EXPANSION_STARTS.test(text[index + 1] ?? ''))
			found.add('a parameter expansion');
		else if (char === '<' || char === '>')
			found.add('a redirection, which can carry a program on the child’s input');
		else if (char === '~' && begins) found.add('a tilde expansion');
	}
	for (const segment of shellSegments(text))
		for (const token of shellTokens(segment)) {
			if (UNMODELLED_BUILTINS.has(token)) found.add(`the shell builtin \`${token}\``);
			if (GLOB_CHARACTERS.test(token) && pathShaped(token))
				found.add(`a glob (${JSON.stringify(token)})`);
		}
	return found;
}

/**
 * A word that could name a file somewhere — it carries a separator or an
 * extension — and is not an absolute path, which no working directory moves.
 * `utf8`, `--`, `init` and `-z` are not.
 */
const pathShaped = (word) =>
	!word.startsWith('/') && (word.includes('/') || /\.[A-Za-z0-9]+$/.test(word));

// `node -e '<code>'` and its relatives run code that lives nowhere on disk, so no
// content hash can bind them. A guarded script may not smuggle one in, and neither
// may an execution site inside the closure: round 11's review ran a repository
// helper out of `spawnSync(process.execPath, ['-e', 'require("./scripts/lib/x.cjs")'])`,
// where the file that executes is named inside a string no reading opens.
const inlineCodeFlags = new Set(['-e', '--eval', '-p', '--print', '--input-type']);

/** The names a command word carries when the child is Node rather than something else. */
const isNodeInterpreter = (word) => ['node', 'nodejs', 'node.exe'].includes(word.split('/').pop());

// `INHERITED_EXECUTION` is the shared reader's, imported rather than repeated:
// there it decides which WRITE into this process's environment is a load, and here
// which VALUE is a flag list a child's interpreter parses. One list, because two
// copies of one list is how the halves of a model drift apart.

/** Expand a single-`*` filename glob. `**`, brackets and braces are not modelled. */
function expandGlob(pattern) {
	if (pattern.includes('**')) return { error: 'recursive `**` globs are not modelled' };
	if (pattern.includes('[')) return { error: 'bracket expressions are not modelled' };
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
 * A literal as the words a site can hand a program — the string itself, and, since
 * a shell is one of the things a site may hand it to, each token of it — with the
 * FRAME the literal was written in carried onto every one of them.
 *
 * WHY THE SPLIT. `exec`, `execSync` and any `spawn` with `shell: true` take a
 * COMMAND LINE rather than a file and an argument list, so the whole invocation is
 * one string: `execSync('node scripts/lib/helper.mjs')` names a repository
 * executable that resolves to no file when the literal is asked as a path, and this
 * control was green with that helper rewritten wholesale. The tokenizer that reads
 * the guarded package.json commands is exactly the reading a shell applies here, so
 * it is applied here, and a command line stops being a place a target can hide.
 *
 * IT ALSO CATCHES THE OTHER STRING A CHILD PARSES: `{ env: { NODE_OPTIONS: '--import
 * ./scripts/lib/helper.mjs' } }` is a repository file loaded into the child by a
 * flag, and it is a token of a literal like any other. Asking every literal both
 * ways is over-inclusive by construction — a word that happens to name a file
 * becomes a target a declaration must name — and that is the direction this check
 * fails in, because the other direction is the decoy it exists to catch.
 *
 * WHY THE FRAME TRAVELS. A token of `'./lib/x.mjs ./lib/y.mjs'` is resolved in
 * exactly the directory the literal is, so splitting a word out of a literal may
 * not lose which directory that was. Over-inclusion is a property of WHICH words
 * are asked, never of WHERE they are asked.
 *
 * AN OPTION MAY BE SPELLED WITH AN `=` INSTEAD OF A SPACE, which is the third of
 * round 11's demonstrated misses and the cheapest of them. `--require ./x.cjs` is
 * two tokens and bound; `--require=./x.cjs` is one token that names no file when
 * it is asked as a path, and `--require=`, `--import=` and `--loader=` all
 * executed repository helpers with this control green. `NODE_OPTIONS=--require=…`
 * as a shell assignment packs two of them into one word. So every token is also
 * read as its `=`-separated pieces, which is the same over-inclusive direction as
 * reading it as a command line.
 *
 * WHERE THE REJECTION APPLIES, and it is a question of PROVENANCE rather than of
 * text. A literal in the COMMAND position is parsed by a shell or handed to
 * execvp; the value of a watched execution variable is split into flags by the
 * child's own interpreter. Those are the strings whose unmodelled constructs
 * change what runs, so those are the ones `shellConstructs` is asked about. Every
 * other literal keeps the over-inclusive tokenization and no rejection, because a
 * rule that fired on a `$` inside a query string would be a finding with no repair
 * — and a rule with no repair is how a gate gets weakened.
 *
 * PROVENANCE IS NOT THE SAME AS POSITION, which is round 12 and the hole that
 * sentence left. `sh -c '<code>'` hands the child's entire command line at an
 * ARGUMENT position: the provenance is a shell either way, and only the position
 * differs. So which strings a shell parses is decided by what the site RUNS — where
 * the command is one of the named interpreters, its arguments are command lines, and
 * so is whatever a `-c` inside one of those carries. The scoping that was already
 * right stays right: `-e` is inline code to a node and a flag to `mkdir`, and it is
 * the interpreter, not the spelling, that decides which.
 *
 * A LOOKUP PATH IS ITS OWN KIND OF STRING, which is round 11's third finding and
 * the reason this reading asks the reader for a variable's NAME. The rule here used
 * to be that every word naming a directory in this tree is a base the site's other
 * words may be resolved in — over-inclusive on purpose, and wrong in both
 * directions at once. `{ env: { PATH: 'scripts/lib:/usr/bin' } }` is a lookup path
 * with two entries, and as one word it names no directory at all, so a bare command
 * beside it ran a repository file with this control green. `{ env: { LABEL_DIR:
 * 'scripts/lib', LABEL_FILE: 'helper.mjs' } }` beside `/usr/bin/true` is two labels
 * and no lookup path whatsoever, and the same rule reported the site as running
 * `scripts/lib/helper.mjs` — a file the child never opens, demanded of a `binds`
 * that could not honestly name it. A directory-valued string is not a base; a
 * variable a child SEARCHES is, and the variable has a name. So `PATH` is split into
 * its entries, each in the frame its literal was written in, and a command word with
 * no separator is resolved through those entries and through nothing else — which is
 * also what execvp does, since a bare name is never sought in the working directory.
 */
const LOOKUP_VARIABLES = new Set(['PATH', 'Path']);

/**
 * The command words that take their child's whole command line as DATA, and the
 * assignment that carries a variable in front of one.
 *
 * WHY A READING SCOPED TO ARGUMENT 0 IS NOT SCOPED TO WHAT RUNS, which is round
 * 12's second finding in two of its parts. `spawnSync('/bin/sh', ['-c', 'set --
 * helper.mjs; node scripts/lib/$1'])` puts a whole command line at an ARGUMENT
 * position, where this reading applied no shell grammar at all and saw a word;
 * `execSync('PATH=scripts/lib helper.mjs')` puts the lookup path the child searches
 * in front of the command, where a reading that took token 0 as the command took
 * the assignment instead and the real command word was answered by nobody. Both ran
 * an unpinned repository helper with this control green. A shell's `-c` and a
 * variable assignment are syntax, so they are read as syntax.
 */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ash', 'ksh', 'mksh', 'zsh']);
const isShellInterpreter = (word) => SHELL_INTERPRETERS.has(word.split('/').pop());
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A COMMAND THAT RUNS ANOTHER COMMAND IS TRANSPARENT, which is round 13's first
 * finding and round 12's sentence one word further along. Which grammar a string
 * is read with is decided by the child that reads it — and `exec sh -c '<code>'`,
 * `env sh -c '<code>'`, `env FOO=1 sh -c …`, `command sh -c …` and `nohup sh -c …`
 * each put the shell somewhere other than the front of the line. A reading that
 * asked only the first word saw `exec` and applied no shell grammar to the payload
 * at all, so an unpinned helper named inside it stayed green through every one of
 * them. A wrapper does not change WHAT runs; it moves where the name of it is
 * written. So the exec chain is walked through it: the wrapper's own options and
 * assignments are its own, and the first word after them is the command it runs.
 *
 * IT IS THE OPERAND, NOT ONLY THE PAYLOAD. `env PATH=scripts/lib helper.mjs` is
 * round 12's lookup-path decoy standing behind a wrapper: the assignment is env's
 * to make rather than a shell's, and the bare word after it is the name the CHILD
 * searches for. Both are read where they are, or the search answers with the file
 * beside the site while the child opens the one on the path.
 *
 * WHAT A WRAPPER TAKES FOR ITSELF IS MODELLED, AND AN OPTION OUTSIDE THAT MODEL IS
 * REPORTED. `env -u NAME sh -c …` hides its operand behind an option that carries a
 * value, and a peel that stepped over `-` words alone would take `NAME` for the
 * command. So each wrapper carries its own options — which take a value, which do
 * not, and which carry a command line of their own — and an option this reading
 * does not model ends the walk as undetermined rather than guessing which word the
 * operand is. An optional-value option (`xargs -i`, `-l`, `-e`) is exactly that
 * case and is left out on purpose: whether the next word is its value or the
 * command cannot be read from the line.
 *
 * AND THE LIST IS NOT THE RULE. A wrapper outside this table would hide a `-c`
 * again, so the payload reading in `siteWords` does not rest on the table at all:
 * it asks where a SHELL NAME stands in the line, which is a question no wrapper can
 * move — in the array form a shell payload cannot exist unless the shell is one of
 * the words the site is written to hand its child. The table buys the operand and
 * the search it is answered by; the shell name closes the grammar.
 */
const wrapperSpec = (spec) => ({
	short: '',
	shortValued: '',
	long: new Set(),
	longValued: new Set(),
	payload: new Set(),
	assignments: false,
	operands: 0,
	...spec,
});
const TRANSPARENT_WRAPPERS = new Map(
	Object.entries({
		exec: wrapperSpec({ short: 'cl', shortValued: 'a' }),
		command: wrapperSpec({ short: 'pvV' }),
		nohup: wrapperSpec({ long: new Set(['help', 'version']) }),
		env: wrapperSpec({
			short: 'i0v',
			shortValued: 'uCS',
			long: new Set(['ignore-environment', 'null', 'debug', 'help', 'version']),
			longValued: new Set(['unset', 'chdir', 'split-string']),
			// `-S` is a command line the wrapper splits into words itself, which is the
			// same string a `-c` carries by another spelling.
			payload: new Set(['S', 'split-string']),
			assignments: true,
		}),
		nice: wrapperSpec({ shortValued: 'n', longValued: new Set(['adjustment']) }),
		setsid: wrapperSpec({ short: 'cfw', long: new Set(['ctty', 'fork', 'wait']) }),
		stdbuf: wrapperSpec({
			shortValued: 'ioe',
			longValued: new Set(['input', 'output', 'error']),
		}),
		time: wrapperSpec({
			short: 'apv',
			shortValued: 'fo',
			long: new Set(['append', 'portability', 'verbose']),
			longValued: new Set(['format', 'output']),
		}),
		timeout: wrapperSpec({
			short: 'fpv',
			shortValued: 'ks',
			long: new Set(['foreground', 'preserve-status', 'verbose']),
			longValued: new Set(['kill-after', 'signal']),
			// The duration is the wrapper's own word, and the command follows it.
			operands: 1,
		}),
		xargs: wrapperSpec({
			short: '0prtx',
			shortValued: 'adEILnPs',
			long: new Set(['null', 'no-run-if-empty', 'interactive', 'verbose', 'exit', 'open-tty']),
			longValued: new Set([
				'arg-file',
				'delimiter',
				'max-args',
				'max-chars',
				'max-lines',
				'max-procs',
				'process-slot-var',
				'replace',
			]),
		}),
	})
);
const wrapperFor = (word) => TRANSPARENT_WRAPPERS.get(word.split('/').pop()) ?? null;

/**
 * One option of a wrapper and the words it takes for itself: where the wrapper's
 * own words carry on, the command lines the option holds, or null where this
 * reading does not model the option — which is where its operand stops being
 * determined.
 */
function wrapperOption(spec, tokens, index) {
	const token = tokens[index];
	const payloads = [];
	if (token.startsWith('--')) {
		const separator = token.indexOf('=');
		const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
		if (spec.longValued.has(name)) {
			if (separator !== -1) {
				if (spec.payload.has(name)) payloads.push(token.slice(separator + 1));
				return { next: index + 1, payloads };
			}
			if (index + 1 >= tokens.length) return null;
			if (spec.payload.has(name)) payloads.push(tokens[index + 1]);
			return { next: index + 2, payloads };
		}
		return separator === -1 && spec.long.has(name) ? { next: index + 1, payloads } : null;
	}
	// A cluster of short options, each of which may take the rest of its own word —
	// or the word after it — as a value.
	for (let position = 1; position < token.length; position += 1) {
		const letter = token[position];
		if (spec.shortValued.includes(letter)) {
			const attached = token.slice(position + 1);
			if (attached) {
				if (spec.payload.has(letter)) payloads.push(attached);
				return { next: index + 1, payloads };
			}
			if (index + 1 >= tokens.length) return null;
			if (spec.payload.has(letter)) payloads.push(tokens[index + 1]);
			return { next: index + 2, payloads };
		}
		if (!spec.short.includes(letter)) return null;
	}
	return { next: index + 1, payloads };
}

/**
 * The words a segment RUNS, in the order the exec chain reaches them, with the
 * role each of the line's other words carries and the command lines its options
 * hold as data.
 */
function runChain(tokens) {
	const roles = new Map();
	const runs = [];
	const payloads = [];
	const chain = (open, undetermined) => ({ runs, roles, payloads, open, undetermined });
	let index = 0;
	// A variable in front of a command is the shell's own syntax, and it is that
	// command's environment.
	while (index < tokens.length && ASSIGNMENT.test(tokens[index])) {
		roles.set(index, 'assignment');
		index += 1;
	}
	while (index < tokens.length) {
		const word = tokens[index];
		roles.set(index, 'run');
		runs.push({ word, index });
		const spec = wrapperFor(word);
		if (!spec) return chain(false, null);
		index += 1;
		let operands = spec.operands;
		while (index < tokens.length) {
			const token = tokens[index];
			// A variable in front of a wrapper's operand is the WRAPPER's to set, and
			// it means there what it means in an `env` bag.
			if (spec.assignments && ASSIGNMENT.test(token)) {
				roles.set(index, 'assignment');
				index += 1;
				continue;
			}
			if (token === '--') {
				index += 1;
				break;
			}
			if (token.startsWith('-')) {
				const option = wrapperOption(spec, tokens, index);
				if (!option)
					return chain(
						false,
						`the option ${JSON.stringify(token)} of \`${word}\`, which decides where that ` +
							'wrapper’s own words end and the command it runs begins'
					);
				payloads.push(...option.payloads);
				index = option.next;
				continue;
			}
			if (operands > 0) {
				operands -= 1;
				index += 1;
				continue;
			}
			break;
		}
		// The wrapper's operand is not in this string at all, which is what
		// `spawnSync('env', ['sh', '-c', …])` looks like from here: the command it
		// runs is written in the argument list beside it.
		if (index >= tokens.length) return chain(true, null);
	}
	return chain(false, null);
}

/**
 * How far a `-c` payload may nest before this reading stops following it — and it
 * stops AS A FINDING, which is round 13's second finding and the difference
 * between a boundary and a hole. The cap used to return silently, which is a
 * reading answering "there is nothing further here" to a question it did not ask:
 * six nested `sh -c` layers carried an unpinned repository helper past the closure
 * with this control green, and the site that did it looked exactly like a site
 * whose payload held nothing. A limit a reading cannot cross is one it reports —
 * the repair being the shape a `binds` can be checked against, which is a file and
 * an argument list rather than five shells wrapped around one.
 */
const SHELL_DEPTH = 4;

function siteWords(literals, execPath) {
	const words = [];
	const seen = new Set();
	const unreadable = new Set();
	const inlineCode = new Set();
	const lookup = [];
	const commands = [];
	const add = (text, frame) => {
		const identity = JSON.stringify([frame, text]);
		if (seen.has(identity)) return;
		seen.add(identity);
		words.push({ text, frame });
	};

	/**
	 * A lookup path as the LIST of directories it is, in the order the child
	 * searches them. An EMPTY entry — a leading, trailing or doubled separator — is
	 * the child's own working directory rather than nothing, which is what execvp
	 * makes of it and what round 12 found this discarding.
	 */
	const searchPath = (text, frame) => {
		for (const entry of text.split(/[:;]/))
			lookup.push(entry ? { text: entry, frame } : { text: '.', frame: 'process' });
	};

	/**
	 * Whether a string hands a child's command line to something that READS one: a
	 * shell whose name stands anywhere in it — a wrapper moves where that is, and
	 * cannot move whether it is there — or a wrapper whose operand is written
	 * outside this string, which is the array form of the same site.
	 */
	const namesAShell = (text) =>
		shellSegments(text).some((segment) => shellTokens(segment).some(isShellInterpreter));
	const readsACommandLine = (text) =>
		namesAShell(text) || shellSegments(text).some((segment) => runChain(shellTokens(segment)).open);

	// Every string this site hands a shell or execvp as a command line: argument 0
	// of the facility, whatever a `-c` of a shell carries, and — where the site's
	// argv reaches a shell or a wrapper that runs one — every argument, since that
	// is where the code sits.
	const shell = literals.some((literal) =>
		literal.role === 'command'
			? readsACommandLine(literal.text)
			: literal.role === 'argument' && namesAShell(literal.text)
	);
	const commandLines = [];
	const collect = ({ text, frame }, depth) => {
		commandLines.push({ text, frame });
		// The strings this line hands a child as a command line of its own: what a
		// `-c` carries after a shell's NAME, wherever in the line a wrapper has moved
		// that name to, and the value of a wrapper option that takes a command line
		// as data.
		const payloads = new Set();
		for (const segment of shellSegments(text)) {
			const tokens = shellTokens(segment);
			for (const payload of runChain(tokens).payloads) payloads.add(payload);
			for (const [index, token] of tokens.entries()) {
				if (!isShellInterpreter(token)) continue;
				for (let after = index + 2; after < tokens.length; after += 1)
					if (tokens[after - 1] === '-c') payloads.add(tokens[after]);
			}
		}
		// Where the nesting outruns this reading, what the innermost line runs is
		// decided by a string this walk stopped reading — which is undetermined, and
		// undetermined is reported rather than passed over.
		if (depth >= SHELL_DEPTH) {
			if (payloads.size)
				unreadable.add(
					`a command line nested deeper than ${SHELL_DEPTH} shells, in ${JSON.stringify(text)}`
				);
			return;
		}
		for (const payload of payloads) collect({ text: payload, frame }, depth + 1);
	};
	for (const literal of literals)
		if (literal.role === 'command' || (shell && literal.role === 'argument')) collect(literal, 0);
	const parsesHere = new Set(
		literals.filter(
			(literal) => literal.role === 'command' || (shell && literal.role === 'argument')
		)
	);

	// Whose flags these are. `-e` is inline code to node and something else to
	// `mkdir`, so the refusal below is scoped to the child that reads it that way —
	// including a node reached through a shell, whose name is inside the `-c`.
	const node =
		execPath ||
		commandLines
			.flatMap(({ text }) => shellSegments(text).flatMap(shellTokens))
			.some(isNodeInterpreter);

	const readWord = (text, frame) => {
		add(text, frame);
		for (const piece of text.split('=').slice(1)) if (piece) add(piece, frame);
		if (node && inlineCodeFlags.has(text.split('=')[0])) inlineCode.add(text);
	};

	const readCommandLine = ({ text, frame }) => {
		for (const construct of shellConstructs(text))
			unreadable.add(`${construct}, in ${JSON.stringify(text)}`);
		for (const segment of shellSegments(text)) {
			const tokens = shellTokens(segment);
			// Which words this line RUNS, and which of them are the assignments that
			// stand in front of one — a shell's, and a wrapper's own.
			const { roles, undetermined } = runChain(tokens);
			if (undetermined) unreadable.add(`${undetermined}, in ${JSON.stringify(segment)}`);
			for (const [index, token] of tokens.entries()) {
				if (roles.get(index) === 'assignment') {
					const separator = token.indexOf('=');
					const name = token.slice(0, separator);
					const value = token.slice(separator + 1);
					// A variable set for one command is that command's environment, and
					// the two names this reading watches mean there what they mean in an
					// `env` bag: a list of directories to search, or flags to a child.
					if (LOOKUP_VARIABLES.has(name)) searchPath(value, frame);
					else readWord(value, frame);
					continue;
				}
				// A word a command line runs is one execvp SEARCHES rather than
				// resolves, so it is answered by the lookup path instead of by this
				// site's working directory — but only where it is a bare name.
				// `./helper.mjs` and `sub/helper.mjs` carry a separator and are resolved
				// against the child's directory like any other word.
				if (roles.get(index) === 'run' && !token.includes('/'))
					commands.push({ text: token, frame });
				else readWord(token, frame);
			}
		}
	};

	for (const literal of literals) {
		const { text, frame, role, key } = literal;
		// A lookup path is a LIST of directories, so it is read as one and not as a
		// word: the whole string names no file, and each entry names no file either.
		if (role === 'env' && LOOKUP_VARIABLES.has(key)) {
			searchPath(text, frame);
			continue;
		}
		// A command line that IS one bare word is the word execvp searches for, and
		// nothing else. Adding it as a word too resolved it against this site's own
		// working directory, so a `PATH` naming a directory in this tree put the file
		// that runs in one place while this control reported the same-named file in
		// the other — round 12's third finding, and a decoy either way round.
		const bare = parsesHere.has(literal) && !text.includes('/') && shellTokens(text).length === 1;
		if (!bare) add(text, frame);
		if (parsesHere.has(literal)) continue;
		if (role === 'env' && INHERITED_EXECUTION.has(key))
			for (const construct of shellConstructs(text))
				unreadable.add(`${construct}, in ${JSON.stringify(text)}`);
		for (const segment of shellSegments(text))
			for (const token of shellTokens(segment)) readWord(token, frame);
	}
	for (const line of commandLines) readCommandLine(line);

	return { words, unreadable, inlineCode, lookup, commands };
}

/**
 * The repository files a disclosed site is WRITTEN to run: each word at the call,
 * resolved in the bases that site names, keeping the ones that name a file inside
 * this tree — and, separately, the ones whose file cannot be determined at all.
 *
 * THE BASE IS PART OF THE SITE, which is round 10 and the third arrival of round
 * 7's lesson. This used to ask two fixed bases: the repository root, because a
 * `spawn` argument is resolved by the child against its working directory and for
 * a guarded command that is the root; and the file, because a path a file computes
 * for itself is written in its own frame — `new URL('../gov-infra/verifiers/x.mjs',
 * import.meta.url)`, `join(__dirname, 'lib/helper.mjs')`. An explicit `cwd` moves
 * the first of those, and nothing here read it: `spawnSync(node,
 * ['scripts/lib/helper.mjs'], { cwd: 'sub' })` ran `sub/scripts/lib/helper.mjs`
 * while its disclosure bound the root-spelled `scripts/lib/helper.mjs` — a real
 * file, pinned, hashed, and never executed — and rewriting the actual child changed
 * the run's output with this control green. A pin on a file that does not run is
 * round 7's decoy; the resolver was fixed then, the contract was held to the site
 * in round 9, and this is the same defect in the third of the three places a path
 * gets decided. `siteBase` in the shared reader answers which directory the site
 * writes, in which frame; the FILE frame is unmoved by any `cwd`, because the
 * parent computes it before the child exists.
 *
 * A LOOKUP ROOT IS A BASE, AND IT IS THE ONE THE SITE NAMES. This used to take
 * every word that happened to name a directory in this tree as a base the site's
 * other words could be resolved in — over-inclusive on purpose, and wrong in both
 * directions at once. `{ env: { PATH: 'scripts/lib:/usr/bin' } }` names no
 * directory as one word, so the bare command beside it ran a repository file with
 * this control green; `{ env: { LABEL_DIR: 'scripts/lib', LABEL_FILE: 'helper.mjs' } }`
 * beside `/usr/bin/true` names no lookup path at all, and the same rule reported
 * the site as running a file the child never opens. A directory-valued string is
 * not a base. A variable a child SEARCHES is, and it has a name: `PATH` is split
 * into its entries, each in its literal's own frame, and a bare command word is
 * answered through those and nothing else — which is also what execvp does.
 *
 * AND IT IS SEARCHED IN ORDER, which is round 12 and the half of execvp the
 * sentence above left out. The child runs the FIRST entry that holds the name and
 * never looks at the rest; this asked every entry and collected every match, so a
 * lookup path whose earlier entry is a directory this walk cannot see into — an
 * absolute one, or one in a frame with no value — let a LATER repository file be
 * bound for an executable the child reaches first somewhere else. A pin on a file
 * that does not run is round 7's decoy however it is arrived at, so the search stops
 * at the first entry that answers, and an entry this reading cannot open ends it as
 * undetermined rather than being stepped over. An EMPTY entry is not nothing either:
 * a leading, trailing or doubled separator is the child's own working directory, and
 * dropping it hid the one place a bare command IS answered by the site's own
 * directory.
 *
 * A WORD IS RESOLVED IN ITS OWN FRAME AND IN NO OTHER, which is round 11 and the
 * hole round 10's fix left open. Both frames were asked of every word, so a word
 * only ONE of them could name was answered by the other — and `const where = 'sub';
 * spawnSync(node, ['helper.mjs'], { cwd: where })` is exactly that shape. The base
 * is correctly reported unreadable; the raw child argument `'helper.mjs'` was then
 * resolved against the GATE FILE's directory, found `scripts/helper.mjs` beside it,
 * and a disclosure bound that pinned file while Node ran the unpinned
 * `sub/helper.mjs`. An unreadable base has to be fail-closed, and it stops being so
 * the moment a second base answers in its place. So the reading reports the frame
 * each word is written in (`siteWords` there) and each is resolved in that frame
 * alone: a word the file computes for itself in the file's directory, a word handed
 * to the child in the child's working directory, and a word written against a base
 * this reading cannot name in neither.
 *
 * WHAT IS NOT DETERMINED IS REPORTED, NOT GUESSED. Where a word's frame has no
 * value — the `cwd` is a variable, a call, an options bag this reading cannot open,
 * or the word sits inside a `join(<unreadable>, …)` — a word that names a repository
 * file under the root MIGHT be that file or might be another one in a directory
 * computed at run time. Answering the first is the guess that produced the decoy,
 * and answering nothing silently drops a target this control demanded a pin for
 * yesterday. So it is returned as undetermined and the caller reports it, with the
 * repair being to spell the `cwd` at the call or to write the path in the file's own
 * frame.
 *
 * A path that leaves the tree is dropped, and so is one under a declared unpinned
 * root — not because either is safe, but because neither is something `binds` may
 * name: the shape check refuses `..` and absolute paths outright, and a `binds`
 * under an unpinned root is refused a few lines below as a binding that pins no
 * bytes. Requiring a declaration to name a path the same file would then reject is
 * a rule with no repair, and a rule with no repair is how a gate gets weakened.
 * Those sites are carried by the disclosure's reason, which is what it is for.
 */
function siteRepositoryTargets(file, literals, base, execPath) {
	const { words, unreadable, inlineCode, lookup, commands } = siteWords(literals, execPath);
	const fileFrame = resolve(root, dirname(file));
	const processFrame =
		base.from === 'file'
			? resolve(fileFrame, base.path)
			: base.from === 'process'
				? resolve(root, base.path)
				: null;

	// The directory each frame stands for. `unknown` stands for none, which is what
	// makes it fail closed.
	const frames = new Map([
		['file', fileFrame],
		['process', processFrame],
		['unknown', null],
	]);

	const repositoryFile = (from, word) => {
		const candidate = repoRelative(resolve(from, word));
		if (candidate.startsWith('..') || underUnpinnedRoot(candidate)) return null;
		return isFile(resolve(root, candidate)) ? candidate : null;
	};

	const runs = new Set();
	for (const word of words) {
		const named = frames.get(word.frame);
		const found = named && repositoryFile(named, word.text);
		if (found) runs.add(found);
	}

	// The search itself, entry by entry, IN THE ORDER THE CHILD WALKS THEM — which
	// is round 12's third finding and the same decoy from the other end. execvp runs
	// the FIRST entry that holds the name and never looks at the rest, and this used
	// to collect a match from every entry at once: with an earlier directory this
	// walk cannot see into, it bound a later repository file that the child never
	// reaches, and exited 0 with the file that really runs unpinned. So an entry
	// this reading cannot place — a frame with no directory, or a path outside this
	// tree — ends the search as UNDETERMINED rather than being skipped over, because
	// what it holds decides everything after it. A site that writes no lookup path
	// at all leaves the search to the environment it inherits, which is the same
	// answer for the same reason.
	const undeterminedCommands = new Set();
	for (const command of commands) {
		let ran = false;
		let opaque = lookup.length === 0;
		for (const entry of lookup) {
			const named = frames.get(entry.frame);
			if (!named) {
				opaque = true;
				break;
			}
			const candidate = repoRelative(resolve(resolve(named, entry.text), command.text));
			if (candidate.startsWith('..')) {
				opaque = true;
				break;
			}
			if (!isFile(resolve(root, candidate))) continue;
			// The search is over at the first entry that holds the name, whether or
			// not the file it found is one a `binds` may name.
			if (!underUnpinnedRoot(candidate)) runs.add(candidate);
			ran = true;
			break;
		}
		if (!ran && opaque && pathShaped(command.text)) undeterminedCommands.add(command.text);
	}

	// Only for a word whose frame has no directory: a word that names a file under
	// the root this site may or may not be resolving in, and a word shaped like a
	// path that names no file under it — which is what a path under a run-time
	// directory looks like from here. A word with no separator and no extension
	// (`utf8`, `--`, `init`) is not one, and an absolute path is not one either,
	// because no working directory moves it.
	const undetermined = new Set();
	for (const word of words) {
		if (frames.get(word.frame)) continue;
		const named = repositoryFile(root, word.text);
		if (named && !runs.has(named)) undetermined.add(named);
		else if (!named && pathShaped(word.text)) undetermined.add(word.text);
	}

	return { runs, undetermined, unreadable, inlineCode, undeterminedCommands };
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
		// The same refusal the execution sites carry, at the root of the same walk: a
		// guarded command whose words are decided when it runs is a command whose
		// `node` targets this closure cannot enumerate. A glob is excepted because it
		// has a better model here — `allowed_globs` names it and `expandGlob` reads it.
		for (const construct of shellConstructs(command))
			if (!construct.startsWith('a glob'))
				findings.push(
					`${CONTRACT}: guarded script "${name}" is written with ${construct}, which this walk does ` +
						'not model; what it runs is decided when it runs, so the targets under it cannot be pinned'
				);
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
				if (GLOB_CHARACTERS.test(token)) {
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
					for (const match of matches) admit(normalizePath(match), `${name} -> ${token}`);
					continue;
				}
				admit(normalizePath(token), name);
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

		for (const {
			expression,
			line,
			kind,
			detail,
			literals,
			base,
			execPath,
			environment,
		} of unfollowable) {
			const declaration = disclosedLoads.take(path, line, expression);
			if (declaration.status === 'declared') {
				// The reading has to still be answering the question this check asks.
				// A release of the shared reader that stopped reporting a site's
				// literals would silently turn every `binds` back into an unchecked
				// claim, and a check that disappears quietly is the shape this whole
				// control exists to refuse — so its absence is a finding, not a default.
				if (
					typeof execPath !== 'boolean' ||
					typeof environment !== 'boolean' ||
					!Array.isArray(literals) ||
					!literals.every(
						(word) =>
							word &&
							typeof word === 'object' &&
							typeof word.text === 'string' &&
							['file', 'process', 'unknown'].includes(word.frame) &&
							['command', 'argument', 'env', 'option'].includes(word.role)
					)
				) {
					findings.push(
						`${path}:${line}: the reading no longer reports the literals ${expression} is written to ` +
							'hand its facility, each with the frame it is written in and the role it is written ' +
							'as, so a `binds` here cannot be checked against its own site; this control cannot ' +
							'tell a bound target from a declared one until that is re-bound'
					);
					continue;
				}
				// The base is the other half of the same reading, and it decides WHICH
				// file a literal names. A release that stopped reporting it would put
				// every literal back in the repository root by default — the guess that
				// pinned a decoy while its site ran something else — and it would do it
				// silently, so its absence is a finding rather than a default.
				if (
					!base ||
					typeof base !== 'object' ||
					!['process', 'file', 'unknown'].includes(base.from) ||
					(base.from !== 'unknown' && typeof base.path !== 'string')
				) {
					findings.push(
						`${path}:${line}: the reading no longer reports the working directory ${expression} is ` +
							'written to run in, so the literals at this site cannot be resolved to the files they ' +
							'name; this control cannot tell a bound target from a decoy until that is re-bound'
					);
					continue;
				}
				const bound = new Set();
				for (const target of declaration.binds) {
					const normalized = normalizePath(target);
					if (underUnpinnedRoot(normalized)) {
						findings.push(
							`${CONTRACT}: the disclosure of ${expression} at ${path}:${line} binds ${target}, which ` +
								'is under a declared unpinned root and so is bound by nothing; a `binds` that pins ' +
								'no bytes reads as coverage and is not'
						);
						continue;
					}
					bound.add(normalized);
					admit(normalized, `${path}:${line}, declared`);
				}

				// A `binds` is a claim about the target the site NAMES, so the two are
				// held to each other in both directions. A repository file the site is
				// written to run and the declaration does not bind is the hole this
				// list exists to close, wearing a declaration; a file the declaration
				// binds and the site is not written to run is a pin pointed away from
				// the thing that runs — round 7's decoy, moved into the contract.
				// Which files those are is decided by the base the site writes, so a
				// target it names in a directory this reading cannot read is neither:
				// it is reported as undetermined rather than resolved by guess.
				const { runs, undetermined, unreadable, inlineCode, undeterminedCommands } =
					siteRepositoryTargets(path, literals, base, execPath);
				for (const command of undeterminedCommands)
					findings.push(
						`${path}:${line}: ${expression} runs the bare command ${JSON.stringify(command)}, which ` +
							'is searched for on a lookup path this reading cannot follow to the file it opens — ' +
							'the site writes none, or an entry ahead of this repository’s own is a directory ' +
							'this walk cannot see into. Which file the child runs is decided by the environment ' +
							'rather than by this repository; spell the path to the file, or write an `env.PATH` ' +
							'whose entries are directories in this tree, the first of them holding what the ' +
							'child is meant to run'
					);
				// An environment this reading cannot open is the same hole as a `cwd` it
				// cannot read, one channel over: a `NODE_OPTIONS` assembled elsewhere
				// loads a repository file into the child, and nothing at this site says
				// so. Reporting the write closes the channel only where the write is
				// legible, and silence about the rest would be permission.
				if (!environment)
					findings.push(
						`${path}:${line}: ${expression} writes its child an environment this reading cannot ` +
							'open, so the execution variables it sets — and the repository files they load ' +
							'before the child reaches its own entry point — are not in this file; write the ' +
							'`env` as an object literal whose watched variables carry literal values'
					);
				for (const construct of unreadable)
					findings.push(
						`${path}:${line}: ${expression} hands a child a string this reading does not model — ` +
							`${construct}; what that builds is decided when it runs, so which file the child opens ` +
							'is not in this file and a `binds` here would pin whichever words this walk could see. ' +
							'Write the child as a file and an argument list of literal paths'
					);
				for (const flag of inlineCode)
					findings.push(
						`${path}:${line}: ${expression} runs inline code in a node child (${flag}); inline code has ` +
							'no file to hash and cannot be pinned — the refusal a guarded package.json script ' +
							'already carries, one level in. Put the code in a repository file and name that file, ' +
							'so the bytes the child runs are bound'
					);
				for (const target of undetermined)
					findings.push(
						`${path}:${line}: ${expression} hands ${JSON.stringify(target)} to a child whose working ` +
							'directory this reading cannot determine, so which file it opens is a guess, and a ' +
							'`binds` here would pin whichever file this walk guessed at; write the cwd as a ' +
							"literal at the call, or write the path in this file's own frame — " +
							'`new URL(…, import.meta.url)` — which no working directory moves'
					);
				for (const target of runs)
					if (!bound.has(target))
						findings.push(
							`${path}:${line}: ${expression} runs ${target}, which its disclosure does not bind; ` +
								'name it in `binds` so the bytes it executes are pinned, or the declaration ' +
								'describes a site other than this one'
						);
				for (const target of bound)
					if (!runs.has(target))
						findings.push(
							`${CONTRACT}: the disclosure of ${expression} at ${path}:${line} binds ${target}, which ` +
								'this site is not written to run; a `binds` is a claim about a target the site ' +
								'names, and a target no reading can see is carried by the reason rather than by a ' +
								'pin nothing can be checked against'
						);
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

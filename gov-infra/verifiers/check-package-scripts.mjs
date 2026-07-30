#!/usr/bin/env node
/**
 * CON-5 — bind the package.json scripts the rubric's exit codes rest on.
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
 * What this is not: a cryptographic binding. An author who edits both the script
 * and the pin still moves the gate. What it buys is that the edit has to happen
 * in gov-infra/planning, in the same diff, where it is the review's subject
 * rather than a line in an application file. The control it composes with is the
 * cross-client adversarial review of the gov-infra diff.
 */
import { readFileSync } from 'node:fs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const findings = [];

function load(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
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

if (findings.length) {
	console.error(findings.join('\n'));
	console.error('');
	console.error('Repair the script, or — if the script legitimately changed — move the pin in');
	console.error(`${CONTRACT} in the same commit, with the reason. Never the pin alone.`);
	process.exit(1);
}

console.log(`${Object.keys(expected).length} guarded package.json scripts match their pins.`);
for (const name of Object.keys(expected).sort()) console.log(`  = ${name}: ${expected[name]}`);
console.log('');
console.log('Every `pnpm run` delegation from a pinned script resolves to another pinned script.');
console.log('PASS here means the rubric is invoking the commands it believes it is invoking.');

#!/usr/bin/env node
/**
 * SEC-6 — the SSR trust-boundary probes, run against a pinned inventory.
 *
 * `node --test a.mjs b.mjs` exits 0 when both files contain no tests at all, and
 * exits 0 just as happily when the invocation quietly lists one file instead of
 * two. Neither the exit code nor the file's existence is coverage. Emptying a
 * probe file is the cheapest way to turn this control green while deleting the
 * thing it proves.
 *
 * So the inventory is pinned in contentus-pinned-repo-contract.json and each
 * file is run on its own — one file per invocation, so the counts attribute
 * unambiguously — with the TAP reporter. A file passes when it reports at least
 * its pinned number of passing test points (TAP's term for the `ok` assertions a
 * run emits) and reports no failed, cancelled, skipped, or todo point. A skipped
 * probe is not a passing probe.
 *
 * The minimums ratchet: they sit at the current counts, rise with new coverage,
 * and are lowered only deliberately, in the pin, with a reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const findings = [];

let contract;
try {
	contract = JSON.parse(readFileSync(CONTRACT, 'utf8'));
} catch (error) {
	console.error(`${CONTRACT} is missing or unparseable: ${error.message}`);
	process.exit(1);
}

const inventory = contract.security_tests?.expected;
if (!Array.isArray(inventory) || inventory.length === 0) {
	console.error(`${CONTRACT}: security_tests.expected must be a non-empty array`);
	console.error('An empty inventory would make SEC-6 assert nothing.');
	process.exit(1);
}

/** Parse node:test's TAP trailer. A counter that is absent is not a zero. */
function tapCounters(output) {
	const counters = {};
	for (const [, name, value] of output.matchAll(
		/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm
	))
		counters[name] = Number(value);
	const plan = output.match(/^1\.\.(\d+)$/m);
	return { ...counters, plan: plan ? Number(plan[1]) : undefined };
}

const summaries = [];
for (const entry of inventory) {
	const file = entry?.file;
	const minimum = entry?.min_test_points;
	if (typeof file !== 'string' || !file) {
		findings.push(`${CONTRACT}: security_tests.expected entry has no "file"`);
		continue;
	}
	if (!Number.isInteger(minimum) || minimum < 1) {
		findings.push(`${CONTRACT}: "${file}" must pin an integer min_test_points >= 1`);
		continue;
	}
	if (!existsSync(file) || !statSync(file).isFile()) {
		findings.push(`${file}: pinned SEC-6 probe is missing`);
		continue;
	}
	if (statSync(file).size === 0) {
		findings.push(`${file}: pinned SEC-6 probe is empty`);
		continue;
	}

	const run = spawnSync(
		process.execPath,
		['--test', '--experimental-strip-types', '--test-reporter=tap', file],
		{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
	);
	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	process.stdout.write(output);
	if (run.error) {
		findings.push(`${file}: could not be run (${run.error.message})`);
		continue;
	}
	if (run.status !== 0) {
		findings.push(`${file}: node --test exited ${run.status}`);
		continue;
	}

	const counters = tapCounters(output);
	if (counters.pass === undefined || counters.fail === undefined) {
		findings.push(
			`${file}: TAP output carried no readable counters; a gate whose output cannot be read has not passed`
		);
		continue;
	}
	for (const name of ['fail', 'cancelled', 'skipped', 'todo']) {
		const value = counters[name] ?? 0;
		if (value !== 0) findings.push(`${file}: ${value} ${name} test point(s); SEC-6 requires none`);
	}
	if (counters.pass < minimum)
		findings.push(
			`${file}: ${counters.pass} passing test point(s), pinned minimum is ${minimum} — ` +
				'a probe was deleted, emptied, or skipped'
		);
	if (counters.plan !== undefined && counters.plan !== counters.tests)
		findings.push(
			`${file}: TAP plan 1..${counters.plan} disagrees with ${counters.tests} reported tests`
		);
	summaries.push(`  = ${file}: ${counters.pass} passing test points (minimum ${minimum})`);
}

if (findings.length) {
	console.error('');
	console.error(findings.join('\n'));
	console.error('');
	console.error('Repair the coverage. Lowering a minimum in');
	console.error(`${CONTRACT} retires a probe, and that is a governance change with a reason.`);
	process.exit(1);
}

console.log('');
console.log(`SEC-6 inventory complete: ${summaries.length} pinned probe file(s), all passing.`);
for (const line of summaries) console.log(line);

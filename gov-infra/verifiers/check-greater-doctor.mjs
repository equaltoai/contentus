#!/usr/bin/env node
/**
 * SEC-7 — vendored greater-components integrity via the pinned `greater` CLI.
 *
 * Two properties are asserted PASS unconditionally, because they are the
 * integrity properties the gate exists for:
 *
 *   - Component Files — every vendored file the manifest records is present
 *   - Orphaned Files  — nothing extra is sitting under the vendored root
 *
 * Everything the doctor reports as non-passing must then match the pinned
 * disclosed set exactly. The blog face requires a Markdown chain contentus
 * declines by design (equaltoai/greater-components#917); declining is what keeps
 * lesser the single canonical renderer, so the finding is disclosed rather than
 * silenced — and installing the chain to make a checker happy is the one repair
 * that is never correct here.
 *
 * The CLI is not published to the npm registry. When it cannot be resolved this
 * exits 3 (BLOCKED), never 0. A gate that cannot run has not passed.
 *
 * Usage: check-greater-doctor.mjs <doctor-json-file>
 */
import { readFileSync } from 'node:fs';

const PIN = 'gov-infra/planning/contentus-disclosed-upstream-findings.json';

function fail(lines) {
	console.error(lines.join('\n'));
	process.exit(1);
}

const [doctorFile] = process.argv.slice(2);
if (!doctorFile) fail(['Usage: check-greater-doctor.mjs <doctor-json-file>']);

const raw = readFileSync(doctorFile, 'utf8');
// The CLI prints a progress line before the JSON document.
const start = raw.indexOf('{');
let doctor;
try {
	if (start < 0) throw new Error('no JSON document found in output');
	doctor = JSON.parse(raw.slice(start));
} catch (error) {
	fail([
		`Could not parse \`greater doctor --json\` output at ${doctorFile}: ${error.message}`,
		'A gate whose output cannot be read is not a gate that passed.',
	]);
}

const pin = JSON.parse(readFileSync(PIN, 'utf8')).greater_doctor ?? {};
const results = doctor.results ?? [];
const byName = new Map(results.map((result) => [result.name, result]));
const findings = [];

// 1. The non-negotiable integrity properties.
for (const name of pin.must_pass ?? []) {
	const result = byName.get(name);
	if (!result) findings.push(`integrity check "${name}" is absent from the doctor report`);
	else if (!result.passed) findings.push(`integrity check "${name}" FAILED: ${result.message}`);
}

// 2. The non-passing set must be exactly what is disclosed.
const disclosedErrors = new Set((pin.disclosed_failures ?? []).map((entry) => entry.name));
const disclosedWarnings = new Set(
	(pin.disclosed_warnings ?? []).flatMap((entry) => entry.names ?? [])
);
const disclosed = new Set([...disclosedErrors, ...disclosedWarnings]);

const failing = results.filter((result) => !result.passed);
for (const result of failing) {
	if (!disclosed.has(result.name))
		findings.push(
			`undisclosed doctor finding: "${result.name}" (${result.severity}) — ${result.message}`
		);
}
for (const name of disclosed) {
	const result = byName.get(name);
	if (!result) findings.push(`disclosed finding "${name}" is absent from the doctor report`);
	else if (result.passed)
		findings.push(
			`disclosed finding "${name}" now PASSES — delete it from the pin; this failure is the retirement path`
		);
}

// 3. The disclosed dependency finding must not have grown or shifted.
for (const entry of pin.disclosed_failures ?? []) {
	const result = byName.get(entry.name);
	if (!result || result.passed) continue;
	if (result.severity !== entry.severity)
		findings.push(
			`disclosed finding "${entry.name}" changed severity: ${entry.severity} -> ${result.severity}`
		);
	if (!entry.missing_dependencies) continue;
	// `fix` carries the complete set; `details` truncates it.
	const actual = String(result.fix ?? '')
		.split(/\s+/)
		.filter((token) => token && token !== 'pnpm' && token !== 'add')
		.sort();
	const expected = [...entry.missing_dependencies].sort();
	const appeared = actual.filter((name) => !expected.includes(name));
	const vanished = expected.filter((name) => !actual.includes(name));
	for (const name of appeared)
		findings.push(`"${entry.name}": undisclosed missing dependency ${name}`);
	for (const name of vanished)
		findings.push(`"${entry.name}": disclosed missing dependency ${name} is no longer reported`);
}

if (findings.length) {
	fail([
		...findings,
		'',
		'Never repair this by installing the declined Markdown chain, by creating empty',
		'alias directories, or by widening the pin. Route the change upstream and update',
		`${PIN} only after examining it.`,
	]);
}

console.log(`greater doctor: ${doctor.passed}/${doctor.totalChecks} checks passed.`);
for (const name of pin.must_pass ?? [])
	console.log(`  PASS ${name} — ${byName.get(name)?.message ?? ''}`);
console.log('');
console.log('Disclosed and unchanged (PASS here means "unchanged", not "clean"):');
for (const entry of pin.disclosed_failures ?? [])
	console.log(`  ${entry.severity.toUpperCase()} ${entry.name} — ${entry.upstream_issue}`);
for (const entry of pin.disclosed_warnings ?? [])
	for (const name of entry.names ?? []) console.log(`  WARNING ${name}`);

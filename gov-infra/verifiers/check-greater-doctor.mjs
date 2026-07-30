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
 * Every disclosed entry is matched as a (name, severity) tuple, warnings included.
 * Name alone is not the disclosure: a check that was disclosed as a warning and now
 * reports as an error is a changed finding, and a gate that pins the exact set has
 * to notice that the set changed shape as well as membership. The pin file itself is
 * schema-validated first — an unreadable pin cannot establish what the gate asserts.
 *
 * The CLI is not published to the npm registry. When it cannot be resolved this
 * exits 3 (BLOCKED), never 0. A gate that cannot run has not passed.
 *
 * Usage: check-greater-doctor.mjs <doctor-json-file>
 */
import { readFileSync } from 'node:fs';
import { loadPin, PIN } from './pin-schema.mjs';

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

const pin = loadPin().greater_doctor;
const results = doctor.results ?? [];
const byName = new Map(results.map((result) => [result.name, result]));
const findings = [];

// 1. The non-negotiable integrity properties.
for (const name of pin.must_pass) {
	const result = byName.get(name);
	if (!result) findings.push(`integrity check "${name}" is absent from the doctor report`);
	else if (!result.passed) findings.push(`integrity check "${name}" FAILED: ${result.message}`);
}

// 2. The non-passing set must be exactly what is disclosed, as (name, severity)
// tuples. A warning that has become an error is a changed finding, not a matched
// one; comparing names alone would let it through as "already disclosed".
const disclosed = new Map();
for (const entry of pin.disclosed_failures) disclosed.set(entry.name, entry.severity);
for (const entry of pin.disclosed_warnings)
	for (const name of entry.names) disclosed.set(name, entry.severity);

const failing = results.filter((result) => !result.passed);
for (const result of failing) {
	if (!disclosed.has(result.name))
		findings.push(
			`undisclosed doctor finding: "${result.name}" (${result.severity}) — ${result.message}`
		);
	else if (disclosed.get(result.name) !== result.severity)
		findings.push(
			`disclosed finding "${result.name}" changed severity: ` +
				`${disclosed.get(result.name)} -> ${result.severity}`
		);
}
for (const name of disclosed.keys()) {
	const result = byName.get(name);
	if (!result) findings.push(`disclosed finding "${name}" is absent from the doctor report`);
	else if (result.passed)
		findings.push(
			`disclosed finding "${name}" now PASSES — delete it from the pin; this failure is the retirement path`
		);
}

// 3. The disclosed dependency finding must not have grown or shifted.
for (const entry of pin.disclosed_failures) {
	const result = byName.get(entry.name);
	if (!result || result.passed) continue;
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
for (const name of pin.must_pass)
	console.log(`  PASS ${name} — ${byName.get(name)?.message ?? ''}`);
console.log('');
console.log('Disclosed and unchanged, matched as (name, severity) tuples');
console.log('(PASS here means "unchanged", not "clean"):');
for (const entry of pin.disclosed_failures)
	console.log(`  ${entry.severity.toUpperCase()} ${entry.name} — ${entry.upstream_issue}`);
for (const entry of pin.disclosed_warnings)
	for (const name of entry.names) console.log(`  ${entry.severity.toUpperCase()} ${name}`);

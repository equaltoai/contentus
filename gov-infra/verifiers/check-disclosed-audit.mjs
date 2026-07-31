#!/usr/bin/env node
/**
 * SEC-2 — dependency audit against a pinned disclosed advisory set.
 *
 * `pnpm audit --audit-level=high --json` runs in full; this compares the
 * high/critical advisories it reports against the exact set pinned in
 * contentus-disclosed-upstream-findings.json. Anything new, anything changed,
 * and anything that quietly disappeared all fail.
 *
 * The audit covers the whole installed graph, not `--prod`. The production
 * dependency set is not the boundary that matters here: dev dependencies execute
 * in CI, where they can read the checkout and the runner's environment, and they
 * are installed by the same lockfile the shipped build resolves from. A dev-only
 * advisory is still disclosed rather than excluded — it enters this pin as its own
 * entry, with its own owner and sunset, exactly like the `ws` entry.
 *
 * This is deliberately not a threshold reduction and not an exclude. The gate
 * still reports every advisory; the assertion is on identity, severity, module,
 * vulnerable range, and dependency path — the fields that would have to change
 * for the risk itself to have changed. Emptying the pin is the only way an
 * advisory leaves, and that requires the upstream fix to have landed.
 *
 * Usage: check-disclosed-audit.mjs <audit-json-file>
 */
import { readFileSync } from 'node:fs';
import { loadPin } from './pin-schema.mjs';

const GATED_SEVERITIES = new Set(['high', 'critical']);

function fail(lines) {
	console.error(lines.join('\n'));
	process.exit(1);
}

const [auditFile] = process.argv.slice(2);
if (!auditFile) fail(['Usage: check-disclosed-audit.mjs <audit-json-file>']);

let audit;
try {
	audit = JSON.parse(readFileSync(auditFile, 'utf8'));
} catch (error) {
	fail([
		`Could not parse audit JSON at ${auditFile}: ${error.message}`,
		'A gate whose output cannot be read is not a gate that passed.',
	]);
}

const pin = loadPin();

/** Identity of an advisory, in the fields that would change if the risk changed. */
function key({ id, severity, module, versions, paths }) {
	return [id, severity, module, versions, [...paths].sort().join(',')].join(' | ');
}

const actual = Object.values(audit.advisories ?? {})
	.filter((advisory) => GATED_SEVERITIES.has(advisory.severity))
	.map((advisory) =>
		key({
			id: advisory.github_advisory_id ?? String(advisory.id),
			severity: advisory.severity,
			module: advisory.module_name,
			versions: advisory.vulnerable_versions,
			paths: (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []),
		})
	);

const expected = (pin.npm_audit?.advisories ?? []).map((advisory) =>
	key({
		id: advisory.id,
		severity: advisory.severity,
		module: advisory.module,
		versions: advisory.vulnerable_versions,
		paths: advisory.paths ?? [],
	})
);

const actualSet = new Set(actual);
const expectedSet = new Set(expected);
const appeared = actual.filter((entry) => !expectedSet.has(entry));
const vanished = expected.filter((entry) => !actualSet.has(entry));

if (appeared.length || vanished.length) {
	const lines = [];
	if (appeared.length) {
		lines.push('Advisories present but NOT disclosed in the pin:');
		for (const entry of appeared) lines.push(`  + ${entry}`);
		lines.push('');
		lines.push('Route this upstream and record it in the pin with an owner and a sunset.');
		lines.push('Do not widen the pin to make this pass without that examination.');
	}
	if (vanished.length) {
		if (appeared.length) lines.push('');
		lines.push('Advisories disclosed in the pin but NOT reported by the audit:');
		for (const entry of vanished) lines.push(`  - ${entry}`);
		lines.push('');
		lines.push('If the upstream fix landed, delete the entry from the pin. That is the');
		lines.push('intended retirement path, and this failure is its forcing function.');
	}
	fail(lines);
}

console.log(`Audit advisory set matches the pinned disclosed set (${expected.length} disclosed).`);
for (const entry of expected) console.log(`  = ${entry}`);
console.log('');
console.log('PASS here means "unchanged", not "clean". Disclosed, unfixed, upstream-owned:');
for (const advisory of pin.npm_audit?.advisories ?? []) {
	const issue = advisory.upstream_issue;
	console.log(`  ${advisory.id} (${advisory.module}) — owner ${advisory.owner}, issue: ${issue}`);
}

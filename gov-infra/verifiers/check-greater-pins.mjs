#!/usr/bin/env node
/**
 * CON-4 — the two greater-components channels must stay in lockstep.
 *
 * Contentus consumes greater through two upstream-sanctioned channels:
 *
 *   1. TARBALL-PIN — compiled sub-packages imported as npm modules, pinned to a
 *      `greater-v<version>` release asset in package.json (and mirrored in the
 *      pnpm overrides block).
 *   2. CLI-COPY — vendored face and shared-module source, recorded in
 *      components.json with `installMode: vendored` and a pinned `ref`.
 *
 * A skew between them is the failure this control exists to catch: vendored
 * source from one release compiled against sub-packages from another produces
 * defects that look like application bugs. Both channels move together, through
 * the `greater` CLI, or not at all.
 */
import { readFileSync } from 'node:fs';

const findings = [];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const RELEASE = /greater-components\/releases\/download\/(greater-v[0-9][^/]*)\//;

const tags = new Map();
function collect(source, specs) {
	for (const [name, spec] of Object.entries(specs ?? {})) {
		if (!name.startsWith('@equaltoai/greater-components')) continue;
		const match = RELEASE.exec(String(spec));
		if (!match) {
			findings.push(`${source}: ${name} is not pinned to a greater release asset (${spec})`);
			continue;
		}
		if (!tags.has(match[1])) tags.set(match[1], []);
		tags.get(match[1]).push(`${source}:${name}`);
	}
}

collect('dependencies', pkg.dependencies);
collect('devDependencies', pkg.devDependencies);
collect('pnpm.overrides', pkg.pnpm?.overrides);

if (tags.size === 0) findings.push('no @equaltoai/greater-components pins found in package.json');
if (tags.size > 1) {
	findings.push(`greater tarball pins are not in lockstep: ${[...tags.keys()].join(', ')}`);
	for (const [tag, holders] of tags) findings.push(`  ${tag}: ${holders.join(', ')}`);
}

let components;
try {
	components = JSON.parse(readFileSync('components.json', 'utf8'));
} catch (error) {
	findings.push(`components.json is missing or unreadable: ${error.message}`);
}

if (components) {
	if (components.installMode !== 'vendored')
		findings.push(
			`components.json installMode must be "vendored" (CLI-copy channel), got ${JSON.stringify(components.installMode)}`
		);
	if (!/^[0-9a-f]{40}$/.test(String(components.ref ?? '')))
		findings.push(
			`components.json ref must be a pinned 40-hex commit, got ${JSON.stringify(components.ref)}`
		);
	const modified = (components.installed ?? []).filter((entry) => entry.modified);
	for (const entry of modified)
		findings.push(`vendored module "${entry.name}" is recorded as hand-modified`);
}

if (findings.length) {
	console.error(findings.join('\n'));
	console.error('');
	console.error('Vendored source is CLI-managed and never hand-edited; pins move together');
	console.error('through a `greater` CLI bump, never one channel at a time.');
	process.exit(1);
}

const [tag] = [...tags.keys()];
console.log(`greater channels in lockstep at ${tag}.`);
console.log(`  TARBALL-PIN: ${tags.get(tag).length} package.json pins`);
console.log(`  CLI-COPY:    components.json installMode=vendored ref=${components.ref}`);
console.log(
	`               ${(components.installed ?? []).length} vendored modules, none modified`
);

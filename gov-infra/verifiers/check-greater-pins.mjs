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
 *
 * "In lockstep with each other" was not enough. The two channels agreeing means
 * nothing if neither is bound to a named release: a 40-hex ref proves only that
 * somebody wrote forty hex characters, and every commit in every repository
 * satisfies that. Both channels are now bound to the release tag and vendoring
 * commit pinned in contentus-pinned-repo-contract.json, and every entry in
 * `installed[]` must carry that same commit — a single re-vendored module from a
 * different ref is exactly the skew this control claims to catch.
 */
import { readStrictJson } from './strict-json.mjs';
import { verifyReleaseBinding } from './release-binding.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const findings = [];
const pkg = readStrictJson('package.json');
const RELEASE = /greater-components\/releases\/download\/(greater-v[0-9][^/]*)\//;

let contract;
try {
	contract = readStrictJson(CONTRACT);
} catch (error) {
	console.error(`${CONTRACT} is missing or unparseable: ${error.message}`);
	process.exit(1);
}
const expected = contract.greater ?? {};
if (typeof expected.release_tag !== 'string' || !expected.release_tag)
	findings.push(`${CONTRACT}: greater.release_tag must be a non-empty string`);
if (!/^[0-9a-f]{40}$/.test(String(expected.vendored_ref ?? '')))
	findings.push(`${CONTRACT}: greater.vendored_ref must be a 40-hex commit`);

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
for (const tag of tags.keys())
	if (tag !== expected.release_tag)
		findings.push(
			`tarball pins resolve to ${tag}, but ${CONTRACT} pins ${expected.release_tag}; ` +
				'a pin bump moves both, in one commit, through the CLI'
		);

let components;
try {
	components = readStrictJson('components.json');
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
	else if (components.ref !== expected.vendored_ref)
		findings.push(
			`components.json ref ${components.ref} is not the vendoring commit pinned for ` +
				`${expected.release_tag} (${expected.vendored_ref}) in ${CONTRACT}`
		);
	const installed = components.installed ?? [];
	if (!installed.length) findings.push('components.json records no installed vendored modules');
	for (const entry of installed)
		if (entry.version !== expected.vendored_ref)
			findings.push(
				`vendored module "${entry.name}" is at ${entry.version}, not the pinned ` +
					`${expected.vendored_ref} — one module re-vendored from another ref is the skew`
			);
	const modified = installed.filter((entry) => entry.modified);
	for (const entry of modified)
		findings.push(`vendored module "${entry.name}" is recorded as hand-modified`);
}

/**
 * CON-4's second half: the vendored BYTES bound to the pinned release.
 *
 * The checks above bind the manifest's own fields to the pin; the release
 * binding (round-1 F4) binds the bytes themselves. Every on-disk vendored file
 * must equal the release's canonical bytes for its source path — or the
 * digest-verified greater CLI's documented import-transform of them — and the
 * recorded checksum must match the same canonical value. A coordinated
 * file+checksum edit, which moves every manifest-field check at once, fails
 * here against the release's own registry manifest (digest-pinned in the
 * contract). See `release-binding.mjs` for the walk.
 */
async function verifyReleaseBindingOrFail(contract) {
	try {
		return await verifyReleaseBinding({ repoRoot: process.cwd(), pin: contract });
	} catch (error) {
		return [
			`release-binding could not run: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

const main = async () => {
	if (findings.length) {
		console.error(findings.join('\n'));
		console.error('');
		console.error('Vendored source is CLI-managed and never hand-edited; pins move together');
		console.error('through a `greater` CLI bump, never one channel at a time.');
		process.exit(1);
	}

	const releaseFindings = await verifyReleaseBindingOrFail(contract);
	if (releaseFindings.length) {
		console.error(releaseFindings.join('\n'));
		console.error('');
		console.error(
			'The vendored tree is not bound to the pinned release: a file or its recorded checksum'
		);
		console.error(
			'does not match the release registry manifest at the pinned commit. Re-vendor through the'
		);
		console.error('`greater` CLI — never repair bytes or checksums by hand.');
		process.exit(1);
	}

	const [tag] = [...tags.keys()];
	console.log(`greater channels in lockstep at ${tag}, bound to the pin in ${CONTRACT}.`);
	console.log(
		`  TARBALL-PIN: ${tags.get(tag).length} package.json pins at ${expected.release_tag}`
	);
	console.log(`  CLI-COPY:    components.json installMode=vendored ref=${components.ref}`);
	console.log(
		`               ${(components.installed ?? []).length} vendored modules, all at the pinned ref, none modified`
	);
};

main().catch((error) => {
	console.error(
		`CON-4 could not complete: ${error instanceof Error ? error.message : String(error)}`
	);
	process.exit(1);
});

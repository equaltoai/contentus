#!/usr/bin/env node
/**
 * SEC-3 (dependency half) — install-time code execution.
 *
 * The hard boundary is ordering, not detection: every `pnpm install` this rubric
 * and this repository's CI performs carries `--ignore-scripts`, so no dependency
 * lifecycle hook runs at any point in the gate. That is the control. Everything
 * below is heuristic screening layered on top of it, and it is written down that
 * way so a green SEC-3 is never read as "we detected that nothing malicious is
 * present". A regex cannot establish that. An install that never executes the
 * hook can.
 *
 * Three things are asserted:
 *
 *   1. The ROOT package.json's own lifecycle hooks. `--ignore-scripts` suppresses
 *      the dependency graph's hooks; the root project's hooks are the repository's
 *      own code and were never scanned at all before. Any root lifecycle hook is
 *      a finding unless it is exactly allowlisted in the pinned contract.
 *   2. pnpm's escape hatches. `--ignore-scripts` does NOT disable `.pnpmfile.cjs`
 *      hooks — they run in-process during resolution — and pnpm 10's
 *      `onlyBuiltDependencies` is an explicit opt-back-in to running lifecycle
 *      scripts for named packages. Both are findings unless disclosed in the pin.
 *   3. Installed dependency hooks, screened for the shapes that show up in real
 *      install-time compromises: piped downloads, out-of-band interpreters
 *      (`node -e`, `sh -c`, `python -c`), process substitution, base64 decoding,
 *      and token exfiltration. This list is not, and cannot be, complete.
 *
 * Usage: check-supply-chain.mjs <newline-delimited-package-json-list-file>
 */
import { existsSync, readFileSync } from 'node:fs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const ALLOWLIST = 'gov-infra/planning/contentus-supply-chain-allowlist.txt';
const LIFECYCLE_HOOKS = [
	'preinstall',
	'install',
	'postinstall',
	'preprepare',
	'prepare',
	'postprepare',
	'prepublish',
	'prepublishOnly',
	'prepack',
	'postpack',
];

/**
 * Screening patterns. Heuristic by construction: each one is a shape seen in
 * published install-time compromises, not a decision procedure. `--ignore-scripts`
 * is what actually holds the line; this is what makes a hook worth looking at.
 */
const SUSPICIOUS = [
	{
		name: 'piped-download',
		pattern: /(?:curl|wget|fetch)\s[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python[23]?)\b/i,
	},
	{
		name: 'node-inline-eval',
		pattern: /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*-{1,2}(?:e|eval|p|print|input-type)\b/i,
	},
	{ name: 'shell-inline-command', pattern: /\b(?:sh|bash|zsh|dash|ksh)\s+(?:-[a-z]*\s+)*-c\b/i },
	{ name: 'python-inline-command', pattern: /\bpython[23]?(?:\.\d+)?\s+(?:-[a-zA-Z]\s+)*-c\b/i },
	{ name: 'process-substitution', pattern: /[<>]\(/ },
	{
		name: 'base64-decode',
		pattern: /base64\s+(?:-{1,2}d|--decode)\b|\batob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"]/i,
	},
	{ name: 'eval-of-fetched-text', pattern: /\beval\s*[("`$]/i },
	{ name: 'exfiltration-target', pattern: /webhook\.site|requestbin|\bnc\s+-\w*e|\/dev\/tcp\//i },
	{ name: 'credential-reference', pattern: /NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET|\.npmrc\b|~\/\.ssh/ },
];

const findings = [];
const notes = [];

function load(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		console.error(`${label} is missing or unparseable: ${error.message}`);
		process.exit(1);
	}
}

const contract = load(CONTRACT, CONTRACT);
const supplyChain = contract.supply_chain ?? {};
const allowedRootHooks = new Set(supplyChain.root_lifecycle_hooks_allowed ?? []);
const disclosedOnlyBuilt = new Set(supplyChain.only_built_dependencies_disclosed ?? []);
const disclosedPnpmfiles = new Set(supplyChain.pnpmfile_disclosed ?? []);

const allowed = new Set(
	existsSync(ALLOWLIST)
		? readFileSync(ALLOWLIST, 'utf8')
				.split(/\r?\n/)
				.filter((line) => line && !line.startsWith('#'))
		: []
);

// --- 1. The root project's own lifecycle hooks -------------------------------
const rootPkg = load('package.json', 'package.json');
for (const hook of LIFECYCLE_HOOKS) {
	const script = rootPkg.scripts?.[hook];
	if (typeof script !== 'string' || !script) continue;
	if (allowedRootHooks.has(hook)) {
		notes.push(`root lifecycle hook "${hook}" is allowlisted in ${CONTRACT}`);
		continue;
	}
	findings.push(
		`GOV-SUPPLY:ROOT:HOOK:hook=${hook} — the repository declares its own install-time ` +
			`script (${script}). Root hooks are not covered by --ignore-scripts on a plain ` +
			`\`pnpm install\` by every consumer; allowlist it in ${CONTRACT} or remove it.`
	);
}

// --- 2. pnpm's own script-execution escape hatches ---------------------------
// `--ignore-scripts` does not reach either of these.
const onlyBuilt = rootPkg.pnpm?.onlyBuiltDependencies;
if (Array.isArray(onlyBuilt) && onlyBuilt.length) {
	for (const name of onlyBuilt) {
		if (disclosedOnlyBuilt.has(name)) {
			notes.push(`pnpm.onlyBuiltDependencies["${name}"] is disclosed in ${CONTRACT}`);
			continue;
		}
		findings.push(
			`GOV-SUPPLY:PNPM:ONLY_BUILT:pkg=${name} — pnpm.onlyBuiltDependencies re-enables ` +
				`lifecycle scripts for this package despite --ignore-scripts. Disclose it in ` +
				`${CONTRACT} with a reason, or remove it.`
		);
	}
} else if (onlyBuilt !== undefined && !Array.isArray(onlyBuilt)) {
	findings.push(
		`GOV-SUPPLY:PNPM:ONLY_BUILT:shape — pnpm.onlyBuiltDependencies is ${JSON.stringify(onlyBuilt)}, ` +
			'which this control cannot read; fail closed rather than guess.'
	);
}
if (rootPkg.pnpm?.neverBuiltDependencies !== undefined)
	notes.push('pnpm.neverBuiltDependencies is present (it only narrows execution; not a finding).');

for (const pnpmfile of ['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.mjs']) {
	if (!existsSync(pnpmfile)) continue;
	if (disclosedPnpmfiles.has(pnpmfile)) {
		notes.push(`${pnpmfile} is disclosed in ${CONTRACT}`);
		continue;
	}
	findings.push(
		`GOV-SUPPLY:PNPM:PNPMFILE:file=${pnpmfile} — pnpm hook files execute during ` +
			'resolution and are NOT suppressed by --ignore-scripts. Disclose it in ' +
			`${CONTRACT} with a reason, or remove it.`
	);
}

// --- 3. Installed dependency lifecycle hooks --------------------------------
const [listFile] = process.argv.slice(2);
if (!listFile) {
	console.error('Usage: check-supply-chain.mjs <package-json-list-file>');
	process.exit(2);
}

let scanned = 0;
let withHooks = 0;
for (const path of readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		// Fixture and template package.json files inside published packages are
		// routinely not valid JSON. They declare no hooks pnpm would run.
		continue;
	}
	scanned += 1;
	for (const hook of LIFECYCLE_HOOKS) {
		const script = pkg.scripts?.[hook];
		if (typeof script !== 'string' || !script) continue;
		withHooks += 1;
		for (const { name, pattern } of SUSPICIOUS) {
			if (!pattern.test(script)) continue;
			const id =
				`GOV-SUPPLY:NODE:SCRIPT:pkg=${pkg.name || path}:ver=${pkg.version || ''}` +
				`:hook=${hook}:shape=${name}`;
			if (!allowed.has(id)) findings.push(`${id}\n    ${script}`);
		}
	}
}

if (findings.length) {
	console.error(findings.join('\n'));
	console.error('');
	console.error('Route the package upstream or drop it. Adding an ID to');
	console.error(`${ALLOWLIST} without examining the hook is how this control stops working.`);
	process.exit(1);
}

console.log(`Root package.json declares no un-allowlisted lifecycle hook.`);
console.log('pnpm.onlyBuiltDependencies is absent or fully disclosed; no undisclosed pnpmfile.');
console.log(
	`Scanned ${scanned} installed package manifests; ${withHooks} declare a lifecycle hook.`
);
for (const note of notes) console.log(`  note: ${note}`);
console.log('');
console.log('Screening is heuristic and is not the control. The control is that every install');
console.log('in this rubric and in CI runs with --ignore-scripts, so none of these hooks execute.');

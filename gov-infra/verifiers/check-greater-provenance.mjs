#!/usr/bin/env node
/**
 * SEC-7 — the provenance of the CLI that produces the evidence, and the execution
 * of that CLI.
 *
 * `greater --version` is the tool describing itself. Any executable that prints
 * `0.11.9` satisfies a version comparison, and one that also emits a plausible
 * `doctor --json` document satisfies the whole control while auditing nothing.
 * That is not a subtle gap: it is the ordinary shape of a PATH shadow.
 *
 * Pinning the release asset's SHA-256 closed the *download*, and for one round
 * that was mistaken for closing the control. It was not. The gate verified the
 * retained tarball and then executed `gov-infra/.tools/node_modules/.bin/greater`
 * — a tree produced by `install-greater-cli.mjs`, which is an ordinary repository
 * file that the pull request under review can edit. A few appended lines that
 * overwrite the installed entry point after the digest check leave the contract,
 * the workflow, and the tarball all untouched, and SEC-7 then reports on output
 * from a stand-in. Verifying one artifact and running a different one binds
 * nothing.
 *
 * So the pinned tarball digest is now the sole root of trust, and the executed
 * code is derived from it here, at gate time:
 *
 *   1. the retained tarball is re-verified against the digest pinned in the repo
 *      contract — on the bytes on disk, independent of how they got there;
 *   2. every archive member is validated (regular files and directories only,
 *      plain relative paths only, no duplicates) and the entry point the package
 *      manifest names is asserted to be present before anything is written;
 *   3. the archive is extracted into a fresh quarantine directory that this
 *      process creates and removes, and every extracted file's digest is compared
 *      against the archive member it came from;
 *   4. `--version` and `doctor --json` run from THAT tree. The repo-local
 *      `gov-infra/.tools` install is never executed and its absence is not
 *      checked: it is setup convenience for local development and a way to warm
 *      the download, not a source of evidence.
 *
 * Unverifiable provenance is BLOCKED, never PASS: an unverifiable tool is a
 * control that could not run. A digest, a member, or a version that resolves and
 * disagrees is a FAIL, because the gate ran.
 *
 * The residual limit, recorded rather than papered over: the CLI's own runtime
 * dependencies are resolved by `npm` from the registry against the ranges declared
 * inside the verified tarball. They are not repository artifacts and no pull
 * request to this repository can substitute them, but they are third-party code
 * reached at gate time, and that is the ordinary registry trust boundary rather
 * than something this control establishes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readStrictJson } from './strict-json.mjs';
import { digestOf, extractEntries, readTarEntries, walkRegularFiles } from './verified-tarball.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const TOOLS = 'gov-infra/.tools';
const TARBALL = `${TOOLS}/greater-components-cli.tgz`;
const DOCTOR_CHECKER = 'gov-infra/verifiers/check-greater-doctor.mjs';
const MEMBER_PREFIX = 'package/';
const BLOCKED_RC = 3;

let quarantine = null;
const cleanup = () => {
	if (!quarantine) return;
	const directory = quarantine;
	quarantine = null;
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// A quarantine that outlives the run is untidy, never unsound: nothing
		// consults it again, and the next run makes its own.
	}
};
process.on('exit', cleanup);

const blocked = (message) => {
	console.log(`GOV-BLOCKED: ${message}`);
	console.log('The greater CLI is not published to the npm registry. Fetch the pinned,');
	console.log('digest-verified release asset with the repository-local installer:');
	console.log('  node gov-infra/verifiers/install-greater-cli.mjs');
	console.log('CI runs exactly that step. SEC-7 consumes the tarball it leaves behind and');
	console.log('extracts its own copy; it never executes the tree that installer produces,');
	console.log('and a PATH `greater` is not accepted at all — provenance by self-report is');
	console.log('not provenance. BLOCKED is not green: this report will not pass.');
	process.exit(BLOCKED_RC);
};

const failed = (lines) => {
	for (const line of lines) console.error(line);
	console.error('This is a FAIL, not BLOCKED: the gate ran and the artifact disagreed.');
	process.exit(1);
};

let contract;
try {
	contract = readStrictJson(CONTRACT);
} catch (error) {
	console.error(`${CONTRACT} is missing or unparseable: ${error.message}`);
	process.exit(1);
}

const asset = contract.greater?.cli_asset;
if (typeof asset?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
	console.error(`${CONTRACT}: greater.cli_asset.sha256 must be a 64-hex digest`);
	console.error('Without a pinned digest there is no provenance for SEC-7 to verify.');
	process.exit(1);
}
const pinnedVersion = contract.greater?.cli_version;
if (typeof pinnedVersion !== 'string' || pinnedVersion === '') {
	console.error(`${CONTRACT}: greater.cli_version is not pinned`);
	console.error('A CLI at an unpinned version audits the vendored tree against no manifest.');
	process.exit(1);
}

if (!existsSync(TARBALL))
	blocked(`${TARBALL} is absent, so SEC-7 has no verified archive to execute from`);

const archive = readFileSync(TARBALL);
const actual = digestOf(archive);
if (actual !== asset.sha256)
	failed([
		`${TARBALL} does not match the pinned release asset digest.`,
		`  pinned: ${asset.sha256}`,
		`  actual: ${actual}`,
	]);

console.log(`greater CLI release asset: ${asset.url}`);
console.log(`  SHA-256 ${actual} verified against ${CONTRACT} at gate time.`);

// --- Members ------------------------------------------------------------------
let entries;
try {
	entries = readTarEntries(archive);
} catch (error) {
	failed([
		`${TARBALL} matches the pinned digest but is not an archive this gate will unpack:`,
		`  ${error.message}`,
	]);
}

const files = entries.filter((entry) => entry.kind === 'file');
const byName = new Map(files.map((entry) => [entry.name, entry]));
const outside = entries.filter((entry) => !entry.name.startsWith(MEMBER_PREFIX));
if (outside.length)
	failed([
		`${TARBALL} contains members outside \`${MEMBER_PREFIX}\`, which an npm pack tarball does not:`,
		...outside.slice(0, 5).map((entry) => `  ${entry.name}`),
	]);

const manifestMember = byName.get(`${MEMBER_PREFIX}package.json`);
if (!manifestMember) failed([`${TARBALL} has no ${MEMBER_PREFIX}package.json member`]);
let manifest;
try {
	manifest = JSON.parse(manifestMember.data.toString('utf8'));
} catch (error) {
	failed([`${MEMBER_PREFIX}package.json inside ${TARBALL} is unparseable: ${error.message}`]);
}

const binField = manifest.bin;
const binPath = typeof binField === 'string' ? binField : binField?.greater;
if (typeof binPath !== 'string' || binPath === '')
	failed([
		`${MEMBER_PREFIX}package.json declares no \`greater\` bin entry, so there is no`,
		'executable this gate can bind to the verified archive.',
	]);
const binRelative = binPath.replace(/^\.\//, '');
if (binRelative.startsWith('/') || binRelative.split('/').some((part) => part === '..'))
	failed([`${MEMBER_PREFIX}package.json declares an unsafe bin path: ${binPath}`]);

const binMember = byName.get(`${MEMBER_PREFIX}${binRelative}`);
if (!binMember)
	failed([
		`${MEMBER_PREFIX}package.json names \`${binPath}\` as its entry point, but`,
		`${TARBALL} contains no such member. The archive cannot supply the executable it`,
		'claims, so nothing here is safe to run.',
	]);
const binDigest = digestOf(binMember.data);
console.log(
	`  ${files.length} archive members validated; entry point ${MEMBER_PREFIX}${binRelative}`
);
console.log(`  entry-point SHA-256 ${binDigest} (from the verified archive)`);

// --- Quarantined extraction ---------------------------------------------------
try {
	quarantine = mkdtempSync(join(tmpdir(), 'contentus-sec7-'));
} catch (error) {
	blocked(`a quarantine directory could not be created (${error.message})`);
}
const cliDirectory = join(quarantine, 'cli');

let written;
try {
	written = extractEntries(entries, cliDirectory, MEMBER_PREFIX);
} catch (error) {
	failed([`${TARBALL} could not be extracted into the quarantine: ${error.message}`]);
}

// The extraction is the binding, and this is the assertion that it held: every
// file on disk is byte-identical to the archive member it came from, and no file
// exists that no member produced.
const expected = new Map(written.map((entry) => [entry.path, entry.sha256]));
let present;
try {
	present = walkRegularFiles(cliDirectory);
} catch (error) {
	failed([`the quarantined extraction is not a plain file tree: ${error.message}`]);
}
const mismatches = [];
for (const path of present) {
	const want = expected.get(path);
	if (!want) {
		mismatches.push(`  ${path}: present in the quarantine but written by no archive member`);
		continue;
	}
	const got = digestOf(readFileSync(join(cliDirectory, path)));
	if (got !== want) mismatches.push(`  ${path}: extracted ${got}, archive member ${want}`);
}
for (const path of expected.keys())
	if (!present.includes(path)) mismatches.push(`  ${path}: archive member did not reach the disk`);
if (mismatches.length)
	failed(['the quarantined extraction does not match the verified archive:', ...mismatches]);

const binary = join(cliDirectory, binRelative);
const extractedBinDigest = digestOf(readFileSync(binary));
if (extractedBinDigest !== binDigest)
	failed([
		'the extracted entry point does not match its archive member.',
		`  archive member: ${binDigest}`,
		`  extracted:      ${extractedBinDigest}`,
	]);
console.log(`  extracted ${present.length} files into a quarantine and re-verified every digest.`);

// --- Runtime dependencies -----------------------------------------------------
// The archive carries the CLI, not its dependency graph. They are installed here,
// from the ranges declared inside the verified archive, with lifecycle scripts
// disabled as everywhere else in this rubric. Nothing in this repository takes
// part: `gov-infra/.tools` is neither read nor executed.
const install = spawnSync(
	'npm',
	[
		'install',
		'--ignore-scripts',
		'--omit=dev',
		'--no-save',
		'--no-package-lock',
		'--no-audit',
		'--no-fund',
		'--prefer-offline',
	],
	{ cwd: cliDirectory, encoding: 'utf8' }
);
if (install.error)
	blocked(`npm could not run to build the quarantined CLI (${install.error.message})`);
if (install.status !== 0) {
	console.log((install.stdout ?? '').trim());
	console.log((install.stderr ?? '').trim());
	blocked(`the quarantined CLI could not be built (npm exited ${install.status})`);
}

const afterInstall = digestOf(readFileSync(binary));
if (afterInstall !== binDigest)
	failed([
		'the quarantined entry point changed while its dependencies were installed.',
		`  archive member: ${binDigest}`,
		`  on disk now:    ${afterInstall}`,
	]);
console.log('  runtime dependencies installed into the quarantine with --ignore-scripts.');

// --- Execution ----------------------------------------------------------------
const runCli = (args) =>
	spawnSync(process.execPath, [binary, ...args], {
		cwd: process.cwd(),
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});

const version = runCli(['--version']);
if (version.error) blocked(`the quarantined CLI could not be executed (${version.error.message})`);
const reported = (version.stdout ?? '').trim().replace(/\s+/g, '');
console.log(`  version=${reported || 'unavailable'}, pinned ${pinnedVersion}`);
if (reported !== pinnedVersion)
	failed([
		`greater CLI version mismatch: the archive-derived CLI reports '${reported || 'none'}', ` +
			`pin requires '${pinnedVersion}'.`,
		'A CLI at another version audits the vendored tree against the wrong manifest.',
	]);

const doctor = runCli(['doctor', '--json']);
if (doctor.error) blocked(`the quarantined CLI could not be executed (${doctor.error.message})`);
const doctorFile = join(quarantine, 'doctor.json');
writeFileSync(doctorFile, doctor.stdout ?? '');

const verdict = spawnSync(process.execPath, [DOCTOR_CHECKER, doctorFile], {
	cwd: process.cwd(),
	stdio: 'inherit',
});
if (verdict.error) {
	console.error(`${DOCTOR_CHECKER} could not run: ${verdict.error.message}`);
	process.exit(1);
}
process.exit(verdict.status ?? 1);

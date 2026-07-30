#!/usr/bin/env node
/**
 * SEC-7, first half — the provenance of the CLI that produces the evidence.
 *
 * `greater --version` is the tool describing itself. Any executable that prints
 * `0.11.9` satisfies a version comparison, and one that also emits a plausible
 * `doctor --json` document satisfies the whole control while auditing nothing.
 * That is not a subtle gap: it is the ordinary shape of a PATH shadow, and the
 * previous form of this control accepted it as evidence.
 *
 * So SEC-7 no longer asks the CLI who it is. It requires the repo-local install,
 * and it re-verifies the release asset that install came from against the SHA-256
 * pinned in the repo contract — at gate time, on the bytes on disk, independent of
 * whether the install script ran honestly. Anything else is BLOCKED, never PASS:
 * an unverifiable tool is a control that could not run.
 *
 * The residual limit, recorded rather than papered over: this binds the tarball,
 * not the unpacked tree. Someone with write access to the runner between install
 * and gate could replace the unpacked binary while leaving the verified tarball in
 * place. That is a compromised runner, not a pull-request-reachable bypass, and it
 * is outside what a repository-side control can establish.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { readStrictJson } from './strict-json.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const TOOLS = 'gov-infra/.tools';
const TARBALL = `${TOOLS}/greater-components-cli.tgz`;
const BINARY = `${TOOLS}/node_modules/.bin/greater`;
const BLOCKED_RC = 3;

const blocked = (message) => {
	console.log(`GOV-BLOCKED: ${message}`);
	console.log('The greater CLI is not published to the npm registry. Install the pinned,');
	console.log('digest-verified release asset with the repository-local installer:');
	console.log('  node gov-infra/verifiers/install-greater-cli.mjs');
	console.log('CI runs exactly that step. A PATH `greater` is deliberately not accepted:');
	console.log('its provenance is whatever it says about itself, which is not evidence.');
	console.log('BLOCKED is not green: this report will not pass.');
	process.exit(BLOCKED_RC);
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

if (!existsSync(BINARY))
	blocked('repo-local pinned greater CLI is not installed; SEC-7 could not run');
if (!existsSync(TARBALL))
	blocked(`${TARBALL} is absent, so the installed CLI has no verifiable provenance`);

const actual = createHash('sha256').update(readFileSync(TARBALL)).digest('hex');
if (actual !== asset.sha256) {
	console.error(`${TARBALL} does not match the pinned release asset digest.`);
	console.error(`  pinned: ${asset.sha256}`);
	console.error(`  actual: ${actual}`);
	console.error('This is a FAIL, not BLOCKED: the gate ran and the artifact disagreed.');
	process.exit(1);
}

console.log(`greater CLI: ${BINARY} (repo-local pinned install)`);
console.log(`  release asset: ${asset.url}`);
console.log(`  SHA-256 ${actual} verified against ${CONTRACT} at gate time.`);

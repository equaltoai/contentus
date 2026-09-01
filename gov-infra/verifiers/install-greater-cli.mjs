#!/usr/bin/env node
/**
 * Fetch the pinned `greater` CLI release asset, digest first, and install it for
 * local use.
 *
 * The CLI is not published to the npm registry; it ships as a GitHub release
 * asset, which means the fetch is a plain download and nothing about the bytes
 * that arrive is checked by a package manager. So the asset URL and its SHA-256
 * are pinned in the repo contract, the download is verified against that digest
 * before anything unpacks it, and the tarball is left on disk. A mismatch deletes
 * the download and fails: a tarball that is not the pinned one is not a version to
 * reason about, it is a different artifact.
 *
 * **SEC-7 does not trust this script, and does not run what it installs.** This
 * file is an ordinary repository file: the pull request being gated can edit it,
 * and a few appended lines that overwrite the installed entry point after the
 * digest check would leave the contract, the workflow and the tarball all
 * untouched. A gate that verified one artifact and executed another would be
 * binding nothing. `check-greater-provenance.mjs` therefore re-verifies the
 * tarball, extracts its own copy into a quarantine, and runs that — every time.
 *
 * What this script is for, then, is two things that are not evidence: leaving the
 * digest-verified tarball where the gate can find it (in CI, that is its whole
 * job, and MAI-4 binds the step so it cannot be dropped to soften SEC-7 into
 * BLOCKED), and giving local development a `greater` on hand. The tree under
 * `gov-infra/.tools/node_modules` is convenience, not provenance.
 *
 * `--ignore-scripts` is passed here for the same reason it is passed everywhere
 * else in this repository: no install anywhere runs lifecycle code.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readStrictJson } from './strict-json.mjs';
import { CLI_ASSET_NAME, cliAssetUrl } from './authenticate-release-index.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const TOOLS = 'gov-infra/.tools';
const TARBALL = `${TOOLS}/greater-components-cli.tgz`;

const contract = readStrictJson(CONTRACT);
const asset = contract.greater?.cli_asset;
// R5-2: the fetch URL is DERIVED from the canonical release facts, never read
// out of the child contract — the contract's `url` field is a comparison
// subject, so a coordinated counterfeit that repoints it fails here instead
// of downloading from the repointed source.
if (asset?.url !== cliAssetUrl()) {
	console.error(
		`${CONTRACT}: greater.cli_asset.url differs from the canonical release asset URL ` +
			`(${cliAssetUrl()}); the fetch is derived from the release identity, not the contract`
	);
	process.exit(1);
}
if (typeof asset?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
	console.error(`${CONTRACT}: greater.cli_asset.sha256 must be a 64-hex digest`);
	process.exit(1);
}

const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

mkdirSync(TOOLS, { recursive: true });

if (existsSync(TARBALL) && digestOf(TARBALL) === asset.sha256) {
	console.log(`greater CLI asset already present and matching the pin: ${TARBALL}`);
} else {
	console.log(`Downloading ${cliAssetUrl()}`);
	const response = await fetch(cliAssetUrl(), {
		redirect: 'follow',
		signal: AbortSignal.timeout(30_000),
		headers: {
			Accept: 'application/octet-stream',
			'User-Agent': 'equaltoai-contentus-release-verifier',
		},
	});
	if (!response.ok) {
		console.error(`download failed: HTTP ${response.status} ${response.statusText}`);
		process.exit(1);
	}
	const body = Buffer.from(await response.arrayBuffer());
	// Bounded size before anything is written: the real asset is ~230 KiB.
	if (body.length === 0 || body.length > 50 * 1024 * 1024) {
		console.error(`download is ${body.length} bytes — outside the bounded asset size; discarded`);
		process.exit(1);
	}
	writeFileSync(TARBALL, body);
	const actual = digestOf(TARBALL);
	if (actual !== asset.sha256) {
		rmSync(TARBALL, { force: true });
		console.error('greater CLI asset digest does not match the pin — download discarded.');
		console.error(`  pinned: ${asset.sha256}`);
		console.error(`  actual: ${actual}`);
		console.error(
			'Move the pin in ' +
				`${CONTRACT} only for a release you verified upstream; the pin is child-governed, and the ` +
				'canonical authenticator anchors the asset to GitHub release metadata'
		);
		process.exit(1);
	}
	console.log(`Verified SHA-256 ${actual} against ${CONTRACT}.`);
}

const install = spawnSync(
	'npm',
	['install', '--no-save', '--ignore-scripts', '--prefix', TOOLS, resolve(TARBALL)],
	{ stdio: 'inherit' }
);
if (install.error) {
	console.error(`npm install could not run: ${install.error.message}`);
	process.exit(1);
}
if (install.status !== 0) process.exit(install.status ?? 1);

const binary = `${TOOLS}/node_modules/.bin/greater`;
if (!existsSync(binary)) {
	console.error(`install completed but ${binary} is absent`);
	process.exit(1);
}
console.log(`Installed the pinned greater CLI to ${binary} from the digest-verified asset.`);
console.log(`The gate does not execute this tree: SEC-7 re-verifies ${TARBALL} and extracts`);
console.log('its own quarantined copy. What CI needs from this step is that tarball.');

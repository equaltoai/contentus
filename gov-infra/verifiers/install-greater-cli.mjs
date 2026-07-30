#!/usr/bin/env node
/**
 * Install the pinned `greater` CLI from its release asset, digest first.
 *
 * The CLI is not published to the npm registry; it ships as a GitHub release
 * asset, which means the install step is a plain download and nothing about the
 * bytes that arrive is checked by a package manager. `greater doctor` is the whole
 * of SEC-7's evidence, so an unverified download is a tool of unknown provenance
 * auditing the vendored tree and reporting whatever it likes.
 *
 * So the asset URL and its SHA-256 are pinned in the repo contract, the download
 * is verified against that digest before anything unpacks it, and the tarball is
 * left on disk so SEC-7 can re-verify at gate time rather than trusting that this
 * script ran. A mismatch deletes the download and fails: a tarball that is not the
 * pinned one is not a version to reason about, it is a different artifact.
 *
 * `--ignore-scripts` is passed here for the same reason it is passed everywhere
 * else in this repository: no install anywhere runs lifecycle code.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readStrictJson } from './strict-json.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const TOOLS = 'gov-infra/.tools';
const TARBALL = `${TOOLS}/greater-components-cli.tgz`;

const contract = readStrictJson(CONTRACT);
const asset = contract.greater?.cli_asset;
if (typeof asset?.url !== 'string' || !/^https:\/\//.test(asset.url)) {
	console.error(`${CONTRACT}: greater.cli_asset.url must be an https URL`);
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
	console.log(`Downloading ${asset.url}`);
	const response = await fetch(asset.url);
	if (!response.ok) {
		console.error(`download failed: HTTP ${response.status} ${response.statusText}`);
		process.exit(1);
	}
	writeFileSync(TARBALL, Buffer.from(await response.arrayBuffer()));
	const actual = digestOf(TARBALL);
	if (actual !== asset.sha256) {
		rmSync(TARBALL, { force: true });
		console.error('greater CLI asset digest does not match the pin — download discarded.');
		console.error(`  pinned: ${asset.sha256}`);
		console.error(`  actual: ${actual}`);
		console.error(`Move the pin in ${CONTRACT} only for a release you verified upstream.`);
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

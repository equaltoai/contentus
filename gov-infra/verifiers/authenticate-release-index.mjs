#!/usr/bin/env node
/**
 * R2-3 — the registry-index pin's independent trust anchor.
 *
 * CON-4 binds every vendored byte to `gov-infra/release/registry-index-<ref>.json`,
 * whose digest is pinned in `contentus-pinned-repo-contract.json` under
 * `greater.registry_index`. That digest lives in the same repository as the
 * index it authenticates, so a coordinated same-diff edit — vendored bytes,
 * `components.json`, the committed index, and the pin digest — moved both
 * CON-4 and CON-5 at once. The pin had no anchor outside itself.
 *
 * THE ANCHOR. `registry_index.url` names the release's OWN registry manifest at
 * the pinned vendoring commit — `raw.githubusercontent.com/equaltoai/
 * greater-components/<ref>/registry/index.json`. A commit SHA is immutable and
 * the URL is served from a repository this child diff cannot write, so the
 * bytes that URL returns are the release's bytes, whatever the child diff
 * claims. This script fetches those bytes and demands two equalities:
 *
 *   1. sha256(fetched) === pin.sha256 — the pin names the real release manifest;
 *   2. sha256(committed index) === pin.sha256 — the committed copy the offline
 *      gate trusts is byte-identical to the fetched release manifest.
 *
 * Both must hold together. Equality 1 alone lets a re-authored pin pass by
 * matching a re-authored commit; equality 2 alone is the old self-referential
 * binding. With both, the committed index is an authenticated copy of the
 * release's manifest, and the offline gate (CON-4) then runs over bytes the
 * network just vouched for.
 *
 * WHERE IT RUNS. As a networked step in `.github/workflows/gov-rubric.yml`,
 * before the offline rubric — `validate-workflows.mjs` (MAI-4) binds the step's
 * presence so a child diff cannot quietly drop it. Locally it is run explicitly
 * (`node gov-infra/verifiers/authenticate-release-index.mjs`); it is NOT part
 * of the offline verifier, which must stay network-free.
 *
 * FAIL-CLOSED. A failed fetch, a mismatched digest, or a committed copy that
 * disagrees with the fetched bytes exits non-zero — an anchor that cannot be
 * checked is an anchor that must not be assumed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStrictJson } from './strict-json.mjs';

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

const contract = readStrictJson(CONTRACT);
const pin = contract.greater?.registry_index;
if (typeof pin?.url !== 'string' || !/^https:\/\//.test(pin.url)) {
	console.error(`${CONTRACT}: greater.registry_index.url must be an https URL`);
	process.exit(1);
}
if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
	console.error(`${CONTRACT}: greater.registry_index.sha256 must be a 64-hex digest`);
	process.exit(1);
}
const vendoredRef = contract.greater?.vendored_ref;
if (typeof vendoredRef !== 'string' || !/^[0-9a-f]{40}$/.test(vendoredRef)) {
	console.error(`${CONTRACT}: greater.vendored_ref must be a 40-hex commit`);
	process.exit(1);
}

const committedIndex = join('gov-infra', 'release', `registry-index-${vendoredRef}.json`);
if (!existsSync(committedIndex)) {
	console.error(
		`${committedIndex} is missing — the committed release artifact the offline gate ` +
			'trusts must exist to be authenticated against the URL'
	);
	process.exit(1);
}

let response;
try {
	response = await fetch(pin.url);
} catch (error) {
	console.error(
		`could not fetch ${pin.url}: ${error instanceof Error ? error.message : String(error)}`
	);
	console.error('The registry-index anchor is the immutable release URL; an anchor that cannot');
	console.error('be reached cannot authenticate the committed copy — failing closed.');
	process.exit(1);
}
if (!response.ok) {
	console.error(`fetch of ${pin.url} failed: HTTP ${response.status} ${response.statusText}`);
	console.error('The registry-index anchor is the immutable release URL; a fetch that does not');
	console.error('succeed cannot authenticate the committed copy — failing closed.');
	process.exit(1);
}

const fetched = Buffer.from(await response.arrayBuffer());
const fetchedDigest = digestOf(fetched);
if (fetchedDigest !== pin.sha256) {
	console.error(`fetched registry index does not match the pinned digest:`);
	console.error(`  pinned: ${pin.sha256}`);
	console.error(`  actual: ${fetchedDigest}`);
	console.error(`The URL is immutable at commit ${vendoredRef}; a mismatch means the pin does not`);
	console.error(`name the release's real manifest. Move the pin only for a verified release.`);
	process.exit(1);
}

const committedBytes = readFileSync(committedIndex);
const committedDigest = digestOf(committedBytes);
if (committedDigest !== pin.sha256) {
	console.error(`${committedIndex} does not match the release's registry index:`);
	console.error(`  fetched: ${fetchedDigest}`);
	console.error(`  committed: ${committedDigest}`);
	console.error('The offline gate runs over the committed copy; a committed copy that disagrees');
	console.error('with the release is a re-authored manifest, not an authenticated one.');
	process.exit(1);
}

console.log(`Registry index authenticated: ${pin.url}`);
console.log(
	`  fetched sha256 ${fetchedDigest} matches the pin and the committed ${committedIndex}`
);
console.log('CON-4 now runs over bytes the immutable release URL vouched for.');

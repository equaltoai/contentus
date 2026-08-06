#!/usr/bin/env node
/**
 * UPSTREAM PROVENANCE GATE — the pinned lesser schema, dereferenced.
 *
 * `scripts/audit-graphql-contract.mjs` validates documents against the schema in
 * `contracts/lesser/`. It checks that those bytes are unchanged since the digest
 * beside them was written, and that is all it can check: both values live in this
 * repository and move together in one commit. An author who fabricates a schema
 * and updates the digest gets a locally self-consistent tree that passes while
 * still claiming lesser `e710ff…`, and a `ref` of forty `f` characters passes
 * too, because offline nothing ever dereferences a ref.
 *
 * This gate is the other half, and it is deliberately a SEPARATE mechanism rather
 * than another local comparison. It asks GitHub for the git object at
 * `<repository>@<ref>:<upstream_path>` and compares it with the bytes in the
 * tree, through git's own content addressing. The answer comes from lesser, so no
 * edit in this repository can manufacture it.
 *
 *   fake ref (forty `f`)          → the commit object does not resolve; FAIL
 *   fabricated schema + digest    → the blob OID moved; upstream disagrees; FAIL
 *   wrong repository or path      → nothing to dereference; FAIL
 *   stale schema                  → upstream's blob is a different object; FAIL
 *
 * WHERE IT RUNS. `.github/workflows/schema-provenance.yml`, on every pull request,
 * as a required check. It is not part of `pnpm build`: a build must stay
 * deterministic and offline, and a network call folded into it would either make
 * the build flaky or — far worse — get a "skip when offline" escape hatch, which
 * is how a gate stops asserting. Run it locally with network any time:
 *
 *   node scripts/verify-schema-provenance.mjs
 *
 * A token is optional and only raises the anonymous rate limit; the lesser
 * repository is public and this gate reads public objects. Nothing is written,
 * and no credential is read from, or echoed into, the output.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readPin, verifyUpstreamObject } from './lib/schema-pin.mjs';

const PROVENANCE = 'contracts/lesser/provenance.json';

function rootFrom(argv) {
	const index = argv.indexOf('--root');
	if (index === -1) return process.cwd();
	const value = argv[index + 1];
	if (!value) {
		process.stderr.write('schema-provenance: --root needs a directory\n');
		process.exit(1);
	}
	return path.resolve(value);
}

function fail(findings) {
	process.stderr.write('\nschema-provenance: FAIL\n');
	for (const finding of findings) process.stderr.write(`  ${finding}\n`);
	process.stderr.write('\n');
	process.exit(1);
}

export async function main(argv, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
	const root = rootFrom(argv);

	let pin;
	try {
		pin = readPin(root, PROVENANCE).schema;
	} catch (error) {
		fail([`${PROVENANCE} could not be read: ${error.message}`]);
		return 1;
	}
	if (!pin) {
		fail([`${PROVENANCE} declares no \`schema\` pin`]);
		return 1;
	}

	const schemaFile = path.join(root, pin.pinned_path ?? '');
	if (!pin.pinned_path || !existsSync(schemaFile)) {
		fail([`${pin.pinned_path ?? '<unset>'} is missing — there are no bytes to authenticate`]);
		return 1;
	}
	const bytes = readFileSync(schemaFile);

	if (typeof fetchImpl !== 'function') {
		fail(['no fetch implementation is available, so upstream provenance was never checked']);
		return 1;
	}

	// A token, when present, only lifts the anonymous rate limit. It is passed
	// straight to the request and never logged, echoed, or written anywhere.
	const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;

	const { findings, observed } = await verifyUpstreamObject({ pin, bytes, fetchImpl, token });
	if (findings.length) {
		fail(findings);
		return 1;
	}

	process.stdout.write(
		`schema-provenance: ${pin.pinned_path} is byte-identical to the git object at\n` +
			`  ${pin.repository}@${pin.ref}\n` +
			`  ${pin.upstream_path}\n` +
			`  blob ${observed.upstream_blob}, ${observed.bytes} bytes, sha256 ${observed.sha256}\n`
	);
	process.stdout.write('schema-provenance: PASS\n');
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv.slice(2)));
}

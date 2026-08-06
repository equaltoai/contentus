#!/usr/bin/env node
/**
 * Every GraphQL document contentus can send, validated against lesser's pinned
 * canonical schema, on every build.
 *
 * THE DEFECT THIS EXISTS FOR. Contentus selected `Actor.avatarUrl` on both public
 * article documents. Lesser's `type Actor` has never published that field — it
 * publishes `avatar`. The name came from the vendored greater adapter's own
 * `Account` projection and reached these queries by resemblance. The failure was
 * quiet by construction: lesser rejects the selection, the normalizer read a key no
 * response carries, and every byline avatar was empty with nothing saying why.
 *
 * Nothing caught it because the only things checking these documents were fixtures
 * written to match them. The fixture said `avatarUrl: null`, the normalizer read
 * `avatarUrl`, and the assertion compared `null` to `null` — the same mistake
 * entered twice, agreeing with itself. A mock agrees with the client. Only the
 * schema disagrees with a wrong document, so the schema is what this gate asks.
 *
 * WHAT IT DOES, IN FULL. Read the pinned schema and re-check its digest. Read the
 * explicit document inventory in `scripts/lib/graphql-inventory.mjs` and prove the
 * inventory is exhaustive in both directions. Hand every document to `graphql-js`
 * — the reference parser and validator, because a GraphQL parser written here is
 * where a contract check would go wrong most quietly — and report every error.
 *
 * WHAT IT DOES NOT DO, DELIBERATELY. It does not walk a module graph, model a
 * transport, resolve imports, claim reachability, or touch the network. Those were
 * the predecessor, and they answered questions this control was never asked. The
 * inventory is forty-six documents; the honest tool for forty-six documents is a
 * list that is checked, not a framework that is trusted.
 *
 * Exit 0 on a clean run, 1 on any finding.
 */
import { execFileSync } from 'node:child_process';

import { buildSchema, specifiedRules, validate, parse } from 'graphql';

import {
	DOCUMENT_INVENTORY,
	PROVENANCE_PATH,
	SCHEMA_PATH,
	loadPinnedSchema,
	ownedModules,
	readInventory,
	repoRoot,
} from './lib/graphql-inventory.mjs';

/**
 * The tracked files, asked of git rather than of the disk.
 *
 * `tests/renderer-authority-audit.test.mjs` plants `.ts` fixtures inside
 * `src/lib/compose` and removes them in a `finally`, and `node --test` runs test
 * files concurrently — so a directory listing can read a file that is not part of
 * this repository, mid-write. Tracked files are what a fresh checkout contains,
 * which is the set this gate is supposed to be talking about.
 */
function trackedFiles() {
	return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', 'src'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 64,
	})
		.split('\0')
		.filter(Boolean);
}

function main() {
	const findings = [];

	let pin;
	try {
		pin = loadPinnedSchema();
	} catch (error) {
		console.error(`# GraphQL contract audit\n\n${error.message}`);
		process.exit(1);
	}

	let schema;
	try {
		schema = buildSchema(pin.sdl);
	} catch (error) {
		console.error(
			`# GraphQL contract audit\n\n${SCHEMA_PATH} is not a buildable schema: ${error.message}`
		);
		process.exit(1);
	}

	const files = trackedFiles();
	const { documents, problems } = readInventory(files);
	findings.push(...problems);

	for (const document of documents) {
		let ast;
		try {
			ast = parse(document.text);
		} catch (error) {
			findings.push(`${document.module}:${document.line} ${document.name} — ${error.message}`);
			continue;
		}
		for (const error of validate(schema, ast, specifiedRules)) {
			const at = error.locations?.[0];
			findings.push(
				`${document.module}:${document.line} ${document.name}` +
					(at ? ` (document line ${at.line}, column ${at.column})` : '') +
					`\n    ${error.message}`
			);
		}
	}

	console.log('# GraphQL contract audit\n');
	console.log(`Schema:     ${SCHEMA_PATH}`);
	console.log(`            ${pin.sdl.length} chars, sha256 ${pin.sha256}`);
	console.log(
		`            ${pin.provenance.upstream.repository}@${pin.provenance.upstream.ref}:${pin.provenance.upstream.path}`
	);
	console.log(`            blob ${pin.provenance.artifact.blob_sha1} (${PROVENANCE_PATH})`);
	console.log(
		'            Integrity checked here; PROVENANCE is the blob id above compared against lesser.'
	);
	console.log(
		`Documents:  ${documents.length} in ${DOCUMENT_INVENTORY.length} inventoried module(s), ` +
			`${documents.reduce((n, d) => n + d.operations.length, 0)} operation(s)`
	);
	console.log(
		`Swept:      ${ownedModules(files).length} contentus-authored .ts module(s) under src/, ` +
			`out of ${files.length} tracked file(s) there`
	);
	console.log('');

	if (findings.length) {
		console.error(`${findings.length} finding(s):\n`);
		for (const finding of findings) console.error(`  - ${finding}`);
		console.error('');
		console.error(
			'lesser owns this schema. A field contentus wants that lesser does not publish is an'
		);
		console.error(
			'upstream issue against equaltoai/lesser — never a compatibility field invented here.'
		);
		process.exit(1);
	}

	console.log('graphql-contract: PASS');
}

main();

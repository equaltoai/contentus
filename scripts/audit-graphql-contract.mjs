#!/usr/bin/env node
/**
 * CONTRACT GATE — every GraphQL document contentus can send, validated against
 * lesser's pinned canonical schema.
 *
 * WHY THIS EXISTS. Contentus asked lesser for `Actor.avatarUrl` across two public
 * article documents for the whole of M1. Lesser's `type Actor` has never had that
 * field; it has `avatar`. Nothing caught it, and the reason nothing caught it is
 * the part worth writing down: the tests passed because the FIXTURES had been
 * written to match the query. A mock that agrees with a wrong document is not
 * evidence about the contract — it is the same mistake, entered twice, agreeing
 * with itself. The only thing that can adjudicate a document is the schema, so
 * this gate holds the schema and reads the documents.
 *
 * FAIL-CLOSED IN FOUR DIRECTIONS, because "the gate was green" has to mean
 * something specific:
 *
 *   1. UNKNOWN FIELD — a document selecting something the schema does not define
 *      fails. This is the defect that motivated the gate.
 *   2. EDITED SCHEMA — the pinned SDL is checked against the digest, byte count
 *      and GIT BLOB OID recorded in `contracts/lesser/provenance.json` before it
 *      is used. A schema edited without moving the pin fails; a pin moved without
 *      the file fails.
 *
 *      THIS IS INTEGRITY, NOT PROVENANCE, and the distinction is the point. All
 *      three values live in this repository and move in the same commit as the
 *      schema, so an author who fabricates an SDL and updates all three produces
 *      a self-consistent tree that passes here while still claiming lesser
 *      `e710ff…` — and a `ref` of forty `f` characters is invisible to any
 *      offline check, because nothing offline dereferences a ref. Adversarial
 *      review demonstrated both. What answers those is a SEPARATE mechanism,
 *      `scripts/verify-schema-provenance.mjs`, which dereferences the git object
 *      at `<repository>@<ref>:<upstream_path>` and runs as a required CI check.
 *      This gate deliberately does not claim its result.
 *   3. OMISSION — a document the reader could not fold, or folded and could not
 *      parse, fails. "I could not read what this sends" is a failure, never a
 *      skip, because a document the gate cannot see is exactly the one that
 *      reaches lesser unchecked.
 *   4. DRIFT ACROSS THE UPSTREAM BOUNDARY — the vendored greater tree is excluded
 *      by a DECLARED, COUNTED disclosure, and the exclusion's safety is checked
 *      rather than assumed: no module outside that tree may reach a
 *      document-bearing module inside it.
 *
 * WHAT A GREEN RUN CLAIMS. That every document this reader found is valid against
 * the bytes pinned in `contracts/lesser/`, and that those bytes are unchanged
 * since their digest was written. Not that those bytes are what lesser published
 * — that is `scripts/verify-schema-provenance.mjs`, and it is a different run.
 * Not that the instance will accept the documents (an instance can run an older
 * lesser), not that the responses are handled correctly, and not that the pinned
 * ref is current.
 *
 * Usage:
 *   node scripts/audit-graphql-contract.mjs              validate; non-zero on any finding
 *   node scripts/audit-graphql-contract.mjs --inventory  also print every document found
 *   node scripts/audit-graphql-contract.mjs --root <dir> validate a tree other than the cwd
 *   node scripts/audit-graphql-contract.mjs --print-disclosure
 *                                                        print the upstream-tree counts
 *                                                        for pasting into provenance.json
 *
 * `--root` exists for `tests/graphql-contract.test.mjs`, which drives this gate
 * over synthetic repositories to prove it bites. It is deliberately a FLAG rather
 * than the cwd: the probe can then spell this file's path as a bare literal at its
 * `spawnSync`, which is what lets CON-5 check the disclosure that binds it against
 * the site — a target reached through a composed base is one no reading can see.
 * The guarded invocation in package.json passes no `--root`, and CON-5 pins that
 * text, so the flag cannot be smuggled into the gate the build actually runs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildSchema, parse, validate } from 'graphql';

import { documentsIn } from './lib/graphql-documents.mjs';
import {
	reachableFrom,
	resolveClosure,
	resolverOver,
	scriptOf as scriptIn,
} from './lib/module-closure.mjs';
import { createViteResolver } from './lib/module-resolution.mjs';
import { checkPinIntegrity, readPin } from './lib/schema-pin.mjs';
import { buildChannelGraph } from './lib/transport-channels.mjs';

function rootFrom(argv) {
	const index = argv.indexOf('--root');
	if (index === -1) return process.cwd();
	const value = argv[index + 1];
	if (!value) {
		process.stderr.write('graphql-contract: --root needs a directory\n');
		process.exit(1);
	}
	return path.resolve(value);
}

const ROOT = rootFrom(process.argv.slice(2));
const PROVENANCE = 'contracts/lesser/provenance.json';

/* -------------------------------------------------------------------------
 * Files
 * ---------------------------------------------------------------------- */

function walk(dir, extensions, out = []) {
	for (const entry of readdirSync(dir).sort()) {
		if (entry === 'node_modules' || entry === '.git') continue;
		const full = path.join(dir, entry);
		const stats = statSync(full);
		if (stats.isDirectory()) walk(full, extensions, out);
		else if (extensions.some((extension) => full.endsWith(extension))) {
			out.push(path.relative(ROOT, full));
		}
	}
	return out;
}

/* -------------------------------------------------------------------------
 * Gate
 * ---------------------------------------------------------------------- */

/** The Vite config a tree declares, or `false` for Vite's defaults. */
function viteConfigIn(root) {
	for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
		const candidate = path.join(root, name);
		if (existsSync(candidate)) return candidate;
	}
	return false;
}

async function main(argv) {
	const inventory = argv.includes('--inventory');
	const printDisclosure = argv.includes('--print-disclosure');
	const findings = [];

	const pin = readPin(ROOT, PROVENANCE);
	const {
		schema: schemaPin,
		document_roots: roots,
		build_entry_points: entries,
		upstream_trees: upstreamTrees,
	} = pin;

	// --- the pinned schema, checked before it is trusted ---------------------
	//
	// Integrity only. These bytes hashing to these recorded values says they are
	// unchanged since the values were written; it says nothing about whether
	// lesser published them, because every value involved is local and co-edited.
	// `scripts/verify-schema-provenance.mjs` dereferences the upstream git object
	// and is the mechanism that makes the stronger claim.
	const schemaFile = path.join(ROOT, schemaPin.pinned_path ?? '');
	if (!schemaPin.pinned_path || !existsSync(schemaFile)) {
		fail([
			`${schemaPin.pinned_path ?? '<unset>'} is missing — the pinned lesser schema is not in the tree`,
		]);
	}
	const schemaBytes = readFileSync(schemaFile);
	const integrity = checkPinIntegrity(schemaPin, schemaBytes);
	if (integrity.length) {
		fail([
			...integrity,
			'Either the schema was edited without moving the pin, or the pin was moved',
			'without the schema. Both are the same failure: the gate no longer knows',
			'which contract it is enforcing.',
		]);
	}

	let schema;
	try {
		schema = buildSchema(schemaBytes.toString('utf8'));
	} catch (error) {
		fail([`the pinned lesser schema does not build: ${error.message}`]);
	}

	// --- documents -----------------------------------------------------------
	const files = roots.paths.flatMap((root) => walk(path.join(ROOT, root), roots.extensions));
	const upstreamPaths = upstreamTrees.map((tree) => tree.path);
	const isUpstream = (file) => upstreamPaths.some((prefix) => file.startsWith(prefix));

	// The build's entry points, checked to exist. A boundary rooted at an entry
	// that is not there would walk nothing and pass vacuously.
	const entryPoints = entries?.paths ?? [];
	if (!entryPoints.length) {
		fail([
			`${PROVENANCE} declares no build_entry_points. Execution has to start somewhere ` +
				'nameable, or the vendored boundary is a walk from nowhere.',
		]);
	}
	for (const entry of entryPoints) {
		if (!existsSync(path.join(ROOT, entry))) {
			fail([`build entry point ${entry} does not exist — the boundary walk would be vacuous`]);
		}
	}

	// Resolution first: both the fold and the boundary read the same closure, and
	// it is Vite's resolver that computes it rather than a candidate list.
	const resolver = await createViteResolver({ root: ROOT, configFile: viteConfigIn(ROOT) });
	let closure;
	try {
		closure = await resolveClosure(ROOT, [...files, ...entryPoints], resolver);
	} finally {
		await resolver.close();
	}
	findings.push(...closure.findings);
	const resolve = resolverOver(closure);

	// The transport graph: which calls, anywhere in the closure, hand a document
	// to lesser. Rooted at the transport exports and followed through aliases,
	// re-exports, members and wrappers — never matched by name.
	const channels = buildChannelGraph({
		files: closure.files,
		sourceOf: (file) => closure.sources.get(file) ?? '',
		resolveSync: resolve.resolveSync,
	});

	const own = { documents: [], unresolved: [], malformed: [], invalid: [] };
	const upstreamCounts = new Map();
	const boundaryNotes = [];

	for (const file of files) {
		let read;
		try {
			read = documentsIn(file, scriptIn(ROOT, file), resolve.resolveForReader, channels);
		} catch (error) {
			// A file the reader cannot parse is a file whose documents are unknown.
			// That is a finding wherever it happens: the alternative reads an
			// unreadable module exactly like a module with nothing in it.
			own.malformed.push({ file, line: 0, name: '<file>', reason: error.message });
			continue;
		}

		if (isUpstream(file)) {
			if (read.documents.length || read.unresolved.length || read.malformed.length) {
				upstreamCounts.set(file, {
					documents: read.documents.length,
					unresolved: read.unresolved.length + read.malformed.length,
				});
			}
			continue;
		}

		own.unresolved.push(...read.unresolved);
		own.malformed.push(...read.malformed);
		for (const document of read.documents) {
			own.documents.push(document);
			const errors = validate(schema, parse(document.text));
			if (errors.length) own.invalid.push({ document, errors });
		}
	}

	if (printDisclosure) {
		const out = {};
		for (const [file, counts] of [...upstreamCounts].sort()) out[file] = counts;
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return 0;
	}

	// --- findings ------------------------------------------------------------
	for (const { document, errors } of own.invalid) {
		findings.push(
			`${document.file}:${document.line} ${document.name} does not validate against lesser's schema:`
		);
		for (const error of errors) findings.push(`    ${error.message}`);
	}
	for (const entry of own.unresolved) {
		findings.push(
			`${entry.file}:${entry.line} ${entry.name} — this reader could not determine what GraphQL ` +
				'text this sends, so it could not be checked. An unreadable document is a finding, ' +
				'not a skip.'
		);
	}
	for (const entry of own.malformed) {
		findings.push(`${entry.file}:${entry.line} ${entry.name} — ${entry.reason}`);
	}

	// --- what the build can execute, walked once ------------------------------
	//
	// Computed here rather than inside the upstream loop because the walk's own
	// findings — an unresolvable path, an unreadable module, a computed import —
	// are facts about this repository's module graph, not about any disclosure. A
	// tree that declares no upstream exclusion still has to be readable, and
	// reporting these only when a disclosure happened to exist made the strictest
	// checks conditional on the thing they were meant to protect.
	const {
		seen: reachable,
		findings: walkFindings,
		unresolvedPackages,
	} = reachableFrom(entryPoints, closure, resolve);
	findings.push(...walkFindings);
	boundaryNotes.push(
		`${reachable.size} modules reachable from ${entryPoints.join(' + ')}; ` +
			`${unresolvedPackages.size} uninstalled package specifiers named by reachable source ` +
			'(each names a package, so none can be a file inside the tree)'
	);

	// --- upstream disclosure: counts, and the boundary that makes it safe -----
	for (const tree of upstreamTrees) {
		const declared = tree.documents;
		const actual = Object.fromEntries(
			[...upstreamCounts].filter(([file]) => file.startsWith(tree.path))
		);

		for (const [file, counts] of Object.entries(actual)) {
			const expected = declared[file];
			if (!expected) {
				findings.push(
					`${file} declares GraphQL documents inside the disclosed upstream tree ${tree.path} ` +
						'but is not named in contracts/lesser/provenance.json. A new upstream document ' +
						'is a governance event, not a silent addition — declare it with its counts.'
				);
				continue;
			}
			if (expected.documents !== counts.documents || expected.unresolved !== counts.unresolved) {
				findings.push(
					`${file} disclosure is stale: declared ${expected.documents} documents / ` +
						`${expected.unresolved} unreadable, found ${counts.documents} / ${counts.unresolved}.`
				);
			}
		}
		for (const file of Object.keys(declared)) {
			if (!actual[file]) {
				findings.push(
					`${file} is declared in contracts/lesser/provenance.json but carries no GraphQL ` +
						'document. A disclosure that no longer describes anything is a pin that has ' +
						'stopped asserting — remove it.'
				);
			}
		}

		// The boundary. Reached from everything OUTSIDE the tree, does anything
		// document-bearing INSIDE it become reachable?
		// EXECUTION STARTS AT THE BUILD ENTRIES, and `reachable` above is that walk.
		// A module no entry reaches cannot run, whatever else in the tree names it —
		// see `build_entry_points` in the pin for why "every file outside the tree"
		// was the wrong roots.
		//
		// Counted, not silent: which outside files WOULD reach a forbidden module if
		// anything executed them. Today that is dead vendored source at the lib root;
		// the day one of them is imported, the boundary above fires.
		const orphanReaches = [];
		for (const file of closure.files) {
			if (file.startsWith(tree.path) || reachable.has(file)) continue;
			const { seen: fromHere } = reachableFrom([file], closure, resolve);
			if (Object.keys(declared).some((document) => fromHere.has(document))) {
				orphanReaches.push(file);
			}
		}
		if (orphanReaches.length) {
			boundaryNotes.push(
				`${orphanReaches.length} file(s) outside ${tree.path} reach a disclosed vendored ` +
					`document but are themselves unreachable from any entry, so nothing executes ` +
					`them: ${orphanReaches.join(', ')}`
			);
		}
		for (const file of Object.keys(declared)) {
			if (reachable.has(file)) {
				findings.push(
					`${file} carries GraphQL documents this gate excludes as upstream, but it IS ` +
						'reachable by import from contentus source. The exclusion is only safe while ' +
						'nothing outside the vendored tree can execute what is inside it — either the ' +
						'import goes, or the documents are validated.'
				);
			}
		}
	}

	// --- report --------------------------------------------------------------
	const upstreamTotal = [...upstreamCounts.values()].reduce(
		(sum, counts) => sum + counts.documents,
		0
	);
	const upstreamUnread = [...upstreamCounts.values()].reduce(
		(sum, counts) => sum + counts.unresolved,
		0
	);

	if (inventory) {
		for (const document of own.documents) {
			process.stdout.write(`  ${document.file}:${document.line}  ${document.name}\n`);
		}
	}

	process.stdout.write(
		`graphql-contract: ${own.documents.length} contentus documents in ${
			new Set(own.documents.map((document) => document.file)).size
		} modules, validated against the pinned SDL ` +
			`(blob ${schemaPin.git_blob_sha1.slice(0, 12)}…, sha256 ${schemaPin.sha256.slice(0, 12)}…, ` +
			`declared as lesser ${schemaPin.ref.slice(0, 12)} ${schemaPin.upstream_path})\n`
	);
	process.stdout.write(
		'graphql-contract: those bytes are checked for INTEGRITY here, not provenance — the ' +
			'declared repository/ref/path are dereferenced by scripts/verify-schema-provenance.mjs\n'
	);
	process.stdout.write(
		`graphql-contract: ${files.length} source files walked; ${upstreamTotal} documents and ` +
			`${upstreamUnread} unreadable candidates disclosed inside ${upstreamPaths.join(', ')} ` +
			'and excluded as upstream-owned\n'
	);
	for (const note of boundaryNotes) process.stdout.write(`graphql-contract: ${note}\n`);

	if (findings.length) {
		fail(findings);
	}

	process.stdout.write('graphql-contract: PASS\n');
	return 0;
}

function fail(findings) {
	process.stderr.write('\ngraphql-contract: FAIL\n');
	for (const finding of findings) process.stderr.write(`  ${finding}\n`);
	process.stderr.write('\n');
	process.exit(1);
}

process.exit(await main(process.argv.slice(2)));

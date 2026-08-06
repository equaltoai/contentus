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
 *   2. STALE SCHEMA — the pinned SDL is checked against the digest recorded in
 *      `contracts/lesser/provenance.json` before it is used. A schema edited
 *      without moving the pin fails; a pin moved without the file fails.
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
 * the schema at the pinned ref. Not that the instance will accept them (an
 * instance can run an older lesser), not that the responses are handled
 * correctly, and not that the pinned ref is current. It is a contract check, and
 * it is worth exactly as much as the pin is honest.
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
import { createHash } from 'node:crypto';
import path from 'node:path';

import { buildSchema, parse, validate } from 'graphql';

import { documentsIn } from './lib/graphql-documents.mjs';
import { liveScript, moduleSpecifiers, modulePath } from './lib/module-imports.mjs';

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
 * Pin
 * ---------------------------------------------------------------------- */

/**
 * Read the provenance pin, rejecting duplicate keys.
 *
 * `JSON.parse` is last-wins, so a repeated key is one value a reviewer reads and
 * a different value this gate enforces. That is the shape of a pin that has
 * quietly stopped asserting what it appears to assert.
 */
function readPin(file) {
	const text = readFileSync(path.join(ROOT, file), 'utf8');
	const seen = [];
	JSON.parse(text, function reviver(key, value) {
		if (key !== '' && Object.hasOwn(this, key) && typeof this === 'object') seen.push(key);
		return value;
	});
	const duplicates = duplicateKeys(text);
	if (duplicates.length) {
		throw new Error(`${file} has duplicate keys: ${duplicates.join(', ')}`);
	}
	return JSON.parse(text);
}

/** Duplicate keys within any single object, found by re-walking the token stream. */
function duplicateKeys(text) {
	const found = new Set();
	const stack = [new Set()];
	const tokens = /"((?:[^"\\]|\\.)*)"\s*:|([{[])|([}\]])/g;
	for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
		if (match[2]) stack.push(new Set());
		else if (match[3]) stack.pop();
		else if (match[1] !== undefined) {
			const scope = stack[stack.length - 1];
			if (scope.has(match[1])) found.add(match[1]);
			scope.add(match[1]);
		}
	}
	return [...found];
}

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

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

/**
 * Resolve a specifier to a repository file, or `null` when it leaves the tree.
 *
 * Extension order matters and is not invented: this repository's own modules are
 * written with explicit `.ts` in some places and extensionless in others, and a
 * directory import means `index`. External packages resolve to `null` — folding
 * stops at the tree edge, which is correct, because a document assembled from an
 * npm package is not a document this repository declares.
 */
const RESOLVE_EXTENSIONS = ['.ts', '.mts', '.cts', '.svelte', '.js', '.mjs', '.cjs'];

function resolveModule(specifier, fromFile) {
	const bare = modulePath(specifier);
	let base;
	if (bare === '$lib') base = path.join(ROOT, 'src/lib');
	else if (bare.startsWith('$lib/')) base = path.join(ROOT, 'src/lib', bare.slice('$lib/'.length));
	else if (bare.startsWith('.')) base = path.resolve(ROOT, path.dirname(fromFile), bare);
	else return null;

	const candidates = [
		base,
		...RESOLVE_EXTENSIONS.map((extension) => base + extension),
		...RESOLVE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return path.relative(ROOT, candidate);
		}
	}
	return null;
}

/** Source a file executes — a component's scripts and markup imports, or the file. */
function scriptOf(file) {
	return liveScript(file, readFileSync(path.join(ROOT, file), 'utf8'));
}

function resolveForReader(specifier, fromFile) {
	const resolved = resolveModule(specifier, fromFile);
	if (!resolved) return null;
	return { file: resolved, source: scriptOf(resolved) };
}

/* -------------------------------------------------------------------------
 * Boundary
 * ---------------------------------------------------------------------- */

/**
 * Every file reachable by import from `roots`, following the tree transitively.
 *
 * This is what turns "we excluded the vendored tree" from an assertion into a
 * checked claim. Contentus imports vendored FACES freely and must keep doing so;
 * what it must never do is reach a vendored module that declares a GraphQL
 * document, because that document would then be one contentus can execute and
 * this gate has declared it out of scope.
 *
 * Static, and therefore an over-approximation of what actually runs — which is
 * the safe direction for a reachability question asked this way round. The
 * complementary reading, over the modules a real build LOADS, lives in
 * tests/graphql-contract.test.mjs; a file this walk misses and the build loads
 * would be caught there.
 */
function reachableFrom(roots) {
	const seen = new Set(roots);
	const queue = [...roots];
	while (queue.length) {
		const file = queue.shift();
		let specifiers;
		try {
			specifiers = moduleSpecifiers(scriptOf(file));
		} catch {
			// An unreadable module is not evidence of absence. Reported by the
			// document walk, which reads the same files; skipping here would only
			// shrink the closure, and a smaller closure cannot manufacture a pass
			// because the boundary check asks whether a FORBIDDEN file was reached.
			continue;
		}
		for (const specifier of specifiers) {
			const resolved = resolveModule(specifier, file);
			if (resolved && !seen.has(resolved)) {
				seen.add(resolved);
				queue.push(resolved);
			}
		}
	}
	return seen;
}

/* -------------------------------------------------------------------------
 * Gate
 * ---------------------------------------------------------------------- */

function main(argv) {
	const inventory = argv.includes('--inventory');
	const printDisclosure = argv.includes('--print-disclosure');
	const findings = [];

	const pin = readPin(PROVENANCE);
	const { schema: schemaPin, document_roots: roots, upstream_trees: upstreamTrees } = pin;

	// --- the pinned schema, checked before it is trusted ---------------------
	const schemaFile = path.join(ROOT, schemaPin.pinned_path);
	if (!existsSync(schemaFile)) {
		fail([`${schemaPin.pinned_path} is missing — the pinned lesser schema is not in the tree`]);
	}
	const schemaBytes = readFileSync(schemaFile);
	const digest = sha256(schemaBytes);
	if (digest !== schemaPin.sha256) {
		fail([
			`${schemaPin.pinned_path} does not match its pin.`,
			`  recorded sha256 ${schemaPin.sha256}`,
			`  actual   sha256 ${digest}`,
			'  Either the schema was edited without moving the pin, or the pin was moved',
			'  without the schema. Both are the same failure: the gate no longer knows',
			'  which contract it is enforcing.',
		]);
	}
	if (schemaBytes.length !== schemaPin.bytes) {
		fail([
			`${schemaPin.pinned_path} is ${schemaBytes.length} bytes; the pin records ${schemaPin.bytes}`,
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

	const own = { documents: [], unresolved: [], malformed: [], invalid: [] };
	const upstreamCounts = new Map();

	for (const file of files) {
		let read;
		try {
			read = documentsIn(file, scriptOf(file), resolveForReader);
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
		const outside = files.filter((file) => !file.startsWith(tree.path));
		const reachable = reachableFrom(outside);
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
		} modules, validated against lesser ${schemaPin.ref.slice(0, 12)} ` +
			`(${schemaPin.upstream_path}, sha256 ${schemaPin.sha256.slice(0, 12)}…)\n`
	);
	process.stdout.write(
		`graphql-contract: ${files.length} source files walked; ${upstreamTotal} documents and ` +
			`${upstreamUnread} unreadable candidates disclosed inside ${upstreamPaths.join(', ')} ` +
			'and excluded as upstream-owned\n'
	);

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

process.exit(main(process.argv.slice(2)));

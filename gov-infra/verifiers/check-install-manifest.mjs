#!/usr/bin/env node
/**
 * CON-3 / COM-1 — the lesser install manifest and the artifacts it points at.
 *
 * The deployment path is milestone zero: a client that cannot install into
 * lesser is not a lesser client. This validates that `facetheory.lesser.json`
 * still declares every key `lesser client install` reads, and — when invoked
 * with --artifacts — that the build actually produced the SSR handler and client
 * asset directory the manifest names.
 *
 * The artifact half is not decoration. The SSR probes and the uncompiled-rune
 * guard both read `build/`; the rune guard walks an empty set when the build is
 * absent and passes vacuously. Asserting the artifacts exist is what stops a
 * missing build from reading as coverage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'facetheory.lesser.json';
const findings = [];
const checkArtifacts = process.argv.includes('--artifacts');

let manifest;
try {
	manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (error) {
	console.error(`${MANIFEST} is missing or unparseable: ${error.message}`);
	process.exit(1);
}

function require_(path, predicate, description) {
	const value = path.reduce((node, key) => (node == null ? undefined : node[key]), manifest);
	if (!predicate(value))
		findings.push(`${MANIFEST}: ${path.join('.')} ${description} (got ${JSON.stringify(value)})`);
	return value;
}

const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

require_(
	['schema_version'],
	(value) => Number.isInteger(value) && value >= 1,
	'must be an integer >= 1'
);
require_(['app_name'], nonEmptyString, 'must be a non-empty string');
require_(['display_name'], nonEmptyString, 'must be a non-empty string');
require_(['version'], nonEmptyString, 'must be a non-empty string');
require_(
	['build', 'command'],
	(value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString),
	'must be a non-empty array of strings'
);
const serverDir = require_(['server', 'dir'], nonEmptyString, 'must be a non-empty string');
const serverEntry = require_(['server', 'entry'], nonEmptyString, 'must be a non-empty string');
require_(['server', 'export'], nonEmptyString, 'must be a non-empty string');
const assetsDir = require_(['assets', 'dir'], nonEmptyString, 'must be a non-empty string');

if (checkArtifacts && nonEmptyString(serverDir) && nonEmptyString(serverEntry)) {
	const handler = join(serverDir, serverEntry);
	if (!existsSync(handler))
		findings.push(`build artifact missing: ${handler} (run \`pnpm run build\`)`);
	else if (statSync(handler).size === 0) findings.push(`build artifact is empty: ${handler}`);
}

if (checkArtifacts && nonEmptyString(assetsDir)) {
	if (!existsSync(assetsDir)) findings.push(`client asset directory missing: ${assetsDir}`);
	else if (readdirSync(assetsDir).length === 0)
		findings.push(`client asset directory is empty: ${assetsDir}`);
}

if (findings.length) {
	console.error(findings.join('\n'));
	process.exit(1);
}

console.log(`${MANIFEST} declares every key \`lesser client install\` reads.`);
console.log(`  app_name=${manifest.app_name} version=${manifest.version}`);
console.log(`  build=${manifest.build.command.join(' ')}`);
console.log(`  server=${join(serverDir, serverEntry)} export=${manifest.server.export}`);
console.log(`  assets=${assetsDir}`);
if (checkArtifacts) console.log('  artifacts present.');

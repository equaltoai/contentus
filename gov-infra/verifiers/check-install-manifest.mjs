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
 * Two properties beyond shape, because shape alone is not a gate:
 *
 *   - Path containment. `server.dir`, `server.entry`, and `assets.dir` are joined
 *     and handed to an installer. A non-empty string is not a safe path: absolute
 *     paths and `..` segments both reach outside the repository, and an entry
 *     outside its own server directory is not the artifact the manifest claims.
 *     Each is resolved and asserted to sit beneath the repository root, and the
 *     entry beneath the resolved server dir.
 *
 *     Lexical containment is not containment. `resolve()` normalizes text; it does
 *     not read the filesystem, so a path that is textually beneath the repository
 *     and is a symlink to somewhere else passes every check above. The installer
 *     does not read text — `lesser client install` opens what these paths name and
 *     follows the link. So containment is asserted on real paths (`realpathSync`),
 *     and --artifacts walks the resolved directories and rejects any symlink found
 *     inside them: a build that emits a link is packaging whatever it points at.
 *   - `build.command` against an allowlist. This is the command the installer
 *     runs; any non-empty array of strings passes a shape check, including one
 *     that runs something else entirely. The exact accepted invocations are
 *     pinned in contentus-pinned-repo-contract.json.
 *
 * The artifact half is not decoration. The SSR probes and the uncompiled-rune
 * guard both read `build/`; the rune guard walks an empty set when the build is
 * absent and passes vacuously. Asserting the artifacts exist is what stops a
 * missing build from reading as coverage — and existence is itself weak, so
 * --artifacts imports the built handler and asserts it really exports the symbol
 * `server.export` names. A file of the right size at the right path is not a
 * handler.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readStrictJson } from './strict-json.mjs';

const MANIFEST = 'facetheory.lesser.json';
const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const findings = [];
const checkArtifacts = process.argv.includes('--artifacts');
const root = resolve(process.cwd());
// The repository root can itself sit under a symlink (a worktree in /tmp on macOS
// is the everyday case). Comparing a real path against a lexical root would then
// report every path as an escape, so the base of every comparison is real too.
const realRoot = realpathSync(root);

let manifest;
try {
	manifest = readStrictJson(MANIFEST);
} catch (error) {
	console.error(`${MANIFEST} is missing or unparseable: ${error.message}`);
	process.exit(1);
}

let contract;
try {
	contract = readStrictJson(CONTRACT);
} catch (error) {
	console.error(`${CONTRACT} is missing or unparseable: ${error.message}`);
	console.error('The pinned contract is the expected value this control asserts against.');
	process.exit(1);
}

function require_(path, predicate, description) {
	const value = path.reduce((node, key) => (node == null ? undefined : node[key]), manifest);
	if (!predicate(value))
		findings.push(`${MANIFEST}: ${path.join('.')} ${description} (got ${JSON.stringify(value)})`);
	return value;
}

const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const beneath = (path, base) => path === base || path.startsWith(base + sep);

/**
 * The real path of `path`, or of the nearest ancestor that exists. A build
 * artifact need not be present for CON-3 to judge the manifest's shape, but every
 * component that does exist must be a real component: resolving the deepest
 * existing ancestor is what makes a symlinked parent directory visible.
 */
function realPathOfNearestExisting(path) {
	let candidate = path;
	for (;;) {
		if (existsSync(candidate)) return realpathSync(candidate);
		const parent = resolve(candidate, '..');
		if (parent === candidate) return candidate;
		candidate = parent;
	}
}

/**
 * A repository-relative path an installer may join. Absolute paths and `..`
 * segments are rejected before resolution rather than after: `resolve` would
 * happily normalize them into somewhere else on the filesystem.
 *
 * Passing those lexical checks is not containment. `resolve` never touches the
 * filesystem, so `build/client` is "beneath the repository root" even when it is
 * a symlink to `/etc`. The installer follows the link. So the resolved path's
 * real path — or the real path of its nearest existing ancestor — must also sit
 * beneath the real base.
 */
function containedPath(
	key,
	value,
	base = root,
	baseLabel = 'the repository root',
	realBase = realRoot
) {
	if (!nonEmptyString(value)) return null;
	if (isAbsolute(value)) {
		findings.push(`${MANIFEST}: ${key} must be a repository-relative path (got ${value})`);
		return null;
	}
	if (value.split(/[\\/]/).includes('..')) {
		findings.push(`${MANIFEST}: ${key} must not contain a ".." segment (got ${value})`);
		return null;
	}
	const resolved = resolve(base, value);
	if (!beneath(resolved, base)) {
		findings.push(`${MANIFEST}: ${key} resolves outside ${baseLabel} (${value} -> ${resolved})`);
		return null;
	}
	let real;
	try {
		real = realPathOfNearestExisting(resolved);
	} catch (error) {
		findings.push(`${MANIFEST}: ${key} could not be resolved on disk (${error.message})`);
		return null;
	}
	if (!beneath(real, realBase)) {
		findings.push(
			`${MANIFEST}: ${key} escapes ${baseLabel} through a symlink (${value} -> ${real}); ` +
				'`lesser client install` follows links, so this packages whatever it points at'
		);
		return null;
	}
	return resolved;
}

/**
 * Walk a build artifact directory and reject every symlink inside it. A build
 * that emits a link is not emitting a file: the installer opens the link target,
 * which may be any file the build host can read. Rejection is on `lstatSync`,
 * never `statSync` — `statSync` follows the very link this is looking for.
 */
function rejectSymlinksUnder(label, directory) {
	const stack = [directory];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch (error) {
			findings.push(`${label}: ${relative(root, current)} could not be read (${error.message})`);
			continue;
		}
		for (const entry of entries) {
			const child = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				let target = 'unresolvable';
				try {
					target = realpathSync(child);
				} catch {
					// A dangling link is still a link, and still a finding.
				}
				findings.push(
					`${label}: ${relative(root, child)} is a symlink (-> ${target}); ` +
						'build artifacts must be real files — the installer follows links on upload'
				);
				continue;
			}
			if (entry.isDirectory()) stack.push(child);
		}
	}
}

require_(
	['schema_version'],
	(value) => Number.isInteger(value) && value >= 1,
	'must be an integer >= 1'
);
require_(['app_name'], nonEmptyString, 'must be a non-empty string');
require_(['display_name'], nonEmptyString, 'must be a non-empty string');
require_(['version'], nonEmptyString, 'must be a non-empty string');

const allowedBuildCommands = contract.install_manifest?.allowed_build_commands;
if (!Array.isArray(allowedBuildCommands) || allowedBuildCommands.length === 0) {
	findings.push(`${CONTRACT}: install_manifest.allowed_build_commands must be a non-empty array`);
} else {
	const buildCommand = require_(
		['build', 'command'],
		(value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString),
		'must be a non-empty array of strings'
	);
	if (Array.isArray(buildCommand)) {
		const rendered = JSON.stringify(buildCommand);
		if (!allowedBuildCommands.some((allowed) => JSON.stringify(allowed) === rendered))
			findings.push(
				`${MANIFEST}: build.command ${rendered} is not an allowed invocation; ` +
					`${CONTRACT} allows ${allowedBuildCommands.map((c) => JSON.stringify(c)).join(', ')}`
			);
	}
}

const serverDir = require_(['server', 'dir'], nonEmptyString, 'must be a non-empty string');
const serverEntry = require_(['server', 'entry'], nonEmptyString, 'must be a non-empty string');
const serverExport = require_(['server', 'export'], nonEmptyString, 'must be a non-empty string');
const assetsDir = require_(['assets', 'dir'], nonEmptyString, 'must be a non-empty string');

const resolvedServerDir = containedPath('server.dir', serverDir);
const resolvedAssetsDir = containedPath('assets.dir', assetsDir);
// The entry is resolved against its own server directory, not the repository
// root: an entry that escapes into a sibling directory is still "contained" by
// the repository while no longer being the artifact the manifest describes.
const resolvedHandler = resolvedServerDir
	? containedPath(
			'server.entry',
			serverEntry,
			resolvedServerDir,
			'server.dir',
			realPathOfNearestExisting(resolvedServerDir)
		)
	: null;

if (checkArtifacts && resolvedServerDir && existsSync(resolvedServerDir))
	rejectSymlinksUnder('server.dir', resolvedServerDir);
if (checkArtifacts && resolvedAssetsDir && existsSync(resolvedAssetsDir))
	rejectSymlinksUnder('assets.dir', resolvedAssetsDir);

if (checkArtifacts && resolvedHandler) {
	if (!existsSync(resolvedHandler))
		findings.push(
			`build artifact missing: ${relative(root, resolvedHandler)} (run \`pnpm run build\`)`
		);
	else if (lstatSync(resolvedHandler).isSymbolicLink())
		findings.push(
			`build artifact is a symlink: ${relative(root, resolvedHandler)}; the SSR handler must be a real file`
		);
	else if (statSync(resolvedHandler).size === 0)
		findings.push(`build artifact is empty: ${relative(root, resolvedHandler)}`);
	else if (nonEmptyString(serverExport)) {
		// A file at the right path with a non-zero size is not a handler. `lesser
		// client install` imports this module and reads this export; so does the
		// SEC-6 probe. Import it here so COM-1 fails on a build that produced a
		// module without it, rather than on the first install attempt.
		try {
			const built = await import(pathToFileURL(resolvedHandler).href);
			if (!Object.hasOwn(built, serverExport))
				findings.push(
					`built handler ${relative(root, resolvedHandler)} does not export ` +
						`"${serverExport}" (exports: ${Object.keys(built).join(', ') || 'none'})`
				);
			else if (typeof built[serverExport] !== 'function')
				findings.push(
					`built handler export "${serverExport}" is ${typeof built[serverExport]}, not a function`
				);
		} catch (error) {
			findings.push(
				`built handler ${relative(root, resolvedHandler)} could not be imported: ${error.message}`
			);
		}
	}
}

if (checkArtifacts && resolvedAssetsDir) {
	if (!existsSync(resolvedAssetsDir))
		findings.push(`client asset directory missing: ${relative(root, resolvedAssetsDir)}`);
	else if (readdirSync(resolvedAssetsDir).length === 0)
		findings.push(`client asset directory is empty: ${relative(root, resolvedAssetsDir)}`);
}

if (findings.length) {
	console.error(findings.join('\n'));
	process.exit(1);
}

console.log(`${MANIFEST} declares every key \`lesser client install\` reads.`);
console.log(`  app_name=${manifest.app_name} version=${manifest.version}`);
console.log(`  build=${manifest.build.command.join(' ')} (allowlisted in ${CONTRACT})`);
console.log(`  server=${join(serverDir, serverEntry)} export=${serverExport}`);
console.log(`  assets=${assetsDir}`);
console.log('  paths resolve beneath the repository root; entry resolves beneath server.dir.');
console.log('  every real path stays beneath its real base; no path escapes through a symlink.');
if (checkArtifacts) {
	console.log(`  artifacts present; built handler exports "${serverExport}".`);
	console.log('  no symlink anywhere under server.dir or assets.dir.');
}

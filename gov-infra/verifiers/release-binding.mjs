#!/usr/bin/env node
/**
 * CON-4's release binding — the round-1 F4 closure.
 *
 * The vendored tree's own manifest is repository-controlled: `greater doctor`
 * verifies on-disk files against `components.json` checksums, and CON-4
 * verifies the manifest's version/ref/modified fields against the pin — so an
 * author who edits a vendored file AND its checksum (and keeps `modified`
 * false) moves both gates at once. F4's finding was exactly that the vendored
 * bytes rest on self-declared manifest state.
 *
 * THE INDEPENDENT BINDING. The release's OWN registry manifest —
 * `registry/index.json` at the pinned vendoring commit, digest-pinned in
 * `contentus-pinned-repo-contract.json` under `greater.registry_index` with a
 * bound URL — carries the canonical per-file checksum of every file the
 * release ships. For each vendored file this verifier re-derives the bytes
 * from that release manifest and demands the working tree match:
 *
 *   - the on-disk bytes must equal the release's canonical bytes for the
 *     file's source path, or the digest-verified greater CLI's documented
 *     import-transform of those bytes (the CLI rewrites package-specifier
 *     imports to consumer-relative paths when it vendors a face — that
 *     transformation is the CLI's own, applied here from the CLI's own
 *     modules so a second copy can never drift);
 *   - the recorded `components.json` checksum must match the same canonical
 *     value or its transform.
 *
 * A coordinated file+checksum edit now leaves the recorded checksum differing
 * from the release's canonical checksum for that path, and the gate fails
 * without ever consulting the repository-controlled manifest's own fields.
 *
 * The committed release artifacts live under `gov-infra/release/`:
 * `registry-index-<vendored_ref>.json` (verified against the pin digest before
 * anything trusts it) and `source/<repo-path>` for the files the CLI ships
 * transformed (each verified against the release manifest's canonical checksum
 * before it is used). The pin's `url` is the release's own file at the pinned
 * commit, so the digest is independently re-derivable by fetching it.
 *
 * FAIL-CLOSED. A missing or mismatched release artifact, an unparseable index,
 * an absent CLI tarball, or a quarantined CLI that cannot be built is a
 * FINDING — never a PASS. There is no network in this path: the committed
 * artifacts are the release bytes, and every byte is re-verified against the
 * pinned digest or the digest-bound manifest before use.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestOf, extractEntries, readTarEntries } from './verified-tarball.mjs';

export const sriOf = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

/** The on-disk path a components.json virtual path resolves to, via aliases. */
export function resolveDiskPath(virtualPath, aliases) {
	const segment = virtualPath.split('/')[0];
	const root = aliases?.[segment];
	return root ? `${root}${virtualPath.slice(segment.length)}` : null;
}

const RELEASE_ROOT = (repoRoot) => join(repoRoot, 'gov-infra', 'release');
const INDEX_FILE = (repoRoot, ref) => join(RELEASE_ROOT(repoRoot), `registry-index-${ref}.json`);
const SOURCE_ROOT = (repoRoot) => join(RELEASE_ROOT(repoRoot), 'source');
const CLI_TARBALL = (repoRoot) =>
	join(repoRoot, 'gov-infra', '.tools', 'greater-components-cli.tgz');

/**
 * The pure per-record decision: is this record bound to the release?
 *
 * `candidates` are the release's canonical entries for the file's source
 * path(s): `{ repoPath, checksum }`. `transformSource`, when the record's
 * virtual path is one the CLI ships rewritten, turns canonical source bytes
 * into the bytes that SHOULD be on disk.
 *
 * Exported so the probes can drive the decision over synthetic release data;
 * the gate uses it through `verifyReleaseBinding` below.
 */
export function verifyRecordAgainstRelease({
	diskSri,
	recordedChecksum,
	candidates,
	transformSource,
}) {
	if (candidates.some((candidate) => candidate.checksum === diskSri)) {
		return { status: 'canonical' };
	}
	if (candidates.some((candidate) => candidate.checksum === recordedChecksum)) {
		return { status: 'canonical-recorded' };
	}
	if (transformSource) {
		for (const candidate of candidates) {
			const transformed = transformSource(candidate.sourceBytes);
			if (!transformed) continue;
			if (sriOf(Buffer.from(transformed)) === diskSri) return { status: 'transformed' };
		}
	}
	return { status: 'unbound' };
}

/**
 * The digest-verified greater CLI's own derivation modules, loaded from a
 * quarantine the gate extracts and builds itself — the same trust root SEC-7
 * uses. The tarball digest is re-verified on the bytes on disk, independent of
 * how they got there, and nothing under `gov-infra/.tools` is executed.
 */
async function loadCliDerivation({ repoRoot, pin }) {
	const tarballPath = CLI_TARBALL(repoRoot);
	if (!existsSync(tarballPath)) {
		throw new Error(
			`${CLI_TARBALL(repoRoot)} is absent — run ` +
				'`node gov-infra/verifiers/install-greater-cli.mjs` so the vendored files can be ' +
				're-derived from the pinned release; an unpresent CLI is a gate that cannot run'
		);
	}
	const asset = pin.greater?.cli_asset;
	const archive = readFileSync(tarballPath);
	const actual = digestOf(archive);
	if (typeof asset?.sha256 !== 'string' || actual !== asset.sha256) {
		throw new Error(
			`${CLI_TARBALL(repoRoot)} does not match the pinned release asset digest ` +
				`(pinned ${asset?.sha256 ?? 'absent'}, actual ${actual})`
		);
	}

	let entries;
	try {
		entries = readTarEntries(archive);
	} catch (error) {
		throw new Error(`the verified greater CLI archive could not be read: ${error.message}`);
	}
	const needed = [
		'package/package.json',
		'package/dist/utils/source-paths.js',
		'package/dist/utils/transform.js',
		'package/dist/utils/config.js',
	];
	const members = new Map(
		entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.name, entry])
	);
	for (const name of needed) {
		if (!members.has(name)) {
			throw new Error(
				`the verified greater CLI archive lacks ${name} — the derivation is incomplete`
			);
		}
	}

	let quarantine = null;
	const cleanup = () => {
		if (!quarantine) return;
		const directory = quarantine;
		quarantine = null;
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// A quarantine that outlives the run is untidy, never unsound.
		}
	};
	process.on('exit', cleanup);
	quarantine = mkdtempSync(join(tmpdir(), 'contentus-release-binding-'));
	try {
		extractEntries(entries, quarantine, 'package/');
	} catch (error) {
		throw new Error(`the verified greater CLI archive could not be extracted: ${error.message}`);
	}

	// The CLI's runtime dependencies (zod, fs-extra) are resolved from the
	// registry against the ranges declared inside the verified archive, with
	// lifecycle scripts disabled — SEC-7's exact dependency boundary.
	const install = spawnSync(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--omit=dev',
			'--no-save',
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--prefer-offline',
		],
		{ cwd: quarantine, encoding: 'utf8' }
	);
	if (install.error || install.status !== 0) {
		throw new Error(
			`the quarantined greater CLI derivation could not be built (npm exited ` +
				`${install.status ?? install.error?.message})`
		);
	}

	const sourcePathsModule = 'source-paths.js';
	const transformModule = 'transform.js';
	const moduleDirectory = 'dist/utils';
	const sourcePaths = await import(
		pathToFileURL(join(quarantine, moduleDirectory, sourcePathsModule)).href
	);
	const transform = await import(
		pathToFileURL(join(quarantine, moduleDirectory, transformModule)).href
	);
	return {
		buildSourcePathCandidates: sourcePaths.buildSourcePathCandidates,
		transformImports: transform.transformImports,
	};
}

/**
 * The release-binding walk. Returns a list of findings (empty when every
 * vendored file is bound to the pinned release).
 */
export async function verifyReleaseBinding({ repoRoot = process.cwd(), pin }) {
	const findings = [];
	const greater = pin.greater ?? {};
	const { release_tag, vendored_ref } = greater;
	const indexPin = greater.registry_index;
	if (
		typeof indexPin?.url !== 'string' ||
		!/^https:\/\//.test(indexPin.url) ||
		typeof indexPin.sha256 !== 'string' ||
		!/^[0-9a-f]{64}$/.test(indexPin.sha256)
	) {
		findings.push(
			'contentus-pinned-repo-contract.json: greater.registry_index must pin { url, sha256 } — ' +
				"without the release's own registry manifest there is nothing independent to bind bytes to"
		);
		return findings;
	}

	// --- The release's own registry manifest, verified before trust ------------
	const indexPath = INDEX_FILE(repoRoot, vendored_ref);
	if (!existsSync(indexPath)) {
		findings.push(
			`${indexPath} is missing — the release's own registry manifest must be committed ` +
				'beside its pin, so the vendored tree has an independent byte ground truth'
		);
		return findings;
	}
	const indexBytes = readFileSync(indexPath);
	const indexDigest = digestOf(indexBytes);
	if (indexDigest !== indexPin.sha256) {
		findings.push(
			`${indexPath} does not match the pinned registry-index digest ` +
				`(pinned ${indexPin.sha256}, actual ${indexDigest}) — the committed release artifact ` +
				'changed; fetch the bound URL to re-derive the true digest'
		);
		return findings;
	}
	let index;
	try {
		index = JSON.parse(indexBytes.toString('utf8'));
	} catch (error) {
		findings.push(`${indexPath} is not a JSON document: ${error.message}`);
		return findings;
	}
	const checksums = index.checksums;
	if (typeof checksums !== 'object' || checksums === null) {
		findings.push(
			`${indexPath} carries no \`checksums\` record — the release manifest is unreadable`
		);
		return findings;
	}

	// --- The working manifest: every installed file, disk and recorded checksum --
	let components;
	try {
		components = JSON.parse(readFileSync(join(repoRoot, 'components.json'), 'utf8'));
	} catch (error) {
		findings.push(`components.json could not be read: ${error.message}`);
		return findings;
	}
	const aliases = components.aliases ?? {};

	const records = [];
	for (const entry of components.installed ?? []) {
		for (const checksumEntry of entry.checksums ?? []) {
			const virtualPath = checksumEntry.path;
			const diskPath = resolveDiskPath(virtualPath, aliases);
			if (!diskPath || !existsSync(join(repoRoot, diskPath))) continue;
			records.push({
				entry: entry.name,
				virtualPath,
				diskPath,
				diskSri: sriOf(readFileSync(join(repoRoot, diskPath))),
				recordedChecksum: checksumEntry.checksum,
			});
		}
	}

	// --- The CLI derivation: the canonical path mapping and transform ---------
	let cli;
	try {
		cli = await loadCliDerivation({ repoRoot, pin });
	} catch (error) {
		findings.push(error.message);
		return findings;
	}
	const buildCandidates = (virtualPath) => cli.buildSourcePathCandidates({}, virtualPath);

	// --- Bind each record to the release --------------------------------------
	let canonicalCount = 0;
	let transformedCount = 0;
	for (const record of records) {
		const candidates = buildCandidates(record.virtualPath);
		const releaseCandidates = candidates
			.filter((repoPath) => typeof checksums[repoPath] === 'string')
			.map((repoPath) => {
				const sourcePath = join(SOURCE_ROOT(repoRoot), repoPath);
				return {
					repoPath,
					checksum: checksums[repoPath],
					// The release bytes for the transform path, verified against the
					// manifest's own canonical checksum before they are trusted.
					sourceBytes: existsSync(sourcePath) ? readFileSync(sourcePath) : null,
				};
			});
		if (releaseCandidates.length === 0) {
			findings.push(
				`${record.virtualPath}: no registry-index entry maps this installed path to a ` +
					`release file at ${release_tag}@${vendored_ref}`
			);
			continue;
		}

		const transformSource = (sourceBytes) => {
			if (sourceBytes === null) return null;
			const transformed = cli.transformImports(
				sourceBytes.toString('utf8'),
				components,
				record.virtualPath,
				{
					consumerRoot: resolve(repoRoot),
					sourceFilePath: record.diskPath,
				}
			);
			return transformed.content;
		};

		// The release bytes must be what the manifest says they are — this is what
		// makes the committed copy a copy OF THE RELEASE and not a self-authored
		// golden manifest.
		for (const candidate of releaseCandidates) {
			if (candidate.sourceBytes === null) continue;
			const actual = sriOf(candidate.sourceBytes);
			if (actual !== candidate.checksum) {
				findings.push(
					`gov-infra/release/source/${candidate.repoPath} does not match the release ` +
						`manifest's canonical checksum (manifest ${candidate.checksum}, actual ${actual})`
				);
				return findings;
			}
		}

		const verdict = verifyRecordAgainstRelease({
			diskSri: record.diskSri,
			recordedChecksum: record.recordedChecksum,
			candidates: releaseCandidates,
			transformSource: transformSource ?? null,
		});
		if (verdict.status === 'canonical' || verdict.status === 'canonical-recorded') {
			canonicalCount += 1;
		} else if (verdict.status === 'transformed') {
			transformedCount += 1;
		} else {
			findings.push(
				`${record.virtualPath} (installed as ${record.entry}): neither the on-disk bytes ` +
					`(${record.diskSri}) nor the recorded checksum (${record.recordedChecksum}) match the ` +
					`release's canonical file or the greater CLI's documented transform of it — a hand edit ` +
					`coordinated with the manifest is the only way to produce this (${release_tag}@${vendored_ref})`
			);
		}
	}

	if (findings.length === 0) {
		console.log(
			`  RELEASE-BINDING: ${records.length} vendored files bound to ${release_tag}@${vendored_ref} ` +
				`(${canonicalCount} canonical, ${transformedCount} CLI-transform); registry index ` +
				`${indexDigest.slice(0, 12)}… verified against the pin`
		);
	}
	return findings;
}

#!/usr/bin/env node
/**
 * Authenticate the committed Greater registry index from Greater's canonical
 * GitHub release/tag/ref identity. None of the network coordinates below come
 * from the mutable child contract: that contract is checked against this
 * independently derived source, never used to choose it.
 *
 * External provenance is GitHub's equaltoai/greater-components release, tag,
 * exact commit and the registry bytes fetched at that commit. This child
 * verifier and workflow remain review-visible, governed code pinned by CON-5;
 * they are not an external or immutable trust authority.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictJson, readStrictJson } from './strict-json.mjs';

export const GREATER_RELEASE = Object.freeze({
	owner: 'equaltoai',
	repo: 'greater-components',
	tag: 'greater-v0.13.7',
	commit: '4592c439b3b0e53ba47b7cddebab196c1f88abdf',
	registryPath: 'registry/index.json',
});

/**
 * The ONE release asset name contentus consumes — the `greater` CLI tarball.
 * Everything the release binding and SEC-7 execute derives from this asset,
 * so its identity is derived here from the canonical release facts above,
 * never read out of the mutable child contract.
 */
export const CLI_ASSET_NAME = 'greater-components-cli.tgz';

/** An upper bound on the CLI asset's size — the real tarball is ~230 KiB, so
 *  anything approaching this limit is a different artifact wearing the name. */
export const CLI_ASSET_MAX_BYTES = 50 * 1024 * 1024;

/** The asset content-types GitHub may serve for a release-asset download. */
const CLI_ASSET_CONTENT_TYPES = new Set([
	'application/x-gzip',
	'application/gzip',
	'application/octet-stream',
	'binary/octet-stream',
]);

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const API_ROOT = `https://api.github.com/repos/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}`;
const RELEASE_URL = `${API_ROOT}/releases/tags/${GREATER_RELEASE.tag}`;
const REF_URL = `${API_ROOT}/git/ref/tags/${GREATER_RELEASE.tag}`;
const RAW_URL = `https://raw.githubusercontent.com/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}/${GREATER_RELEASE.commit}/${GREATER_RELEASE.registryPath}`;
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalReleaseUrls() {
	return { release: RELEASE_URL, ref: REF_URL, raw: RAW_URL };
}

/**
 * The canonical download URL of the CLI asset, DERIVED from the fixed
 * owner/repo/tag/asset-name — the child contract never selects this source.
 * R5-2: the round-5 review showed `cli_asset.url` was child-contract bytes a
 * coordinated counterfeit could repoint; the URL is now a comparison subject
 * for the contract, not a network trust coordinate.
 */
export function cliAssetUrl() {
	return `https://github.com/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}/releases/download/${GREATER_RELEASE.tag}/${CLI_ASSET_NAME}`;
}

/**
 * Whether a release-asset `content_type` is one GitHub serves for the
 * tarball download. Anything else — `text/html`, `application/x-www-form-…
 * urlencoded` — is a sign the response is not the stored artifact.
 */
export function allowedAssetContentType(type) {
	const base = String(type ?? '').split(';')[0].trim().toLowerCase();
	return CLI_ASSET_CONTENT_TYPES.has(base);
}

/**
 * Whether a redirect hop's Location may be followed. GitHub's own release
 * download redirects from `github.com/…/releases/download/…` to its object
 * storage; any other host ends the chain as a finding. A `github.com`
 * Location is accepted only when it IS the canonical asset URL (a direct
 * serve); `objects.githubusercontent.com` is GitHub's object storage and
 * accepts the signed object path. A redirect to anything else — an
 * attacker's host, a mirror, a shortened URL, even the bare github.com
 * homepage — is rejected.
 */
export function redirectHopAllowed(location) {
	if (typeof location !== 'string' || !/^https:\/\//.test(location)) return false;
	try {
		const url = new URL(location);
		const host = url.host.toLowerCase();
		if (host === 'github.com') return location === cliAssetUrl();
		if (host === 'objects.githubusercontent.com') return true;
		return false;
	} catch {
		return false;
	}
}

/**
 * Select the CLI release asset from GitHub's authenticated release metadata.
 * Returns the asset record, or throws with the specific rejection. The
 * checks are the R5-2 identity surface: exactly one asset with the exact
 * expected name, its canonical `browser_download_url` (derived, so a wrong
 * host, owner, repo, tag, or renamed/duplicated asset each fails), and a
 * bounded positive size — GitHub stores the size at upload, so it is
 * external metadata, not child-controlled bytes.
 */
export function selectCliAsset(release) {
	const assets = Array.isArray(release?.assets) ? release.assets : [];
	const matches = assets.filter((asset) => asset?.name === CLI_ASSET_NAME);
	if (matches.length === 0)
		throw new Error(
			`the authenticated ${GREATER_RELEASE.tag} release carries no asset named ${CLI_ASSET_NAME} — ` +
				'missing, not renamed: a renamed asset is a different artifact'
		);
	if (matches.length > 1)
		throw new Error(
			`the authenticated ${GREATER_RELEASE.tag} release carries ${matches.length} assets named ` +
				`${CLI_ASSET_NAME} — duplicate asset names are not a canonical release`
		);
	const asset = matches[0];
	if (asset.browser_download_url !== cliAssetUrl())
		throw new Error(
			`the ${CLI_ASSET_NAME} asset resolves to ${JSON.stringify(asset.browser_download_url)}, not the ` +
				`canonical ${cliAssetUrl()} — wrong host, owner, repository, or tag`
		);
	const size = Number(asset.size);
	if (!Number.isInteger(size) || size <= 0 || size > CLI_ASSET_MAX_BYTES)
		throw new Error(
			`the ${CLI_ASSET_NAME} asset declares size ${JSON.stringify(asset.size)}, outside the bounded ` +
				`1..${CLI_ASSET_MAX_BYTES}-byte range — a different artifact wearing the name`
		);
	return asset;
}

export async function fetchBound(url, { json = true, maxBytes = 1024 * 1024 } = {}) {
	let response;
	try {
		response = await fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
			headers: json
				? {
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': 'equaltoai-contentus-release-verifier',
					}
				: { Accept: 'application/json', 'User-Agent': 'equaltoai-contentus-release-verifier' },
		});
	} catch (error) {
		throw new Error(
			`could not fetch canonical source ${url}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (response.url !== url) throw new Error(`canonical fetch ended at ${response.url}, not ${url}`);
	if (response.status !== 200)
		throw new Error(`canonical fetch ${url} returned HTTP ${response.status}`);
	const contentType = response.headers.get('content-type') ?? '';
	const allowedContentType = json
		? /^(?:application)\/(?:[^;]+\+)?json\b/i.test(contentType)
		: /^(?:application\/(?:[^;]+\+)?json|text\/plain)\b/i.test(contentType);
	if (!allowedContentType)
		throw new Error(
			`canonical fetch ${url} returned non-JSON content-type ${JSON.stringify(contentType)}`
		);
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new Error(
			`canonical fetch ${url} declares ${declared} bytes, above the ${maxBytes}-byte limit`
		);
	const chunks = [];
	let length = 0;
	for await (const chunk of response.body) {
		length += chunk.byteLength;
		if (length > maxBytes)
			throw new Error(`canonical fetch ${url} exceeded the ${maxBytes}-byte limit`);
		chunks.push(Buffer.from(chunk));
	}
	const bytes = Buffer.concat(chunks);
	if (
		Number.isFinite(declared) &&
		!response.headers.get('content-encoding') &&
		declared !== bytes.length
	)
		throw new Error(
			`canonical fetch ${url} was truncated: declared ${declared} bytes, received ${bytes.length}`
		);
	return bytes;
}

async function fetchJson(url) {
	const bytes = await fetchBound(url);
	return parseStrictJson(bytes.toString('utf8'), url);
}

export async function resolveTagCommit(ref) {
	if (ref?.ref !== `refs/tags/${GREATER_RELEASE.tag}`)
		throw new Error(`GitHub ref does not identify refs/tags/${GREATER_RELEASE.tag}`);
	let object = ref.object;
	if (object?.type === 'tag') {
		if (typeof object.sha !== 'string' || !/^[0-9a-f]{40}$/.test(object.sha))
			throw new Error('GitHub annotated tag object has no canonical SHA');
		const tagUrl = `${API_ROOT}/git/tags/${object.sha}`;
		const tag = await fetchJson(tagUrl);
		if (tag?.tag !== GREATER_RELEASE.tag)
			throw new Error(`annotated tag names ${tag?.tag}, not ${GREATER_RELEASE.tag}`);
		object = tag.object;
	}
	if (object?.type !== 'commit' || object.sha !== GREATER_RELEASE.commit)
		throw new Error(
			`Greater tag resolves to ${object?.type ?? 'unknown'} ${object?.sha ?? 'unknown'}, not commit ${GREATER_RELEASE.commit}`
		);
	return object.sha;
}

export function validateReleaseContract(contract) {
	const pin = contract.greater?.registry_index;
	if (
		contract.greater?.release_tag !== GREATER_RELEASE.tag ||
		contract.greater?.vendored_ref !== GREATER_RELEASE.commit
	)
		throw new Error(
			`${CONTRACT}: Greater release/tag commit differs from the verifier's canonical release facts`
		);
	if (pin?.url !== RAW_URL)
		throw new Error(
			`${CONTRACT}: greater.registry_index.url differs from the canonical commit/path; contract URLs never select the trust root`
		);
	if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256))
		throw new Error(`${CONTRACT}: greater.registry_index.sha256 must be a lowercase 64-hex digest`);
	// R5-2: the CLI asset URL is DERIVED from the canonical release facts; the
	// contract's `cli_asset.url` is a comparison subject, never a network
	// coordinate. The SHA-256 stays a pin — and is described honestly as
	// CHILD-GOVERNED: GitHub's release API exposes no digest for a release
	// asset, so the external part of this trust root is the identity surface
	// (name, browser_download_url, size, host) authenticated below, and the
	// digest is this repository's own pin of the bytes that identity serves.
	const cliAsset = contract.greater?.cli_asset;
	if (cliAsset?.url !== cliAssetUrl())
		throw new Error(
			`${CONTRACT}: greater.cli_asset.url differs from the canonical release asset URL ` +
				`(${cliAssetUrl()}); contract URLs never select the trust root`
		);
	if (typeof cliAsset?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cliAsset.sha256))
		throw new Error(
			`${CONTRACT}: greater.cli_asset.sha256 must be a lowercase 64-hex digest — the child-governed ` +
				'pin of the bytes the canonical identity serves'
		);
	return pin;
}

/**
 * Fetch the CLI asset from the DERIVED canonical URL with bounded checks —
 * status, redirect chain, content-type, size, and truncation — returning the
 * exact stored bytes. Every hop's Location must be one of the two allowed
 * hosts; the final URL must be GitHub's own object storage or the canonical
 * URL itself; the response must be 200, uncompressed, with an allowed
 * content-type; and the received byte count must match the size GitHub's own
 * release metadata recorded at upload.
 */
export async function fetchCliAsset(asset) {
	const url = asset?.browser_download_url ?? cliAssetUrl();
	const expectedSize = Number(asset?.size);
	const maxBytes = CLI_ASSET_MAX_BYTES;
	let current = url;
	let response = null;
	for (let hop = 0; hop < 6; hop += 1) {
		let attempt;
		try {
			attempt = await fetch(current, {
				redirect: 'manual',
				signal: AbortSignal.timeout(30_000),
				headers: {
					Accept: 'application/octet-stream',
					'User-Agent': 'equaltoai-contentus-release-verifier',
				},
			});
		} catch (error) {
			throw new Error(
				`could not fetch the greater CLI asset ${current}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (attempt.status >= 300 && attempt.status < 400) {
			const location = attempt.headers.get('location');
			if (!redirectHopAllowed(location))
				throw new Error(
					`the greater CLI asset redirects to ${JSON.stringify(location)} — a redirect outside ` +
						"GitHub's own release download chain ends the authentication"
				);
			current = location;
			continue;
		}
		response = attempt;
		break;
	}
	if (!response || response.status !== 200)
		throw new Error(`the greater CLI asset fetch ended at HTTP ${response?.status ?? 'none'}`);
	if (!redirectHopAllowed(response.url) && response.url !== url)
		throw new Error(
			`the greater CLI asset fetch ended at ${response.url}, not GitHub's release download chain`
		);
	if (response.headers.get('content-encoding'))
		throw new Error(
			'the greater CLI asset is served compressed (content-encoding present) — the digest and size ' +
				'bindings require the stored bytes, uncompressed'
		);
	const contentType = response.headers.get('content-type') ?? '';
	if (!allowedAssetContentType(contentType))
		throw new Error(
			`the greater CLI asset download returned content-type ${JSON.stringify(contentType)}, which is ` +
				'not a stored tarball'
		);
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new Error(
			`the greater CLI asset download declares ${declared} bytes, above the ${maxBytes}-byte limit`
		);
	const chunks = [];
	let length = 0;
	for await (const chunk of response.body) {
		length += chunk.byteLength;
		if (length > maxBytes)
			throw new Error(`the greater CLI asset download exceeded the ${maxBytes}-byte limit`);
		chunks.push(Buffer.from(chunk));
	}
	const bytes = Buffer.concat(chunks);
	if (Number.isFinite(declared) && declared !== bytes.length)
		throw new Error(
			`the greater CLI asset download was truncated: declared ${declared} bytes, received ${bytes.length}`
		);
	if (Number.isInteger(expectedSize) && expectedSize > 0 && bytes.length !== expectedSize)
		throw new Error(
			`the greater CLI asset download is ${bytes.length} bytes, but GitHub's release metadata records ` +
				`${expectedSize} — a different artifact wearing the name`
		);
	return { bytes, size: bytes.length, finalUrl: response.url };
}

export async function authenticateReleaseIndex() {
	const contract = readStrictJson(CONTRACT);
	const pin = validateReleaseContract(contract);

	const release = await fetchJson(RELEASE_URL);
	if (
		release?.tag_name !== GREATER_RELEASE.tag ||
		release?.draft !== false ||
		release?.html_url !==
			`https://github.com/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}/releases/tag/${GREATER_RELEASE.tag}`
	)
		throw new Error(
			`GitHub release metadata does not identify the published canonical ${GREATER_RELEASE.tag} release`
		);
	await resolveTagCommit(await fetchJson(REF_URL));

	const fetched = await fetchBound(RAW_URL, { json: false, maxBytes: 8 * 1024 * 1024 });
	parseStrictJson(fetched.toString('utf8'), RAW_URL);
	const fetchedDigest = digestOf(fetched);
	if (fetchedDigest !== pin.sha256)
		throw new Error(
			`canonical registry index hashes to ${fetchedDigest}, not contract digest ${pin.sha256}`
		);
	const committedIndex = join(
		'gov-infra',
		'release',
		`registry-index-${GREATER_RELEASE.commit}.json`
	);
	if (!existsSync(committedIndex)) throw new Error(`${committedIndex} is missing`);
	const committed = readFileSync(committedIndex);
	parseStrictJson(committed.toString('utf8'), committedIndex);
	if (!committed.equals(fetched))
		throw new Error(
			`${committedIndex} is not byte-identical to the canonical Greater registry index`
		);

	// R5-2: the CLI asset, bound to the SAME authenticated release. The asset's
	// identity — name, browser_download_url, size — comes from the release
	// metadata GitHub served above; the download is bounded and digest-checked
	// against the child-governed pin, stated as such.
	const asset = selectCliAsset(release);
	const { bytes, size, finalUrl } = await fetchCliAsset(asset);
	const assetDigest = digestOf(bytes);
	const pinnedDigest = contract.greater?.cli_asset?.sha256;
	if (assetDigest !== pinnedDigest)
		throw new Error(
			`the authenticated greater CLI asset hashes to ${assetDigest}, not the pinned ${pinnedDigest}`
		);

	console.log(`Greater release authenticated: ${GREATER_RELEASE.tag} -> ${GREATER_RELEASE.commit}`);
	console.log(`Registry index authenticated: ${RAW_URL}`);
	console.log(`  sha256 ${fetchedDigest}; committed copy is byte-identical`);
	console.log(`CLI asset authenticated: ${cliAssetUrl()}`);
	console.log(
		`  name=${CLI_ASSET_NAME} size=${size} bytes (GitHub's recorded size, bounded), final host ` +
			`${new URL(finalUrl).host}`
	);
	console.log(
		`  sha256 ${assetDigest} verified against the ${CONTRACT} pin — a CHILD-GOVERNED pin, stated as ` +
			"such: GitHub's release API exposes no digest for the asset, so the external part of this " +
			'trust root is the identity surface above, not the digest'
	);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))
) {
	authenticateReleaseIndex().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		console.error('Canonical Greater provenance could not be authenticated; failing closed.');
		process.exitCode = 1;
	});
}

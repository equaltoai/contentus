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

const CONTRACT = 'gov-infra/planning/contentus-pinned-repo-contract.json';
const API_ROOT = `https://api.github.com/repos/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}`;
const RELEASE_URL = `${API_ROOT}/releases/tags/${GREATER_RELEASE.tag}`;
const REF_URL = `${API_ROOT}/git/ref/tags/${GREATER_RELEASE.tag}`;
const RAW_URL = `https://raw.githubusercontent.com/${GREATER_RELEASE.owner}/${GREATER_RELEASE.repo}/${GREATER_RELEASE.commit}/${GREATER_RELEASE.registryPath}`;
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalReleaseUrls() {
	return { release: RELEASE_URL, ref: REF_URL, raw: RAW_URL };
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
	return pin;
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

	console.log(`Greater release authenticated: ${GREATER_RELEASE.tag} -> ${GREATER_RELEASE.commit}`);
	console.log(`Registry index authenticated: ${RAW_URL}`);
	console.log(`  sha256 ${fetchedDigest}; committed copy is byte-identical`);
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

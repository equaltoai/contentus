import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CLI_ASSET_NAME,
	GREATER_RELEASE,
	allowedAssetContentType,
	canonicalReleaseUrls,
	cliAssetUrl,
	redirectHopAllowed,
	resolveTagCommit,
	selectCliAsset,
	validateReleaseContract,
} from '../gov-infra/verifiers/authenticate-release-index.mjs';

test('release authentication derives canonical coordinates internally', () => {
	assert.deepEqual(GREATER_RELEASE, {
		owner: 'equaltoai',
		repo: 'greater-components',
		tag: 'greater-v0.13.7',
		commit: '4592c439b3b0e53ba47b7cddebab196c1f88abdf',
		registryPath: 'registry/index.json',
	});
	assert.deepEqual(canonicalReleaseUrls(), {
		release:
			'https://api.github.com/repos/equaltoai/greater-components/releases/tags/greater-v0.13.7',
		ref: 'https://api.github.com/repos/equaltoai/greater-components/git/ref/tags/greater-v0.13.7',
		raw: 'https://raw.githubusercontent.com/equaltoai/greater-components/4592c439b3b0e53ba47b7cddebab196c1f88abdf/registry/index.json',
	});
});

test('the CLI asset URL is derived from the canonical release facts (R5-2)', () => {
	assert.equal(
		cliAssetUrl(),
		'https://github.com/equaltoai/greater-components/releases/download/greater-v0.13.7/greater-components-cli.tgz'
	);
	assert.equal(CLI_ASSET_NAME, 'greater-components-cli.tgz');
});

test('coordinated contract repointing cannot select counterfeit release bytes', () => {
	const canonical = {
		greater: {
			release_tag: GREATER_RELEASE.tag,
			vendored_ref: GREATER_RELEASE.commit,
			registry_index: {
				url: canonicalReleaseUrls().raw,
				sha256: '0'.repeat(64),
			},
			cli_asset: {
				url: cliAssetUrl(),
				sha256: '1'.repeat(64),
			},
		},
	};
	assert.equal(validateReleaseContract(canonical), canonical.greater.registry_index);
	for (const counterfeit of [
		{ ...canonical, greater: { ...canonical.greater, release_tag: 'greater-v9.9.9' } },
		{ ...canonical, greater: { ...canonical.greater, vendored_ref: '1'.repeat(40) } },
		{
			...canonical,
			greater: {
				...canonical.greater,
				registry_index: {
					...canonical.greater.registry_index,
					url: 'https://example.com/counterfeit.json',
				},
			},
		},
		{
			...canonical,
			greater: {
				...canonical.greater,
				cli_asset: {
					...canonical.greater.cli_asset,
					url: 'https://evil.example.com/greater-components-cli.tgz',
				},
			},
		},
		{
			...canonical,
			greater: {
				...canonical.greater,
				cli_asset: {
					...canonical.greater.cli_asset,
					url: 'https://github.com/equaltoai/greater-components/releases/download/greater-v0.13.7/renamed.tgz',
				},
			},
		},
		{
			...canonical,
			greater: {
				...canonical.greater,
				cli_asset: {
					...canonical.greater.cli_asset,
					sha256: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
				},
			},
		},
		{ ...canonical, greater: { ...canonical.greater, cli_asset: undefined } },
	]) {
		assert.throws(
			() => validateReleaseContract(counterfeit),
			/canonical release facts|canonical commit\/path|canonical release asset URL|64-hex digest/
		);
	}
	// A WELL-FORMED but different digest is a comparison subject, not a
	// self-consistency claim: the pin is checked against the bytes the
	// canonical identity serves at fetch time, so contract validation cannot
	// (and must not) reject a changed 64-hex value — that is the honest,
	// child-governed position the round-5 remediation records.
	const changedDigest = {
		...canonical,
		greater: {
			...canonical.greater,
			cli_asset: { ...canonical.greater.cli_asset, sha256: '9'.repeat(64) },
		},
	};
	assert.equal(validateReleaseContract(changedDigest), canonical.greater.registry_index);
});

test('the canonical tag must resolve to the exact Greater release commit', async () => {
	await assert.rejects(
		resolveTagCommit({
			ref: 'refs/tags/greater-v0.13.7',
			object: { type: 'commit', sha: '0000000000000000000000000000000000000000' },
		}),
		/not commit 4592c439/
	);
	await assert.rejects(
		resolveTagCommit({
			ref: 'refs/tags/counterfeit',
			object: { type: 'commit', sha: GREATER_RELEASE.commit },
		}),
		/does not identify/
	);
	assert.equal(
		await resolveTagCommit({
			ref: 'refs/tags/greater-v0.13.7',
			object: { type: 'commit', sha: GREATER_RELEASE.commit },
		}),
		GREATER_RELEASE.commit
	);
});

/* ============================================================
   R5-2 — the CLI asset identity surface, offline
   ============================================================ */

const canonicalAsset = {
	name: CLI_ASSET_NAME,
	browser_download_url: cliAssetUrl(),
	size: 236292,
	content_type: 'application/x-gzip',
};

test('selectCliAsset picks exactly the canonical asset (R5-2)', () => {
	const asset = selectCliAsset({ assets: [canonicalAsset] });
	assert.equal(asset.name, CLI_ASSET_NAME);
	assert.equal(asset.size, 236292);
});

test('selectCliAsset rejects missing, duplicate, renamed, wrong-URL, and unbounded assets (R5-2)', () => {
	for (const [label, release] of [
		['missing', { assets: [] }],
		['duplicate', { assets: [canonicalAsset, canonicalAsset] }],
		[
			'renamed',
			{
				assets: [
					{
						...canonicalAsset,
						name: 'greater-components-cli-evil.tgz',
						browser_download_url:
							'https://github.com/equaltoai/greater-components/releases/download/greater-v0.13.7/greater-components-cli-evil.tgz',
					},
				],
			},
		],
		[
			'wrong-host url',
			{
				assets: [
					{
						...canonicalAsset,
						browser_download_url: 'https://evil.example.com/greater-components-cli.tgz',
					},
				],
			},
		],
		[
			'wrong-owner url',
			{
				assets: [
					{
						...canonicalAsset,
						browser_download_url:
							'https://github.com/other/greater-components/releases/download/greater-v0.13.7/greater-components-cli.tgz',
					},
				],
			},
		],
		[
			'wrong-tag url',
			{
				assets: [
					{
						...canonicalAsset,
						browser_download_url:
							'https://github.com/equaltoai/greater-components/releases/download/greater-v9.9.9/greater-components-cli.tgz',
					},
				],
			},
		],
		['zero size', { assets: [{ ...canonicalAsset, size: 0 }] }],
		['negative size', { assets: [{ ...canonicalAsset, size: -1 }] }],
		['oversize', { assets: [{ ...canonicalAsset, size: 60 * 1024 * 1024 }] }],
	]) {
		assert.throws(
			() => selectCliAsset(release),
			/no asset named|duplicate asset names|not the canonical|outside the bounded/,
			label
		);
	}
});

test('asset content-type and redirect-hop bounds reject non-GitHub responses (R5-2)', () => {
	assert.equal(allowedAssetContentType('application/x-gzip'), true);
	assert.equal(allowedAssetContentType('application/gzip'), true);
	assert.equal(allowedAssetContentType('application/octet-stream'), true);
	assert.equal(allowedAssetContentType('APPLICATION/OCTET-STREAM'), true);
	assert.equal(allowedAssetContentType('text/html'), false);
	assert.equal(allowedAssetContentType('application/x-www-form-urlencoded'), false);
	assert.equal(allowedAssetContentType(null), false);

	assert.equal(
		redirectHopAllowed(
			'https://objects.githubusercontent.com/github-production-release-asset-2e65be/…'
		),
		true
	);
	// The host CI observed for the real greater-components-cli.tgz download
	// (round-5): GitHub's release-asset object storage, with the signed path.
	assert.equal(
		redirectHopAllowed(
			'https://release-assets.githubusercontent.com/github-production-release-asset/1035528441/eb290b71-88ab-4ac0-af76-a75311a37cc5?sp=r&sv=2018-11-09'
		),
		true
	);
	assert.equal(
		redirectHopAllowed(
			'https://github.com/equaltoai/greater-components/releases/download/greater-v0.13.7/greater-components-cli.tgz'
		),
		true
	);
	assert.equal(redirectHopAllowed('https://evil.example.com/greater-components-cli.tgz'), false);
	assert.equal(redirectHopAllowed('http://objects.githubusercontent.com/x'), false);
	assert.equal(redirectHopAllowed('https://release-assets.example.com/x'), false);
	assert.equal(redirectHopAllowed('/relative/redirect'), false);
	assert.equal(redirectHopAllowed('https://github.com'), false);
});

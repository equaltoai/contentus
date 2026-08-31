import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	GREATER_RELEASE,
	canonicalReleaseUrls,
	resolveTagCommit,
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

test('coordinated contract repointing cannot select counterfeit release bytes', () => {
	const canonical = {
		greater: {
			release_tag: GREATER_RELEASE.tag,
			vendored_ref: GREATER_RELEASE.commit,
			registry_index: {
				url: canonicalReleaseUrls().raw,
				sha256: '0'.repeat(64),
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
	]) {
		assert.throws(
			() => validateReleaseContract(counterfeit),
			/canonical release facts|canonical commit\/path/
		);
	}
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

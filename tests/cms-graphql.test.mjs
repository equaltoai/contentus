import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFeatureDisabledError } from '../src/lib/cms/graphql.ts';

test('feature-disabled classification is total over malformed error entries', () => {
	const malformed = [null, undefined, false, 17, 'failure', {}, { message: null }];

	assert.doesNotThrow(() => isFeatureDisabledError(malformed));
	assert.equal(isFeatureDisabledError(malformed), false);
	assert.equal(
		isFeatureDisabledError([...malformed, { message: 'Long-form publishing is disabled' }]),
		true
	);
});

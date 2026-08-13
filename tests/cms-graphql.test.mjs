import assert from 'node:assert/strict';
import { test } from 'node:test';

import { graphqlRequest, isFeatureDisabledError } from '../src/lib/cms/graphql.ts';

test('feature-disabled classification is total over malformed error entries', () => {
	const malformed = [null, undefined, false, 17, 'failure', {}, { message: null }];

	assert.doesNotThrow(() => isFeatureDisabledError(malformed));
	assert.equal(isFeatureDisabledError(malformed), false);
	assert.equal(
		isFeatureDisabledError([...malformed, { message: 'Long-form publishing is disabled' }]),
		true
	);
});

/**
 * Act-as (agent share-grants, lesser v1.6.5). The transport's one job here is
 * honest transmission: send `X-Lesser-Act-As` exactly when the caller asked
 * for it, never invent it. Which operations lesser honors the header on is
 * lesser's contract, not something this transport can see.
 */
async function captureHeaders(options) {
	const originalFetch = globalThis.fetch;
	let sent;
	globalThis.fetch = async (input, init = {}) => {
		sent = new Headers(init.headers);
		return new Response(JSON.stringify({ data: {} }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	try {
		await graphqlRequest('{ __typename }', {}, options);
	} finally {
		globalThis.fetch = originalFetch;
	}
	return sent;
}

test('actAs sends X-Lesser-Act-As with the agent username', async () => {
	const headers = await captureHeaders({ accessToken: 'tok', actAs: 'scribe' });
	assert.equal(headers.get('x-lesser-act-as'), 'scribe');
});

test('actAs omitted or empty sends no act-as header', async () => {
	for (const actAs of [undefined, null, '']) {
		const headers = await captureHeaders({ accessToken: 'tok', actAs });
		assert.equal(headers.get('x-lesser-act-as'), null);
	}
});

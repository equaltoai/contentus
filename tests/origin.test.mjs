import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	canonicalArticleUrl,
	graphqlEndpointForOrigin,
	resolveRequestOrigin,
} from '../src/lib/cms/origin.ts';

/**
 * No hard-coded domains is a non-negotiable (product design §8), which makes
 * origin derivation security-relevant: a spoofed Host header would otherwise
 * land in a canonical URL, an OG tag, or a server-side fetch target.
 */

test('origin derives from the Host header', () => {
	assert.equal(resolveRequestOrigin({ host: 'dev.example.com' }), 'https://dev.example.com');
});

test('x-forwarded-host wins over host', () => {
	assert.equal(
		resolveRequestOrigin({ host: 'internal.local', 'x-forwarded-host': 'dev.example.com' }),
		'https://dev.example.com'
	);
});

test('scheme honours x-forwarded-proto but defaults to https', () => {
	assert.equal(
		resolveRequestOrigin({ host: 'localhost:5173', 'x-forwarded-proto': 'http' }),
		'http://localhost:5173'
	);
	assert.equal(resolveRequestOrigin({ host: 'example.com' }), 'https://example.com');
	// An unrecognised proto must not be echoed into the URL.
	assert.equal(
		resolveRequestOrigin({ host: 'example.com', 'x-forwarded-proto': 'javascript' }),
		'https://example.com'
	);
});

test('a malformed or injected host is rejected rather than guessed', () => {
	for (const host of [
		'example.com/path',
		'example.com evil.com',
		'https://example.com',
		'example.com\r\nX-Injected: 1',
		'',
	]) {
		assert.equal(resolveRequestOrigin({ host }), null, `expected null for host: ${host}`);
	}
});

test('a missing host yields null rather than a fabricated origin', () => {
	assert.equal(resolveRequestOrigin(undefined), null);
	assert.equal(resolveRequestOrigin({}), null);
	assert.equal(graphqlEndpointForOrigin(null), null);
	assert.equal(canonicalArticleUrl(null, 'hello'), null);
});

test('canonical article identity follows lesser, not the contentus route', () => {
	// lesser's contract: https://<domain>/articles/<slug> — NOT /l/articles/<slug>.
	assert.equal(
		canonicalArticleUrl('https://example.com', 'hello-world'),
		'https://example.com/articles/hello-world'
	);
});

test('a slug is encoded into the canonical URL', () => {
	assert.equal(
		canonicalArticleUrl('https://example.com', 'a b/c'),
		'https://example.com/articles/a%20b%2Fc'
	);
});

test('the GraphQL endpoint is derived, never hard-coded', () => {
	assert.equal(
		graphqlEndpointForOrigin('https://dev.example.com'),
		'https://dev.example.com/api/graphql'
	);
});

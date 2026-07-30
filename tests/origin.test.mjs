import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	canonicalArticleUrl,
	graphqlEndpointForOrigin,
	resolveRequestOrigin,
} from '../src/lib/cms/origin.ts';

/**
 * No hard-coded domains is a non-negotiable (product design §8), which makes
 * origin derivation security-relevant: this value becomes the URL the SERVER
 * fetches GraphQL from, plus the canonical URL and OG tags the page advertises.
 * Which header is allowed to decide it is therefore a security boundary, not a
 * detail of deployment plumbing.
 */

test('origin derives from the edge-injected host', () => {
	// lesser's CloudFront function overwrites x-lesser-forwarded-host with the
	// verified viewer Host on every request, so it is the only forwarded host
	// worth believing — and the only one consulted.
	assert.equal(
		resolveRequestOrigin({ 'x-lesser-forwarded-host': 'dev.example.com' }),
		'https://dev.example.com'
	);
});

test('an ambient Host header is not a trusted host', () => {
	// The regression this pins: `host` used to be consulted as a fallback, so a
	// request that reached the handler without passing the edge — carrying
	// whatever Host its caller chose — decided the URL the SERVER fetches.
	assert.equal(resolveRequestOrigin({ host: 'attacker.example' }), null);
	assert.equal(
		resolveRequestOrigin({ host: 'attacker.example', 'x-forwarded-host': 'attacker.example' }),
		null
	);
	// Present but empty is still absent.
	assert.equal(
		resolveRequestOrigin({ host: 'instance.example.com', 'x-lesser-forwarded-host': '' }),
		null
	);
});

test('the trusted host wins over every host a caller can set', () => {
	// CloudFront forwards viewer headers to /l/* verbatim, so this is a bag an
	// anonymous request can actually produce. None of it may displace the one
	// header the edge overwrites.
	assert.equal(
		resolveRequestOrigin({
			host: 'attacker.example',
			'x-lesser-forwarded-host': 'instance.example.com',
			'x-forwarded-host': 'evil.example',
			forwarded: 'host=evil.example;proto=http',
		}),
		'https://instance.example.com'
	);
	// Nor may a viewer downgrade the scheme of a server-side fetch.
	assert.equal(
		resolveRequestOrigin({
			'x-lesser-forwarded-host': 'instance.example.com',
			'x-forwarded-proto': 'http',
		}),
		'https://instance.example.com'
	);
});

test('scheme honours the edge-injected proto but defaults to https', () => {
	assert.equal(
		resolveRequestOrigin({
			'x-lesser-forwarded-host': 'localhost:5173',
			'x-lesser-forwarded-proto': 'http',
		}),
		'http://localhost:5173'
	);
	assert.equal(
		resolveRequestOrigin({ 'x-lesser-forwarded-host': 'example.com' }),
		'https://example.com'
	);
	// An unrecognised proto must not be echoed into the URL.
	assert.equal(
		resolveRequestOrigin({
			'x-lesser-forwarded-host': 'example.com',
			'x-lesser-forwarded-proto': 'javascript',
		}),
		'https://example.com'
	);
});

test('a malformed or injected trusted host is rejected rather than guessed', () => {
	for (const host of [
		'example.com/path',
		'example.com evil.com',
		'https://example.com',
		'example.com\r\nX-Injected: 1',
		'user@example.com',
		'',
	]) {
		assert.equal(
			resolveRequestOrigin({ 'x-lesser-forwarded-host': host }),
			null,
			`expected null for host: ${host}`
		);
	}
});

test('a malformed trusted host fails closed rather than reaching for another', () => {
	// A spoofed-looking value in the one header that should be unspoofable is a
	// reason to stop, not a reason to fall back to a host nobody verified.
	assert.equal(
		resolveRequestOrigin({
			host: 'instance.example.com',
			'x-lesser-forwarded-host': 'evil.example/path',
		}),
		null
	);
});

test('a forwarded host list collapses to its first entry, lower-cased', () => {
	assert.equal(
		resolveRequestOrigin({ 'x-lesser-forwarded-host': 'Dev.Example.COM, proxy.internal' }),
		'https://dev.example.com'
	);
});

test('a missing trusted host yields null rather than a fabricated origin', () => {
	assert.equal(resolveRequestOrigin(undefined), null);
	assert.equal(resolveRequestOrigin({}), null);
	// And a null origin produces no endpoint and no canonical, so failing closed
	// propagates as absence rather than as a URL pointing somewhere unchosen.
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

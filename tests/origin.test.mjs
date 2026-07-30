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

test('origin derives from the Host header', () => {
	assert.equal(resolveRequestOrigin({ host: 'dev.example.com' }), 'https://dev.example.com');
});

test('the edge-injected host wins over host', () => {
	// lesser's CloudFront function overwrites x-lesser-forwarded-host with the
	// verified viewer Host, so it is the only forwarded host worth believing.
	assert.equal(
		resolveRequestOrigin({ host: 'internal.local', 'x-lesser-forwarded-host': 'dev.example.com' }),
		'https://dev.example.com'
	);
});

test('viewer-controlled forwarding headers never steer the origin', () => {
	// CloudFront forwards viewer headers to /l/* verbatim. If x-forwarded-host
	// could win, an anonymous request would choose the host the server fetches
	// GraphQL from — SSRF — and the canonical/OG host the page advertises.
	assert.equal(
		resolveRequestOrigin({
			host: 'instance.example.com',
			'x-forwarded-host': 'evil.example',
		}),
		'https://instance.example.com'
	);
	assert.equal(
		resolveRequestOrigin({
			host: 'origin.internal',
			'x-lesser-forwarded-host': 'instance.example.com',
			'x-forwarded-host': 'evil.example',
		}),
		'https://instance.example.com'
	);
	// Nor may a viewer downgrade the scheme of a server-side fetch.
	assert.equal(
		resolveRequestOrigin({ host: 'instance.example.com', 'x-forwarded-proto': 'http' }),
		'https://instance.example.com'
	);
});

test('scheme honours the edge-injected proto but defaults to https', () => {
	assert.equal(
		resolveRequestOrigin({ host: 'localhost:5173', 'x-lesser-forwarded-proto': 'http' }),
		'http://localhost:5173'
	);
	assert.equal(resolveRequestOrigin({ host: 'example.com' }), 'https://example.com');
	// An unrecognised proto must not be echoed into the URL.
	assert.equal(
		resolveRequestOrigin({ host: 'example.com', 'x-lesser-forwarded-proto': 'javascript' }),
		'https://example.com'
	);
});

test('a malformed or injected host is rejected rather than guessed', () => {
	for (const host of [
		'example.com/path',
		'example.com evil.com',
		'https://example.com',
		'example.com\r\nX-Injected: 1',
		'user@example.com',
		'',
	]) {
		assert.equal(resolveRequestOrigin({ host }), null, `expected null for host: ${host}`);
	}
});

test('a malformed trusted host fails closed instead of falling through', () => {
	// Matching lesser's SSR host: the first PRESENT forwarded host is the one
	// that gets sanitized. A spoofed-looking value is a reason to stop, not a
	// reason to try the next header.
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

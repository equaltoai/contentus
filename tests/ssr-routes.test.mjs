import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadHandler, renderRoute } from '../scripts/render-routes.mjs';

/**
 * SSR-every-route is a hard requirement, not a performance preference: lesser
 * performs no SPA fallback under `/l/*`, so a route that fails to server-render
 * is an error page on the instance rather than a slow first paint.
 *
 * These run against the built handler, so they require `pnpm run build:client`
 * and `pnpm run build:server` first.
 */

const handler = await loadHandler();

async function render(path, expectStatus = 200) {
	return renderRoute(handler, { name: path, path, expectStatus });
}

test('every route server-renders a complete document', async () => {
	for (const path of [
		'/l/',
		'/l/articles/example',
		'/l/series/example',
		'/l/categories/example',
		'/l/auth/callback',
	]) {
		const result = await render(path);
		assert.equal(result.status, 200, `${path} should render`);
		assert.match(result.html, /^<!doctype html>/i, `${path} should emit a full document`);
		assert.ok(result.html.includes('contentus-shell'), `${path} should render the shell`);
	}
});

test('an unknown route renders with a real 404 status', async () => {
	const result = await render('/l/no-such-surface', 404);
	assert.equal(result.status, 404);
	assert.match(result.html, /Not found/i);
});

test('the base path is stripped, so bare and prefixed paths agree', async () => {
	const prefixed = await render('/l/');
	const bare = await render('/');
	assert.equal(prefixed.status, bare.status);
});

test('every response carries a strict CSP header', async () => {
	for (const path of ['/l/', '/l/articles/example', '/l/no-such-surface']) {
		const { headers } = await render(path, path.includes('no-such') ? 404 : 200);
		const csp = headers['content-security-policy'];

		assert.ok(csp, `${path} must set a CSP header`);
		assert.doesNotMatch(csp, /unsafe-inline/, `${path} must not allow unsafe-inline`);
		assert.doesNotMatch(csp, /unsafe-eval/, `${path} must not allow unsafe-eval`);
		assert.match(csp, /object-src 'none'/);
		assert.match(csp, /frame-ancestors 'none'/);
	}
});

test('hydration data travels out of band, not in an inline script', async () => {
	const result = await render('/l/');

	// The document advertises an external same-origin JSON endpoint...
	assert.match(result.html, /rel="facetheory-hydration"/);
	// ...and carries no inline script body at all.
	for (const match of result.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		assert.equal((match[1] ?? '').trim(), '', 'no <script> may have an inline body');
	}
});

test('the hydration endpoint returns JSON and is not cached', async () => {
	const result = await render('/l/_facetheory/hydration?path=%2F');

	assert.equal(result.status, 200);
	assert.match(result.headers['content-type'] ?? '', /application\/json/);
	assert.equal(result.headers['cache-control'], 'no-store');
	assert.equal(result.headers['x-content-type-options'], 'nosniff');
	assert.doesNotThrow(() => JSON.parse(result.html));
});

test('an unreachable instance degrades to a designed state, not a 500', async () => {
	// No instance is reachable from the build host, so every loader fails. The
	// page must still render and explain itself.
	const result = await render('/l/');

	assert.equal(result.status, 200);
	assert.ok(
		/unavailable|not answer|could not be reached|No articles/i.test(result.html),
		'a failed load should render an explained state'
	);
});

test('anonymous SSR output shows only the anonymous nav', async () => {
	// The session lives in sessionStorage, so the server render is always
	// anonymous — which is what makes the public surfaces cacheable.
	const result = await render('/l/');

	assert.ok(result.html.includes('Articles'));
	assert.ok(result.html.includes('Timelines'));
	assert.ok(result.html.includes('Agents'));
	assert.ok(!result.html.includes('>Review<'), 'Review is authenticated-only');
	assert.ok(!result.html.includes('>Messages<'), 'Messages is authenticated-only');
});

test('no article body is emitted when lesser returns no rendered HTML', async () => {
	const result = await render('/l/articles/example');
	assert.doesNotMatch(result.html, /gr-blog-article__content/);
});

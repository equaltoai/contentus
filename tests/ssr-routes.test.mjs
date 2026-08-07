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

test('a query-suffixed import of the handler still renders every route', async () => {
	// The regression this pins: lesser's SSR host imports the installed entry as
	// `handler.mjs?install=<id>` to scope the module cache per install. When the
	// SSR build emitted a shared chunk for `svelte/server` (entry → chunk →
	// entry, circular), the query made Node instantiate the bundle TWICE —
	// components ran in the queried instance while Svelte's render runtime (and
	// its module-global `ssr_context`) lived in the query-less one, so every
	// `getContext`/`setContext` threw `lifecycle_outside_component` and the
	// context-using routes (review, compose, timelines, messages, agents,
	// profiles, drones) returned a bare 500 on the live instance while passing
	// every query-less local render. `codeSplitting: false` in vite.config.ts
	// makes the handler one self-contained module; this test imports it exactly
	// the way the SSR host does and would catch any future split.
	const { pathToFileURL } = await import('node:url');
	const { resolve } = await import('node:path');
	const entry = resolve(process.cwd(), 'build/server/handler.mjs');
	const mod = await import(`${pathToFileURL(entry).href}?install=regression-test`);
	assert.equal(typeof mod.handler, 'function');

	for (const path of [
		'/l/review',
		'/l/review/drafts/draft-123',
		'/l/compose',
		'/l/timelines',
		'/l/messages',
		'/l/messages/conversation-123',
		'/l/agents',
		'/l/agents/weatherbot',
		'/l/profiles/ada',
		'/l/drones',
	]) {
		const result = await renderRoute(mod.handler, { name: path, path, expectStatus: 200 });
		assert.equal(result.status, 200, `${path} must render under a query-suffixed import`);
		assert.ok(result.html.includes('contentus-shell'), `${path} should render the shell`);
	}
});

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
		assert.ok(
			result.html.includes('<footer class="contentus-footer">'),
			`${path} should close with the page's contentinfo landmark`
		);
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
	// `</script(?=[\s/>])[^>]*>`, matching scripts/audit-csp.mjs: a browser
	// closes the element on `</script\t\n bar>` just as it does on `</script>`,
	// so a narrower spelling matches nothing on a document that uses one — the
	// loop runs zero times and the assertion passes having examined nothing.
	// Same defect CodeQL flagged in the M2d probe that was copied from here; the
	// two are fixed together rather than leaving a known-weak twin behind.
	for (const match of result.html.matchAll(
		/<script\b[^>]*>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi
	)) {
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
	assert.ok(
		!result.html.includes('>Agents<'),
		'Agents is authenticated-only (the gateway refuses anonymous `agents`)'
	);
	assert.ok(!result.html.includes('>Review<'), 'Review is authenticated-only');
	assert.ok(!result.html.includes('>Messages<'), 'Messages is authenticated-only');
	// The session control is an inert placeholder until mount: the server cannot
	// read the session, so SSR must not paint a control that claims either state.
	assert.ok(
		result.html.includes('contentus-session__button--pending'),
		'the session control is a placeholder until mount'
	);
	assert.ok(!result.html.includes('>Sign out<'), 'SSR never claims a session');
});

test('no article body is emitted when lesser returns no rendered HTML', async () => {
	const result = await render('/l/articles/example');
	assert.doesNotMatch(result.html, /gr-blog-article__content/);
});

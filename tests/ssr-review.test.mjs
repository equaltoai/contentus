import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadHandler, renderRoute, withStubbedGraphql } from '../scripts/render-routes.mjs';

/**
 * Face 2's SSR probes.
 *
 * The claim under test is narrow and load-bearing: `/review` is a real
 * server-rendered route, and the server renders it WITHOUT ever asking lesser
 * about anybody's drafts.
 *
 * That is not a performance property. Contentus's render props are serialized
 * into a public, same-origin hydration endpoint (`entry-server.ts`), and every
 * review operation needs a bearer token the server does not have. A server-side
 * queue fetch would therefore either fail (useless) or, on an instance that
 * answered it, publish one reviewer's unpublished drafts behind a URL anyone
 * could request. "Makes no GraphQL request at all" is the shape that cannot go
 * wrong, and it is what these probes pin.
 *
 * Runs against the built handler, so `pnpm run build:client` and
 * `pnpm run build:server` come first.
 */

const handler = await loadHandler();

const render = (path, expectStatus = 200) =>
	renderRoute(handler, { name: path, path, expectStatus });

test('the review queue server-renders a complete document', async () => {
	const result = await render('/l/review');

	// 200, AND WHY THAT IS THE HONEST ANSWER rather than the convenient one.
	// A protected route answering 200 to an anonymous caller looks wrong, and it
	// is the shape this face has: lesser's auth contract keeps the access token
	// in `sessionStorage`, never a cookie, so NOTHING about an authenticated
	// reviewer's document request differs from an anonymous one. The server
	// cannot tell them apart, and a blanket 401 would be returned to the
	// authorized reviewer on every cold deep link — lesser performs no SPA
	// fallback under `/l/*`, so every navigation is one. What this response
	// truthfully reports is that the sign-in shell was delivered; the protected
	// resource is the drafts, and those answer 401 over authenticated GraphQL.
	// The caching and indexing half is closed below. Recorded in full, with the
	// upstream routing, in `docs/consumption/auth-boundary.md`.
	assert.equal(result.status, 200);
	assert.match(result.html, /^<!doctype html>/i);
	assert.ok(result.html.includes('contentus-shell'), 'the review route renders inside the shell');
});

test('an auth-required route is never cached and never indexed', async () => {
	// The residual risk in that 200 is a shared cache or a crawler treating a
	// protected surface as ordinary public content. Both are the origin's to
	// prevent — the origin owns its headers on `/l` routes (lesser-host's
	// CloudFront policy for the client install is a non-overriding fallback,
	// and it sets neither of these) — so contentus sets them, on every route
	// whose descriptor carries `requiresAuth`.
	for (const path of ['/l/review', '/l/review/drafts/draft-123', '/l/compose']) {
		const { headers, status } = await render(path);

		assert.equal(status, 200, `${path} status`);
		assert.equal(headers['cache-control'], 'no-store', `${path} must not be cacheable`);
		assert.equal(headers['x-robots-tag'], 'noindex, nofollow', `${path} must not be indexable`);
	}
});

test('the public reading surface keeps its cacheability', async () => {
	// The negative half, and the reason it is here: `no-store` applied to every
	// route would be a quiet performance regression on the surface the whole
	// client exists to serve, and nothing else in the suite would notice.
	for (const path of ['/l/', '/l/articles/example-article']) {
		const { headers } = await render(path);

		assert.notEqual(headers['cache-control'], 'no-store', `${path} must stay cacheable`);
		assert.equal(headers['x-robots-tag'], undefined, `${path} must stay indexable`);
	}
});

test('the review queue renders its sign-in state, not a queue', async () => {
	const result = await render('/l/review');

	assert.match(result.html, /Sign in to review/i);
	// The groups and their cards belong to the authenticated client render. An
	// anonymous document that already showed "Shared with you" would be
	// promising a queue the server cannot have loaded.
	assert.doesNotMatch(result.html, /gr-blog-review-card/);
});

test('rendering the review queue makes no GraphQL request whatsoever', async () => {
	const { requests } = await withStubbedGraphql(
		() => ({ data: null }),
		() => render('/l/review')
	);

	assert.deepEqual(
		requests,
		[],
		'the server must not ask lesser about drafts: it has no token, and the answer would ' +
			'land in the public hydration payload'
	);
});

test('the review queue never sends an Authorization header from the server', async () => {
	const seen = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		seen.push(init.headers ?? {});
		return new Response(JSON.stringify({ data: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		await render('/l/review');
	} finally {
		globalThis.fetch = originalFetch;
	}

	for (const headers of seen) {
		const names = Object.keys(headers).map((name) => name.toLowerCase());
		assert.ok(!names.includes('authorization'), 'no server-side review fetch may be authenticated');
	}
});

test('the hydration payload for the review queue carries no draft data', async () => {
	const result = await renderRoute(handler, {
		name: 'review-hydration',
		path: '/l/_facetheory/hydration?path=%2Freview',
		expectStatus: 200,
	});

	assert.equal(result.status, 200);

	const props = JSON.parse(result.html);
	assert.equal(props.page.key, 'review-queue');
	assert.equal(props.page.requiresAuth, true);

	// Whatever else the payload grows, it must never carry a draft. Asserting on
	// the serialized text rather than on named fields is deliberate: a future
	// field that smuggled one in would still be caught.
	const serialized = JSON.stringify(props);
	for (const forbidden of ['draftId', 'renderedHtml', 'sharedDraftReviews', 'myDrafts']) {
		assert.ok(
			!serialized.includes(forbidden),
			`the public hydration payload must not carry "${forbidden}"`
		);
	}
});

test('the review workspace server-renders its sign-in state, never a draft', async () => {
	const result = await render('/l/review/drafts/draft-123');

	// Same 200, same reason as the queue above — and the assertions below are
	// what make it correct: the anonymous document carries no draft at all.
	assert.equal(result.status, 200);
	assert.match(result.html, /^<!doctype html>/i);
	assert.match(result.html, /Sign in to review this draft/i);

	// The draft id is in the URL and may legitimately appear in the payload; a
	// BODY may not. `gr-blog-article__content` is the vendored element the
	// preview renders into, so its absence is the absence of a rendered draft.
	assert.doesNotMatch(result.html, /gr-blog-article__content/);
	assert.doesNotMatch(result.html, /gr-blog-review-attribution/);

	// #112's bound media is the sharp case: the figure the authenticated DOM
	// must show is exactly what the anonymous document must not carry. No
	// `<figure>` anywhere; an `<img>` only as chrome (the shell's brand
	// wordmark), never as draft media with a minted access URL.
	assert.doesNotMatch(result.html, /<figure/i);
	assert.doesNotMatch(result.html, /includeAccessUrls/);
	const imgs = [...result.html.matchAll(/<img\b[^>]*>/gi)];
	for (const img of imgs)
		assert.match(
			img[0],
			/contentus-brand__wordmark/,
			`the only permitted <img> in the anonymous document is the brand wordmark: ${img[0]}`
		);
});

test('rendering the review workspace makes no GraphQL request whatsoever', async () => {
	const { requests } = await withStubbedGraphql(
		() => ({ data: null }),
		() => render('/l/review/drafts/draft-123')
	);

	assert.deepEqual(
		requests,
		[],
		'the server must not fetch a draft or its preview: the answer would land in the ' +
			'public hydration payload'
	);
});

test('the workspace hydration payload carries the address and no draft body', async () => {
	const result = await renderRoute(handler, {
		name: 'workspace-hydration',
		path: '/l/_facetheory/hydration?path=%2Freview%2Fdrafts%2Fdraft-123',
		expectStatus: 200,
	});

	const props = JSON.parse(result.html);
	assert.equal(props.page.key, 'review-workspace');
	assert.equal(props.page.requiresAuth, true);

	// The ADDRESS travels — that is what makes the client's fetch possible.
	assert.equal(props.review.draftId, 'draft-123');

	// The DRAFT does not.
	const serialized = JSON.stringify(props);
	for (const forbidden of [
		'renderedHtml',
		'editorNotes',
		'reviewStatus',
		'verdicts',
		// #112's media half: no figure markup and no minted access URL may sit
		// one fetch away in the public payload.
		'<figure',
		'<img',
		'accessUrl',
	]) {
		assert.ok(
			!serialized.includes(forbidden),
			`the public hydration payload must not carry "${forbidden}"`
		);
	}
});

test('the panel a link names survives a cold server render', async () => {
	// The panel is a URL parameter rather than component state so a reviewer can
	// link to "the preview of this draft" — which only works if the server
	// resolves it on a cold request, since lesser does no SPA fallback.
	const preview = await renderRoute(handler, {
		name: 'workspace-preview-panel',
		path: '/l/_facetheory/hydration?path=%2Freview%2Fdrafts%2Fdraft-123&search=panel%3Dpreview',
		expectStatus: 200,
	});
	assert.equal(JSON.parse(preview.html).review.panel, 'preview');

	// Anything unrecognised lands on the details rail rather than nowhere.
	const nonsense = await renderRoute(handler, {
		name: 'workspace-bad-panel',
		path: '/l/_facetheory/hydration?path=%2Freview%2Fdrafts%2Fdraft-123&search=panel%3Dwombat',
		expectStatus: 200,
	});
	assert.equal(JSON.parse(nonsense.html).review.panel, 'details');
});

test('a /review/drafts address naming no draft is a real 404', async () => {
	// Not an empty workspace: the address names nothing, and rendering a
	// workspace for it under a 200 would tell a crawler the page exists.
	const result = await render('/l/review/drafts', 404);
	assert.equal(result.status, 404);
});

test('the review queue response carries the same strict CSP as every other route', async () => {
	const { headers } = await render('/l/review');
	const csp = headers['content-security-policy'];

	assert.ok(csp, 'the review route must set a CSP header');
	assert.doesNotMatch(csp, /unsafe-inline/);
	assert.doesNotMatch(csp, /unsafe-eval/);
	assert.match(csp, /object-src 'none'/);
	assert.match(csp, /frame-ancestors 'none'/);
});

test('the review queue emits no inline script and no inline style', async () => {
	const result = await render('/l/review');

	// `</script(?=[\s/>])[^>]*>`, matching scripts/audit-csp.mjs. A browser
	// closes the element on any end tag whose name matches, however much junk
	// rides before the `>` — `</script\t\n bar>` closes a script exactly as
	// `</script>` does. A narrower spelling (`</script>`, or `</script\s*>`,
	// which still stops at the first non-space) matches nothing on such a
	// document, so the loop runs zero times. A test whose evidence is "the loop
	// found no violations" passes most convincingly when it examined nothing at
	// all, which is the failure CodeQL's js/bad-html-filtering-regexp names. The
	// lookahead keeps `</scriptfoo>` — not an end tag — from matching.
	for (const match of result.html.matchAll(
		/<script\b[^>]*>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi
	)) {
		assert.equal((match[1] ?? '').trim(), '', 'no <script> may have an inline body');
	}

	// And the loop is only evidence if it ran. Every opening `<script` must have
	// been paired by the matcher above; a count mismatch means a script element
	// this assertion never looked inside.
	const opens = [...result.html.matchAll(/<script\b/gi)].length;
	const paired = [...result.html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script(?=[\s/>])[^>]*>/gi)]
		.length;
	assert.equal(opens, paired, 'every <script> element must have been examined');
	assert.doesNotMatch(result.html, /<style\b/i, 'no inline <style> may reach the document');
});

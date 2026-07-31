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

	assert.equal(result.status, 200);
	assert.match(result.html, /^<!doctype html>/i);
	assert.ok(result.html.includes('contentus-shell'), 'the review route renders inside the shell');
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

	assert.equal(result.status, 200);
	assert.match(result.html, /^<!doctype html>/i);
	assert.match(result.html, /Sign in to review this draft/i);

	// The draft id is in the URL and may legitimately appear in the payload; a
	// BODY may not. `gr-blog-article__content` is the vendored element the
	// preview renders into, so its absence is the absence of a rendered draft.
	assert.doesNotMatch(result.html, /gr-blog-article__content/);
	assert.doesNotMatch(result.html, /gr-blog-review-attribution/);
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
	for (const forbidden of ['renderedHtml', 'editorNotes', 'reviewStatus', 'verdicts']) {
		assert.ok(
			!serialized.includes(forbidden),
			`the public hydration payload must not carry "${forbidden}"`
		);
	}
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

	for (const match of result.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		assert.equal((match[1] ?? '').trim(), '', 'no <script> may have an inline body');
	}
	assert.doesNotMatch(result.html, /<style\b/i, 'no inline <style> may reach the document');
});

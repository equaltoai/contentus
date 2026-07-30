import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadHandler, renderRoute, withStubbedGraphql } from '../scripts/render-routes.mjs';

/**
 * Built-artifact SSR probes.
 *
 * `tests/ssr-routes.test.mjs` covers the degraded path — no instance reachable,
 * every route rendering its designed unavailable state. These cover the loaded
 * path: the built handler driven with controlled GraphQL responses, which is
 * the only branch a real instance actually serves.
 *
 * The distinction is not academic. Every defect these probes pin down lived in
 * a branch the degraded audits never reached, and `pnpm dev` behaviour is not
 * evidence about a bundled artifact. So the assertions run against
 * `build/server/handler.mjs`, exactly as lesser's SSR host invokes it.
 */

const handler = await loadHandler();

/** A published article as lesser's `articleBySlug` returns one. */
function articleFixture(overrides = {}) {
	return {
		id: 'https://instance.example.com/articles/hello',
		slug: 'hello',
		title: 'Hello',
		subtitle: 'A subtitle',
		excerpt: 'An excerpt.',
		readingTimeMinutes: 4,
		wordCount: 800,
		publishedAt: '2026-07-30T00:00:00Z',
		updatedAt: '2026-07-30T00:00:00Z',
		author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatarUrl: null },
		featuredImage: null,
		categories: [],
		content: '# Heading\n\nSome *markdown* source.',
		contentFormat: 'MARKDOWN',
		canonicalUrl: null,
		seoTitle: null,
		seoDescription: null,
		ogImage: null,
		tableOfContents: [{ id: 'heading', level: 1, text: 'Heading' }],
		series: null,
		seriesOrder: null,
		...overrides,
	};
}

/** Answer whichever CMS operation the handler asks for, from one fixture set. */
function respondWith({ article = null, categories = [], articles = [] } = {}) {
	return ({ operation }) => {
		switch (operation) {
			case 'ContentusArticleBySlug':
				return { data: { articleBySlug: article } };
			case 'ContentusArticleNavigation':
				return { data: { categories } };
			case 'ContentusArticlesIndex':
				return {
					data: {
						articles: {
							totalCount: articles.length,
							pageInfo: { hasNextPage: false, endCursor: null },
							edges: articles.map((node) => ({ cursor: node.id, node })),
						},
					},
				};
			default:
				return { data: null };
		}
	};
}

/** A well-formed request as lesser's edge delivers it. */
const INSTANCE_HEADERS = {
	host: 'instance.example.com',
	'x-lesser-forwarded-host': 'instance.example.com',
	'x-lesser-forwarded-proto': 'https',
};

/**
 * The same request with every viewer-settable forwarding header pointed
 * somewhere else. CloudFront forwards viewer headers to `/l/*` verbatim, so this
 * is a bag an anonymous request can actually produce — only the
 * `x-lesser-*` pair is overwritten at the edge and therefore believable.
 */
const SPOOFED_HEADERS = {
	...INSTANCE_HEADERS,
	host: 'origin.internal',
	'x-forwarded-host': 'evil.example',
	'x-forwarded-proto': 'http',
	forwarded: 'host=evil.example;proto=http',
};

function probe(route, fixtures) {
	return withStubbedGraphql(respondWith(fixtures), () =>
		renderRoute(handler, { name: 'probe', expectStatus: 200, ...route })
	);
}

test('a spoofed forwarding header never becomes the server-side fetch target', async () => {
	const { value, requests } = await probe(
		{ path: '/l/articles/hello', headers: SPOOFED_HEADERS },
		{ article: articleFixture() }
	);

	assert.ok(requests.length > 0, 'the probe must have driven at least one GraphQL request');
	for (const request of requests) {
		assert.equal(
			request.url,
			'https://instance.example.com/api/graphql',
			'the server must fetch the edge-verified host, never a viewer-supplied one'
		);
	}
	assert.equal(value.status, 200);
});

test('a spoofed forwarding header never reaches the advertised identity', async () => {
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: SPOOFED_HEADERS },
		{ article: articleFixture() }
	);

	assert.match(
		value.html,
		/content="https:\/\/instance\.example\.com\/articles\/hello" property="og:url"/
	);
	assert.doesNotMatch(value.html, /evil\.example/, 'a spoofed host must not reach the document');
});

test('with no trusted host at all, no viewer-supplied host is substituted', async () => {
	const { value, requests } = await probe(
		{ path: '/l/articles/hello', headers: { 'x-forwarded-host': 'evil.example' } },
		{ article: articleFixture() }
	);

	// No resolvable origin means no absolute endpoint, so the request keeps the
	// relative path — which has no host to be pointed at, and on a real server
	// fails rather than resolving anywhere. Either way it is not aimed wherever
	// the viewer said.
	for (const request of requests) {
		assert.equal(
			request.url,
			'/api/graphql',
			'an unresolvable origin must not fall back to a viewer-supplied host'
		);
	}
	assert.equal(value.status, 200);
	assert.doesNotMatch(value.html, /evil\.example/);
});

test('a loaded article renders rather than 500ing on its own canonical tag', async () => {
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{ article: articleFixture() }
	);

	assert.equal(value.status, 200, 'the loaded-article path must render, not error');
	assert.match(value.html, /^<!doctype html>/i);
	assert.ok(value.html.includes('Hello'), 'the article title should reach the document');
});

test('an HTML article renders its body through the vendored blog face', async () => {
	// The one body class contentus currently displays. It reaches the vendored
	// face, whose Article context uses Svelte-5 runes in a plain `.ts` module —
	// so this is also the regression test for that module reaching the bundle
	// uncompiled.
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{
			article: articleFixture({
				content: '<h2 id="heading">Heading</h2><p>Rendered by lesser.</p>',
				contentFormat: 'HTML',
			}),
		}
	);

	assert.equal(value.status, 200, 'the HTML-article path must render, not error');
	assert.match(value.html, /gr-blog-article__content/, 'the vendored face must have rendered');
	assert.ok(value.html.includes('Rendered by lesser.'), 'the server-rendered body must be shown');
});

test('canonical identity is advertised in both forms lesser expects', async () => {
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{ article: articleFixture() }
	);

	// og:url carries lesser's absolute Article identity...
	assert.match(
		value.html,
		/content="https:\/\/instance\.example\.com\/articles\/hello" property="og:url"/
	);
	// ...and the canonical link carries the same URL in the relative form
	// FaceTheory's strict CSP permits. Note /articles/, not the /l/ reading
	// route: the identity is lesser's, and contentus does not rewrite it.
	assert.match(value.html, /href="\/articles\/hello" rel="canonical"/);
});

test('a cross-origin canonical is left to og:url rather than mis-stated', async () => {
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{ article: articleFixture({ canonicalUrl: 'https://syndicated.example/posts/hello' }) }
	);

	assert.equal(value.status, 200);
	assert.match(
		value.html,
		/content="https:\/\/syndicated\.example\/posts\/hello" property="og:url"/
	);
	// A cross-origin canonical cannot be expressed relatively, so no link tag is
	// emitted — better than emitting one that points somewhere else.
	assert.doesNotMatch(value.html, /rel="canonical"/);
});

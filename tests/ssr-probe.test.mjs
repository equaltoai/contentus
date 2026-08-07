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
		author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatar: null },
		featuredImage: null,
		categories: [],
		content: '# Heading\n\nSome unrendered SOURCE-SENTINEL prose.',
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

function articleConnection(articles) {
	return {
		totalCount: articles.length,
		pageInfo: { hasNextPage: false, endCursor: null },
		edges: articles.map((node) => ({ cursor: node.id, node })),
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

/**
 * A request that never passed lesser's edge, carrying only the Host its caller
 * chose. The edge sets `x-lesser-forwarded-host` unconditionally, so its absence
 * means this request came from somewhere else — and `Host` is then caller input,
 * not the origin's own domain.
 */
const UNTRUSTED_HOST_ONLY_HEADERS = { host: 'attacker.example' };

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
	// FaceTheory 4.0.6 validates absolute link hrefs against a request-derived
	// allowedOrigin read from x-forwarded-* — which this exact bag spoofs. The
	// handler replaces those headers with the edge-verified pair before
	// FaceTheory sees them, so the canonical resolves same-origin and renders.
	assert.match(
		value.html,
		/href="https:\/\/instance\.example\.com\/articles\/hello" rel="canonical"/,
		'the viewer-supplied x-forwarded-* must not steer the strict-CSP origin check'
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

test('an ambient Host never becomes the server-side fetch target', async () => {
	// The regression this pins: `Host` used to be a fallback, so this exact bag
	// made the server fetch https://attacker.example/api/graphql and advertise
	// that host in og:url. Absence of the edge header now fails closed.
	const { value, requests } = await probe(
		{ path: '/l/articles/hello', headers: UNTRUSTED_HOST_ONLY_HEADERS },
		{ article: articleFixture() }
	);

	for (const request of requests) {
		assert.equal(
			request.url,
			'/api/graphql',
			'an unverified Host must not become an absolute fetch target'
		);
	}
	assert.equal(value.status, 200);
	assert.doesNotMatch(value.html, /attacker\.example/, 'nor may it reach the document');
	assert.doesNotMatch(value.html, /rel="canonical"/, 'no origin means no canonical to state');
});

test('the trusted header still wins when an ambient Host disagrees with it', async () => {
	const { value, requests } = await probe(
		{
			path: '/l/articles/hello',
			headers: { ...UNTRUSTED_HOST_ONLY_HEADERS, ...INSTANCE_HEADERS, host: 'attacker.example' },
		},
		{ article: articleFixture() }
	);

	assert.ok(requests.length > 0, 'the probe must have driven at least one GraphQL request');
	for (const request of requests) {
		assert.equal(request.url, 'https://instance.example.com/api/graphql');
	}
	assert.match(
		value.html,
		/content="https:\/\/instance\.example\.com\/articles\/hello" property="og:url"/
	);
	// No ogImage on the fixture: the brand card stands in, absolute on the
	// request origin, so a shared link still renders a card.
	assert.match(
		value.html,
		/content="https:\/\/instance\.example\.com\/l\/_assets\/brand\/og-card\.png" property="og:image"/
	);
	assert.doesNotMatch(value.html, /attacker\.example/);
});

test('with no trusted host the page degrades on a real fetch, not just a stubbed one', async () => {
	// No stub here: the handler runs `fetch` for real. A null origin leaves the
	// relative path, which has no base on the server, so the request fails and
	// each loader returns its designed unavailable state. That is the whole cost
	// of failing closed — the page renders and explains itself.
	const value = await renderRoute(handler, {
		name: 'untrusted-host-degrade',
		path: '/l/articles/hello',
		headers: UNTRUSTED_HOST_ONLY_HEADERS,
		expectStatus: 200,
	});

	assert.equal(value.status, 200, 'failing closed must degrade, not 500');
	assert.match(value.html, /^<!doctype html>/i);
	assert.match(
		value.html,
		/class="contentus-shell" data-theme="dark"/,
		'the shell must carry the dark theme so the vendored dark rules activate'
	);
	assert.ok(value.html.includes('contentus-shell'), 'the shell must still render');
	assert.ok(
		/unavailable|not answer|could not be reached/i.test(value.html),
		'the degraded state must explain itself'
	);
	assert.doesNotMatch(value.html, /attacker\.example/);
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

test('article index keeps partial data when the GraphQL error envelope contains null', async () => {
	const articles = [
		articleFixture({ id: 'article-1', slug: 'first', title: 'First partial article' }),
		articleFixture({ id: 'article-2', slug: 'second', title: 'Second partial article' }),
		articleFixture({ id: 'article-3', slug: 'third', title: 'Third partial article' }),
	];
	const category = { id: 'category-1', slug: 'essays', name: 'Essays' };
	const { value } = await withStubbedGraphql(
		({ operation }) => {
			switch (operation) {
				case 'ContentusArticlesIndex':
					return { data: { articles: articleConnection(articles) }, errors: [null] };
				case 'ContentusArticleNavigation':
					return { data: { categories: [category] }, errors: [null] };
				default:
					return { data: null };
			}
		},
		() =>
			renderRoute(handler, {
				name: 'partial-articles-index',
				path: '/l/_facetheory/hydration?path=%2F',
				headers: INSTANCE_HEADERS,
				expectStatus: 200,
			})
	);

	assert.equal(value.status, 200);
	const props = JSON.parse(value.html);
	assert.deepEqual(
		props.index.articles.map(({ title }) => title),
		articles.map(({ title }) => title)
	);
	assert.deepEqual(
		props.index.categories.map(({ id, slug, name }) => ({ id, slug, name })),
		[category]
	);
	assert.equal(props.index.unavailable, null);
});

test('category loader keeps partial data when its GraphQL error envelope contains null', async () => {
	const category = { id: 'category-1', slug: 'essays', name: 'Essays' };
	const article = articleFixture({
		id: 'article-1',
		slug: 'category-article',
		title: 'Category partial article',
	});
	const { value } = await withStubbedGraphql(
		({ operation }) => {
			switch (operation) {
				case 'ContentusCategoryBySlug':
					return { data: { categoryBySlug: category }, errors: [null] };
				case 'ContentusArticlesIndex':
					return { data: { articles: articleConnection([article]) } };
				case 'ContentusArticleNavigation':
					return { data: { categories: [category] }, errors: [null] };
				default:
					return { data: null };
			}
		},
		() =>
			renderRoute(handler, {
				name: 'partial-category-index',
				path: '/l/_facetheory/hydration?path=%2Fcategories%2Fessays',
				headers: INSTANCE_HEADERS,
				expectStatus: 200,
			})
	);

	assert.equal(value.status, 200);
	const props = JSON.parse(value.html);
	assert.equal(props.index.articles.length, 1);
	assert.equal(props.index.articles[0].title, article.title);
	assert.deepEqual(
		props.index.categories.map(({ id, slug, name }) => ({ id, slug, name })),
		[category]
	);
	assert.equal(props.index.unavailable, null);
});

test('canonical renderedHtml renders even when the stored source is Markdown', async () => {
	// lesser v1.6.2's read path: `renderedHtml` is the authority's output and
	// outranks `contentFormat`. This is the finding the audit named — articles
	// showing the withhold state on a v1.6.2 instance must now render.
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{
			article: articleFixture({
				renderedHtml: '<h2 id="heading">Heading</h2><p>Canonical output.</p>',
			}),
		}
	);

	assert.equal(value.status, 200);
	assert.match(value.html, /gr-blog-article__content/, 'the vendored face must have rendered');
	assert.ok(value.html.includes('Canonical output.'), 'the canonical body must be shown');
	assert.doesNotMatch(value.html, /SOURCE-SENTINEL/, 'the stored source must not ship beside it');
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

test('a withheld body is absent from the public hydration payload', async () => {
	// The reader's withhold stance is only real if the source is not sitting one
	// fetch away in the hydration JSON. Anonymous request, no session, no token.
	const { value } = await probe(
		{ path: '/l/_facetheory/hydration?path=%2Farticles%2Fhello', headers: INSTANCE_HEADERS },
		{ article: articleFixture() }
	);

	assert.equal(value.status, 200);
	assert.match(value.headers['content-type'] ?? '', /application\/json/);

	const props = JSON.parse(value.html);
	assert.equal(props.reader.article.content, '', 'no article source may leave the server');
	assert.equal(props.reader.body.kind, 'withhold');
	assert.equal(props.reader.body.reason, 'unrendered-source');
	assert.doesNotMatch(value.html, /SOURCE-SENTINEL/, 'no fragment of the source may survive');
	// `contentFormat` itself stays: it is metadata describing what lesser holds,
	// which is exactly what the reader needs to explain the withhold.
	assert.equal(props.reader.article.contentFormat, 'MARKDOWN');

	// Everything the reader legitimately shows still travels.
	assert.equal(props.reader.article.title, 'Hello');
	assert.equal(props.reader.article.readingTimeMinutes, 4);
	assert.equal(props.reader.article.tableOfContents.length, 1);
});

test('a withheld body is absent from the SSR document too', async () => {
	const { value } = await probe(
		{ path: '/l/articles/hello', headers: INSTANCE_HEADERS },
		{ article: articleFixture() }
	);

	assert.equal(value.status, 200);
	assert.doesNotMatch(value.html, /SOURCE-SENTINEL/);
	assert.match(value.html, /isn't available yet/i, 'the reason must still be stated');
	// User-facing copy only: no issue-tracker language, no vendor attribution.
	assert.doesNotMatch(value.html, /upstream gap|CMS contract|ActivityPub/i);
	// The withhold header carries the article's date as a <time>, and the
	// reader still offers the way back and keeps the nav's current marker.
	assert.match(value.html, /<time datetime="2026-07-30T00:00:00Z">Jul 30, 2026<\/time>/);
	assert.match(value.html, /Back to articles/);
	assert.match(value.html, /aria-current="page"/);
});

test('a displayable body still reaches hydration, since the page shows it', async () => {
	// The rule is renderer authority, not secrecy: HTML that cleared the gate is
	// what the document already renders, so withholding it from hydration would
	// only break the client without protecting anything.
	const { value } = await probe(
		{ path: '/l/_facetheory/hydration?path=%2Farticles%2Fhello', headers: INSTANCE_HEADERS },
		{ article: articleFixture({ content: '<p>Rendered by lesser.</p>', contentFormat: 'HTML' }) }
	);

	const props = JSON.parse(value.html);
	assert.equal(props.reader.body.kind, 'render');
	assert.equal(props.reader.article.content, '<p>Rendered by lesser.</p>');
});

test('a missing article is a real 404, not a 200 that says "not found"', async () => {
	const { value } = await probe(
		{ path: '/l/articles/no-such-article', headers: INSTANCE_HEADERS, expectStatus: 404 },
		{ article: null }
	);

	assert.equal(value.status, 404);
	assert.match(value.html, /Article not found/i);
});

test('a missing series or category is a real 404 too', async () => {
	for (const path of ['/l/series/no-such-series', '/l/categories/no-such-category']) {
		// `seriesBySlug` / `categoryBySlug` resolve to null, which the loader
		// reports as not-found rather than falling back to the unfiltered listing.
		const { value } = await probe({ path, headers: INSTANCE_HEADERS, expectStatus: 404 }, {});

		assert.equal(value.status, 404, `${path} should 404`);
	}
});

test('an instance with long-form off is a 200 product state, not a 404', async () => {
	const { value } = await withStubbedGraphql(
		() => ({ errors: [{ message: 'long-form publishing is not enabled on this instance' }] }),
		() =>
			renderRoute(handler, {
				name: 'cms-disabled',
				path: '/l/articles/hello',
				headers: INSTANCE_HEADERS,
				expectStatus: 200,
			})
	);

	assert.equal(value.status, 200, 'a feature-gated instance is a designed state, not a miss');
	assert.match(value.html, /Long-form publishing is off/i);
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
	// ...and so does the canonical link. FaceTheory 4.0.6 forwards a per-request
	// allowedOrigin into the strict-CSP head check, so the relative-form
	// workaround is retired: the link carries the absolute identity, validated
	// against the edge-verified origin. Note /articles/, not the /l/ reading
	// route: the identity is lesser's, and contentus does not rewrite it.
	assert.match(
		value.html,
		/href="https:\/\/instance\.example\.com\/articles\/hello" rel="canonical"/
	);
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
	// A cross-origin canonical can never pass the strict-CSP same-origin check,
	// so no link tag is emitted — better than emitting one that points somewhere
	// else, or throwing the route to a 500.
	assert.doesNotMatch(value.html, /rel="canonical"/);
});

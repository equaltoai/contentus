import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARTICLES_PAGE_SIZE, fetchArticlesPage } from '../src/lib/cms/pagination.ts';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

/**
 * P1-10 — the index pages. The first page is SSR like every other route; the
 * "Load more" control fetches `articles(first:after:)` in the browser,
 * anonymously, with the SAME resolved filter IDs the loader used. What is
 * worth asserting: the cursor and the filters reach the wire, a failure keeps
 * the painted page instead of replacing it with an error, and the served
 * document carries a real button rather than the old "later milestone" note.
 */

function summaryFixture(n) {
	return {
		id: `https://instance.example.com/articles/post-${n}`,
		slug: `post-${n}`,
		title: `Post ${n}`,
		subtitle: null,
		excerpt: `Excerpt ${n}.`,
		readingTimeMinutes: 3,
		wordCount: 600,
		publishedAt: '2026-07-30T00:00:00Z',
		updatedAt: '2026-07-30T00:00:00Z',
		author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatar: null },
		featuredImage: null,
		categories: [],
	};
}

function connectionEnvelope(count, pageInfo) {
	return {
		data: {
			articles: {
				totalCount: count,
				pageInfo,
				edges: Array.from({ length: count }, (_, i) => ({
					cursor: `cursor-${i + 1}`,
					node: summaryFixture(i + 1),
				})),
			},
		},
	};
}

/** The pagination module's own stub: records the request, answers once. */
async function withRecordedFetch(respond, body) {
	const requests = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : String(input?.url ?? input);
		const payload = init.body ? JSON.parse(init.body) : {};
		requests.push({ url, variables: payload.variables ?? {} });
		const envelope = respond() ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	try {
		return { value: await body(), requests };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// ── the module: cursor and filters reach the wire ───────────────────────────

test('fetchArticlesPage sends the cursor and the resolved filter IDs, anonymously', async () => {
	const { value, requests } = await withRecordedFetch(
		() => connectionEnvelope(2, { hasNextPage: true, endCursor: 'cursor-2' }),
		() => fetchArticlesPage({ categoryId: 'cat-1' }, 'cursor-12')
	);

	assert.equal(requests.length, 1);
	assert.equal(
		requests[0].url,
		'/api/graphql',
		'browser-style relative endpoint, no origin needed'
	);
	assert.deepEqual(requests[0].variables, {
		seriesId: null,
		categoryId: 'cat-1',
		first: ARTICLES_PAGE_SIZE,
		after: 'cursor-12',
	});

	assert.equal(value.articles.length, 2);
	assert.equal(value.endCursor, 'cursor-2');
	assert.equal(value.hasNextPage, true);
});

test('a transport failure returns null — the painted page stays, the control offers retry', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error('network down');
	};
	try {
		assert.equal(await fetchArticlesPage({}, 'cursor-12'), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('GraphQL errors with no usable page return null', async () => {
	const { value } = await withRecordedFetch(
		() => ({ data: null, errors: [{ message: 'boom' }] }),
		() => fetchArticlesPage({}, 'cursor-12')
	);
	assert.equal(value, null);
});

test('an exhausted page is a page, not a failure', async () => {
	const { value } = await withRecordedFetch(
		() => connectionEnvelope(0, { hasNextPage: false, endCursor: null }),
		() => fetchArticlesPage({}, 'cursor-12')
	);
	assert.deepEqual(value, { articles: [], endCursor: null, hasNextPage: false });
});

// ── the served document: a control, not a note ──────────────────────────────

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

function respondWithPage({ hasNextPage, endCursor }) {
	return ({ operation }) => {
		switch (operation) {
			case 'ContentusArticlesIndex':
				return connectionEnvelope(3, { hasNextPage, endCursor });
			case 'ContentusArticleNavigation':
				return { data: { categories: [] } };
			case 'ContentusCategoryBySlug':
				return {
					data: {
						categoryBySlug: {
							id: 'cat-1',
							slug: 'example-category',
							name: 'Example',
							description: null,
							articleCount: 3,
						},
					},
				};
			default:
				return { data: null };
		}
	};
}

test('the index serves a Load more button when hasNextPage, and no "later milestone" note', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		respondWithPage({ hasNextPage: true, endCursor: 'cursor-3' }),
		() => renderRoute(handler, route('articles-index'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Load more articles'), 'the control is in the served document');
	assert.ok(
		!value.html.includes('More articles are available'),
		'the deferred-milestone note is gone'
	);

	const initial = requests.find((request) => request.operation === 'ContentusArticlesIndex');
	assert.ok(initial, 'the index queried articles');
	assert.equal(initial.variables.after, null, 'the first page starts at the head');
	assert.equal(initial.variables.first, ARTICLES_PAGE_SIZE);
});

test('a filtered listing pages too — the button is not an index-only affordance', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		respondWithPage({ hasNextPage: true, endCursor: 'cursor-3' }),
		() => renderRoute(handler, route('category'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Load more articles'));

	const filtered = requests.find((request) => request.operation === 'ContentusArticlesIndex');
	assert.equal(filtered.variables.categoryId, 'cat-1', 'the slug resolved to an ID on the wire');
});

test('no next page, no control', async () => {
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		respondWithPage({ hasNextPage: false, endCursor: 'cursor-3' }),
		() => renderRoute(handler, route('articles-index'))
	);

	assert.equal(value.status, 200);
	assert.ok(!value.html.includes('Load more articles'));
});

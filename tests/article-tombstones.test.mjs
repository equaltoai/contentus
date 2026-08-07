import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	isArticleTombstone,
	toArticleConnection,
	toArticleDetail,
	toArticleSummary,
} from '../src/lib/cms/articles.ts';
import { ARTICLES_INDEX_QUERY, ARTICLE_BY_SLUG_QUERY } from '../src/lib/cms/queries.ts';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

/**
 * lesser v1.6.0 surfaces article tombstones where earlier versions returned
 * nothing: `article(id)`, `articleBySlug(slug)`, and the legacy object-ID path
 * fall back to a synthesized Article carrying `deletedAt` once the live article
 * is gone (`graph/query_resolvers_cms.go`, `deletedCMSArticle`).
 *
 * The shape of that fallback is what these tests are really about. lesser
 * builds it from the tombstone record alone, so it has an ID, a slug, an
 * author and a `deletedAt` — and NO title and NO content. A client that keys
 * "is this real" off the title therefore gets the right answer for the wrong
 * reason, and would go on getting it right only until lesser put a title on a
 * tombstone. These tests pin the behaviour to `deletedAt`.
 */

/** A tombstone exactly as `deletedCMSArticle` builds it: no title, no body. */
function tombstoneFixture(overrides = {}) {
	return {
		id: 'https://example.invalid/articles/gone',
		deletedAt: '2026-08-01T12:00:00Z',
		slug: 'gone',
		authorId: 'https://example.invalid/users/ada',
		author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatar: null },
		title: '',
		subtitle: null,
		excerpt: null,
		content: '',
		contentFormat: 'HTML',
		readingTimeMinutes: 0,
		wordCount: 0,
		publishedAt: '2026-08-01T12:00:00Z',
		updatedAt: '2026-08-01T12:00:00Z',
		featuredImage: null,
		categories: [],
		tableOfContents: [],
		series: null,
		seriesOrder: null,
		...overrides,
	};
}

function liveFixture(overrides = {}) {
	return {
		...tombstoneFixture(),
		deletedAt: null,
		slug: 'hello',
		title: 'Hello',
		content: '<p>Rendered by lesser.</p>',
		...overrides,
	};
}

test('every article read asks lesser for deletedAt', () => {
	// The field cannot be consulted if it was never selected, and a tombstone is
	// otherwise indistinguishable from an article lesser returned empty.
	assert.match(ARTICLE_BY_SLUG_QUERY, /deletedAt/);
	assert.match(ARTICLES_INDEX_QUERY, /deletedAt/);
});

test('a tombstone is recognised by deletedAt, not by its missing title', () => {
	assert.equal(isArticleTombstone(tombstoneFixture()), true);

	// The one that matters: a tombstone lesser HAS titled is still a tombstone.
	// Title-based inference gets this wrong.
	assert.equal(isArticleTombstone(tombstoneFixture({ title: 'Once Published' })), true);

	assert.equal(isArticleTombstone(liveFixture()), false);
	assert.equal(isArticleTombstone(liveFixture({ deletedAt: null })), false);
	assert.equal(isArticleTombstone(liveFixture({ deletedAt: '   ' })), false);
	assert.equal(isArticleTombstone(null), false);
});

test('a tombstone never normalises into an article view model', () => {
	// Enforced in the normaliser rather than at each call site, so that holding
	// an ArticleSummary IS the guarantee that the article is live.
	assert.equal(toArticleSummary(tombstoneFixture({ title: 'Once Published' })), null);
	assert.equal(toArticleDetail(tombstoneFixture({ title: 'Once Published' })), null);

	assert.notEqual(toArticleSummary(liveFixture()), null);
});

test('a deleted article never renders as a card in a listing', () => {
	const connection = toArticleConnection({
		edges: [
			{ cursor: 'a', node: liveFixture({ slug: 'first', title: 'First' }) },
			{ cursor: 'b', node: tombstoneFixture({ slug: 'second', title: 'Second' }) },
			{ cursor: 'c', node: liveFixture({ slug: 'third', title: 'Third' }) },
		],
		pageInfo: { hasNextPage: false, endCursor: 'c' },
	});

	assert.deepEqual(
		connection.articles.map((article) => article.slug),
		['first', 'third']
	);
});

test('page info survives the filtering, because paging is lesser’s to state', () => {
	// Dropping a tombstone from a page must not be mistaken for the end of the
	// list: `hasNextPage` is lesser's answer, never inferred from page length.
	const connection = toArticleConnection({
		edges: [{ cursor: 'a', node: tombstoneFixture() }],
		pageInfo: { hasNextPage: true, endCursor: 'a' },
	});

	assert.deepEqual(connection.articles, []);
	assert.equal(connection.hasNextPage, true);
	assert.equal(connection.endCursor, 'a');
});

test('a deleted article is served as 410 Gone, and says so', async () => {
	// End to end through the BUILT SSR handler rather than against
	// `statusForRoute` directly: the status a crawler receives is the claim
	// being made here, and only the handler actually emits it.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusArticleBySlug'
				? { data: { articleBySlug: tombstoneFixture() } }
				: { data: null },
		() => renderRoute(handler, route('article-reader'))
	);

	assert.equal(value.status, 410);
	assert.ok(
		value.html.includes('Article deleted'),
		'the reader must say the article was deleted, not that it was never here'
	);
	assert.ok(
		!value.html.includes('Article not found'),
		'"not found" would misreport an address that did hold an article'
	);
});

test('an address that never held an article is still 404', async () => {
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusArticleBySlug' ? { data: { articleBySlug: null } } : { data: null },
		() => renderRoute(handler, route('article-reader'))
	);

	assert.equal(value.status, 404);
	assert.ok(value.html.includes('Article not found'));
});

test('a live article is unaffected by the tombstone path', async () => {
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusArticleBySlug'
				? { data: { articleBySlug: liveFixture({ contentFormat: 'HTML' }) } }
				: { data: null },
		() => renderRoute(handler, route('article-reader'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Hello'));
});

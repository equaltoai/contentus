import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	resolveArticleBody,
	toArticleDetail,
	toBlogFaceArticle,
} from '../src/lib/cms/articles.ts';

/**
 * Renderer authority is the invariant contentus exists to keep, so it gets
 * behavioural tests rather than only a static audit. The audit proves we did
 * not import a renderer; these prove the gate actually withholds.
 */

function articleFixture(overrides = {}) {
	return toArticleDetail({
		id: 'https://example.invalid/articles/hello',
		slug: 'hello',
		title: 'Hello',
		subtitle: null,
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
		tableOfContents: [],
		series: null,
		seriesOrder: null,
		...overrides,
	});
}

test('markdown source is withheld, never rendered', () => {
	const article = articleFixture();
	const decision = resolveArticleBody(article);

	assert.equal(decision.kind, 'withhold');
	assert.equal(decision.reason, 'unrendered-source');
});

test('a withheld body never reaches the face as content', () => {
	const article = articleFixture();
	const faceInput = toBlogFaceArticle(article, resolveArticleBody(article));

	assert.equal(faceInput.content, '');
	assert.ok(
		!faceInput.content.includes('markdown'),
		'raw source must not survive into the face input'
	);
});

test('server-rendered HTML is passed through', () => {
	const article = articleFixture({
		content: '<h1>Heading</h1><p>Rendered by lesser.</p>',
		contentFormat: 'HTML',
	});
	const decision = resolveArticleBody(article);

	assert.equal(decision.kind, 'render');
	assert.equal(decision.html, '<h1>Heading</h1><p>Rendered by lesser.</p>');
	assert.equal(toBlogFaceArticle(article, decision).content, decision.html);
});

test('an empty body is withheld distinctly from unrendered source', () => {
	const decision = resolveArticleBody(articleFixture({ content: '   ', contentFormat: 'HTML' }));

	assert.equal(decision.kind, 'withhold');
	assert.equal(decision.reason, 'empty');
});

test('contentFormat reaching the face is always html', () => {
	// The face renders `{@html}` only for 'html' and escapes otherwise. Contentus
	// withholds non-HTML bodies outright, so the only format it ever hands over
	// is 'html' with content that cleared the gate — never 'markdown' with source.
	const markdown = articleFixture();
	const faceInput = toBlogFaceArticle(markdown, resolveArticleBody(markdown));

	assert.equal(faceInput.contentFormat, 'html');
	assert.equal(faceInput.content, '');
});

test('an unknown contentFormat is treated as unrendered, not as HTML', () => {
	// Fail closed: a format lesser adds later must not be assumed safe to inject.
	const decision = resolveArticleBody(
		articleFixture({ content: '<p>x</p>', contentFormat: 'ASCIIDOC' })
	);

	assert.equal(decision.kind, 'withhold');
	assert.equal(decision.reason, 'unrendered-source');
});

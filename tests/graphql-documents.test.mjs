import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSchema, parse, specifiedRules, validate } from 'graphql';

import {
	DOCUMENT_INVENTORY,
	loadPinnedSchema,
	operationNames,
	ownedModules,
	readInventory,
	readModuleStringConstants,
	repoRoot,
} from '../scripts/lib/graphql-inventory.mjs';
import {
	resolveArticleBody,
	toArticleConnection,
	toArticleDetail,
	toAuthorSummary,
	toBlogFaceArticle,
} from '../src/lib/cms/articles.ts';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

/**
 * The defect, the boundary, and the gate that would have caught both.
 *
 * These are deliberately few. The predecessor to this milestone shipped ~2,700
 * lines of tests around a static-analysis framework, and the bug it was built
 * over was one field name. What is worth asserting is: lesser's schema says
 * `avatar`; contentus asks for `avatar`; the answer reaches a byline; the Greater
 * face still gets `avatarUrl` at the one line that translates; and the gate is
 * red when any of that stops being true.
 */

const AVATAR = 'https://instance.example.com/media/ada.png';

function articleFixture(overrides = {}) {
	return {
		id: 'https://instance.example.com/articles/hello',
		slug: 'hello',
		title: 'Hello',
		subtitle: null,
		excerpt: 'An excerpt.',
		readingTimeMinutes: 4,
		wordCount: 800,
		publishedAt: '2026-07-30T00:00:00Z',
		updatedAt: '2026-07-30T00:00:00Z',
		author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatar: AVATAR },
		featuredImage: null,
		categories: [],
		content: '<p>Server-rendered.</p>',
		contentFormat: 'HTML',
		canonicalUrl: null,
		seoTitle: null,
		seoDescription: null,
		ogImage: null,
		tableOfContents: [],
		series: null,
		seriesOrder: null,
		...overrides,
	};
}

// ── the response shape carries lesser's name ────────────────────────────────

test('toAuthorSummary reads lesser`s `avatar`', () => {
	const author = toAuthorSummary({
		id: 'actor-1',
		username: 'ada',
		displayName: 'Ada',
		avatar: AVATAR,
	});
	assert.equal(author.avatar, AVATAR);
});

test('a response carrying only `avatarUrl` yields no avatar — the defect, stated as one', () => {
	// This is exactly what the old query produced against a real instance once
	// lesser rejected the selection: a well-formed author with an empty avatar and
	// nothing anywhere saying why. Asserting it keeps the failure legible if the
	// mapping is ever pointed back at greater's field name.
	const author = toAuthorSummary({
		id: 'actor-1',
		username: 'ada',
		displayName: 'Ada',
		avatarUrl: AVATAR,
	});
	assert.equal(author.avatar, null);
	assert.equal(author.avatarUrl, undefined);
});

test('toBlogFaceArticle renames to `avatarUrl` at the view-model boundary, and only there', () => {
	const article = toArticleDetail(articleFixture());
	assert.equal(article.author.avatar, AVATAR, 'the response shape keeps lesser’s name');

	const faceInput = toBlogFaceArticle(article, resolveArticleBody(article));
	assert.equal(faceInput.author.avatarUrl, AVATAR, 'the face gets the name the face reads');
	assert.equal(faceInput.author.avatar, undefined, 'and does not get both');
});

test('a missing avatar stays absent rather than becoming an empty string', () => {
	const article = toArticleDetail(
		articleFixture({ author: { id: 'actor-1', username: 'ada', displayName: 'Ada', avatar: null } })
	);
	assert.equal(article.author.avatar, null);
	assert.equal(toBlogFaceArticle(article, resolveArticleBody(article)).author.avatarUrl, undefined);
});

// ── the built route harness: index and detail ───────────────────────────────

function respondWith({ article = null, articles = [] }) {
	return ({ operation }) => {
		switch (operation) {
			case 'ContentusArticleBySlug':
				return { data: { articleBySlug: article } };
			case 'ContentusArticleNavigation':
				return { data: { categories: [] } };
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

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

test('the article INDEX serves the article, and carries lesser`s `avatar` in the summary', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		respondWith({ articles: [articleFixture()] }),
		() => renderRoute(handler, route('articles-index'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Hello'), 'the article title reaches the index');
	assert.ok(value.html.includes('Ada'), 'and so does the author');
	assert.ok(
		requests.some((request) => request.operation === 'ContentusArticlesIndex'),
		'the index route queried articles'
	);

	// THE INDEX CARD HAS NO AVATAR ELEMENT. It renders the author's name and not
	// their picture, so asserting the URL appears in this document would be
	// asserting something the surface has never done — the assertion would have to
	// be deleted the moment anyone read it. The avatar's end-to-end proof is the
	// DETAIL route below; what the index proves is that the same `avatar` field
	// survives the summary mapping, which is where the old code lost it.
	assert.ok(!value.html.includes(AVATAR), 'stated, not assumed: the index shows no avatar');
	const summary = toArticleConnection({
		totalCount: 1,
		pageInfo: { hasNextPage: false, endCursor: null },
		edges: [{ cursor: 'c', node: articleFixture() }],
	}).articles[0];
	assert.equal(summary.author.avatar, AVATAR);
});

test('the article DETAIL renders a lesser `avatar` into the served document', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		respondWith({ article: articleFixture() }),
		() => renderRoute(handler, route('article-reader'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Hello'));
	assert.ok(value.html.includes(AVATAR), 'the avatar reaches the rendered article byline');

	// The document the route actually sent asks for `avatar`, not `avatarUrl`. The
	// harness records the query text, so this is what went on the wire rather than
	// what the module says it would send.
	const sent = requests.find((request) => request.operation === 'ContentusArticleBySlug');
	assert.ok(sent, 'the detail route queried articleBySlug');
});

// ── the pinned schema, and the exact mismatch ───────────────────────────────

test('lesser’s pinned schema publishes Actor.avatar and has never published avatarUrl', () => {
	const { sdl, provenance, sha256 } = loadPinnedSchema();
	assert.equal(sha256, provenance.artifact.sha256, 'integrity is re-checked, not assumed');

	const schema = buildSchema(sdl);
	const actor = schema.getType('Actor');
	assert.ok(actor, 'lesser publishes `type Actor`');
	assert.ok(actor.getFields().avatar, 'Actor.avatar exists');
	assert.equal(actor.getFields().avatarUrl, undefined, 'Actor.avatarUrl does not');
	assert.ok(!sdl.includes('avatarUrl'), 'and the string does not occur anywhere in the schema');
});

test('the exact mismatch is rejected, and the corrected selection is accepted', () => {
	const schema = buildSchema(loadPinnedSchema().sdl);
	const document = (field) => `
		query ContentusProbeArticle($slug: String!) {
			articleBySlug(slug: $slug) { id author { id username displayName ${field} } }
		}
	`;

	const rejected = validate(schema, parse(document('avatarUrl')), specifiedRules);
	assert.equal(rejected.length, 1);
	assert.match(rejected[0].message, /Cannot query field "avatarUrl" on type "Actor"/);

	assert.deepEqual(validate(schema, parse(document('avatar')), specifiedRules), []);
});

// ── the inventory is the coverage, and it is checked ────────────────────────

function trackedSrc() {
	return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', 'src'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 64,
	})
		.split('\0')
		.filter(Boolean);
}

test('every inventoried document parses and validates against the pinned schema', () => {
	const schema = buildSchema(loadPinnedSchema().sdl);
	const { documents, problems } = readInventory(trackedSrc());

	assert.deepEqual(problems, [], 'the inventory matches the source in both directions');
	assert.ok(documents.length >= 45, `expected the full document set, got ${documents.length}`);

	for (const document of documents) {
		const errors = validate(schema, parse(document.text), specifiedRules);
		assert.deepEqual(
			errors.map((error) => error.message),
			[],
			`${document.module}:${document.line} ${document.name}`
		);
	}
});

test('the sweep reaches every module that declares an operation', () => {
	const owned = ownedModules(trackedSrc());
	for (const { module } of DOCUMENT_INVENTORY)
		assert.ok(owned.includes(module), `${module} must be in the swept set, or it is not checked`);
	assert.ok(owned.length > DOCUMENT_INVENTORY.length, 'the sweep is wider than the inventory');
});

/**
 * The two silences that would make the inventory decorative, each proven loud.
 *
 * Asserted against a synthetic tree in a temp directory rather than by planting a
 * broken document in THIS repository — the reader takes its root from the module,
 * so the fixtures below exercise `readModuleStringConstants` and `operationNames`
 * directly on files that are nobody's source.
 */
test('an unresolvable interpolation inside an operation is an error, not a skip', () => {
	const dir = mkdtempSync(join(tmpdir(), 'contentus-inventory-'));
	try {
		const file = join(dir, 'probe.ts');
		writeFileSync(
			file,
			'const NAME = compute();\nconst DOC = `query ContentusProbe { ${NAME} }`;\n'
		);
		const { resolved, unresolved } = readModuleStringConstants(file);
		assert.ok(!resolved.has('DOC'), 'a document with an unresolvable span is never "resolved"');
		assert.ok(unresolved.has('DOC'), 'it is reported as unresolved, with a reason');
		assert.match(unresolved.get('DOC').failure, /not a plain identifier|not a top-level string/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('operationNames answers by parsing, not by pattern-matching', () => {
	assert.equal(operationNames('accounts'), null, 'a plain string is not a document');
	assert.equal(
		operationNames('\n\tid\n\tusername\n'),
		null,
		'a selection fragment is not a document'
	);
	assert.deepEqual(operationNames('query ContentusProbe { __typename }'), ['query ContentusProbe']);
	assert.deepEqual(operationNames('mutation M { __typename }'), ['mutation M']);
});

import type {
	ArticleDetail,
	ArticleSummary,
	AuthorSummary,
	CategorySummary,
	ContentFormat,
	FeaturedImage,
	SeriesSummary,
	TocEntry,
} from './types';

/**
 * Adapters from lesser's CMS GraphQL shapes into contentus view models, and
 * from those into the vendored greater blog face's input shape.
 *
 * The renderer-authority gate lives here (`resolveArticleBody`). It is the one
 * place that decides whether an article body may be shown at all, so there is
 * exactly one thing to audit rather than a decision spread across routes.
 */

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function toAuthorSummary(raw: unknown): AuthorSummary | null {
	const node = record(raw);
	if (!node) return null;
	const id = str(node.id);
	if (!id) return null;
	return {
		id,
		username: str(node.username),
		displayName: str(node.displayName),
		avatarUrl: str(node.avatarUrl),
	};
}

export function toCategorySummary(raw: unknown): CategorySummary | null {
	const node = record(raw);
	if (!node) return null;
	const id = str(node.id);
	const slug = str(node.slug);
	const name = str(node.name);
	if (!id || !slug || !name) return null;
	return {
		id,
		slug,
		name,
		description: str(node.description),
		articleCount: num(node.articleCount),
	};
}

export function toSeriesSummary(raw: unknown): SeriesSummary | null {
	const node = record(raw);
	if (!node) return null;
	const id = str(node.id);
	const slug = str(node.slug);
	const title = str(node.title);
	if (!id || !slug || !title) return null;
	return {
		id,
		slug,
		title,
		description: str(node.description),
		articleCount: num(node.articleCount),
	};
}

function toFeaturedImage(raw: unknown): FeaturedImage | null {
	const node = record(raw);
	const url = node ? str(node.url) : null;
	if (!url) return null;
	return { url, description: node ? str(node.description) : null };
}

function toTocEntries(raw: unknown): TocEntry[] {
	return list(raw)
		.map((entry) => {
			const node = record(entry);
			if (!node) return null;
			const id = str(node.id);
			const text = str(node.text);
			if (!id || !text) return null;
			return { id, level: num(node.level, 1), text } satisfies TocEntry;
		})
		.filter((entry): entry is TocEntry => entry !== null);
}

function toContentFormat(raw: unknown): ContentFormat {
	return String(raw).toUpperCase() === 'HTML' ? 'HTML' : 'MARKDOWN';
}

export function toArticleSummary(raw: unknown): ArticleSummary | null {
	const node = record(raw);
	if (!node) return null;
	const id = str(node.id);
	const slug = str(node.slug);
	const title = str(node.title);
	if (!id || !slug || !title) return null;

	return {
		id,
		slug,
		title,
		subtitle: str(node.subtitle),
		excerpt: str(node.excerpt),
		readingTimeMinutes: num(node.readingTimeMinutes),
		wordCount: num(node.wordCount),
		publishedAt: str(node.publishedAt) ?? '',
		updatedAt: str(node.updatedAt) ?? '',
		author: toAuthorSummary(node.author),
		featuredImage: toFeaturedImage(node.featuredImage),
		categories: list(node.categories)
			.map(toCategorySummary)
			.filter((category): category is CategorySummary => category !== null),
	};
}

export function toArticleDetail(raw: unknown): ArticleDetail | null {
	const summary = toArticleSummary(raw);
	const node = record(raw);
	if (!summary || !node) return null;

	return {
		...summary,
		content: typeof node.content === 'string' ? node.content : '',
		contentFormat: toContentFormat(node.contentFormat),
		canonicalUrl: str(node.canonicalUrl),
		seoTitle: str(node.seoTitle),
		seoDescription: str(node.seoDescription),
		ogImage: str(node.ogImage),
		tableOfContents: toTocEntries(node.tableOfContents),
		series: toSeriesSummary(node.series),
		seriesOrder: typeof node.seriesOrder === 'number' ? node.seriesOrder : null,
	};
}

/** Extract the article list and page info from an `ArticleConnection`. */
export function toArticleConnection(raw: unknown): {
	articles: ArticleSummary[];
	endCursor: string | null;
	hasNextPage: boolean;
} {
	const connection = record(raw);
	const pageInfo = connection ? record(connection.pageInfo) : null;

	return {
		articles: list(connection?.edges)
			.map((edge) => toArticleSummary(record(edge)?.node))
			.filter((article): article is ArticleSummary => article !== null),
		endCursor: pageInfo ? str(pageInfo.endCursor) : null,
		hasNextPage: pageInfo?.hasNextPage === true,
	};
}

// ---------------------------------------------------------------------------
// Renderer authority
// ---------------------------------------------------------------------------

export type ArticleBodyDecision =
	| { kind: 'render'; html: string }
	| { kind: 'withhold'; reason: 'unrendered-source' | 'empty' };

/**
 * Decide whether an article body may be displayed.
 *
 * lesser's server-side renderer/sanitizer is the single authority for article
 * HTML (`docs/architecture/cms/fediverse-first-blog-cms-contract.md`
 * → "Renderer authority contract"). Contentus displays that output and nothing
 * else. Two things it will never do, both explicitly forbidden:
 *
 *   - render Markdown client-side, and
 *   - display raw draft/article source as a reading view.
 *
 * On lesser as it stands, GraphQL `Article.content` carries the STORED SOURCE
 * rather than rendered output — only the ActivityPub serialization path runs
 * `cmsrender.RenderArticleContent`. So `contentFormat` is the only signal
 * available for whether what we received is publishable HTML:
 *
 *   HTML     → the body is HTML; the vendored blog face passes it through
 *              greater's `sanitizeHtml` before display. Rendered.
 *   MARKDOWN → the body is Markdown SOURCE that no renderer has touched.
 *              Withheld. Rendering it here would create the second canonical
 *              renderer the contract forbids; showing it raw would publish
 *              source as a reading view. Neither is acceptable, so the reader
 *              shows an explicit state and the gap is tracked upstream.
 *
 * When lesser renders on the read path (or exposes a `renderedHtml` field),
 * this function is where that lands — and the withhold branch disappears.
 */
export function resolveArticleBody(article: ArticleDetail): ArticleBodyDecision {
	if (!article.content.trim()) {
		return { kind: 'withhold', reason: 'empty' };
	}
	if (article.contentFormat !== 'HTML') {
		return { kind: 'withhold', reason: 'unrendered-source' };
	}
	return { kind: 'render', html: article.content };
}

/**
 * The subset of the blog face's `ArticleDisplayData` that contentus populates.
 *
 * Declared structurally rather than imported from the vendored tree: the
 * vendored types are upstream-owned and excluded from our typecheck, and
 * importing them would drag that whole tree into our compilation. Structural
 * typing still fails the build if the face's required fields drift, which is
 * the property worth having.
 */
export interface BlogFaceArticleInput {
	id: string;
	slug: string;
	content: string;
	contentFormat: 'html';
	author: {
		id: string;
		displayName?: string | undefined;
		username?: string | undefined;
		avatarUrl?: string | undefined;
	};
	title?: string | undefined;
	subtitle?: string | undefined;
	excerpt?: string | undefined;
	description?: string | undefined;
	publishedAt?: string | undefined;
	updatedAt?: string | undefined;
	readingTimeMinutes?: number | undefined;
	wordCount?: number | undefined;
	canonicalUrl?: string | undefined;
	seoDescription?: string | undefined;
	featuredImage?: { url: string; altText?: string | undefined } | undefined;
	categories?: { id: string; name: string; slug: string }[] | undefined;
	isPublished?: boolean | undefined;
}

/**
 * Map a contentus article onto the flat input shape the vendored blog face's
 * `normalizeArticleData` accepts (it explicitly supports "the flat
 * Lesser/Emdash article display shape").
 *
 * `content` is passed only for bodies that cleared `resolveArticleBody`; a
 * withheld body is passed as an empty string so no source can reach the DOM
 * even if a future face revision changes its fallback rendering.
 */
export function toBlogFaceArticle(
	article: ArticleSummary | ArticleDetail,
	body?: ArticleBodyDecision
): BlogFaceArticleInput {
	const detail = 'content' in article ? article : null;
	const renderedBody = body?.kind === 'render' ? body.html : '';

	return {
		id: article.id,
		slug: article.slug,
		title: article.title,
		subtitle: article.subtitle ?? undefined,
		excerpt: article.excerpt ?? undefined,
		description: article.excerpt ?? article.subtitle ?? article.title,
		content: renderedBody,
		// Only ever 'html': a withheld body is not Markdown we are choosing not
		// to render, it is content we are declining to display at all.
		contentFormat: 'html',
		publishedAt: article.publishedAt,
		updatedAt: article.updatedAt,
		readingTimeMinutes: article.readingTimeMinutes,
		wordCount: article.wordCount,
		canonicalUrl: detail?.canonicalUrl ?? undefined,
		seoDescription: detail?.seoDescription ?? undefined,
		featuredImage: article.featuredImage
			? { url: article.featuredImage.url, altText: article.featuredImage.description ?? undefined }
			: undefined,
		categories: article.categories.map((category) => ({
			id: category.id,
			name: category.name,
			slug: category.slug,
		})),
		author: {
			id: article.author?.id ?? article.id,
			displayName: article.author?.displayName ?? undefined,
			username: article.author?.username ?? undefined,
			avatarUrl: article.author?.avatarUrl ?? undefined,
		},
		isPublished: true,
	};
}

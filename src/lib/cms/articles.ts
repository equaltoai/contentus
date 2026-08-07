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
		// lesser's field is `avatar` (`type Actor`). Reading `avatarUrl` here read a key
		// no lesser response has ever carried, so every byline avatar was silently null
		// — and stayed null against a real instance, because `str(undefined)` is a
		// perfectly well-behaved way to be wrong.
		avatar: str(node.avatar),
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

/**
 * Has lesser reported this article as deleted?
 *
 * `Article.deletedAt` is lesser's tombstone signal, non-null only on the
 * synthesized Article its single-article reads return once the live article is
 * gone. This is a RAW-node predicate on purpose: it has to be answerable before
 * normalization, because a tombstone carries no title and would otherwise be
 * dropped by the summary guard below — indistinguishable from an address that
 * never existed. Keying on the contract field instead of on the missing title
 * keeps the deletion lesser's statement rather than our inference.
 */
export function isArticleTombstone(raw: unknown): boolean {
	return str(record(raw)?.deletedAt) !== null;
}

/**
 * A tombstone is never an `ArticleSummary`. Rejecting it here — rather than at
 * each call site — is what lets every consumer of these types treat an
 * `ArticleSummary` as a live article, so no surface can render a deleted one by
 * forgetting a check.
 */
export function toArticleSummary(raw: unknown): ArticleSummary | null {
	const node = record(raw);
	if (!node) return null;
	if (isArticleTombstone(node)) return null;
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
		renderedHtml: typeof node.renderedHtml === 'string' ? node.renderedHtml : null,
		canonicalUrl: str(node.canonicalUrl),
		seoTitle: str(node.seoTitle),
		seoDescription: str(node.seoDescription),
		ogImage: str(node.ogImage),
		tableOfContents: toTocEntries(node.tableOfContents),
		series: toSeriesSummary(node.series),
		seriesOrder: typeof node.seriesOrder === 'number' ? node.seriesOrder : null,
	};
}

/**
 * Extract the article list and page info from an `ArticleConnection`.
 *
 * Tombstones are dropped here as a consequence of `toArticleSummary` rejecting
 * them, not by a separate check. lesser's `articles` connection reads the live
 * article store and its converter never sets `deletedAt`, so this filter is
 * defensive rather than load-bearing today — but the guarantee a listing needs
 * is "no deleted article renders as a card", and that has to hold whether or
 * not the list resolver ever starts emitting what the single-article reads
 * already do.
 */
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
	{ kind: 'render' } | { kind: 'withhold'; reason: 'unrendered-source' | 'empty' };

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
 * Since lesser v1.6.2 the read path carries that authority's output directly:
 * `Article.renderedHtml` is the canonical sanitized HTML ("Never fall back to
 * rendering content when this field is unavailable", per the schema itself),
 * produced by the same renderer the ActivityPub serialization path uses. When
 * it is present, it is the body. When it is absent — an older instance — the
 * only signal left is `contentFormat`:
 *
 *   HTML     → the body is HTML; the vendored blog face passes it through
 *              greater's `sanitizeHtml` before display. Rendered.
 *   MARKDOWN → the body is Markdown SOURCE that no renderer has touched.
 *              Withheld. Rendering it here would create the second canonical
 *              renderer the contract forbids; showing it raw would publish
 *              source as a reading view. Neither is acceptable, so the reader
 *              shows an explicit state.
 */
export function resolveArticleBody(article: ArticleDetail): ArticleBodyDecision {
	if (article.renderedHtml?.trim()) {
		return { kind: 'render' };
	}
	if (!article.content.trim()) {
		return { kind: 'withhold', reason: 'empty' };
	}
	if (article.contentFormat !== 'HTML') {
		return { kind: 'withhold', reason: 'unrendered-source' };
	}
	return { kind: 'render' };
}

/**
 * Apply the renderer-authority decision to the article itself.
 *
 * Deciding not to DISPLAY source is not the same as not SENDING it. Contentus
 * server-renders, and its render props travel on to the browser as hydration
 * JSON — so an article whose body the reader withholds was still shipping that
 * body verbatim to every anonymous viewer, one fetch away from the page that
 * politely declined to show it. A withhold that only holds in the template is
 * decoration.
 *
 * So the decision is made once, here, at the point the article is constructed,
 * and the withheld source is dropped rather than carried. Everything the reader
 * legitimately shows — title, byline, dates, reading time, excerpt, table of
 * contents — is server-derived scalar data and is untouched.
 *
 * Callers get the decision back because the reader still needs to say WHY the
 * body is missing, and by then `content` is empty and no longer able to tell it
 * apart from an article lesser returned empty.
 */
export function withholdUnrenderableSource(article: ArticleDetail): {
	article: ArticleDetail;
	body: ArticleBodyDecision;
} {
	const body = resolveArticleBody(article);
	return {
		article: body.kind === 'render' ? article : { ...article, content: '', renderedHtml: null },
		body,
	};
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
	renderedHtml?: string | undefined;
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
 * A body is passed only when it cleared `resolveArticleBody`, and only in the
 * form the authority produced it: when lesser supplied `renderedHtml` (v1.6.2+)
 * that field is the carrier and `content` goes out empty — the stored source
 * is not shipped to the browser beside its own rendering. On the legacy path
 * (no `renderedHtml`, `contentFormat: HTML`) `content` itself is the rendered
 * body. A withheld body goes out as empty strings in both fields so no source
 * can reach the DOM even if a future face revision changes its fallback
 * rendering. By this point `withholdUnrenderableSource` has already emptied
 * them — this is the second of the two locks, not the only one. The vendored
 * normalize prefers `renderedHtml` and marks the format `html` when it is
 * present, which is the same precedence `resolveArticleBody` applies.
 */
export function toBlogFaceArticle(
	article: ArticleSummary | ArticleDetail,
	body?: ArticleBodyDecision
): BlogFaceArticleInput {
	const detail = 'content' in article ? article : null;
	const canonicalHtml = body?.kind === 'render' ? (detail?.renderedHtml ?? null) : null;
	const renderedBody =
		body?.kind === 'render' && !canonicalHtml?.trim() ? (detail?.content ?? '') : '';

	return {
		id: article.id,
		slug: article.slug,
		title: article.title,
		subtitle: article.subtitle ?? undefined,
		excerpt: article.excerpt ?? undefined,
		// Never the title: with no distinct excerpt the card's accessible name
		// announced the same sentence twice (the whole card is one anchor —
		// upstream greater-components#1008). The card's own fallback already
		// shows the subtitle when description is absent, and an article with
		// neither simply shows no excerpt.
		description: article.excerpt ?? article.subtitle ?? undefined,
		content: renderedBody,
		// Only ever 'html': a withheld body is not Markdown we are choosing not
		// to render, it is content we are declining to display at all.
		contentFormat: 'html',
		renderedHtml: canonicalHtml?.trim() ? canonicalHtml : undefined,
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
			// THE BOUNDARY. lesser says `avatar`; the vendored blog face's
			// `normalizeArticleData` reads `avatarUrl`. The rename belongs here and only
			// here — one line, in the function whose whole job is to translate a lesser
			// response into the face's input — so neither side carries the other's
			// vocabulary.
			avatarUrl: article.author?.avatar ?? undefined,
		},
		isPublished: true,
	};
}

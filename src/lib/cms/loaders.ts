import type {
	ArticlesIndexData,
	ArticleReaderData,
	ContentUnavailable,
} from '../../facetheory/types';
import {
	isArticleTombstone,
	toArticleConnection,
	toArticleDetail,
	toCategorySummary,
	toSeriesSummary,
	withholdUnrenderableSource,
} from './articles';
import { GraphQLTransportError, graphqlRequest, isFeatureDisabledError } from './graphql';
import { ARTICLES_PAGE_SIZE } from './pagination';
import {
	ARTICLES_INDEX_QUERY,
	ARTICLE_BY_SLUG_QUERY,
	ARTICLE_NAVIGATION_QUERY,
	CATEGORY_BY_SLUG_QUERY,
	SERIES_BY_SLUG_QUERY,
} from './queries';
import type { CategorySummary, SeriesSummary } from './types';

/**
 * Route loaders for the anonymous article surfaces.
 *
 * These run on the server for every SSR request and again in the browser only
 * when the client navigates. They never attach a token: `articles`,
 * `articleBySlug`, and `categories` are public reads on an instance with CMS
 * long-form enabled, and keeping them anonymous by construction is what makes
 * the reading surface anonymous-safe.
 *
 * No loader throws. A route that cannot load data renders a designed state
 * describing why — an instance with the CMS feature gate off is not an error,
 * and a reader should not see a stack trace because an origin blipped.
 */

const NO_FILTERS = { seriesId: null, categoryId: null };

function unavailableFromFailure(error: unknown): ContentUnavailable {
	if (error instanceof GraphQLTransportError) {
		return {
			reason: 'transport',
			message: 'The instance did not answer. This is usually temporary — try again shortly.',
		};
	}
	return {
		reason: 'transport',
		message: 'The article service could not be reached.',
	};
}

const CMS_DISABLED: ContentUnavailable = {
	reason: 'cms-disabled',
	message: 'Long-form publishing is not enabled on this instance.',
};

export interface LoaderContext {
	/** Absolute endpoint on the server; null in the browser (relative path used). */
	endpoint: string | null;
	signal?: AbortSignal;
}

export async function loadArticlesIndex(
	ctx: LoaderContext,
	filters: { seriesId?: string | null; categoryId?: string | null } = {}
): Promise<ArticlesIndexData> {
	const appliedFilters = {
		seriesId: filters.seriesId ?? null,
		categoryId: filters.categoryId ?? null,
	};
	const empty: ArticlesIndexData = {
		articles: [],
		series: [],
		categories: [],
		endCursor: null,
		hasNextPage: false,
		filters: appliedFilters,
		unavailable: null,
	};

	try {
		const [articlesResult, navigationResult] = await Promise.all([
			graphqlRequest<{ articles: unknown }>(
				ARTICLES_INDEX_QUERY,
				{
					seriesId: filters.seriesId ?? null,
					categoryId: filters.categoryId ?? null,
					first: ARTICLES_PAGE_SIZE,
					after: null,
				},
				{ endpoint: ctx.endpoint, ...(ctx.signal ? { signal: ctx.signal } : {}) }
			),
			// Navigation is supporting chrome: if categories fail while articles
			// succeed, the index still reads. Resolved separately so one does not
			// take the other down.
			graphqlRequest<{ categories: unknown }>(
				ARTICLE_NAVIGATION_QUERY,
				{},
				{ endpoint: ctx.endpoint, ...(ctx.signal ? { signal: ctx.signal } : {}) }
			).catch(() => ({ data: null, errors: [] })),
		]);

		if (isFeatureDisabledError(articlesResult.errors)) {
			return { ...empty, unavailable: CMS_DISABLED };
		}

		const connection = toArticleConnection(articlesResult.data?.articles);
		const categories = Array.isArray(navigationResult.data?.categories)
			? (navigationResult.data.categories as unknown[])
					.map(toCategorySummary)
					.filter((category): category is CategorySummary => category !== null)
			: [];

		// lesser exposes `series(id:)` and `seriesBySlug(slug:)` but no "list all
		// series" query, so the index cannot offer series navigation the way it
		// offers categories. Recorded as an upstream gap; a client-side listing
		// assembled from article pages would be an invented operation, not a
		// consumed one.
		const series: SeriesSummary[] = [];

		if (connection.articles.length === 0 && articlesResult.errors.length > 0) {
			return {
				...empty,
				categories,
				unavailable: {
					reason: 'transport',
					message: 'The instance could not return articles right now.',
				},
			};
		}

		return {
			articles: connection.articles,
			series,
			categories,
			endCursor: connection.endCursor,
			hasNextPage: connection.hasNextPage,
			filters: appliedFilters,
			unavailable: null,
		};
	} catch (error) {
		return { ...empty, unavailable: unavailableFromFailure(error) };
	}
}

/**
 * Resolve a `/series/{slug}` or `/categories/{slug}` route to a filtered index.
 *
 * The filter is resolved to an ID first. If the slug matches nothing, the route
 * reports not-found rather than falling back to the unfiltered listing — a URL
 * that names a category should never quietly render every article.
 */
export async function loadFilteredIndex(
	ctx: LoaderContext,
	kind: 'series' | 'category',
	slug: string
): Promise<ArticlesIndexData> {
	// The resolved filter ID is unknown until the slug lookup answers, so the
	// empty shape here carries no filters; the loaded listing carries its own.
	const empty: ArticlesIndexData = {
		articles: [],
		series: [],
		categories: [],
		endCursor: null,
		hasNextPage: false,
		filters: NO_FILTERS,
		unavailable: null,
	};

	try {
		const query = kind === 'series' ? SERIES_BY_SLUG_QUERY : CATEGORY_BY_SLUG_QUERY;
		const result = await graphqlRequest<Record<string, unknown>>(
			query,
			{ slug },
			{ endpoint: ctx.endpoint, ...(ctx.signal ? { signal: ctx.signal } : {}) }
		);

		if (isFeatureDisabledError(result.errors)) {
			return { ...empty, unavailable: CMS_DISABLED };
		}

		const filter =
			kind === 'series'
				? toSeriesSummary(result.data?.seriesBySlug)
				: toCategorySummary(result.data?.categoryBySlug);

		if (!filter) {
			return {
				...empty,
				unavailable: {
					reason: 'not-found',
					message:
						kind === 'series'
							? 'No series matches this address.'
							: 'No category matches this address.',
				},
			};
		}

		const index = await loadArticlesIndex(
			ctx,
			kind === 'series' ? { seriesId: filter.id } : { categoryId: filter.id }
		);

		return kind === 'series' ? { ...index, series: [filter as SeriesSummary] } : index;
	} catch (error) {
		return { ...empty, unavailable: unavailableFromFailure(error) };
	}
}

export async function loadArticleBySlug(
	ctx: LoaderContext,
	slug: string
): Promise<ArticleReaderData> {
	if (!slug) {
		return {
			article: null,
			body: null,
			unavailable: { reason: 'not-found', message: 'No article was requested.' },
		};
	}

	try {
		const result = await graphqlRequest<{ articleBySlug: unknown }>(
			ARTICLE_BY_SLUG_QUERY,
			{ slug },
			{ endpoint: ctx.endpoint, ...(ctx.signal ? { signal: ctx.signal } : {}) }
		);

		if (isFeatureDisabledError(result.errors)) {
			return { article: null, body: null, unavailable: CMS_DISABLED };
		}

		// The tombstone check runs BEFORE normalization, because normalization is
		// what would hide it: lesser's tombstone Article carries no title, so
		// `toArticleDetail` rejects it and a deletion would arrive here looking
		// exactly like an address that never existed.
		//
		// lesser v1.6.0 closed the gap this used to record. `articleBySlug` now
		// falls back to a synthesized Article with `deletedAt` set when the live
		// article is gone, so contentus can finally distinguish "deleted" from
		// "never existed" on lesser's authority instead of guessing — and a
		// tombstone lesser is willing to show anonymously is a statement it has
		// already decided is public (`cmsArticleTombstoneVisible`).
		if (isArticleTombstone(result.data?.articleBySlug)) {
			return {
				article: null,
				body: null,
				unavailable: {
					reason: 'tombstoned',
					message: 'This article was deleted.',
				},
			};
		}

		const article = toArticleDetail(result.data?.articleBySlug);
		if (!article) {
			return {
				article: null,
				body: null,
				unavailable: { reason: 'not-found', message: 'No article matches this address.' },
			};
		}

		// Renderer authority is applied HERE, not in the template: these props are
		// serialized into the public hydration endpoint, so a withheld body has to
		// be gone before it leaves the loader.
		return { ...withholdUnrenderableSource(article), unavailable: null };
	} catch (error) {
		return { article: null, body: null, unavailable: unavailableFromFailure(error) };
	}
}

// Explicit `.ts` extensions, like `cms/graphql.ts`: this module is loaded
// straight off disk by `node --test --experimental-strip-types`, and Node's
// ESM resolver does not guess extensions. Vite and `tsc`
// (`allowImportingTsExtensions`) both accept the explicit form.
import { toArticleConnection } from './articles.ts';
import { graphqlRequest } from './graphql.ts';
import { ARTICLES_INDEX_QUERY } from './queries.ts';
import type { ArticleSummary } from './types.ts';

export const ARTICLES_PAGE_SIZE = 12;

export interface ArticlesPageFilters {
	seriesId?: string | null;
	categoryId?: string | null;
}

export interface ArticlesPage {
	articles: ArticleSummary[];
	endCursor: string | null;
	hasNextPage: boolean;
}

/**
 * One page of the articles index — the initial load and every "Load more".
 *
 * Anonymous, like every article read: `articles` is public on an instance
 * with CMS long-form enabled and no token is ever attached. In the browser
 * `endpoint` stays null and the request goes to the same-origin relative
 * path, so pagination inherits the anonymous-safe transport by construction.
 *
 * Returns null on any failure. The initial load distinguishes failure causes
 * because it must choose a designed state; a failed NEXT page changes nothing
 * on screen, so the only fact the caller needs is "did not load" — the
 * control stays and the reader can retry.
 */
export async function fetchArticlesPage(
	filters: ArticlesPageFilters,
	after: string | null,
	options: { endpoint?: string | null; signal?: AbortSignal } = {}
): Promise<ArticlesPage | null> {
	try {
		const result = await graphqlRequest<{ articles: unknown }>(
			ARTICLES_INDEX_QUERY,
			{
				seriesId: filters.seriesId ?? null,
				categoryId: filters.categoryId ?? null,
				first: ARTICLES_PAGE_SIZE,
				after,
			},
			{ endpoint: options.endpoint ?? null, ...(options.signal ? { signal: options.signal } : {}) }
		);

		const connection = toArticleConnection(result.data?.articles);
		if (connection.articles.length === 0 && result.errors.length > 0) return null;
		return connection;
	} catch {
		return null;
	}
}

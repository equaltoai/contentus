import type { ArticleBodyDecision } from '$lib/cms/articles';
import type { ArticleSummary, ArticleDetail, CategorySummary, SeriesSummary } from '$lib/cms/types';

/** Stable identifier for each contentus surface in the M1 route table. */
export type AppPageKey =
	'articles-index' | 'article-reader' | 'series' | 'category' | 'auth-callback' | 'not-found';

/**
 * Brand surface variant, applied as `data-surface` on the shell root. Face 1
 * (Articles) is the journal surface; faces 3-7 land on core/mcp in later
 * milestones (product design §2).
 */
export type SurfaceVariant = 'journal' | 'core' | 'mcp';

export interface AppPageDescriptor {
	key: AppPageKey;
	path: string;
	title: string;
	eyebrow: string;
	summary: string;
	surface: SurfaceVariant;
	/** Whether lesser requires an authenticated caller for this surface's reads. */
	requiresAuth: boolean;
}

/**
 * Why an article surface has no content to show. Distinguishing these matters:
 * a feature-gated instance is a designed empty state, a renderer gap is an
 * upstream defect, and a transport failure is transient.
 */
export type ContentUnavailableReason =
	'cms-disabled' | 'not-found' | 'tombstoned' | 'unrendered-source' | 'transport';

export interface ContentUnavailable {
	reason: ContentUnavailableReason;
	/** Operator/reader-facing explanation. Never contains raw article source. */
	message: string;
}

export interface ArticlesIndexData {
	articles: ArticleSummary[];
	series: SeriesSummary[];
	categories: CategorySummary[];
	endCursor: string | null;
	hasNextPage: boolean;
	unavailable: ContentUnavailable | null;
}

export interface ArticleReaderData {
	/**
	 * The article as it may leave the server. When `body` withholds, `content`
	 * has already been emptied — these props are serialized into the public
	 * hydration endpoint, so a body the reader declines to show must not be
	 * sitting in the payload behind it.
	 */
	article: ArticleDetail | null;
	/**
	 * Why the body is or is not displayable, decided once in
	 * `withholdUnrenderableSource`. The reader presents this rather than
	 * re-deriving it — by the time props arrive, an emptied `content` is
	 * indistinguishable from an article lesser returned empty.
	 */
	body: ArticleBodyDecision | null;
	unavailable: ContentUnavailable | null;
}

export interface RouteProps {
	page: AppPageDescriptor;
	/** Slug captured from `/articles/{slug}`, `/series/{slug}`, `/categories/{slug}`. */
	slug: string | null;
	index: ArticlesIndexData | null;
	reader: ArticleReaderData | null;
}

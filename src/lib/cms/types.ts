/**
 * Contentus-side view of lesser's CMS contract.
 *
 * These mirror `docs/contracts/graphql-schema.graphql` in the lesser repo and
 * are deliberately narrow: only the fields the M1 article surfaces read. They
 * are a consumption view, never a redefinition — when lesser's contract moves,
 * this file follows it, and a field contentus wants but lesser does not expose
 * is an upstream issue, not an invention here.
 */

/** `enum ContentFormat { HTML MARKDOWN }` */
export type ContentFormat = 'HTML' | 'MARKDOWN';

/**
 * `type Actor`, narrowed to what an article byline reads.
 *
 * `avatar` carries lesser's field name deliberately. This is the RESPONSE shape —
 * what came back off the wire — so renaming it here would put a name lesser never
 * sent into the one place a reader goes to learn what lesser sends. The Greater blog
 * face wants `avatarUrl`, and it gets it, at the view-model boundary in
 * `cms/articles.ts` where the translation is visible and one line long.
 */
export interface AuthorSummary {
	id: string;
	username: string | null;
	displayName: string | null;
	avatar: string | null;
}

export interface SeriesSummary {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	articleCount: number;
}

export interface CategorySummary {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	articleCount: number;
}

export interface FeaturedImage {
	url: string;
	description: string | null;
}

export interface TocEntry {
	id: string;
	level: number;
	text: string;
}

/** Shape used by the index grid — no article body is fetched or held. */
export interface ArticleSummary {
	id: string;
	slug: string;
	title: string;
	subtitle: string | null;
	excerpt: string | null;
	readingTimeMinutes: number;
	wordCount: number;
	publishedAt: string;
	updatedAt: string;
	author: AuthorSummary | null;
	featuredImage: FeaturedImage | null;
	categories: CategorySummary[];
}

/** Shape used by the reader. `content`/`contentFormat` carry lesser's body. */
export interface ArticleDetail extends ArticleSummary {
	content: string;
	contentFormat: ContentFormat;
	canonicalUrl: string | null;
	seoTitle: string | null;
	seoDescription: string | null;
	ogImage: string | null;
	tableOfContents: TocEntry[];
	series: SeriesSummary | null;
	seriesOrder: number | null;
}

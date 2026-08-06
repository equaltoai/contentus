/**
 * Read operations against lesser's CMS contract.
 *
 * Every field selected here exists in lesser `docs/contracts/graphql-schema.graphql`
 * (`type Article`, `type Series`, `type Category`, `ArticleConnection`). Nothing is
 * speculative: a field contentus wants that lesser does not expose is an upstream
 * issue, never a client-side substitute.
 *
 * DEPTH. lesser enforces `GRAPHQL_MAX_DEPTH` (default 12) for ordinary callers and a
 * hard cap of 3 for agent/CLI-class tokens (`cmd/graphql/main.go`). Contentus's public
 * reads are anonymous, so the effective limit is 12. The depth-3 cap cannot express a
 * Relay connection at all — `articles → edges → node → field` is already depth 4 — so
 * the product design's "prefer authorId scalars" guidance is honored where it buys
 * something (the reader selects a minimal author) rather than treated as a limit these
 * queries could actually meet.
 *
 * These documents are anonymous-safe: `articles`, `articleBySlug`, `series`, and
 * `categories` are public reads when the instance has CMS long-form enabled.
 */

/**
 * `Article.author` is an `Actor`, and an Actor's avatar field is `avatar`.
 *
 * It was `avatarUrl` here until this milestone, which is a field lesser's schema
 * has never had — `graphql-schema.graphql` `type Actor` publishes `avatar: String`.
 * The name came from the vendored greater adapter's own `Account` projection, not
 * from lesser, and nothing caught the difference because the only things checking
 * these documents were fixtures that had been written to match the query. A mock
 * that agrees with a wrong query is not evidence; it is the same mistake, twice.
 *
 * `scripts/audit-graphql-contract.mjs` now validates every document this
 * repository can send against the pinned schema, so this class of drift fails the
 * build instead of failing the instance. The Greater-facing `avatarUrl` name still
 * exists, but only past the view-model boundary in `cms/articles.ts` — lesser's
 * response shape keeps lesser's field name.
 */
const AUTHOR_FIELDS = `
	id
	username
	displayName
	avatar
`;

const CATEGORY_FIELDS = `
	id
	slug
	name
	description
	articleCount
`;

const SERIES_FIELDS = `
	id
	slug
	title
	description
	articleCount
`;

/**
 * Index card fields. The article BODY is deliberately absent: an index that
 * never fetches `content` cannot leak unrendered source into a listing, and it
 * keeps the payload proportional to what the grid shows.
 *
 * TOMBSTONES. `deletedAt` is selected on every article read because lesser
 * v1.6.0 surfaces article tombstones where earlier versions returned nothing:
 * `article(id)`, `articleBySlug(slug)`, and the legacy `/objects/<uuid>` path
 * all fall back to a synthesized Article carrying `deletedAt` when the live
 * article is gone (lesser `graph/query_resolvers_cms.go`, `deletedCMSArticle`).
 * That Article has no title and no body, so a client that does not ask for
 * `deletedAt` cannot tell a deletion from a live article lesser returned
 * empty — it can only guess from the missing title. Selecting the field makes
 * the distinction lesser's to state rather than ours to infer.
 */
const ARTICLE_SUMMARY_FIELDS = `
	id
	deletedAt
	slug
	title
	subtitle
	excerpt
	readingTimeMinutes
	wordCount
	publishedAt
	updatedAt
	featuredImage { url description }
	categories { ${CATEGORY_FIELDS} }
	author { ${AUTHOR_FIELDS} }
`;

export const ARTICLES_INDEX_QUERY = `
	query ContentusArticlesIndex($seriesId: ID, $categoryId: ID, $first: Int, $after: Cursor) {
		articles(seriesId: $seriesId, categoryId: $categoryId, first: $first, after: $after) {
			totalCount
			pageInfo { hasNextPage endCursor }
			edges {
				cursor
				node { ${ARTICLE_SUMMARY_FIELDS} }
			}
		}
	}
`;

export const ARTICLE_NAVIGATION_QUERY = `
	query ContentusArticleNavigation {
		categories { ${CATEGORY_FIELDS} }
	}
`;

/**
 * Resolve a filter slug to the ID `articles(seriesId:, categoryId:)` expects.
 *
 * The index filters take IDs while contentus's routes are slugged, so the
 * filtered views resolve first. Both lookups are single public queries, and
 * either resolving to null is a 404 for that filter rather than an unfiltered
 * listing — silently showing everything would misrepresent the URL.
 */
export const SERIES_BY_SLUG_QUERY = `
	query ContentusSeriesBySlug($slug: String!) {
		seriesBySlug(slug: $slug) { ${SERIES_FIELDS} }
	}
`;

export const CATEGORY_BY_SLUG_QUERY = `
	query ContentusCategoryBySlug($slug: String!) {
		categoryBySlug(slug: $slug) { ${CATEGORY_FIELDS} }
	}
`;

export const ARTICLE_BY_SLUG_QUERY = `
	query ContentusArticleBySlug($slug: String!) {
		articleBySlug(slug: $slug) {
			${ARTICLE_SUMMARY_FIELDS}
			content
			contentFormat
			canonicalUrl
			seoTitle
			seoDescription
			ogImage
			tableOfContents { id level text }
			series { ${SERIES_FIELDS} }
			seriesOrder
		}
	}
`;

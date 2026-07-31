import type { ArticleBodyDecision } from '$lib/cms/articles';
import type { SourceStatus } from '$lib/cms/compose';
import type { ArticleSummary, ArticleDetail, CategorySummary, SeriesSummary } from '$lib/cms/types';
import type { TimelineFailure, TimelinePage } from '$lib/timelines/contract';
import type { TimelineTabId } from '$lib/timelines/tabs';
import type { Account } from '$lib/types';

/** Stable identifier for each contentus surface in the route table. */
export type AppPageKey =
	| 'articles-index'
	| 'article-reader'
	| 'series'
	| 'category'
	| 'compose'
	| 'review-queue'
	| 'review-workspace'
	| 'timelines'
	| 'profile'
	| 'auth-callback'
	| 'not-found';

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

/**
 * What the composer was opened to do. Derived from the query string, because
 * a reply is the same surface as a new post with a target attached — not a
 * different route.
 */
export type ComposeMode = 'new' | 'reply' | 'quote' | 'edit';

export interface ComposeIntent {
	mode: ComposeMode;
	/** lesser Object id the intent refers to; null for a plain new post. */
	statusId: string | null;
}

export interface ComposeData {
	intent: ComposeIntent;
	/**
	 * The source status, when the server could load it.
	 *
	 * The SSR pass is anonymous by design — the session lives in
	 * `sessionStorage` — so this resolves for public statuses and comes back
	 * null for anything narrower. The client reloads it with the token on
	 * mount. A null here is "not yet", never "does not exist".
	 */
	source: SourceStatus | null;
}

/**
 * What `/review/drafts/{id}` carries from the server.
 *
 * The draft id and nothing else, and the emptiness is the design. Every review
 * operation needs a bearer token, the session lives in `sessionStorage`, and
 * these props are serialized into a PUBLIC hydration endpoint — so a
 * server-side metadata or preview fetch would put an unpublished draft behind a
 * URL anyone could request. The route ships its address; the draft arrives once
 * the client has read the session (product design §5, face 2).
 */
export interface ReviewRouteData {
	/** Draft id from `/review/drafts/{id}`. */
	draftId: string | null;
	/** Which panel the single-column workspace opens on, from `?panel=`. */
	panel: ReviewPanel;
}

/**
 * The single-column workspace shows one panel at a time, never a split view
 * (product design §5). It travels in the URL rather than living only in
 * component state so a reviewer can link to "the preview of this draft".
 */
export type ReviewPanel = 'details' | 'preview';

/**
 * What `/timelines` carries from the server.
 *
 * `page` is present for Instance and Federated and null for Home, and the
 * asymmetry is the contract rather than an oversight. Those two are
 * anonymous-safe reads of public content, so the server fetches them and a cold
 * deep link paints a real timeline; Home needs a token the server does not have,
 * and these props are serialized into a PUBLIC hydration endpoint, so a
 * server-side Home fetch would put one reader's follow graph behind a URL
 * anyone could request. See `isServerFetchable`.
 */
export interface TimelinesRouteData {
	tab: TimelineTabId;
	/** The first page, when the server could and should fetch it. */
	page: TimelinePage | null;
	/**
	 * Why there is no page. Null alongside a null `page` means "not fetched
	 * here" — the Home case — which the client resolves after reading the
	 * session. A reason means the server tried and lesser said no.
	 */
	failure: TimelineFailure | null;
	/**
	 * lesser answered the server's read, and part of the answer failed. See
	 * `TimelineResult.partial`.
	 *
	 * It travels because the server pass is the ONLY pass for a reader with no
	 * script, and the first paint for everyone else. A failed nullable field
	 * comes back looking exactly like an absent one, so dropping this marker at
	 * the SSR boundary would hand the page a timeline it believes is complete —
	 * the transport's whole reason for carrying the marker, undone one layer
	 * later.
	 */
	partial: boolean;
}

/**
 * What `/profiles/{username}` carries from the server.
 *
 * Both halves are anonymous-safe (`actor` is on lesser's public-read list and
 * ACTOR timelines need no token), so a profile deep link server-renders
 * completely — header, posts and all — which is the whole point of the surface.
 */
export interface ProfileRouteData {
	/** The handle from the path, `user@host` or a bare local username. */
	handle: string | null;
	actor: Account | null;
	page: TimelinePage | null;
	failure: TimelineFailure | null;
	/**
	 * The ACTOR read half-failed. Two markers rather than one because the route
	 * makes two reads and they fail independently: this one is about the posts.
	 */
	pagePartial: boolean;
	/**
	 * The `actor(username:)` read half-failed, so the card above the posts is
	 * missing something. A distinct claim from `pagePartial` and a distinct
	 * screen — "parts of this profile" is not "parts of these posts" — and
	 * collapsing them would put the wrong sentence over the wrong element.
	 */
	actorPartial: boolean;
}

export interface RouteProps {
	page: AppPageDescriptor;
	/** Slug captured from `/articles/{slug}`, `/series/{slug}`, `/categories/{slug}`. */
	slug: string | null;
	index: ArticlesIndexData | null;
	reader: ArticleReaderData | null;
	compose: ComposeData | null;
	review: ReviewRouteData | null;
	timelines: TimelinesRouteData | null;
	profile: ProfileRouteData | null;
}

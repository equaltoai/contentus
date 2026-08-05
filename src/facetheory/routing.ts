import { APP_BASE_PATH } from '$lib/config/base-path';
import { DEFAULT_TIMELINE_TAB, tabFor, type TimelineTabId } from '$lib/timelines/tabs';

import type {
	AppPageDescriptor,
	AppPageKey,
	ComposeIntent,
	MessageFolderTab,
	ReviewPanel,
	RouteProps,
} from './types';

export const FACETHEORY_BASE_PATH = APP_BASE_PATH;

/**
 * The M1 route table.
 *
 * String-based, not filesystem-derived: lesser performs no SPA fallback under
 * `/l/*`, so every route here must server-render on a cold request. A route
 * that is not in this table and not matched by the catch-all does not exist.
 *
 * Faces 4-7 (timelines, messages, agents, drones) are registered only as their
 * milestones land — a nav entry pointing at a route that 404s is worse than one
 * that is not there.
 *
 * `/compose` (face 3) and the `/review` pair (face 2) require an authenticated
 * caller, but they are still fully server-rendered routes: the session lives in
 * `sessionStorage`, so the server cannot know who is asking, and rendering the
 * signed-out state is both the honest answer and the only one a cold deep link
 * can produce.
 */
const PAGE_DEFINITIONS: Record<AppPageKey, AppPageDescriptor> = {
	'articles-index': {
		key: 'articles-index',
		path: '/',
		title: 'Articles',
		eyebrow: 'Long-form publishing',
		summary: 'Essays and long-form writing published on this instance.',
		surface: 'journal',
		requiresAuth: false,
	},
	'article-reader': {
		key: 'article-reader',
		path: '/articles',
		title: 'Article',
		eyebrow: 'Reading',
		summary: 'A long-form article published on this instance.',
		surface: 'journal',
		requiresAuth: false,
	},
	series: {
		key: 'series',
		path: '/series',
		title: 'Series',
		eyebrow: 'Collected writing',
		summary: 'Articles collected into a series.',
		surface: 'journal',
		requiresAuth: false,
	},
	category: {
		key: 'category',
		path: '/categories',
		title: 'Category',
		eyebrow: 'Browse by category',
		summary: 'Articles filed under a category.',
		surface: 'journal',
		requiresAuth: false,
	},
	compose: {
		key: 'compose',
		path: '/compose',
		title: 'New post',
		eyebrow: 'Post to timeline',
		summary: 'Write a post for this instance and the wider fediverse.',
		surface: 'core',
		requiresAuth: true,
	},
	'review-queue': {
		key: 'review-queue',
		path: '/review',
		title: 'Review',
		eyebrow: 'Article review',
		summary: 'Drafts shared with you for review, and your own agent-generated drafts.',
		surface: 'journal',
		requiresAuth: true,
	},
	'review-workspace': {
		key: 'review-workspace',
		path: '/review/drafts',
		title: 'Review draft',
		eyebrow: 'Article review',
		summary: "Read the instance's rendered preview and the attribution behind it.",
		surface: 'journal',
		requiresAuth: true,
	},
	timelines: {
		key: 'timelines',
		path: '/timelines',
		title: 'Timelines',
		eyebrow: 'Instance and fediverse',
		summary: 'Posts from this instance and the wider fediverse.',
		surface: 'core',
		// The ROUTE is anonymous — Instance and Federated are anonymous-safe
		// reads. Only the Home tab needs a token, and it says so itself rather
		// than making the whole surface auth-gated; marking the page
		// `requiresAuth` here would send `no-store, noindex` on a public
		// reading surface.
		requiresAuth: false,
	},
	messages: {
		key: 'messages',
		path: '/messages',
		title: 'Messages',
		eyebrow: 'Direct messages',
		summary: 'Private conversations, and the requests waiting on your answer.',
		surface: 'mcp',
		// Unlike `/timelines`, this whole surface is auth-gated: lesser serves no
		// part of `conversations` anonymously, and the honest anonymous render is
		// a sign-in prompt. `requiresAuth` is what sends `no-store` and
		// `noindex` — correct for a private surface even though the anonymous
		// document carries nothing.
		requiresAuth: true,
	},
	'message-thread': {
		key: 'message-thread',
		path: '/messages',
		title: 'Conversation',
		eyebrow: 'Direct messages',
		summary: 'A private conversation on this instance.',
		surface: 'mcp',
		requiresAuth: true,
	},
	agents: {
		key: 'agents',
		path: '/agents',
		title: 'Agents',
		eyebrow: 'Agents and MCP',
		summary: 'Agents registered on this instance, and the MCP surface each publishes.',
		surface: 'mcp',
		// Anonymous, like `/timelines` and unlike `/messages`: lesser serves
		// `agents` and `agent` without a caller. Only `myAgents` and the
		// `ownerUsername` filter need a token, and the surfaces that use them say
		// so themselves rather than gating the whole public roster.
		requiresAuth: false,
	},
	'agent-detail': {
		key: 'agent-detail',
		path: '/agents',
		title: 'Agent',
		eyebrow: 'Agents and MCP',
		summary: 'An agent on this instance, and the MCP surface it publishes.',
		surface: 'mcp',
		// Anonymous, and `mcpAccess` in particular is NOT among the fields lesser
		// redacts for non-owners — so the published MCP contract is public and
		// belongs in the server's paint.
		requiresAuth: false,
	},
	drones: {
		key: 'drones',
		path: '/drones',
		title: 'Your drones',
		eyebrow: 'Drone creation',
		summary: 'Create and track the unsouled agents owned by your Lesser account.',
		surface: 'mcp',
		requiresAuth: true,
	},
	profile: {
		key: 'profile',
		path: '/profiles',
		title: 'Profile',
		eyebrow: 'Actor',
		summary: 'An actor on this instance or elsewhere in the fediverse, and their posts.',
		surface: 'core',
		requiresAuth: false,
	},
	'auth-callback': {
		key: 'auth-callback',
		path: '/auth/callback',
		title: 'Completing sign-in',
		eyebrow: 'Authorization',
		summary: 'Finishing the lesser Authorization Code + PKCE exchange.',
		surface: 'journal',
		requiresAuth: false,
	},
	'not-found': {
		key: 'not-found',
		path: '/404',
		title: 'Not found',
		eyebrow: 'Unknown address',
		summary: 'This address does not match any contentus surface.',
		surface: 'journal',
		requiresAuth: false,
	},
};

/** Route patterns registered with FaceTheory. Every one server-renders. */
export const ROUTE_PATTERNS = [
	'/',
	'/articles/{slug}',
	'/series/{slug}',
	'/categories/{slug}',
	'/compose',
	'/review',
	'/review/drafts/{id}',
	'/timelines',
	'/messages',
	'/messages/{conversationId}',
	'/agents',
	'/agents/{username}',
	'/drones',
	'/profiles/{username}',
	'/auth/callback',
	'/{proxy+}',
] as const;

export function stripBasePath(pathname: string): string {
	const raw = String(pathname || '').trim() || '/';
	if (raw === FACETHEORY_BASE_PATH || raw === `${FACETHEORY_BASE_PATH}/`) return '/';
	if (raw.startsWith(`${FACETHEORY_BASE_PATH}/`)) {
		return raw.slice(FACETHEORY_BASE_PATH.length) || '/';
	}
	return raw.startsWith('/') ? raw : `/${raw}`;
}

export function normalizeRoutePath(pathname: string): string {
	const withoutBase = stripBasePath(pathname);
	if (!withoutBase || withoutBase === '/') return '/';
	const trimmed =
		withoutBase.endsWith('/') && withoutBase !== '/' ? withoutBase.slice(0, -1) : withoutBase;
	return trimmed || '/';
}

function segmentAfter(route: string, prefix: string): string | null {
	if (!route.startsWith(prefix)) return null;
	const raw = route.slice(prefix.length).trim();
	if (!raw) return null;
	try {
		return decodeURIComponent(raw) || null;
	} catch {
		return raw;
	}
}

export function resolvePage(pathname: string): AppPageDescriptor {
	const route = normalizeRoutePath(pathname);

	if (route === '/') return PAGE_DEFINITIONS['articles-index'];
	if (route === '/compose') return PAGE_DEFINITIONS.compose;
	if (route === '/review') return PAGE_DEFINITIONS['review-queue'];
	// `/review/drafts` with no id names no draft, so it is not the workspace: it
	// falls through to not-found rather than rendering an empty one.
	if (segmentAfter(route, '/review/drafts/')) return PAGE_DEFINITIONS['review-workspace'];
	if (route === '/timelines') return PAGE_DEFINITIONS.timelines;
	if (route === '/messages') return PAGE_DEFINITIONS.messages;
	// `/messages/` with no id names no conversation, so it is not the thread
	// surface: it falls through to not-found rather than rendering an empty one.
	// Same rule as `/review/drafts` and `/profiles` above.
	if (segmentAfter(route, '/messages/')) return PAGE_DEFINITIONS['message-thread'];
	if (route === '/agents') return PAGE_DEFINITIONS.agents;
	// `/agents/` with no username names no agent, so it is not the detail
	// surface: it falls through to the roster rather than rendering an empty
	// one. The trailing slash normalises away first, which is why this reads as
	// the roster above rather than as not-found — the same resolution
	// `/messages/` takes, and the better of the two answers.
	if (segmentAfter(route, '/agents/')) return PAGE_DEFINITIONS['agent-detail'];
	if (route === '/drones') return PAGE_DEFINITIONS.drones;
	// `/profiles` with no username names no actor, so it is not the profile
	// surface: it falls through to not-found rather than rendering an empty one.
	// Same rule as `/review/drafts` above.
	if (segmentAfter(route, '/profiles/')) return PAGE_DEFINITIONS.profile;
	if (route === '/auth/callback') return PAGE_DEFINITIONS['auth-callback'];
	if (segmentAfter(route, '/articles/')) return PAGE_DEFINITIONS['article-reader'];
	if (segmentAfter(route, '/series/')) return PAGE_DEFINITIONS.series;
	if (segmentAfter(route, '/categories/')) return PAGE_DEFINITIONS.category;

	return PAGE_DEFINITIONS['not-found'];
}

/**
 * Draft id captured from `/review/drafts/{id}`, or null.
 *
 * Kept separate from `resolveSlug` because it names a different kind of thing: a
 * slug is a published article's public identity, a draft id names an
 * unpublished object only its author and invited reviewers may see. One shared
 * accessor would invite a route to read one where it meant the other.
 */
export function resolveDraftId(pathname: string): string | null {
	return segmentAfter(normalizeRoutePath(pathname), '/review/drafts/');
}

/**
 * Which workspace panel a link opens, from `?panel=`.
 *
 * Anything unrecognised is `details`: the rail is where a reviewer starts —
 * attribution before prose — and a malformed link should land somewhere
 * sensible rather than nowhere.
 */
export function resolveReviewPanel(
	query: Readonly<Record<string, string[] | undefined>> | undefined
): ReviewPanel {
	return query?.['panel']?.[0]?.trim().toLowerCase() === 'preview' ? 'preview' : 'details';
}

/** Slug captured from whichever slugged route matched, or null. */
export function resolveSlug(pathname: string): string | null {
	const route = normalizeRoutePath(pathname);
	return (
		segmentAfter(route, '/articles/') ??
		segmentAfter(route, '/series/') ??
		segmentAfter(route, '/categories/')
	);
}

/**
 * What `/compose` was opened to do, read from the query string.
 *
 * One route, four intents. A reply is not a different surface from a new post —
 * it is the same composer with a target attached — so it is not a different
 * route either, and `/compose?inReplyTo=…` deep-links and server-renders like
 * anything else.
 *
 * Exactly one intent wins, in a fixed order, because a link carrying two is
 * malformed rather than ambiguous: guessing which the caller meant would make
 * the composer's behaviour depend on parameter order in a URL somebody else
 * built.
 */
export function resolveComposeIntent(
	query: Readonly<Record<string, string[] | undefined>> | undefined
): ComposeIntent {
	const first = (key: string): string | null => {
		const value = query?.[key]?.[0];
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	};

	const edit = first('edit');
	if (edit) return { mode: 'edit', statusId: edit };

	const inReplyTo = first('inReplyTo');
	if (inReplyTo) return { mode: 'reply', statusId: inReplyTo };

	const quote = first('quote');
	if (quote) return { mode: 'quote', statusId: quote };

	return { mode: 'new', statusId: null };
}

/** App-relative href for a compose intent, so callers do not hand-build one. */
export function composeHref(intent: ComposeIntent): string {
	if (!intent.statusId || intent.mode === 'new') return href('/compose');

	const key = intent.mode === 'edit' ? 'edit' : intent.mode === 'reply' ? 'inReplyTo' : 'quote';
	return `${href('/compose')}?${key}=${encodeURIComponent(intent.statusId)}`;
}

/**
 * The username captured from `/profiles/{username}`, or null.
 *
 * Kept separate from `resolveSlug` for the reason `resolveDraftId` is: a
 * username names an actor, a slug names an article, and one shared accessor
 * would let a route read whichever it did not mean.
 */
export function resolveProfileUsername(pathname: string): string | null {
	return segmentAfter(normalizeRoutePath(pathname), '/profiles/');
}

/**
 * Which timeline tab a link opens, from `?tab=`.
 *
 * An unrecognised value resolves to the default rather than to not-found: the
 * tab is a view onto one surface, not a different address, and a stale link
 * should land on the timelines page rather than on an error. `?tab=home` for an
 * anonymous reader deliberately still resolves to Home — the route explains
 * that it needs a sign-in, which is more useful than silently showing Instance
 * under a URL that says otherwise.
 */
export function resolveTimelineTab(
	query: Readonly<Record<string, string[] | undefined>> | undefined
): TimelineTabId {
	return tabFor(query?.['tab']?.[0]).id;
}

/** App-relative href for a timeline tab, so callers do not hand-build one. */
export function timelinesHref(tab?: TimelineTabId): string {
	const base = href('/timelines');
	return !tab || tab === DEFAULT_TIMELINE_TAB ? base : `${base}?tab=${tab}`;
}

/**
 * The conversation id captured from `/messages/{conversationId}`, or null.
 *
 * Its own accessor for the reason `resolveDraftId` is: a conversation id names
 * a private thread between named people, and a shared accessor would let a
 * route read one where it meant a slug or a username.
 */
export function resolveConversationId(pathname: string): string | null {
	return segmentAfter(normalizeRoutePath(pathname), '/messages/');
}

/**
 * Which messages folder a link opens, from `?folder=`.
 *
 * Requests is a first-class tab, so it is addressable. Anything unrecognised
 * resolves to the inbox rather than to not-found — same rule as the timeline
 * tab: the folder is a view onto one surface, not a different address, and a
 * stale link should land on the messages page rather than on an error.
 */
export function resolveMessageFolder(
	query: Readonly<Record<string, string[] | undefined>> | undefined
): MessageFolderTab {
	return query?.['folder']?.[0]?.trim().toLowerCase() === 'requests' ? 'requests' : 'inbox';
}

/** App-relative href for a messages folder, so callers do not hand-build one. */
export function messagesHref(folder?: MessageFolderTab): string {
	const base = href('/messages');
	return folder === 'requests' ? `${base}?folder=requests` : base;
}

/** App-relative href for one conversation's thread. */
export function conversationHref(conversationId: string): string {
	return href(`/messages/${encodeURIComponent(conversationId)}`);
}

/**
 * App-relative href for an actor.
 *
 * Takes the full `user@host` handle, because that is what identifies an actor
 * across the fediverse and what lesser's `actor(username:)` resolves. A bare
 * username would silently mean "the local one".
 */
export function profileHref(handle: string): string {
	return href(`/profiles/${encodeURIComponent(handle)}`);
}

/**
 * App-relative href for the agent roster, filters included.
 *
 * Lives here with the other href builders rather than beside the filter model,
 * so `$lib/agents/filters` stays a pure module with no route dependency — the
 * same split `$lib/timelines/tabs` and `timelinesHref` already use.
 *
 * `after` is a cursor, and a cursor is only meaningful within the query that
 * produced it: a caller changing any facet must drop it, or lesser is asked to
 * resume a list that no longer exists. The type makes that the caller's
 * decision by taking the whole state at once.
 */
export function agentsHref(
	filters: {
		type?: string | null;
		query?: string | null;
		verified?: boolean | null;
		after?: string | null;
	} = {}
): string {
	const params = new URLSearchParams();
	if (filters.type) params.set('type', filters.type);
	if (filters.query) params.set('q', filters.query);
	if (filters.verified === true) params.set('verified', 'true');
	if (filters.verified === false) params.set('verified', 'false');
	if (filters.after) params.set('after', filters.after);

	const search = params.toString();
	return search ? `${href('/agents')}?${search}` : href('/agents');
}

/**
 * Agent username captured from `/agents/{username}`, or null.
 *
 * Kept separate from `resolveProfileUsername` because the two name different
 * things: a profile handle is `user@host` and may be remote, while `agent(username:)`
 * resolves a LOCAL agent on this instance. One shared accessor would invite a
 * route to read one where it meant the other.
 */
export function resolveAgentUsername(pathname: string): string | null {
	return segmentAfter(normalizeRoutePath(pathname), '/agents/');
}

/** App-relative href for one agent's detail page. */
export function agentHref(username: string): string {
	return href(`/agents/${encodeURIComponent(username.trim().replace(/^@/, ''))}`);
}

/** Build an app-relative href, base path included. */
export function href(path: string): string {
	if (path === '/') return `${FACETHEORY_BASE_PATH}/`;
	return `${FACETHEORY_BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

export function articleHref(slug: string): string {
	return href(`/articles/${encodeURIComponent(slug)}`);
}

export function categoryHref(slug: string): string {
	return href(`/categories/${encodeURIComponent(slug)}`);
}

export function seriesHref(slug: string): string {
	return href(`/series/${encodeURIComponent(slug)}`);
}

export function reviewQueueHref(): string {
	return href('/review');
}

export function reviewDraftHref(draftId: string, panel?: ReviewPanel): string {
	const path = href(`/review/drafts/${encodeURIComponent(draftId)}`);
	return panel === 'preview' ? `${path}?panel=preview` : path;
}

/**
 * HTTP status a rendered route should be served with.
 *
 * The route descriptor alone cannot answer this: `/articles/{slug}` matches
 * whether or not the slug names anything, so a missing article was rendering
 * "Article not found" under a 200. Crawlers index that, caches keep it, and
 * monitoring reads a healthy instance. The loader already knows — it returns a
 * `not-found` state — so status derives from the loaded data, not just the path.
 *
 * The other unavailable states deliberately stay 200. `cms-disabled` is an
 * instance that does not offer long-form publishing: a product state, correctly
 * rendered, not a missing resource. `transport` is contentus reporting that the
 * instance did not answer, which is a page that rendered exactly as designed.
 *
 * `tombstoned` is 410, and it is a separate status from 404 because lesser now
 * makes it a separate FACT. Under v1.6.0 the article reads fall back to a
 * tombstone Article carrying `deletedAt`, so "this address held an article that
 * was deleted" is something the instance states rather than something contentus
 * would be guessing at. 410 is the honest rendering of that statement: it tells
 * a crawler to drop the URL rather than keep retrying it, which 404 does not.
 * The distinction is only ever drawn from `deletedAt` — never from a missing
 * title or an empty body, which is what inferring it would look like.
 */
export function statusForRoute(props: RouteProps): number {
	if (props.page.key === 'not-found') return 404;

	const unavailable = props.reader?.unavailable ?? props.index?.unavailable ?? null;
	if (unavailable?.reason === 'tombstoned') return 410;
	return unavailable?.reason === 'not-found' ? 404 : 200;
}

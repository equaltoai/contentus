import { APP_BASE_PATH } from '$lib/config/base-path';

import type { AppPageDescriptor, AppPageKey, RouteProps } from './types';

export const FACETHEORY_BASE_PATH = APP_BASE_PATH;

/**
 * The M1 route table.
 *
 * String-based, not filesystem-derived: lesser performs no SPA fallback under
 * `/l/*`, so every route here must server-render on a cold request. A route
 * that is not in this table and not matched by the catch-all does not exist.
 *
 * Faces 2 and 4-7 (review, timelines, messages, agents, drones) land in later
 * milestones and are deliberately absent rather than stubbed — a nav entry
 * pointing at a route that 404s is worse than one that is not there.
 *
 * `/compose` (face 3) requires an authenticated caller, but it is still a fully
 * server-rendered route: the session lives in `sessionStorage`, so the server
 * cannot know who is asking, and rendering the signed-out state is both the
 * honest answer and the only one a cold deep link can produce.
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
	if (route === '/auth/callback') return PAGE_DEFINITIONS['auth-callback'];
	if (segmentAfter(route, '/articles/')) return PAGE_DEFINITIONS['article-reader'];
	if (segmentAfter(route, '/series/')) return PAGE_DEFINITIONS.series;
	if (segmentAfter(route, '/categories/')) return PAGE_DEFINITIONS.category;

	return PAGE_DEFINITIONS['not-found'];
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
 * lesser's CMS contract has no Tombstone on the article read path, so a deleted
 * article and one that never existed are indistinguishable here and both get
 * 404. A speculative 410 would be a guess about deletion state.
 */
export function statusForRoute(props: RouteProps): number {
	if (props.page.key === 'not-found') return 404;

	const unavailable = props.reader?.unavailable ?? props.index?.unavailable ?? null;
	return unavailable?.reason === 'not-found' ? 404 : 200;
}

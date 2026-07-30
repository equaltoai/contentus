import { APP_BASE_PATH } from '$lib/config/base-path';

import type { AppPageDescriptor, AppPageKey } from './types';

export const FACETHEORY_BASE_PATH = APP_BASE_PATH;

/**
 * The M1 route table.
 *
 * String-based, not filesystem-derived: lesser performs no SPA fallback under
 * `/l/*`, so every route here must server-render on a cold request. A route
 * that is not in this table and not matched by the catch-all does not exist.
 *
 * Faces 2-7 (review, compose, timelines, messages, agents, drones) land in
 * later milestones and are deliberately absent rather than stubbed — a nav
 * entry pointing at a route that 404s is worse than one that is not there.
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

/** HTTP status a page should be served with. */
export function statusForPage(page: AppPageDescriptor): number {
	return page.key === 'not-found' ? 404 : 200;
}

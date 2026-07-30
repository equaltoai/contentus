import { href } from '../../facetheory/routing';
import type { AppPageKey, SurfaceVariant } from '../../facetheory/types';

/**
 * The contentus navigation model (product design §4).
 *
 * All five destinations are declared here, not just the ones M1 ships, because
 * the nav is where the product's shape is legible. Entries whose face has not
 * landed yet are marked `upcoming`: they render as non-interactive items rather
 * than links that would 404, since lesser performs no SPA fallback under `/l/*`
 * and a dead nav link is a hard error page rather than a soft miss.
 */
export interface NavEntry {
	id: string;
	label: string;
	/** App-relative destination, or null while the face is still upcoming. */
	href: string | null;
	/** Page key this entry marks as current, when it is live. */
	pageKey: AppPageKey | null;
	surface: SurfaceVariant;
	/** Whether lesser requires an authenticated caller for this surface. */
	requiresAuth: boolean;
	/** Milestone that lands the face; absent once shipped. */
	upcoming: string | null;
}

export const NAV_ENTRIES: NavEntry[] = [
	{
		id: 'articles',
		label: 'Articles',
		href: href('/'),
		pageKey: 'articles-index',
		surface: 'journal',
		requiresAuth: false,
		upcoming: null,
	},
	{
		id: 'review',
		label: 'Review',
		href: null,
		pageKey: null,
		surface: 'journal',
		requiresAuth: true,
		upcoming: 'M2',
	},
	{
		id: 'timelines',
		label: 'Timelines',
		href: null,
		pageKey: null,
		surface: 'core',
		requiresAuth: false,
		upcoming: 'M4',
	},
	{
		id: 'messages',
		label: 'Messages',
		href: null,
		pageKey: null,
		surface: 'mcp',
		requiresAuth: true,
		upcoming: 'M5',
	},
	{
		id: 'agents',
		label: 'Agents',
		href: null,
		pageKey: null,
		surface: 'mcp',
		requiresAuth: false,
		upcoming: 'M6',
	},
];

/**
 * Nav entries visible to a given session.
 *
 * Anonymous visitors see only the surfaces lesser serves anonymously —
 * Articles, Timelines, Agents — matching the instance's actual read behavior
 * rather than showing a signed-out user destinations that would reject them.
 */
export function visibleNavEntries(authenticated: boolean): NavEntry[] {
	return NAV_ENTRIES.filter((entry) => authenticated || !entry.requiresAuth);
}

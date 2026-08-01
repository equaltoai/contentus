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
	/**
	 * Further page keys this entry also marks as current.
	 *
	 * A face can span more than one address: `/messages/{conversationId}` is its
	 * own route with its own descriptor, but it is still the Messages
	 * destination, and a nav that drops its current marker when a reader opens a
	 * conversation tells them they have left the surface they are looking at.
	 */
	alsoCurrentFor?: AppPageKey[];
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
		href: href('/review'),
		pageKey: 'review-queue',
		surface: 'journal',
		requiresAuth: true,
		upcoming: null,
	},
	{
		id: 'timelines',
		label: 'Timelines',
		href: href('/timelines'),
		pageKey: 'timelines',
		surface: 'core',
		// The route is anonymous: Instance and Federated are anonymous-safe
		// reads. Only the Home TAB needs a token, and it says so itself.
		requiresAuth: false,
		upcoming: null,
	},
	{
		id: 'messages',
		label: 'Messages',
		href: href('/messages'),
		pageKey: 'messages',
		alsoCurrentFor: ['message-thread'],
		surface: 'mcp',
		// The whole surface is auth-gated, unlike `/timelines`: lesser serves no
		// part of `conversations` anonymously, so an anonymous reader is not shown
		// a destination that would only refuse them.
		requiresAuth: true,
		upcoming: null,
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
 * Whether a nav entry is the surface the reader is on.
 *
 * One helper rather than an inline comparison in each nav, because there are
 * two navs and they must not be able to disagree about what "here" means.
 */
export function isCurrentEntry(entry: NavEntry, pageKey: AppPageKey): boolean {
	if (!entry.href) return false;
	return entry.pageKey === pageKey || (entry.alsoCurrentFor?.includes(pageKey) ?? false);
}

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

/**
 * The compose action (product design §4, "New").
 *
 * Deliberately not a `NavEntry`: it is not a destination in the primary nav. On
 * desktop it is an action in the sidebar; on mobile it is the centered FAB in
 * the bottom tab bar, which is the highest-frequency mobile write path the
 * whole chrome exists to serve.
 *
 * It is shown to everyone, including anonymous visitors, even though lesser
 * requires `write` scope to post. Two reasons, and they are the same reason
 * twice: the FAB is the centre slot of a fixed bar, so hiding it until
 * hydration would shift the bar under the reader's thumb on every public page;
 * and `/compose` is a real server-rendered route that renders a designed
 * sign-in state rather than a rejection. Advertising the action and explaining
 * the requirement on arrival beats a control that appears a beat late.
 */
export interface ComposeAction {
	id: 'compose';
	label: string;
	/** App-relative destination, or null while the face is still upcoming. */
	href: string | null;
	pageKey: AppPageKey | null;
	surface: SurfaceVariant;
	/** lesser requires an authenticated caller to post; the route says so. */
	requiresAuth: true;
	/** Milestone that lands the face; absent once shipped. */
	upcoming: string | null;
}

export const COMPOSE_ACTION: ComposeAction = {
	id: 'compose',
	label: 'New post',
	href: href('/compose'),
	pageKey: 'compose',
	surface: 'core',
	requiresAuth: true,
	upcoming: null,
};

/**
 * The four destinations the mobile tab bar carries (product design §4).
 *
 * Review is deliberately absent: a thumb-reachable bar holds four targets and a
 * FAB before the targets drop under 44px, and Review is a desk task on a queue.
 * It stays in the sidebar nav, which the tab bar does not replace.
 */
const MOBILE_TAB_IDS = ['articles', 'timelines', 'messages', 'agents'] as const;

/**
 * Tab-bar entries visible to a given session, in bar order.
 *
 * Same auth rule as the sidebar, and the same consequence: the server render is
 * always the anonymous bar, because the session token lives in `sessionStorage`
 * and there is no cookie for the server to read. Messages therefore appears on
 * hydration for a signed-in reader. The bar is already painted by then, so this
 * costs one reflow of a rendered control rather than a control that was not
 * there — which is the trade M1 already made for the sidebar, kept here so the
 * two navs cannot disagree about who sees what.
 */
export function visibleMobileTabs(authenticated: boolean): NavEntry[] {
	const byId = new Map(NAV_ENTRIES.map((entry) => [entry.id, entry]));
	return MOBILE_TAB_IDS.map((id) => byId.get(id)).filter(
		(entry): entry is NavEntry => entry !== undefined && (authenticated || !entry.requiresAuth)
	);
}

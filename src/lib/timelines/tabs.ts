/**
 * The `/timelines` tab model (product design §5, face 4).
 *
 * sim has no tabbed instance/federated UI — it ships separate routes — so this
 * is contentus's own, and the design doc calls it a deliberate improvement and
 * a candidate to upstream. Keeping the model in a pure module rather than
 * inside the component is what makes that offer real: the behaviour worth
 * upstreaming is this table and these three functions, and they are testable
 * without a DOM.
 *
 * WHY THE TAB TRAVELS IN THE URL. `/timelines?tab=federated` is linkable,
 * shareable, and server-renderable. lesser performs no SPA fallback under
 * `/l/*`, so a cold deep link has to produce a complete page — a tab held only
 * in component state would render the default and then jump.
 *
 * WHY AVAILABILITY IS A FUNCTION AND NOT A FLAG. The server pass is always
 * anonymous: the session lives in `sessionStorage`, so the server genuinely
 * cannot know who is asking. Home therefore appears at hydration rather than in
 * the first paint, and it has to appear WITHOUT a reload. Deriving the tab list
 * from a session boolean, instead of baking it at render time, is what lets the
 * same component answer differently a beat later.
 */

import type { ContentusTimelineType } from './contract.ts';

export type TimelineTabId = 'instance' | 'federated' | 'home';

export interface TimelineTab {
	id: TimelineTabId;
	label: string;
	/** What the tab reads. The whole difference between tabs is this value. */
	type: ContentusTimelineType;
	/** Short line under the heading, so an empty tab still explains itself. */
	description: string;
	/** Whether lesser needs a token to answer this tab's read. */
	requiresAuth: boolean;
}

/**
 * Declared in display order, all three always.
 *
 * Home is present in the table and filtered out of the visible list rather than
 * conditionally constructed: `tabFor` has to resolve `?tab=home` for an
 * anonymous reader too, so the route can render "sign in to see your home
 * timeline" instead of silently redirecting to Instance. A link somebody shared
 * should explain itself, not quietly become a different page.
 */
export const TIMELINE_TABS: readonly TimelineTab[] = [
	{
		id: 'instance',
		label: 'Instance',
		type: 'LOCAL',
		description: 'Posts from accounts on this instance.',
		requiresAuth: false,
	},
	{
		id: 'federated',
		label: 'Federated',
		type: 'PUBLIC',
		description: 'Public posts from across the fediverse, as this instance sees them.',
		requiresAuth: false,
	},
	{
		id: 'home',
		label: 'Home',
		type: 'HOME',
		description: 'Posts from the accounts you follow.',
		requiresAuth: true,
	},
];

export const DEFAULT_TIMELINE_TAB: TimelineTabId = 'instance';

/**
 * The tabs a given session may choose between.
 *
 * Anonymous gets Instance and Federated — exactly the reads lesser answers
 * without a token, so the control offers nothing that would reject the person
 * who touched it.
 */
export function visibleTimelineTabs(authenticated: boolean): TimelineTab[] {
	return TIMELINE_TABS.filter((tab) => authenticated || !tab.requiresAuth);
}

/** Look a tab up by id, or the default when the id names nothing. */
export function tabFor(id: string | null | undefined): TimelineTab {
	const match = TIMELINE_TABS.find((tab) => tab.id === String(id ?? '').toLowerCase());
	return match ?? TIMELINE_TABS.find((tab) => tab.id === DEFAULT_TIMELINE_TAB)!;
}

/**
 * Whether the SERVER may fetch this tab during the SSR pass.
 *
 * Two independent reasons a tab is server-fetchable, and both must hold. It has
 * to be anonymous-safe, because the server has no token. And its content has to
 * be public, because these props are serialized verbatim into contentus's
 * PUBLIC hydration endpoint — the same reasoning that keeps the review queue
 * and draft previews off the server pass. Instance and Federated satisfy both;
 * Home satisfies neither, and is loaded in the browser after the session is read.
 */
export function isServerFetchable(tab: TimelineTab): boolean {
	return !tab.requiresAuth;
}

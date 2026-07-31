/**
 * The feed's two collections and every rule that moves a status between them.
 *
 * Split out of `TimelineFeed.svelte` for the reason the rest of face 4 is split:
 * a rule this consequential deserves a probe that drives the SHIPPED function,
 * and a rule living inside a component can only be driven by rendering one. The
 * component now owns which state is showing; this module owns what is in the
 * lists and why, and `tests/timeline-feed-state.test.mjs` drives it directly.
 *
 * TWO COLLECTIONS, AND THEY MUST BE DEDUPLICATED AGAINST EACH OTHER.
 * `items` is what is rendered; `pending` is what the socket delivered while the
 * reader was scrolled away. The bug this module was extracted to fix lived in
 * exactly the gap between them: page ingest deduplicated against `items` alone,
 * so a status buffered in `pending` that ALSO arrived in the next page entered
 * `items` — and then prepended a second time when the buffer was revealed. Two
 * cards, same post, and to a reader that reads as the author having posted
 * twice. Every function here dedupes against BOTH.
 *
 * BOUNDED BY REFUSING TO GROW, NEVER BY EVICTING. Every cap here is enforced by
 * declining the ARRIVING status, never by dropping one already held. That is not
 * fastidiousness: `endCursor` points at the last status a page delivered, so
 * evicting the tail of `items` and then paginating from that cursor appends
 * posts contiguous with something no longer on screen — a hole in the middle of
 * the timeline that nothing marks. Lesser's cursor happens to be the status id
 * today, which would make a tail-derived cursor work, but that is an
 * implementation detail this client has no contract for and will not build a
 * bound on. So growth STOPS at the cap and the stop is disclosed, which is a
 * state a reader can act on, where a hole is not.
 *
 * Three caps, and they compose to one number. `LIVE_BUFFER_LIMIT` bounds the
 * buffer; `MATERIALIZED_LIMIT` bounds what pagination may add; `FEED_LIMIT`
 * bounds the two TOGETHER, which is the one that was missing — without it a
 * reader who buffers and reveals repeatedly grows the rendered list by a full
 * buffer per cycle, forever, and each individual cap still holds. The strict
 * bound on `items` is therefore `MATERIALIZED_LIMIT + TIMELINE_PAGE_SIZE +
 * LIVE_BUFFER_LIMIT`: the cap, the page that was in flight when it was crossed,
 * and one last buffer revealed on top. The adversarial probe in
 * `tests/timeline-feed-state.test.mjs` is what holds that claim honest — it is
 * what found the missing cap.
 */

import type { Status } from '../types.ts';

/**
 * How many statuses the rendered list holds before pagination stops offering
 * more. Roughly twenty-five pages at lesser's own page size — far past any
 * session that is still reading rather than scrolling, and small enough that
 * the backing array is not a memory story on a phone.
 */
export const MATERIALIZED_LIMIT = 500;

/**
 * How many live statuses the buffer holds before it stops accepting them.
 *
 * This is the cap that matters most, because this is the collection that grows
 * with NO reader action at all: a busy Federated timeline fills it at whatever
 * rate the instance publishes, for as long as the tab is open. Past the cap the
 * buffer is declared overflowed rather than trimmed — a buffer missing its
 * middle would prepend a block with a silent gap under it.
 */
export const LIVE_BUFFER_LIMIT = 200;

/**
 * How many statuses the feed holds across BOTH collections.
 *
 * The cap the other two do not imply. Buffering and revealing moves statuses
 * from `pending` into `items` and empties the buffer, so a reader who scrolls
 * away and back on a busy timeline can repeat that cycle indefinitely — adding a
 * full buffer to the rendered list each time, with `LIVE_BUFFER_LIMIT` and
 * `MATERIALIZED_LIMIT` both still satisfied at every step. This is what stops
 * that: once the feed holds this many, live arrivals are refused and the
 * overflow is disclosed.
 */
export const FEED_LIMIT = MATERIALIZED_LIMIT + LIVE_BUFFER_LIMIT;

export interface FeedItems {
	/** Rendered, oldest-last. */
	items: Status[];
	/** Live arrivals held back, newest-first. */
	pending: Status[];
	/**
	 * The buffer filled and stopped accepting. Live posts are being missed, so
	 * revealing the buffer would show an incomplete run — the affordance for this
	 * state is a re-read, not a reveal.
	 */
	overflowed: boolean;
}

export const EMPTY_FEED: FeedItems = { items: [], pending: [], overflowed: false };

/** Seed from whatever the server rendered. */
export function feedFrom(items: Status[]): FeedItems {
	return { items, pending: [], overflowed: false };
}

function idsIn(...lists: readonly Status[][]): Set<string> {
	const ids = new Set<string>();
	for (const list of lists) for (const status of list) ids.add(status.id);
	return ids;
}

/** Whether pagination may still add to the rendered list. */
export function canMaterializeMore(feed: FeedItems): boolean {
	return feed.items.length < MATERIALIZED_LIMIT;
}

/** How many statuses the feed is holding, rendered and buffered together. */
export function heldCount(feed: FeedItems): number {
	return feed.items.length + feed.pending.length;
}

/**
 * Take one status off the socket.
 *
 * `atTop` decides the destination, and it is the whole no-scroll-steal rule:
 * prepending is safe only where offset zero cannot move under the reader.
 * Anywhere else the status buffers and a count appears, so nothing under the
 * thumb moves until the reader chooses it.
 */
export function acceptLiveStatus(
	feed: FeedItems,
	status: Status,
	options: { atTop: boolean }
): FeedItems {
	// Against BOTH collections. lesser can publish an object a page fetch also
	// returned, and a duplicate card is indistinguishable from a double post.
	if (idsIn(feed.items, feed.pending).has(status.id)) return feed;

	if (options.atTop && canMaterializeMore(feed)) {
		return { ...feed, items: [status, ...feed.items] };
	}

	// Refuse rather than evict, on either cap. Dropping the oldest buffered post
	// to make room would leave the revealed block with a hole under it that no
	// copy names; `FEED_LIMIT` is the one that stops buffer-and-reveal cycles
	// from growing the rendered list a buffer at a time, forever.
	if (feed.pending.length >= LIVE_BUFFER_LIMIT || heldCount(feed) >= FEED_LIMIT) {
		return { ...feed, overflowed: true };
	}

	return { ...feed, pending: [status, ...feed.pending] };
}

/**
 * Append a page.
 *
 * Drops ids already rendered — a cursor page can overlap the previous one when
 * objects arrived in between — AND ids already buffered, which is the half that
 * was missing: a status in `pending` that also pages in would otherwise be
 * appended here and prepended again at reveal.
 *
 * Also drops ids repeated WITHIN the page, so a server-side duplicate cannot
 * become two cards either.
 *
 * Refuses outright at `MATERIALIZED_LIMIT` — a backstop rather than a path a
 * reader reaches, because the component hides the load-more control at the same
 * threshold. It is here so the bound is a property of this module and not of its
 * caller's discipline.
 */
export function ingestPage(feed: FeedItems, page: readonly Status[]): FeedItems {
	if (!canMaterializeMore(feed)) return feed;

	const seen = idsIn(feed.items, feed.pending);
	const fresh: Status[] = [];

	for (const status of page) {
		if (seen.has(status.id)) continue;
		seen.add(status.id);
		fresh.push(status);
	}

	if (!fresh.length) return feed;
	return { ...feed, items: [...feed.items, ...fresh] };
}

/**
 * Move the buffer into the rendered list.
 *
 * Filters against `items` on the way in, because a buffered status can have
 * paged in between being buffered and being revealed — the other direction of
 * the same overlap `ingestPage` guards, and the one that produced the duplicate.
 */
export function revealBuffered(feed: FeedItems): FeedItems {
	if (!feed.pending.length) return feed.overflowed ? { ...feed, overflowed: false } : feed;

	const materialized = idsIn(feed.items);
	const fresh = feed.pending.filter((status) => !materialized.has(status.id));

	return { items: [...fresh, ...feed.items], pending: [], overflowed: false };
}

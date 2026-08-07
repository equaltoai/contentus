/**
 * Face 4's feed-reconciliation probes.
 *
 * These drive `src/lib/timelines/feed-state.ts` — the rules that decide what is
 * in the rendered list and what is in the live buffer — directly, with no
 * component and no browser. That module was extracted from `TimelineFeed.svelte`
 * for exactly this reason: the duplicate-card bug below lived in a rule a probe
 * could not reach, and a rule a probe cannot reach is a rule nobody is checking.
 *
 * Two properties are asserted here and they are different in kind. The
 * DEDUPLICATION properties are about correctness: the same post must never
 * render twice, whichever direction it arrives from. The BOUNDING properties are
 * about a page that stays open for hours: neither collection may grow without
 * limit, and — the part that constrains the fix — neither bound may be enforced
 * by dropping something already read, because `endCursor` points at the tail.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TIMELINE_PAGE_SIZE } from '../src/lib/timelines/transport.ts';
import {
	FEED_LIMIT,
	LIVE_BUFFER_LIMIT,
	MATERIALIZED_LIMIT,
	acceptLiveStatus,
	canMaterializeMore,
	feedFrom,
	heldCount,
	ingestPage,
	revealBuffered,
} from '../src/lib/timelines/feed-state.ts';

/** A status is only ever identified here, so an id and a marker is the whole shape. */
const status = (id, from = 'page') => ({ id, content: `<p>${id} via ${from}</p>` });

const ids = (list) => list.map((item) => item.id);

/* ---------------------------------------------------------------------------
 * Deduplication — including the direction that was missing
 * ------------------------------------------------------------------------ */

test('a page never appends a status already rendered', () => {
	const feed = ingestPage(feedFrom([status('a'), status('b')]), [status('b'), status('c')]);

	assert.deepEqual(ids(feed.items), ['a', 'b', 'c'], 'a cursor page can overlap the previous one');
});

test('a page never appends a status already BUFFERED — the duplicate-card hole', () => {
	// THE FINDING. Page ingest deduplicated against the rendered list alone, so a
	// live status sitting in the buffer that also arrived in the next page was
	// appended here — and then prepended AGAIN when the buffer was revealed. Two
	// cards, one post, and to a reader that reads as a double post.
	let feed = feedFrom([status('a')]);
	feed = acceptLiveStatus(feed, status('live-1', 'socket'), { atTop: false });
	assert.deepEqual(ids(feed.pending), ['live-1']);

	feed = ingestPage(feed, [status('b'), status('live-1', 'page')]);
	assert.deepEqual(ids(feed.items), ['a', 'b'], 'the buffered id must not also materialize');

	feed = revealBuffered(feed);
	assert.deepEqual(ids(feed.items), ['live-1', 'a', 'b']);
	assert.equal(
		ids(feed.items).filter((id) => id === 'live-1').length,
		1,
		'and after the reveal it is on screen exactly once'
	);
});

test('the reveal drops ids that paged in while they were buffered', () => {
	// The other direction of the same overlap, guarded independently: if anything
	// ever puts a buffered id into `items` by another route, the reveal must not
	// prepend it a second time.
	let feed = feedFrom([]);
	feed = acceptLiveStatus(feed, status('x', 'socket'), { atTop: false });
	// Simulate the id having materialized by a path other than `ingestPage`.
	feed = { ...feed, items: [status('x', 'page')] };

	feed = revealBuffered(feed);
	assert.deepEqual(ids(feed.items), ['x']);
	assert.deepEqual(feed.pending, [], 'and the buffer is emptied either way');
});

test('a live status already on screen or already buffered is dropped on arrival', () => {
	let feed = feedFrom([status('a')]);

	feed = acceptLiveStatus(feed, status('a', 'socket'), { atTop: true });
	assert.deepEqual(ids(feed.items), ['a'], 'a republished object is not a second post');

	feed = acceptLiveStatus(feed, status('b', 'socket'), { atTop: false });
	feed = acceptLiveStatus(feed, status('b', 'socket'), { atTop: false });
	assert.deepEqual(ids(feed.pending), ['b']);
});

test('a page carrying the same id twice yields one card', () => {
	const feed = ingestPage(feedFrom([]), [status('a'), status('a'), status('b')]);
	assert.deepEqual(ids(feed.items), ['a', 'b']);
});

/* ---------------------------------------------------------------------------
 * No scroll steal — where a live status lands, and why
 * ------------------------------------------------------------------------ */

test('a live status prepends at the top and buffers anywhere else', () => {
	const atTop = acceptLiveStatus(feedFrom([status('a')]), status('new'), { atTop: true });
	assert.deepEqual(ids(atTop.items), ['new', 'a'], 'offset zero cannot move under the reader');
	assert.deepEqual(atTop.pending, []);

	const scrolled = acceptLiveStatus(feedFrom([status('a')]), status('new'), { atTop: false });
	assert.deepEqual(ids(scrolled.items), ['a'], 'nothing under the thumb may move');
	assert.deepEqual(ids(scrolled.pending), ['new']);
});

/* ---------------------------------------------------------------------------
 * Bounds — and the eviction that must NOT happen
 * ------------------------------------------------------------------------ */

test('the live buffer stops accepting at its cap rather than growing forever', () => {
	// The collection that grows with NO reader action: a busy timeline fills it
	// at whatever rate the instance publishes, for as long as the tab is open.
	let feed = feedFrom([status('seed')]);

	for (let i = 0; i < LIVE_BUFFER_LIMIT + 500; i += 1) {
		feed = acceptLiveStatus(feed, status(`live-${i}`), { atTop: false });
	}

	assert.equal(feed.pending.length, LIVE_BUFFER_LIMIT);
	assert.equal(feed.overflowed, true, 'and the overflow is a state, not a silent drop');
});

test('the buffer cap drops the ARRIVING post, never one already held', () => {
	// Trimming the oldest buffered post to make room would leave the revealed
	// block with a hole in its middle that no copy names. Refusing the newest
	// keeps the block contiguous, and the overflow flag is what tells the reader
	// the top of it is now incomplete.
	let feed = feedFrom([]);
	for (let i = 0; i < LIVE_BUFFER_LIMIT; i += 1) {
		feed = acceptLiveStatus(feed, status(`live-${i}`), { atTop: false });
	}
	const beforeOverflow = ids(feed.pending);

	feed = acceptLiveStatus(feed, status('one-too-many'), { atTop: false });

	assert.deepEqual(ids(feed.pending), beforeOverflow, 'nothing already buffered may be evicted');
	assert.ok(!ids(feed.pending).includes('one-too-many'));
	assert.equal(feed.overflowed, true);
});

test('pagination stops at the materialized cap instead of evicting the tail', () => {
	// THE CONSTRAINT ON THE FIX. `endCursor` points at the last status a page
	// delivered. Evicting the tail and then paginating from that cursor appends
	// posts contiguous with something no longer on screen — a hole in the middle
	// of the timeline that nothing marks. So the cap stops growth; it never
	// removes. The tail of the list must therefore still be the status the cursor
	// was computed from.
	let feed = feedFrom([]);
	const oldest = status('page-0');
	feed = ingestPage(feed, [oldest]);

	while (canMaterializeMore(feed)) {
		const next = feed.items.length;
		feed = ingestPage(
			feed,
			Array.from({ length: TIMELINE_PAGE_SIZE }, (_, i) => status(`page-${next + i + 1}`))
		);
	}

	assert.ok(feed.items.length >= MATERIALIZED_LIMIT);
	assert.equal(canMaterializeMore(feed), false, 'the component stops offering "load more" here');
	assert.equal(feed.items[0].id, 'page-0', 'and the oldest read post is still on screen');

	// Proving the "never evicts" half directly: another page changes nothing that
	// was already there.
	const before = ids(feed.items);
	const after = ingestPage(feed, [status('page-would-be-next')]);
	assert.deepEqual(
		ids(after.items).slice(0, before.length),
		before,
		'ingest may only append; a cap enforced by eviction would break the cursor'
	);
});

test('a live status at the cap buffers instead of prepending, so the list stays bounded', () => {
	let feed = feedFrom(Array.from({ length: MATERIALIZED_LIMIT }, (_, i) => status(`p-${i}`)));

	feed = acceptLiveStatus(feed, status('live-at-cap'), { atTop: true });

	assert.equal(
		feed.items.length,
		MATERIALIZED_LIMIT,
		'the rendered list did not grow past the cap'
	);
	assert.deepEqual(ids(feed.pending), ['live-at-cap'], 'the post is held, not dropped');
});

test('the composite bound holds under an adversarial drive', () => {
	// Ten thousand live statuses and forty pages against one open feed — far past
	// any real session — asserting the bound this module documents:
	// MATERIALIZED_LIMIT + one page in flight + one full buffer revealed on top.
	//
	// THIS PROBE FOUND A MISSING CAP. Written against the first version of the
	// module it failed at 940 items, because buffering and revealing moves the
	// buffer INTO the rendered list and empties it — so each cycle added a full
	// buffer while `LIVE_BUFFER_LIMIT` and `MATERIALIZED_LIMIT` were both still
	// satisfied at every individual step. `FEED_LIMIT` is what that failure
	// bought. A bound asserted only per-collection is not a bound.
	const bound = MATERIALIZED_LIMIT + TIMELINE_PAGE_SIZE + LIVE_BUFFER_LIMIT;
	let feed = feedFrom([]);

	for (let round = 0; round < 40; round += 1) {
		for (let i = 0; i < 250; i += 1) {
			feed = acceptLiveStatus(feed, status(`live-${round}-${i}`), { atTop: round % 2 === 0 });
		}
		feed = ingestPage(
			feed,
			Array.from({ length: TIMELINE_PAGE_SIZE }, (_, i) => status(`page-${round}-${i}`))
		);
		feed = revealBuffered(feed);

		assert.ok(
			feed.items.length <= bound,
			`items reached ${feed.items.length}, past the documented bound of ${bound}`
		);
		assert.ok(feed.pending.length <= LIVE_BUFFER_LIMIT);
	}

	// And no id is ever on screen twice, after all of that.
	assert.equal(new Set(ids(feed.items)).size, feed.items.length);
});

test('the combined cap stops a buffer-and-reveal cycle from growing the list forever', () => {
	// The mechanism the probe above catches, isolated: fill, reveal, repeat. Each
	// collection stays inside its own cap the whole time; only the combined one
	// stops it.
	let feed = feedFrom([]);

	for (let cycle = 0; cycle < 12; cycle += 1) {
		for (let i = 0; i < LIVE_BUFFER_LIMIT + 20; i += 1) {
			feed = acceptLiveStatus(feed, status(`c${cycle}-${i}`), { atTop: false });
		}
		feed = revealBuffered(feed);
		assert.ok(heldCount(feed) <= FEED_LIMIT, `held ${heldCount(feed)} past ${FEED_LIMIT}`);
	}

	assert.ok(feed.items.length <= FEED_LIMIT);
});

test('revealing an empty buffer clears the overflow rather than getting stuck', () => {
	// The overflow state has to be escapable, or a busy timeline latches it for
	// the life of the route. The component's escape is a re-read, which rebuilds
	// the feed from scratch; this covers the reveal path reaching the same place.
	let feed = feedFrom([status('a')]);
	feed = { ...feed, overflowed: true };

	assert.equal(revealBuffered(feed).overflowed, false);
	assert.deepEqual(ids(revealBuffered(feed).items), ['a']);
});

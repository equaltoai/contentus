<!--
One timeline, rendered: virtualized scroll, designed states, cursor pagination,
and the realtime prepend affordance (product design §5, face 4).

Used by both `/timelines` and `/profiles/{username}`, because a profile timeline
IS a timeline — the only difference is the `timeline(type:)` behind it, which is
a prop.

WHAT IS VENDORED AND WHAT IS OURS. `TimelineVirtualized` owns the scroller and
renders `StatusCard`, which renders `ActionBar`; `Timeline.EmptyState` and
`Timeline.ErrorState` are the vendored state components. This file owns what
goes AROUND them: which state is showing and why, the pagination, the realtime
buffer, and the pull-to-refresh affordance.

AND THE ONE VENDORED COMPONENT THAT COULD NOT BE USED. `Timeline.LoadMore` calls
`getTimelineContext()`, which THROWS outside `Timeline.Root` — so using it means
mounting Root, and Root is not a passive provider. It renders its own
`<div role="feed" onscroll>` with its own infinite-scroll trigger, while
`TimelineVirtualized` renders its own scroll region containing its own
`role="feed"`. Nesting them gives two feed roles and two load-more triggers on
one list: an accessibility defect and a double fetch. The two vendored timeline
stacks do not compose, and choosing the one the milestone names means owning the
load-more control here. Routed upstream as a composition ask; see
docs/consumption/timeline-contract.md. `EmptyState` and `ErrorState` take no
context and are used as they are.

SSR AND VIRTUALIZATION. `virtualScrolling` is off until mount, and that is not a
performance choice. `createVirtualizer` measures a scroll element, and on the
server there is none — so the virtualized branch renders an empty list. lesser
performs no SPA fallback under `/l/*`, so the server's paint IS the first paint
of every cold deep link, and an empty one would be a blank timeline for readers
and crawlers alike. Off on the server renders every item; on after mount, the
virtualized path is what the browser actually runs.

WHAT IS IN THE LISTS IS NOT DECIDED HERE. `feed-state.ts` owns every rule that
moves a status between the rendered list and the live buffer — deduplication
across both, and the caps that keep neither growing for the lifetime of the
route. It is a separate module because a rule inside a component can only be
driven by rendering one, and these rules earned probes: the duplicate-card bug
and the unbounded buffer both lived here, in code no test could reach. This file
owns which state is SHOWING and why; that one owns what is in the lists.

NO SCROLL STEAL, and how it is actually guaranteed. Live items never enter the
rendered list while the reader is somewhere in it. Two cases:

  - Reader is at the top. Prepending is safe there — offset zero does not move
    under them — so items go straight in.
  - Reader has scrolled. Items go into a BUFFER and a count appears. Nothing in
    the list changes, so nothing under the thumb moves. Activating the
    affordance is the reader choosing the jump.

The scroll position is read from the vendored scroller's own element rather
than from a window listener, because that element is the one that scrolls.

RENDERER AUTHORITY. Every status body here is lesser's server-sanitized HTML,
passed to `StatusCard` untouched; the vendored `ContentRenderer` sanitizes again
on the way to the DOM. Nothing in this file transforms, excerpts, truncates or
re-renders a body.

ACTION BAR SCOPE, stated because a disabled control looks like a bug otherwise.
Reply and quote are wired: they navigate to `/compose`, a real route that
already renders its own designed sign-in state for anonymous readers. Boost,
favourite and bookmark are NOT wired, because M4 is the read face — those are
lesser mutations no part of this milestone consumes, and `ActionBar` disables a
button whose handler is absent. A signed-in reader therefore sees their own
favourites marked and not yet changeable here, which is true. Wiring them is the
write face's job, not a stub's.
-->

<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import { Timeline } from '$lib/components/Timeline/index';
	import TimelineVirtualized from '$lib/components/TimelineVirtualized.svelte';
	import type { Status } from '$lib/types';

	import { composeHref } from '../../facetheory/routing';
	import {
		TIMELINE_FAILURE_COPY,
		TIMELINE_UPDATES_SUBSCRIPTION,
		realtimeAvailability,
		toTimelineStatus,
		type ContentusTimelineType,
		type TimelineFailure,
		type TimelinePage,
	} from './contract';
	import {
		acceptLiveStatus,
		canMaterializeMore,
		feedFrom,
		ingestPage,
		revealBuffered,
		type FeedItems,
	} from './feed-state';
	import { fetchTimelinePage } from './transport';
	import { subscribe, subscriptionEndpoint, type SubscriptionState } from './subscription';

	interface Props {
		type: ContentusTimelineType;
		/** Required for ACTOR. */
		actorId?: string | null;
		/** The first page, when the server fetched one. */
		initialPage: TimelinePage | null;
		/** Why the server has no page, when it tried and failed. */
		initialFailure: TimelineFailure | null;
		/**
		 * The server's page half-failed. Optional only so a caller with no server
		 * read at all (there is none today) is not forced to say `false` about a
		 * read it never made; every route that passes `initialPage` passes this.
		 */
		initialPartial?: boolean;
		authenticated: boolean;
		accessToken?: string | null;
		/** Shown when the timeline is genuinely empty. */
		emptyTitle: string;
		emptyDescription: string;
		/** Realtime is opt-out for the tabbed timelines and off for profiles. */
		realtime?: boolean;
	}

	let {
		type,
		actorId = null,
		initialPage,
		initialFailure,
		initialPartial = false,
		authenticated,
		accessToken = null,
		emptyTitle,
		emptyDescription,
		realtime = false,
	}: Props = $props();

	// SEEDED from the server's page, then owned here. `untrack` says that
	// deliberately rather than leaving the compiler to warn about it: once the
	// feed has paginated, prepended live items, or refreshed, the prop is a
	// stale first page and re-deriving from it would throw the reader's scroll
	// position and their live items away.
	//
	// The two collections and every rule that moves a status between them live in
	// `feed-state.ts`, so they are driven by probes rather than only by a browser.
	let feed = $state<FeedItems>(feedFrom(untrack(() => initialPage)?.items ?? []));
	let endCursor = $state<string | null>(untrack(() => initialPage)?.endCursor ?? null);
	let hasNextPage = $state(untrack(() => initialPage)?.hasNextPage ?? false);
	let skipped = $state(untrack(() => initialPage)?.skipped ?? 0);
	let failure = $state<TimelineFailure | null>(untrack(() => initialFailure));
	/**
	 * lesser answered, and part of the answer failed. See `TimelineResult.partial`.
	 *
	 * SEEDED from the server's read like every other field above, and it was not
	 * always: this started at `false` unconditionally, so a server page that
	 * arrived marked rendered as a whole one. The reader with no script saw a
	 * timeline the client knew was incomplete and had nothing to tell them, and
	 * the reader with script saw it that way until something refetched.
	 */
	let partial = $state(untrack(() => initialPartial));

	let mounted = $state(false);
	let loadingMore = $state(false);
	let refreshing = $state(false);

	let liveState = $state<SubscriptionState>('idle');
	let atTop = $state(true);

	let scrollRoot = $state<HTMLElement | null>(null);
	let stopLive: (() => void) | null = null;

	const items = $derived(feed.items);
	const pending = $derived(feed.pending);
	const realtimeMode = $derived(realtime ? realtimeAvailability(type, authenticated) : 'unsupported');
	const failureCopy = $derived(failure ? TIMELINE_FAILURE_COPY[failure] : null);
	/** The rendered list is at its bound, so pagination stops offering more. */
	const atMaterializedLimit = $derived(!canMaterializeMore(feed));

	function revealPending() {
		feed = revealBuffered(feed);
		scrollRoot?.querySelector('.timeline-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	async function loadMore() {
		// The cap is enforced by NOT FETCHING, never by evicting what is already
		// read: `endCursor` points at the last status a page delivered, so
		// dropping the tail and paginating from that cursor would append posts
		// contiguous with something no longer on screen — a hole nothing marks.
		if (loadingMore || !hasNextPage || !endCursor || atMaterializedLimit) return;
		loadingMore = true;
		try {
			const result = await fetchTimelinePage({ type, actorId, after: endCursor, accessToken });
			if (result.ok) {
				feed = ingestPage(feed, result.page.items);
				endCursor = result.page.endCursor;
				hasNextPage = result.page.hasNextPage;
				skipped += result.page.skipped;
				partial = partial || result.partial;
			} else {
				// A failed NEXT page must not erase the pages already read. The
				// list stays; only the load-more control reports the failure.
				failure = result.failure;
				hasNextPage = false;
			}
		} finally {
			loadingMore = false;
		}
	}

	/**
	 * Re-read the first page from the top.
	 *
	 * Also the recovery path for a dropped socket, an overflowed buffer, and a
	 * degraded stream: none of those can replay what they missed, so closing the
	 * gap means asking lesser again rather than pretending it was seamless. It is
	 * therefore the one place `liveState` is allowed to leave `degraded`, because
	 * this is the moment the gap it names actually closes.
	 */
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const result = await fetchTimelinePage({ type, actorId, accessToken });
			if (result.ok) {
				feed = feedFrom(result.page.items);
				endCursor = result.page.endCursor;
				hasNextPage = result.page.hasNextPage;
				skipped = result.page.skipped;
				partial = result.partial;
				failure = null;
				if (liveState === 'degraded') liveState = 'live';
			} else {
				failure = result.failure;
			}
		} finally {
			refreshing = false;
		}
	}

	function onScroll() {
		const scroller = scrollRoot?.querySelector('.timeline-scroll');
		atTop = !scroller || scroller.scrollTop < 24;
		// An overflowed buffer is NOT auto-revealed: it is missing posts in its
		// middle, so prepending it would put a silent gap on screen. That state
		// offers a re-read instead, and the reader chooses it.
		if (atTop && pending.length && !feed.overflowed) revealPending();
	}

	/**
	 * Re-read once the session resolves, when the server's page was anonymous.
	 *
	 * The server pass has no token, so its objects carry no viewer state — by
	 * design, since `false` from lesser there means "there is no viewer". For a
	 * reader who IS signed in, that leaves their own favourites showing as
	 * unknown until something asks again with the token. This is that ask, and
	 * it runs exactly once: `viewerLoaded` latches, so a token arriving does not
	 * start a refresh loop.
	 */
	let viewerLoaded = $state(false);
	$effect(() => {
		if (!mounted || viewerLoaded || !accessToken) return;
		viewerLoaded = true;
		if (untrack(() => items).length) void refresh();
	});

	onMount(() => {
		mounted = true;

		// The server pass is anonymous, so an auth-gated timeline arrives with no
		// page and no failure — "not fetched here". The client is where it can
		// finally be asked for.
		if (!untrack(() => initialPage) && !untrack(() => initialFailure)) void refresh();

		const scroller = scrollRoot?.querySelector('.timeline-scroll');
		scroller?.addEventListener('scroll', onScroll, { passive: true });

		if (realtimeMode === 'available') {
			const endpoint = subscriptionEndpoint(window.location.origin);
			if (!endpoint) {
				liveState = 'unavailable';
			} else {
				stopLive = subscribe<{ timelineUpdates?: unknown }>({
					endpoint,
					query: TIMELINE_UPDATES_SUBSCRIPTION,
					variables: { type },
					accessToken,
					onState: (state) => (liveState = state),
					onData: (data) => {
						const status = toTimelineStatus(data.timelineUpdates, {
							viewerAuthenticated: Boolean(accessToken),
						});
						if (status) feed = acceptLiveStatus(feed, status, { atTop });
					},
				});
			}
		} else if (realtimeMode === 'requires-auth') {
			liveState = 'requires-auth';
		}

		return () => {
			scroller?.removeEventListener('scroll', onScroll);
			stopLive?.();
		};
	});

	const replyHandlers = {
		onReply: (status: Status) => {
			window.location.assign(composeHref({ mode: 'reply', statusId: status.id }));
		},
		onQuote: (status: Status) => {
			window.location.assign(composeHref({ mode: 'quote', statusId: status.id }));
		},
	};
</script>

<div class="contentus-feed" bind:this={scrollRoot}>
	<!--
	THE TWO PINNED `ContentRenderer` GAPS DISCLOSED HERE ARE CLOSED, and the
	disclosure left with them at greater-v0.13.0.

	They were: nothing server-rendered, because the component wrote its output
	through a Svelte action that does not run during SSR; and what hydration
	filled in was CORRUPTED for ordinary posts, because already-sanitized markup
	was passed to a plain-text linkifier that escaped it. Both are fixed upstream
	— the component now renders `{@html processedContent}` declaratively and
	linkifies with an HTML-aware pass — so post text is in the server's paint and
	arrives as markup rather than as literal `<p>`.

	Nothing replaces this block, deliberately. A disclosure that outlives the
	fault it discloses teaches readers to ignore disclosures. What guards the
	repair now is `tests/ssr-timelines.test.mjs`, which asserts a status body IS
	in the server's paint and is NOT escaped — the same two probes, inverted.
	-->

	{#if realtimeMode !== 'unsupported'}
		<!-- The live strip is never a blank: every state says something, which is
		     the point of tracking `requires-auth` apart from `unavailable`. -->
		<div class="contentus-feed__live" data-state={liveState}>
			{#if feed.overflowed}
				<!-- The buffer filled and stopped accepting, so posts are being
				     missed. Revealing it would show an incomplete run with no mark
				     on the gap; a re-read is the only thing that closes it. -->
				<p class="contentus-feed__live-note">
					More new posts than this view can hold at once.
					<button type="button" class="contentus-feed__retry" onclick={refresh}>
						Refresh the timeline
					</button>
				</p>
			{:else if pending.length}
				<button type="button" class="contentus-feed__new" onclick={revealPending}>
					{pending.length === 1 ? '1 new post' : `${pending.length} new posts`}
				</button>
			{:else if liveState === 'live'}
				<p class="contentus-feed__live-note">Live — new posts appear as they arrive.</p>
			{:else if liveState === 'connecting'}
				<p class="contentus-feed__live-note">Connecting for live updates…</p>
			{:else if liveState === 'degraded'}
				<!-- The socket is open and something it delivered could not be
				     shown. Saying "live" would claim a continuity this stream lost;
				     saying "stopped" would be false. This is neither. -->
				<p class="contentus-feed__live-note">
					Some live posts could not be shown.
					<button type="button" class="contentus-feed__retry" onclick={refresh}>
						Refresh the timeline
					</button>
				</p>
			{:else if liveState === 'requires-auth'}
				<!-- lesser's WebSocket gateway refuses every connection with no
				     token, whatever the subscription resolver would allow. So the
				     timelines read for everyone and go live for signed-in readers,
				     and saying so beats a spinner that never resolves. -->
				<p class="contentus-feed__live-note">Sign in to see this timeline update live.</p>
			{:else if liveState === 'unavailable'}
				<p class="contentus-feed__live-note">
					Live updates stopped.
					<button type="button" class="contentus-feed__retry" onclick={refresh}>
						Refresh the timeline
					</button>
				</p>
			{/if}
		</div>
	{/if}

	<!-- Pull-to-refresh's affordance is an explicit control, not a hidden
	     gesture. A gesture with no visible target is undiscoverable and
	     unreachable by anyone not using a thumb; this is a real button at the
	     44px floor that the gesture-inclined can ignore. -->
	<div class="contentus-feed__refresh">
		<button type="button" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Refreshing…' : 'Refresh'}
		</button>
	</div>

	{#if failure && !items.length}
		{#if failure === 'auth-required'}
			<Timeline.EmptyState
				title={failureCopy?.title ?? 'Sign in'}
				description={failureCopy?.detail ?? ''}
			/>
		{:else}
			<Timeline.ErrorState error={failureCopy?.detail ?? 'Timeline unavailable'} onRetry={refresh} />
		{/if}
	{:else if !items.length && !mounted && !initialPage}
		<!-- Server pass for an auth-gated tab: nothing was fetched and nothing
		     failed. Neither empty nor broken — say exactly that. -->
		<Timeline.EmptyState
			title="Loading your timeline"
			description="This timeline is loaded once your session is read."
		/>
	{:else if !items.length && partial}
		<!-- lesser answered, part of the answer failed, and nothing survived to
		     render. "No posts yet" below would be this client asserting an
		     emptiness that only half an answer supports — the false empty the
		     marker exists to stop, arriving through the one state that never
		     carried it. The unconditional Refresh above is the action. -->
		<p class="contentus-feed__partial" role="status">
			Part of this timeline could not be loaded, so posts may be missing from it. Refresh to try
			reading it again.
		</p>
	{:else if !items.length}
		<Timeline.EmptyState title={emptyTitle} description={emptyDescription} />
	{:else}
		{#if skipped > 0}
			<!-- A silent drop is indistinguishable from a short page, so it is
			     counted and said. -->
			<p class="contentus-feed__skipped" role="status">
				{skipped === 1
					? '1 post could not be displayed by this client.'
					: `${skipped} posts could not be displayed by this client.`}
			</p>
		{/if}

		{#if partial}
			<!-- lesser answered and part of the answer failed. Distinct from the
			     count above: those are objects this CLIENT could not project, this
			     is a field the INSTANCE could not resolve. A failed nullable field
			     comes back looking exactly like an absent one, so without this the
			     posts would quietly under-report themselves. -->
			<p class="contentus-feed__partial" role="status">
				Parts of these posts could not be loaded, so something may be missing from them.
			</p>
		{/if}

		<TimelineVirtualized
			{items}
			virtualScrolling={mounted}
			endReached={!hasNextPage}
			loadingBottom={loadingMore}
			onLoadMore={loadMore}
			actionHandlers={replyHandlers}
			density="comfortable"
		/>

		{#if hasNextPage && atMaterializedLimit}
			<!-- The bound, disclosed rather than enforced by eviction. Dropping the
			     tail to keep paginating would append the next page contiguous with
			     posts no longer on screen; stopping is the honest end, and the
			     re-read is the way past it. -->
			<p class="contentus-feed__limit" role="status">
				This view holds as many posts as it can at once.
				<button type="button" class="contentus-feed__retry" onclick={refresh}>
					Refresh to read from the top
				</button>
			</p>
		{:else if hasNextPage}
			<div class="contentus-feed__more">
				<button type="button" onclick={loadMore} disabled={loadingMore}>
					{loadingMore ? 'Loading…' : 'Load more posts'}
				</button>
			</div>
		{:else if failure}
			<!-- Pages already read stay on screen; only the tail reports. -->
			<p class="contentus-feed__tail" role="status">
				{failureCopy?.detail ?? 'Could not load more posts.'}
			</p>
		{/if}
	{/if}
</div>

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
	let items = $state<Status[]>(untrack(() => initialPage)?.items ?? []);
	let endCursor = $state<string | null>(untrack(() => initialPage)?.endCursor ?? null);
	let hasNextPage = $state(untrack(() => initialPage)?.hasNextPage ?? false);
	let skipped = $state(untrack(() => initialPage)?.skipped ?? 0);
	let failure = $state<TimelineFailure | null>(untrack(() => initialFailure));

	let mounted = $state(false);
	let loadingMore = $state(false);
	let refreshing = $state(false);

	/** Live items held back because the reader is not at the top. */
	let pending = $state<Status[]>([]);
	let liveState = $state<SubscriptionState>('idle');
	let atTop = $state(true);

	let scrollRoot = $state<HTMLElement | null>(null);
	let stopLive: (() => void) | null = null;

	const realtimeMode = $derived(realtime ? realtimeAvailability(type, authenticated) : 'unsupported');
	const failureCopy = $derived(failure ? TIMELINE_FAILURE_COPY[failure] : null);

	/**
	 * The one place a status enters the list from the socket.
	 *
	 * Deduplicated by id against BOTH the rendered list and the buffer: lesser
	 * can publish an object that the page fetch also returned, and a duplicate
	 * card is indistinguishable from the author having posted twice.
	 */
	function acceptLive(status: Status) {
		if (items.some((item) => item.id === status.id)) return;
		if (pending.some((item) => item.id === status.id)) return;

		if (atTop) items = [status, ...items];
		else pending = [status, ...pending];
	}

	function revealPending() {
		if (!pending.length) return;
		items = [...pending, ...items];
		pending = [];
		scrollRoot?.querySelector('.timeline-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	async function loadMore() {
		if (loadingMore || !hasNextPage || !endCursor) return;
		loadingMore = true;
		try {
			const result = await fetchTimelinePage({ type, actorId, after: endCursor, accessToken });
			if (result.ok) {
				// Append by id rather than concatenating blind: a cursor page can
				// overlap the previous one when objects arrived in between.
				const seen = new Set(items.map((item) => item.id));
				items = [...items, ...result.page.items.filter((item) => !seen.has(item.id))];
				endCursor = result.page.endCursor;
				hasNextPage = result.page.hasNextPage;
				skipped += result.page.skipped;
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
	 * Also the recovery path for a dropped socket: the stream cannot replay what
	 * it missed, so closing the gap means asking lesser again rather than
	 * pretending the reconnect was seamless.
	 */
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const result = await fetchTimelinePage({ type, actorId, accessToken });
			if (result.ok) {
				items = result.page.items;
				endCursor = result.page.endCursor;
				hasNextPage = result.page.hasNextPage;
				skipped = result.page.skipped;
				pending = [];
				failure = null;
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
		if (atTop && pending.length) revealPending();
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
						if (status) acceptLive(status);
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
	A PINNED UPSTREAM GAP, said out loud rather than left to be discovered.

	The vendored `ContentRenderer` writes its sanitized output through a Svelte
	ACTION (`use:setHtml` → `node.innerHTML`), and actions do not run during SSR
	— so the server emits an empty body container and the post text appears at
	hydration. Every social status path reaches that component; the blog face's
	`Article.Content` uses `{@html}` and renders fine, so it is one component's
	defect, not a framework limit.

	Contentus cannot repair it here. Vendored source is never hand-edited, and an
	`{@html}` in contentus-owned source is precisely what check 3 of the
	renderer-authority audit forbids — weakening that gate to route around an
	upstream bug is the repair that is never correct. So the gap is reported
	upstream, pinned by `tests/ssr-timelines.test.mjs`, and disclosed here to the
	one reader it actually reaches. Delete this block when the probe goes red.
	-->
	<noscript>
		<p class="contentus-feed__noscript">
			Post text on this instance is filled in by JavaScript. Authors, timestamps and links are
			shown above without it; the text of each post is not.
		</p>
	</noscript>

	{#if realtimeMode !== 'unsupported'}
		<!-- The live strip is never a blank: every state says something, which is
		     the point of tracking `requires-auth` apart from `unavailable`. -->
		<div class="contentus-feed__live" data-state={liveState}>
			{#if pending.length}
				<button type="button" class="contentus-feed__new" onclick={revealPending}>
					{pending.length === 1 ? '1 new post' : `${pending.length} new posts`}
				</button>
			{:else if liveState === 'live'}
				<p class="contentus-feed__live-note">Live — new posts appear as they arrive.</p>
			{:else if liveState === 'connecting'}
				<p class="contentus-feed__live-note">Connecting for live updates…</p>
			{:else if liveState === 'requires-auth'}
				<!-- lesser answers `timelineUpdates` for PUBLIC anonymously and for
				     nothing else. The Instance tab reads fine and cannot go live,
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

		<TimelineVirtualized
			{items}
			virtualScrolling={mounted}
			endReached={!hasNextPage}
			loadingBottom={loadingMore}
			onLoadMore={loadMore}
			actionHandlers={replyHandlers}
			density="comfortable"
		/>

		{#if hasNextPage}
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

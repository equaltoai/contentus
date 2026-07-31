<!--
The `/timelines` segmented control (product design §5, face 4).

A CONTENTUS-OWNED component, and recorded as such. sim ships instance and
federated as separate routes and has no tabbed control; the design doc calls
this a deliberate improvement, small enough to own, and a candidate to upstream.
That offer is real rather than rhetorical because the model it renders lives in
`./tabs.ts` — a pure module with no DOM — so what would move upstream is a
component plus a table, not a component plus this route.

WHY LINKS AND NOT `role="tablist"`. Each tab is a real address: `/timelines`,
`?tab=federated`, `?tab=home`. They server-render, they can be shared, and the
browser's back button moves between them. `role="tab"` describes a control that
swaps panels within one document, and applying it to navigation would tell a
screen reader the wrong thing about what activating it does — and would also
mean the control needs JavaScript to work at all. lesser performs no SPA
fallback under `/l/*`, so the first paint of a phone deep link is the server's,
and a nav made of links is correct in that paint with no script at all.

`aria-current="page"` is therefore the selected-state signal, which is what it
means for a link.

MOBILE. The list scrolls horizontally rather than wrapping or shrinking, so the
targets stay at the 44px floor no matter how many tabs a session has (product
design §4). `scroll-snap` keeps a partially-swiped tab from resting half off
screen. All of it is CSS in `src/lib/brand/timelines.css`, so it holds in the
server's paint too.
-->

<script lang="ts">
	import { timelinesHref } from '../../facetheory/routing';
	import { visibleTimelineTabs, type TimelineTabId } from './tabs';

	interface Props {
		/** The tab the route resolved, which may be one this session cannot see. */
		active: TimelineTabId;
		/**
		 * Client-side session state. The server render is always anonymous
		 * because the token lives in `sessionStorage`, so Home appears at
		 * hydration — WITHOUT a reload, which is the requirement this prop
		 * exists to meet.
		 */
		authenticated: boolean;
	}

	let { active, authenticated }: Props = $props();

	const tabs = $derived(visibleTimelineTabs(authenticated));
</script>

<nav class="contentus-timeline-tabs" aria-label="Timelines">
	<ul class="contentus-timeline-tabs__list">
		{#each tabs as tab (tab.id)}
			<li class="contentus-timeline-tabs__item">
				<a
					class="contentus-timeline-tabs__tab"
					href={timelinesHref(tab.id)}
					aria-current={tab.id === active ? 'page' : undefined}
				>
					{tab.label}
				</a>
			</li>
		{/each}
	</ul>
</nav>

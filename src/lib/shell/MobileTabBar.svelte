<!--
Mobile bottom tab bar with a centered compose FAB (product design §4).

A CONTENTUS-OWNED component, and recorded as such. greater-components has no
bottom-nav, drawer, or sheet component at greater-v0.11.9 — product design §7
carries that as a planned upstream gap — so the chrome is composed here from
shell primitives and the headless behaviours. It is generic enough to become a
greater `shell` addition, and that offer goes upstream once proven on an
instance (framework feedback lane).

SWAP-TO-VENDORED: when greater M3a lands its mobile-nav components, this file
becomes a thin binding over them — the tab model in `./nav.ts` and the lesser
side of the chrome are already separate from the presentation here, so the swap
is an import change plus deleting the CSS block in `src/lib/brand/bridge.css`,
not a redesign. Do not extend this component with behaviour that belongs
upstream; add it to the upstream brief instead.

Rendered on every route and hidden above 960px by CSS rather than by a
JS-measured viewport: the bar has to be correct in the SSR document, because
lesser performs no SPA fallback under `/l/*` and a phone's first paint is the
server's.
-->

<script lang="ts">
	import BookOpenIcon from '$lib/greater/icons/icons/book-open.svelte';
	import CpuIcon from '$lib/greater/icons/icons/cpu.svelte';
	import LayersIcon from '$lib/greater/icons/icons/layers.svelte';
	import MessageSquareIcon from '$lib/greater/icons/icons/message-square.svelte';
	import PlusIcon from '$lib/greater/icons/icons/plus.svelte';

	import { COMPOSE_ACTION, visibleMobileTabs } from './nav';
	import type { AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		/** Client-side session state; the server render is always anonymous. */
		authenticated: boolean;
	}

	let { page, authenticated }: Props = $props();

	const TAB_ICONS = {
		articles: BookOpenIcon,
		timelines: LayersIcon,
		messages: MessageSquareIcon,
		agents: CpuIcon,
	} as const;

	const tabs = $derived(visibleMobileTabs(authenticated));
</script>

<nav class="contentus-tabbar" aria-label="Primary (mobile)">
	<ul class="contentus-tabbar__list">
		{#each tabs as tab (tab.id)}
			{@const Icon = TAB_ICONS[tab.id as keyof typeof TAB_ICONS]}
			<li class="contentus-tabbar__item">
				{#if tab.href}
					<a
						class="contentus-tabbar__tab"
						href={tab.href}
						aria-current={tab.pageKey === page.key ? 'page' : undefined}
					>
						<Icon size={22} aria-hidden="true" />
						<span class="contentus-tabbar__label">{tab.label}</span>
					</a>
				{:else}
					<!-- Not a link, for the same reason the sidebar's upcoming entries
					     are not: lesser has no SPA fallback under /l/*, so an href to a
					     face that has not shipped is a hard error page rather than a
					     soft miss. The milestone is stated instead of hidden. -->
					<span class="contentus-tabbar__tab" aria-disabled="true">
						<Icon size={22} aria-hidden="true" />
						<span class="contentus-tabbar__label">{tab.label}</span>
						<span class="contentus-tabbar__upcoming">{tab.upcoming}</span>
					</span>
				{/if}
			</li>
		{/each}
	</ul>

	<!-- The FAB sits in its own stacking context above the bar so the tab row can
	     stay an even flex distribution: a centre slot carved out of the row would
	     make the two middle targets narrower than 44px on a 360px phone. -->
	{#if COMPOSE_ACTION.href}
		<a
			class="contentus-fab"
			href={COMPOSE_ACTION.href}
			aria-current={COMPOSE_ACTION.pageKey === page.key ? 'page' : undefined}
		>
			<PlusIcon size={26} aria-hidden="true" />
			<span class="contentus-visually-hidden">{COMPOSE_ACTION.label}</span>
		</a>
	{:else}
		<span class="contentus-fab" aria-disabled="true">
			<PlusIcon size={26} aria-hidden="true" />
			<span class="contentus-visually-hidden">
				{COMPOSE_ACTION.label} — lands in {COMPOSE_ACTION.upcoming}
			</span>
		</span>
	{/if}
</nav>

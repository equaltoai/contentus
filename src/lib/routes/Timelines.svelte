<!--
Face 4 — the tabbed timelines surface (product design §5) · core surface.

THREE TABS, ONE SURFACE. Instance (LOCAL), Federated (PUBLIC), and Home (HOME)
are one route with a `?tab=` parameter rather than three routes, which is the
deliberate improvement over sim's separate routes the design doc names. The tab
model lives in `$lib/timelines/tabs` so what would go upstream is a component
and a table, not this route.

SSR. Instance and Federated are anonymous-safe reads of PUBLIC content, so the
server fetches the first page and a cold deep link paints real posts — this is a
reading surface, and a spinner in the first paint would make it a worse one.
Home is fetched in the browser only: it needs a token the server does not have,
and these props are serialized into contentus's PUBLIC hydration endpoint, so a
server-side Home fetch would put one reader's follow graph behind a URL anyone
could request. Same rule that keeps the review queue off the server pass.

AUTH WITHOUT A RELOAD. The server render is always the anonymous tab set,
because the session lives in `sessionStorage`. Home appears at hydration when
there is a session — the tabs come from `visibleTimelineTabs(authenticated)`,
evaluated in the browser, so nothing reloads. A shared `?tab=home` link opened
by a signed-out reader still resolves to Home and explains the sign-in rather
than silently becoming Instance, because a link that quietly becomes a different
page is worse than one that says what it needs.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { isAuthenticated, readSession, startLogin } from '$lib/auth/session';
	import TimelineFeed from '$lib/timelines/TimelineFeed.svelte';
	import TimelineTabs from '$lib/timelines/TimelineTabs.svelte';
	import { tabFor } from '$lib/timelines/tabs';

	import type { AppPageDescriptor, TimelinesRouteData } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: TimelinesRouteData;
	}

	let { page, data }: Props = $props();

	/**
	 * Three states, not two. `unknown` is the server's honest answer and the
	 * client's first frame: nothing has read `sessionStorage` yet, so claiming
	 * either way would be a guess that flickers.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let accessToken = $state<string | null>(null);
	let signInError = $state<string | null>(null);

	const tab = $derived(tabFor(data.tab));
	const authenticated = $derived(session === 'authenticated');

	onMount(() => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		accessToken = readSession()?.accessToken ?? null;
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (cause) {
			signInError = cause instanceof Error ? cause.message : 'Could not start sign-in.';
		}
	}
</script>

<section class="contentus-timelines" data-surface={page.surface}>
	<header class="contentus-timelines__head">
		<p class="contentus-timelines__eyebrow">{page.eyebrow}</p>
		<h1 class="contentus-timelines__title">{page.title}</h1>
	</header>

	<TimelineTabs active={tab.id} {authenticated} />

	<p class="contentus-timelines__description">{tab.description}</p>

	{#if tab.requiresAuth && session === 'unknown'}
		<!-- The first frame of an auth-gated tab, and the reason it is its own
		     branch: mounting the feed here would fire a HOME read with no token
		     — because nothing has read `sessionStorage` yet — and lesser would
		     correctly answer "authentication required" to a reader who is signed
		     in. The honest state for "we have not looked yet" is neither the
		     timeline nor the sign-in prompt. -->
		<Panel>
			<h2>Home</h2>
			<p>Reading your session…</p>
		</Panel>
	{:else if tab.requiresAuth && session === 'anonymous'}
		<!-- A shared `?tab=home` link, opened signed-out. The honest answer, with
		     the action attached — not a redirect to a tab nobody asked for. -->
		<Panel>
			<h2>Sign in to see your home timeline</h2>
			<p>
				Home shows posts from the accounts you follow, so this instance only shares it with a
				signed-in reader. Instance and Federated are open to everyone.
			</p>
			<button type="button" class="contentus-timelines__signin" onclick={onSignIn}>
				Sign in on this instance
			</button>
			{#if signInError}
				<p class="contentus-timelines__error" role="alert">{signInError}</p>
			{/if}
		</Panel>
	{:else}
		<!-- Keyed on the tab so switching tabs remounts the feed rather than
		     letting one timeline's items, cursor and socket leak into another's.
		     A boost that arrived on Federated must not appear under Instance. -->
		{#key tab.id}
			<TimelineFeed
				type={tab.type}
				initialPage={data.page}
				initialFailure={data.failure}
				initialPartial={data.partial}
				{authenticated}
				{accessToken}
				realtime
				emptyTitle="No posts yet"
				emptyDescription={tab.id === 'home'
					? 'Posts from the accounts you follow will appear here.'
					: 'When this instance sees posts for this timeline, they will appear here.'}
			/>
		{/key}
	{/if}
</section>

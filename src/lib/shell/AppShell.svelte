<!--
Contentus application shell.

Composes the sticky-nav | content grid described in product design §4. The
960px collapse to a single column lives in `src/lib/brand/bridge.css` rather
than here, so layout stays in the stylesheet and this component stays
structural.

Auth awareness is deliberately client-only. The server render is always the
anonymous nav because the session token lives in `sessionStorage` — there is no
cookie for the server to read, by design. That means SSR output for the public
article surfaces is identical for every visitor and safe to cache, and the
authenticated entries appear on hydration.

Below 960px the sidebar nav gives way to the bottom tab bar (product design
§4). Both are rendered — the swap is CSS, not a JS viewport measurement, because
lesser performs no SPA fallback under `/l/*` and a phone's first paint is the
server's document. The duplication is one nav model (`./nav.ts`) presented
twice, not two navigation systems.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { isAuthenticated, clearSession, startLogin } from '$lib/auth/session';
	import { onSessionChange } from '$lib/auth/session-events';
	import MobileTabBar from './MobileTabBar.svelte';
	import { COMPOSE_ACTION, isCurrentEntry, visibleNavEntries } from './nav';
	import { unreadBadgeLabel, unreadBadgeText, unreadStore } from '$lib/messaging/unread.svelte';
	import type { AppPageDescriptor } from '../../facetheory/types';
	import { href as appHref } from '../../facetheory/routing';

	interface Props {
		page: AppPageDescriptor;
		children?: import('svelte').Snippet;
	}

	let { page, children }: Props = $props();

	let authenticated = $state(false);
	let signInError = $state<string | null>(null);

	onMount(() => {
		authenticated = isAuthenticated();
		// The badge's count comes from an authenticated read, so it cannot exist in
		// the server document — it appears once the session has been read. The
		// store returns without a request for an anonymous reader, so a public
		// article page makes no call it would only be refused.
		void unreadStore.refresh();

		// The nav holds one thing bought with the session — the unread badge — so
		// it listens for the session ending rather than assuming the sign-out that
		// ends it happened here. A sign-out anywhere (an expired session, another
		// surface) has to take the count with it: a badge reading "3" over a
		// signed-out nav is a claim about somebody else's inbox.
		return onSessionChange((change) => {
			authenticated = change === 'signed-in' && isAuthenticated();
			if (authenticated) void unreadStore.refresh();
			else unreadStore.reset();
		});
	});

	const entries = $derived(visibleNavEntries(authenticated));
	const unreadText = $derived(unreadBadgeText(unreadStore.state));
	const unreadLabel = $derived(unreadBadgeLabel(unreadStore.state));

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	function onSignOut() {
		// `clearSession` announces the sign-out, and the announcement is what
		// every other surface acts on — the messages face closes its socket and
		// drops its conversations on it. Setting the local flag as well keeps the
		// nav correct on a build where the announcement cannot run (the server
		// pass, where `clearSession` returns early).
		clearSession();
		authenticated = false;
		unreadStore.reset();
	}
</script>

<a class="contentus-skip-link" href="#contentus-main">Skip to content</a>

<!-- `data-page` so a face can claim the whole viewport at a breakpoint without
     JavaScript deciding it. The composer uses it to become a full-screen sheet
     below 960px (product design §5) while the same document still renders as a
     panel on a desktop. -->
<div class="contentus-shell" data-surface={page.surface} data-page={page.key}>
	<header class="contentus-sidebar">
		<a class="contentus-brand" href={appHref('/')} aria-label="Contentus home">
			<img
				class="contentus-brand__wordmark"
				src="/l/_assets/brand/wordmark-theory-cloud.svg"
				alt="Theory Cloud"
				width="160"
				height="22"
			/>
		</a>

		<nav class="contentus-nav" aria-label="Primary">
			{#each entries as entry (entry.id)}
				{#if entry.href}
					<a
						class="contentus-nav__link"
						href={entry.href}
						aria-current={isCurrentEntry(entry, page.key) ? 'page' : undefined}
					>
						<span>{entry.label}</span>
						{#if entry.id === 'messages' && unreadText && unreadLabel}
							<!-- The count is of CONVERSATIONS with unread activity, not of
							     messages: lesser's contract carries one `unread` boolean per
							     conversation and no message count. The visible glyph is a
							     number, so the accessible name is what carries the unit. -->
							<span class="contentus-nav__unread" aria-label={unreadLabel}>{unreadText}</span>
						{/if}
					</a>
				{:else}
					<!-- Not a link: the face has not shipped, and lesser has no SPA
					     fallback under /l/*, so a href here would 404 rather than
					     degrade. -->
					<span class="contentus-nav__link" aria-disabled="true">
						<span>{entry.label}</span>
						<span class="contentus-nav__badge">{entry.upcoming}</span>
					</span>
				{/if}
			{/each}

			<!-- The compose action, which the tab bar carries as the FAB on mobile.
			     Shown to everyone for the same reason it is there: /compose renders
			     a sign-in state rather than rejecting, so advertising the action
			     costs an anonymous visitor nothing, and hiding it until hydration
			     would move the nav under them. -->
			{#if COMPOSE_ACTION.href}
				<a
					class="contentus-nav__compose"
					href={COMPOSE_ACTION.href}
					aria-current={COMPOSE_ACTION.pageKey === page.key ? 'page' : undefined}
				>
					{COMPOSE_ACTION.label}
				</a>
			{/if}
		</nav>

		<div class="contentus-session">
			{#if authenticated}
				<button class="contentus-session__button" type="button" onclick={onSignOut}>
					Sign out
				</button>
			{:else}
				<button class="contentus-session__button" type="button" onclick={onSignIn}>
					Sign in
				</button>
			{/if}
			{#if signInError}
				<p class="contentus-meta" role="alert">{signInError}</p>
			{/if}
		</div>
	</header>

	<main class="contentus-main" id="contentus-main">
		{@render children?.()}
	</main>

	<MobileTabBar {page} {authenticated} />
</div>

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
	import MobileTabBar from './MobileTabBar.svelte';
	import { visibleNavEntries } from './nav';
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
	});

	const entries = $derived(visibleNavEntries(authenticated));

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	function onSignOut() {
		clearSession();
		authenticated = false;
	}
</script>

<a class="contentus-skip-link" href="#contentus-main">Skip to content</a>

<div class="contentus-shell" data-surface={page.surface}>
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
						aria-current={entry.pageKey === page.key ? 'page' : undefined}
					>
						<span>{entry.label}</span>
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

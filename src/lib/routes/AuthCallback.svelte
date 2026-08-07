<!--
OAuth callback.

The code/state exchange is browser-only by necessity: the PKCE verifier lives
in `sessionStorage`, which the server cannot read. SSR renders the neutral
"finishing sign-in" state and the exchange runs on mount.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { completeLogin } from '$lib/auth/session';
	import { href as appHref } from '../../facetheory/routing';
	import type { AppPageDescriptor } from '../../facetheory/types';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();

	let error = $state<string | null>(null);
	let done = $state(false);

	onMount(async () => {
		const result = await completeLogin(new URLSearchParams(window.location.search));
		if (result.ok) {
			done = true;
			window.location.replace(result.returnTo);
			return;
		}
		error = result.error;
	});
</script>

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{page.title}</h1>
</header>

{#if error}
	<Notice title="Sign-in did not complete" message={error} />
	<p class="contentus-meta"><a href={appHref('/')}>Return to articles</a></p>
{:else if done}
	<p class="contentus-lede">Signed in. Returning you to where you left off…</p>
{:else}
	<p class="contentus-lede">{page.summary}</p>
{/if}

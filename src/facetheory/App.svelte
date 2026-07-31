<!--
Root component. Dispatches the resolved page to its route component inside the
app shell.

Every branch here corresponds to a route registered in `entry-server.ts`; there
is no catch-all render path that could silently show the wrong surface.
-->

<script lang="ts">
	import AppShell from '$lib/shell/AppShell.svelte';
	import ArticleReaderRoute from '$lib/routes/ArticleReader.svelte';
	import ArticlesIndexRoute from '$lib/routes/ArticlesIndex.svelte';
	import AuthCallbackRoute from '$lib/routes/AuthCallback.svelte';
	import ComposeRoute from '$lib/routes/Compose.svelte';
	import NotFoundRoute from '$lib/routes/NotFound.svelte';

	import type { RouteProps } from './types';

	let { page, slug, index, reader, compose }: RouteProps = $props();
</script>

<AppShell {page}>
	{#if page.key === 'article-reader'}
		<ArticleReaderRoute {page} data={reader ?? { article: null, body: null, unavailable: null }} />
	{:else if page.key === 'compose'}
		<ComposeRoute
			{page}
			data={compose ?? { intent: { mode: 'new', statusId: null }, source: null }}
		/>
	{:else if page.key === 'auth-callback'}
		<AuthCallbackRoute {page} />
	{:else if page.key === 'not-found'}
		<NotFoundRoute {page} />
	{:else}
		<!-- articles-index, series, category all render the index surface,
		     differing only by the filter applied in the loader. -->
		<ArticlesIndexRoute
			{page}
			data={index ?? {
				articles: [],
				series: [],
				categories: [],
				endCursor: null,
				hasNextPage: false,
				unavailable: null,
			}}
			filterSlug={slug}
		/>
	{/if}
</AppShell>

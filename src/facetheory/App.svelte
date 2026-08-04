<!--
Root component. Dispatches the resolved page to its route component inside the
app shell.

Every branch here corresponds to a route registered in `entry-server.ts`; there
is no catch-all render path that could silently show the wrong surface.
-->

<script lang="ts">
	import AppShell from '$lib/shell/AppShell.svelte';
	import AgentsRoute from '$lib/routes/Agents.svelte';
	import ArticleReaderRoute from '$lib/routes/ArticleReader.svelte';
	import ArticlesIndexRoute from '$lib/routes/ArticlesIndex.svelte';
	import AuthCallbackRoute from '$lib/routes/AuthCallback.svelte';
	import ComposeRoute from '$lib/routes/Compose.svelte';
	import MessageThreadRoute from '$lib/routes/MessageThread.svelte';
	import MessagesRoute from '$lib/routes/Messages.svelte';
	import NotFoundRoute from '$lib/routes/NotFound.svelte';
	import ProfileRoute from '$lib/routes/Profile.svelte';
	import ReviewQueueRoute from '$lib/routes/ReviewQueue.svelte';
	import ReviewWorkspaceRoute from '$lib/routes/ReviewWorkspace.svelte';
	import TimelinesRoute from '$lib/routes/Timelines.svelte';

	import type { RouteProps } from './types';

	let {
		page,
		slug,
		index,
		reader,
		compose,
		review,
		timelines,
		messages,
		agents,
		profile,
	}: RouteProps = $props();
</script>

<AppShell {page}>
	{#if page.key === 'article-reader'}
		<ArticleReaderRoute {page} data={reader ?? { article: null, body: null, unavailable: null }} />
	{:else if page.key === 'compose'}
		<ComposeRoute
			{page}
			data={compose ?? { intent: { mode: 'new', statusId: null }, source: null }}
		/>
	{:else if page.key === 'review-queue'}
		<ReviewQueueRoute {page} />
	{:else if page.key === 'review-workspace'}
		<ReviewWorkspaceRoute {page} data={review ?? { draftId: null, panel: 'details' }} />
	{:else if page.key === 'timelines'}
		<TimelinesRoute
			{page}
			data={timelines ?? { tab: 'instance', page: null, failure: null, partial: false }}
		/>
	{:else if page.key === 'messages'}
		<MessagesRoute {page} data={messages ?? { folder: 'inbox', conversationId: null }} />
	{:else if page.key === 'message-thread'}
		<MessageThreadRoute {page} data={messages ?? { folder: 'inbox', conversationId: null }} />
	{:else if page.key === 'agents'}
		<AgentsRoute
			{page}
			data={agents ?? {
				page: null,
				failure: null,
				filters: { type: null, query: null, verified: null, after: null },
			}}
		/>
	{:else if page.key === 'profile'}
		<ProfileRoute
			{page}
			data={profile ?? {
				handle: null,
				actor: null,
				page: null,
				failure: 'not-found',
				pagePartial: false,
				actorPartial: false,
			}}
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

<!--
Face 1 — the articles index.

Anonymous by construction: `articles` and `categories` are public reads on an
instance with CMS long-form enabled, and the loader attaches no token.

Cards come from the vendored blog face (`ArticleIndexCard`). The index never
fetches an article body, so there is no path by which unrendered source could
reach a listing.
-->

<script lang="ts">
	import { ArticleIndexCard } from '$lib/greater/faces/blog/components/Article/index.js';

	import { toBlogFaceArticle } from '$lib/cms/articles';
	import { fetchArticlesPage } from '$lib/cms/pagination';
	import { articleHref, categoryHref, href as appHref } from '../../facetheory/routing';
	import type { AppPageDescriptor, ArticlesIndexData } from '../../facetheory/types';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
		data: ArticlesIndexData;
		/** Category or series slug when this is a filtered view. */
		filterSlug?: string | null;
	}

	let { page, data, filterSlug = null }: Props = $props();

	const heading = $derived(filterSlug ? `${page.title}: ${filterSlug}` : page.title);

	// "Load more" pages the SAME listing the server painted: the resolved filter
	// IDs and the cursor both come from the loader, and the fetch is anonymous
	// for the same reason the initial load is. `data` never changes after
	// hydration (a filter change is a navigation, not a prop update), so local
	// state seeded from it is the source of truth from the first click on.
	let articles = $state(data.articles);
	let endCursor = $state(data.endCursor);
	let hasNextPage = $state(data.hasNextPage);
	let loadingMore = $state(false);
	let loadMoreFailed = $state(false);
	let pageStatus = $state('');

	async function loadMore() {
		if (loadingMore || !hasNextPage) return;
		loadingMore = true;
		loadMoreFailed = false;

		const next = await fetchArticlesPage(data.filters, endCursor);

		loadingMore = false;
		if (!next) {
			// Nothing on screen changes: the control stays, labelled for retry,
			// and the status region says what happened.
			loadMoreFailed = true;
			pageStatus = 'More articles could not be loaded.';
			return;
		}

		articles = [...articles, ...next.articles];
		endCursor = next.endCursor;
		hasNextPage = next.hasNextPage;
		pageStatus = `Showing ${articles.length} articles.`;
	}
</script>

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{heading}</h1>
	<p class="contentus-lede">{page.summary}</p>
</header>

{#if data.categories.length > 0}
	<nav class="contentus-filters" aria-label="Categories">
		<a class="contentus-filter" href={appHref('/')} aria-current={filterSlug ? undefined : 'page'}>
			All
		</a>
		{#each data.categories as category (category.id)}
			<a
				class="contentus-filter"
				href={categoryHref(category.slug)}
				aria-current={filterSlug === category.slug ? 'page' : undefined}
			>
				{category.name}
			</a>
		{/each}
	</nav>
{/if}

{#if data.unavailable}
	<Notice
		title={data.unavailable.reason === 'cms-disabled'
			? 'Long-form publishing is off'
			: 'Articles are unavailable'}
		message={data.unavailable.message}
	/>
{:else if data.articles.length === 0}
	<Notice
		title="No articles yet"
		message="Nothing has been published on this instance so far. Once an article is
			reviewed and published it appears here."
	/>
{:else}
	<div class="contentus-card-grid">
		{#each articles as article (article.id)}
			<ArticleIndexCard
				article={toBlogFaceArticle(article)}
				href={articleHref(article.slug)}
				headingLevel={2}
			/>
		{/each}
	</div>

	{#if hasNextPage}
		<div class="contentus-load-more">
			<button
				type="button"
				class="contentus-load-more__button"
				disabled={loadingMore}
				onclick={loadMore}
			>
				{loadingMore ? 'Loading…' : loadMoreFailed ? 'Try again' : 'Load more articles'}
			</button>
			{#if loadMoreFailed}
				<p class="contentus-meta">More articles could not be loaded.</p>
			{/if}
		</div>
	{/if}
	<p class="contentus-visually-hidden" role="status">{pageStatus}</p>
{/if}

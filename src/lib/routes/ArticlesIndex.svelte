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
		{#each data.articles as article (article.id)}
			<ArticleIndexCard
				article={toBlogFaceArticle(article)}
				href={articleHref(article.slug)}
				headingLevel={2}
			/>
		{/each}
	</div>

	{#if data.hasNextPage}
		<p class="contentus-meta">
			More articles are available. Pagination beyond the first page lands with the
			reading-surface work in a later milestone.
		</p>
	{/if}
{/if}

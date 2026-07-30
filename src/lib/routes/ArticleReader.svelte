<!--
Face 1 — the article reader.

RENDERER AUTHORITY. lesser's server-side renderer/sanitizer is the only source
of article HTML. This component displays that output; it never renders Markdown
and never shows raw source. The decision of whether a body may be displayed at
all is made once, in `resolveArticleBody`, and ENFORCED where the data is built
(`withholdUnrenderableSource`, applied in the loader) — so a withheld body is
already gone by the time it reaches here, rather than merely unrendered. This
component presents the decision; it does not re-take it.

When the body is withheld, the reader still renders everything lesser HAS
rendered authoritatively — title, subtitle, byline, dates, reading time, word
count, table of contents — because those are server-derived scalars, not body
content. A reader that shows the article's shape and says plainly why the prose
is missing is more honest than a blank page, and far more honest than a page
that quietly prints Markdown source.
-->

<script lang="ts">
	import { ArticleReader as BlogArticleReader } from '$lib/greater/faces/blog/components/Article/index.js';

	import { toBlogFaceArticle } from '$lib/cms/articles';
	import { seriesHref } from '../../facetheory/routing';
	import type { AppPageDescriptor, ArticleReaderData } from '../../facetheory/types';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
		data: ArticleReaderData;
	}

	let { page, data }: Props = $props();

	// The gate already ran in the loader, which is also where the withheld source
	// was dropped. Re-deriving it here would be a second opinion on a decision
	// that has already been enforced — and by now `content` is empty either way.
	const body = $derived(data.body);
	const faceArticle = $derived(
		data.article && body ? toBlogFaceArticle(data.article, body) : null
	);
</script>

{#if !data.article}
	<Notice
		title={data.unavailable?.reason === 'cms-disabled'
			? 'Long-form publishing is off'
			: 'Article not found'}
		message={data.unavailable?.message ?? 'No article matches this address.'}
	/>
{:else}
	<article class="contentus-reader">
		{#if body?.kind === 'render' && faceArticle}
			<BlogArticleReader
				article={faceArticle}
				config={{ showTableOfContents: data.article.tableOfContents.length > 0 }}
			/>
		{:else}
			<!--
				Withheld body. lesser returned content that has not been through its
				publication renderer, so there is nothing here we are permitted to
				display: rendering it would make contentus a second canonical
				renderer, and printing it raw would publish source as a reading view.
			-->
			<header class="contentus-page-header">
				<p class="contentus-eyebrow">{page.eyebrow}</p>
				<h1 class="contentus-h1">{data.article.title}</h1>
				{#if data.article.subtitle}
					<p class="contentus-lede">{data.article.subtitle}</p>
				{/if}
				<p class="contentus-meta">
					{#if data.article.author?.displayName || data.article.author?.username}
						{data.article.author.displayName ?? `@${data.article.author.username}`} ·
					{/if}
					{data.article.readingTimeMinutes} min read · {data.article.wordCount} words
				</p>
			</header>

			{#if body?.kind === 'withhold' && body.reason === 'unrendered-source'}
				<Notice
					title="This article is awaiting server-rendered output"
					message="The instance returned this article's source rather than its published
						HTML. Contentus shows only what lesser's renderer produces — it will not
						render the source itself, and it will not display it raw."
					detail="Tracked as an upstream gap against lesser's CMS contract: the article
						read path does not run the publication renderer that the ActivityPub path
						uses."
				/>
			{:else}
				<Notice
					title="This article has no body yet"
					message="The instance returned an article with empty content."
				/>
			{/if}

			{#if data.article.excerpt}
				<p class="contentus-lede">{data.article.excerpt}</p>
			{/if}

			{#if data.article.tableOfContents.length > 0}
				<nav aria-label="Table of contents">
					<h2 class="contentus-notice__title">Contents</h2>
					<ol>
						{#each data.article.tableOfContents as entry (entry.id)}
							<li>{entry.text}</li>
						{/each}
					</ol>
				</nav>
			{/if}
		{/if}

		{#if data.article.series}
			<p class="contentus-meta">
				Part of the series
				<a href={seriesHref(data.article.series.slug)}>{data.article.series.title}</a>
			</p>
		{/if}
	</article>
{/if}

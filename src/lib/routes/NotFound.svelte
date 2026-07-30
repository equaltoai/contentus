<!--
404. Served with an actual 404 status (see `statusForPage`) rather than a
200 with apologetic copy — lesser has no SPA fallback under `/l/*`, so this is
a real miss and crawlers should be told so.
-->

<script lang="ts">
	import { href as appHref } from '../../facetheory/routing';
	import type { AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();
</script>

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{page.title}</h1>
	<p class="contentus-lede">{page.summary}</p>
</header>

<p class="contentus-meta"><a href={appHref('/')}>Back to articles</a></p>

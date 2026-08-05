<!-- Face 7 — owned drone roster. Authenticated, write-scoped, client-loaded. -->

<script lang="ts">
	import DroneRoster from '$lib/drones/DroneRoster.svelte';
	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';

	import type { AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();
</script>

<PageFrame width="wide">
	<header class="contentus-page-header">
		<p class="contentus-eyebrow">{page.eyebrow}</p>
		<h1 class="contentus-h1">{page.title}</h1>
		<p class="contentus-lede">{page.summary}</p>
	</header>
	<DroneRoster />
</PageFrame>

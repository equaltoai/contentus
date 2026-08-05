<!-- Face 7 — private drone delegation and one-time credential reveal. -->

<script lang="ts">
	import DroneCreationFlow from '$lib/drones/DroneCreationFlow.svelte';
	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';

	import type { AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();
</script>

<PageFrame width="default">
	<header class="contentus-page-header">
		<p class="contentus-eyebrow">{page.eyebrow}</p>
		<h1 class="contentus-h1">{page.title}</h1>
		<p class="contentus-lede">{page.summary}</p>
	</header>
	<DroneCreationFlow />
</PageFrame>

<!--
Face 5 — `/messages`, the conversation list (product design §5) · mcp surface.

Auth: REQUIRED, for the whole route rather than for one tab. Unlike `/timelines`
— where Instance and Federated are anonymous-safe reads and only Home needs a
token — lesser serves no part of `conversations` anonymously, so there is no
half of this surface an anonymous reader can be shown. The route still
server-renders: lesser performs no SPA fallback under `/l/*`, so a cold deep
link has to produce a complete page, and the complete page for a reader the
server cannot identify is the sign-in state.
-->

<script lang="ts">
	import MessagesPage from '$lib/messaging/MessagesPage.svelte';

	import type { AppPageDescriptor, MessagesRouteData } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: MessagesRouteData;
	}

	let { page, data }: Props = $props();
</script>

<MessagesPage {page} {data} mode="list" />

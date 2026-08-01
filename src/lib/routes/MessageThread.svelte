<!--
Face 5 — `/messages/{conversationId}`, one conversation (product design §5) ·
mcp surface.

ITS OWN ROUTE, which is what makes the mobile two-pane collapse work: below
960px the list is full width and a conversation PUSHES as its own address with a
back affordance, rather than being a mode the list switches into. Above it, the
same route renders both panes with this conversation selected — one URL that
always names what is on screen, so a conversation can be linked, bookmarked, and
reopened after the full page load lesser's routing gives us anyway.

Auth: REQUIRED, and nothing about the conversation travels from the server. The
id is in the path and the messages are fetched by the client with the session
token; a server-side fetch would put private correspondence into the public
hydration payload. See `createRouteProps` in `entry-server.ts`.
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

<MessagesPage {page} {data} mode="thread" />

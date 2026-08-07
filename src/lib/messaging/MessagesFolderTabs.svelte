<!--
Inbox | Requests, as a first-class addressable tab pair (product design §5).

WHY CONTENTUS OWNS THIS. `Messages.Conversations` ships its own tab bar, and it
is not addressable: the buttons call `fetchConversations` on the context and the
component takes no prop saying which folder to open. `?folder=requests` is what
makes Requests a tab somebody can be SENT to rather than one they have to know
to click, which is the strongest reading of "a first-class tab, not a hidden
filter" — so the tabs are here and the ask is upstream.

The count on Requests is `state.requestCount`, which the context maintains from
`viewerMetadata.requestState === 'PENDING'` across both folder reads. It is a
count of pending REQUESTS, which is what the word means here, and unlike the
unread badge it needs no relabelling: one conversation is one request.

Both tabs are links AND buttons: the `href` makes the folder shareable and
survives a cold load, while the click handler switches folder in place without
the full page load lesser's no-SPA-fallback routing would otherwise force.
-->

<script lang="ts">
	import type { ConversationFolder } from '$lib/components/messaging/context.svelte.js';
	import { messagesHref } from '../../facetheory/routing';

	interface Props {
		active: ConversationFolder;
		requestCount: number;
		onSelect: (folder: ConversationFolder) => void;
	}

	let { active, requestCount, onSelect }: Props = $props();

	const TABS = [
		{ folder: 'INBOX' as const, label: 'Inbox', href: messagesHref('inbox') },
		{ folder: 'REQUESTS' as const, label: 'Requests', href: messagesHref('requests') },
	];

	function select(event: MouseEvent, folder: ConversationFolder) {
		// Let the browser handle the modified clicks it owns — a new tab, a new
		// window, a download — rather than swallowing them into an in-page switch.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
			return;
		}
		event.preventDefault();
		onSelect(folder);
		// Keep the address in step with what is on screen, without adding a history
		// entry per tab press: a reader pressing back expects the page they came
		// from, not the other tab.
		if (typeof history !== 'undefined') {
			history.replaceState(history.state, '', folder === 'REQUESTS' ? TABS[1].href : TABS[0].href);
		}
	}
</script>

<nav class="contentus-messages__tabs" aria-label="Message folders">
	{#each TABS as tab (tab.folder)}
		<a
			class="contentus-messages__tab"
			class:contentus-messages__tab--active={active === tab.folder}
			href={tab.href}
			aria-current={active === tab.folder ? 'page' : undefined}
			onclick={(event) => select(event, tab.folder)}
		>
			{tab.label}
			{#if tab.folder === 'REQUESTS' && requestCount > 0}
				<span
					class="contentus-messages__tab-count"
					aria-label={requestCount === 1 ? '1 pending request' : `${requestCount} pending requests`}
				>
					{requestCount > 99 ? '99+' : requestCount}
				</span>
			{/if}
		</a>
	{/each}
</nav>

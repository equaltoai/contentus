<!--
The conversation list, with accept/decline on the request card (product design
§5, sub-issue #33).

WHY THIS IS NOT `Messages.Conversations`. That component's card is a `<button>`
with no action slot and no snippet, and §5 puts Accept and Decline on the card
itself — reachable without opening the thread, which is the whole point of a
Requests tab. There is no prop that adds them. So the cards are composed here
over the SAME `getMessagesContext()` the vendored components read, sharing their
state and their handlers rather than running a parallel model. `Message`,
`Thread`, `Composer`, `NewConversation` and `Root` are all still upstream's.
Routed as an ask; see docs/consumption/messaging-contract.md.

REQUEST STATE IS READ, NEVER INFERRED. Every request affordance below is gated
on `conversation.requestState`, which the adapter maps straight from lesser's
`viewerMetadata.requestState`. Nothing here derives "this looks like a request"
from an empty message list, an unknown participant, or the folder it arrived in
— an inference would be this client deciding something lesser is authoritative
about, and would be wrong the moment a request is accepted in another tab.
-->

<script lang="ts">
	import type {
		Conversation,
		ConversationFolder,
	} from '$lib/components/messaging/context.svelte.js';
	import { formatMessageTime, getConversationName } from '$lib/components/messaging/utils.js';
	import { conversationHref } from '../../facetheory/routing';

	interface Props {
		conversations: Conversation[];
		folder: ConversationFolder;
		loading: boolean;
		/** A conversation-level mutation is in flight; actions disable together. */
		busy: boolean;
		selectedId: string | null;
		onSelect: (conversation: Conversation) => void;
		/**
		 * Both actions carry the NAME the card displayed.
		 *
		 * The outcome notice the surface renders names the person whose request it
		 * was, and this component is the only place that name is derived — from
		 * `getConversationName`, which is upstream's. Re-deriving it there would be
		 * a second opinion about what to call somebody.
		 */
		onAccept: (conversation: Conversation, name: string) => Promise<void> | void;
		onDecline: (conversation: Conversation, name: string) => Promise<void> | void;
	}

	let {
		conversations,
		folder,
		loading,
		busy,
		selectedId,
		onSelect,
		onAccept,
		onDecline,
	}: Props = $props();

	/**
	 * The viewer's own id is not needed to name a conversation here.
	 *
	 * `getConversationName` filters the viewer out of the participant list, and
	 * contentus does not hold a session actor id on this surface. Passing an empty
	 * id means no participant is filtered, so a 1:1 conversation is named by both
	 * people rather than by the other one — wordier, and honest. Inventing an id
	 * to filter on would risk hiding the WRONG participant's name.
	 */
	const VIEWER_UNKNOWN = '';

	function preview(conversation: Conversation): string | null {
		const message = conversation.lastMessage;
		if (!message) return null;
		// A sensitive message's body is not previewed — the warning is the preview.
		// Same rule the vendored list applies, kept because a content warning that
		// leaks its body into a list is not a content warning.
		if (message.sensitive) return message.spoilerText?.trim() || 'Sensitive message';
		return message.content;
	}

	function isPending(conversation: Conversation): boolean {
		return conversation.requestState === 'PENDING';
	}

	function click(event: MouseEvent, conversation: Conversation) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
			return;
		}
		event.preventDefault();
		onSelect(conversation);
	}
</script>

{#if loading}
	<p class="contentus-messages__loading" role="status">Loading conversations…</p>
{:else if conversations.length === 0}
	<!-- Reached only when the read SUCCEEDED and returned nothing: the adapter
	     throws rather than returning an empty list for a failed read, and the
	     surface renders the failure above instead of this. -->
	<p class="contentus-messages__empty">
		{folder === 'REQUESTS'
			? 'No message requests are waiting for you.'
			: 'No conversations yet. Start one with anybody on the fediverse.'}
	</p>
{:else}
	<ul class="contentus-conversations">
		{#each conversations as conversation (conversation.id)}
			{@const name = getConversationName(conversation, VIEWER_UNKNOWN)}
			{@const body = preview(conversation)}
			<li
				class="contentus-conversations__item"
				class:contentus-conversations__item--selected={selectedId === conversation.id}
				class:contentus-conversations__item--unread={conversation.unreadCount > 0}
			>
				<!-- A real link: it survives the server render, it can be opened in a
				     new tab, and below 960px it is the navigation that pushes the
				     thread as its own route. The handler intercepts the plain click
				     so a wide viewport selects in place instead. -->
				<a
					class="contentus-conversations__link"
					href={conversationHref(conversation.id)}
					aria-current={selectedId === conversation.id ? 'page' : undefined}
					onclick={(event) => click(event, conversation)}
				>
					<span class="contentus-conversations__avatar" aria-hidden="true">
						{#if conversation.participants[0]?.avatar}
							<img src={conversation.participants[0].avatar} alt="" />
						{:else}
							<span class="contentus-conversations__initial">
								{conversation.participants[0]?.displayName?.[0]?.toUpperCase() ?? '?'}
							</span>
						{/if}
					</span>

					<span class="contentus-conversations__body">
						<span class="contentus-conversations__name">{name}</span>
						{#if body}
							<!-- Escaped, like every message body on this build. The
							     surface-level disclosure explains why; see
							     MessagingSurface.svelte. -->
							<span class="contentus-conversations__preview">{body}</span>
						{/if}
					</span>

					<span class="contentus-conversations__meta">
						{#if conversation.lastMessage}
							<time datetime={conversation.lastMessage.createdAt}>
								{formatMessageTime(conversation.lastMessage.createdAt)}
							</time>
						{/if}
						{#if conversation.unreadCount > 0}
							<!-- lesser gives one `unread` BOOLEAN per conversation and no
							     message count, so this is a dot rather than a number. A
							     numeral here would read as a message count contentus does
							     not have. -->
							<span class="contentus-conversations__dot" aria-label="Unread messages"></span>
						{/if}
					</span>
				</a>

				{#if isPending(conversation)}
					<div class="contentus-conversations__request">
						<p class="contentus-conversations__request-text">
							{name} wants to start a conversation. Accepting moves it to your inbox and lets you reply.
						</p>
						<div class="contentus-conversations__actions">
							<button
								type="button"
								class="contentus-conversations__decline"
								disabled={busy}
								onclick={() => onDecline(conversation, name)}
							>
								Decline
							</button>
							<button
								type="button"
								class="contentus-conversations__accept"
								disabled={busy}
								onclick={() => onAccept(conversation, name)}
							>
								Accept
							</button>
						</div>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

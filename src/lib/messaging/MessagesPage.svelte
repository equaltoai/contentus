<!--
The messaging face's session gate and provider, shared by both routes.

THE ROOT MOUNTS ONLY FOR A SIGNED-IN READER, and that is load-bearing rather
than tidy. `Messages.Root` fires `fetchConversations` and `startRealtime` from
its own `onMount`; rendering it before the session has been read would post an
unauthenticated `conversations` query and open a socket with no token — lesser
would refuse both, correctly, and the surface would show a signed-in reader an
error caused by contentus asking too early.

THREE SESSION STATES, NOT TWO. `unknown` is the server's honest answer and the
client's first frame: nothing has read `sessionStorage` yet. Claiming either way
would be a guess that flickers, and on this surface the guess that flickers is
"you have no messages".
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Root from '$lib/components/messaging/Root.svelte';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { isAuthenticated, startLogin } from '$lib/auth/session';
	import { resolveBrowserOrigin } from '$lib/cms/origin';
	import type { SubscriptionState } from '$lib/timelines/subscription';
	import MessagingSurface from './MessagingSurface.svelte';
	import { createMessagingBinding, type MessagingBinding } from './handlers';
	import { unreadStore } from './unread.svelte';
	import type { AppPageDescriptor, MessagesRouteData } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: MessagesRouteData;
		mode: 'list' | 'thread';
	}

	let { page, data, mode }: Props = $props();

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let signInError = $state<string | null>(null);
	let binding = $state<MessagingBinding | null>(null);

	/**
	 * The realtime state as OBSERVED, not as assumed.
	 *
	 * `createLesserMessagesHandlers` reports `connected` synchronously after
	 * subscribing — before a socket has opened, let alone been acknowledged — so
	 * the context's `realtimeStatus` is optimism. The adapter reports what the
	 * socket actually did, and that is what the surface renders.
	 */
	let realtime = $state<SubscriptionState>('idle');
	let partialOperations = $state<string[]>([]);

	onMount(() => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') {
			unreadStore.reset();
			return;
		}

		binding = createMessagingBinding({
			origin: resolveBrowserOrigin(),
			onRealtimeState: (state) => {
				realtime = state;
			},
			onPartial: (operation) => {
				if (!partialOperations.includes(operation)) {
					partialOperations = [...partialOperations, operation];
				}
			},
		});
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (cause) {
			signInError = cause instanceof Error ? cause.message : 'Could not start sign-in.';
		}
	}
</script>

<section class="contentus-messages-page" data-surface={page.surface}>
	<header class="contentus-messages-page__head">
		<p class="contentus-messages-page__eyebrow">{page.eyebrow}</p>
		<h1 class="contentus-messages-page__title">{page.title}</h1>
	</header>

	{#if session === 'unknown'}
		<!-- The server render and the first client frame. Not the sign-in prompt:
		     the server cannot read `sessionStorage`, so it does not know whether
		     this reader is signed in, and showing them a sign-in they do not need
		     is as wrong as showing an empty inbox they do not have. -->
		<Panel>
			<h2>Messages</h2>
			<p>Reading your session…</p>
		</Panel>
	{:else if session === 'anonymous'}
		<Panel>
			<h2>Sign in to read your messages</h2>
			<p>
				Direct messages are private, so this instance serves none of them without a sign-in — not the
				conversations, not the requests, not the participants.
			</p>
			<button type="button" class="contentus-messages__signin" onclick={onSignIn}>
				Sign in on this instance
			</button>
			{#if signInError}
				<p class="contentus-messages__error" role="alert">{signInError}</p>
			{/if}
		</Panel>
	{:else if binding}
		<!-- `autoFetch` stays on: it is what loads the inbox and, in the background,
		     the request count that feeds the Requests tab badge. -->
		<Root handlers={binding.handlers}>
			<MessagingSurface
				{binding}
				{mode}
				folder={data.folder}
				conversationId={data.conversationId}
				{realtime}
				{partialOperations}
			/>
		</Root>
	{/if}
</section>

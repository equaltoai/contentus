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

THE GATE TRACKS THE SESSION; IT DOES NOT SNAPSHOT IT. That distinction was a
defect: reading `isAuthenticated()` once in `onMount` meant sign-out emptied
`sessionStorage` while this component went on holding everything the session had
bought — the conversations, the participants, the bodies, and an AUTHORIZED
SOCKET still receiving. On a shared device the next person met the last one's
inbox. So `clearSession` announces itself (`$lib/auth/session-events`), and
`closeSession` below is what that announcement runs: the socket is closed first,
the binding is dropped, and every piece of state bought with the old session
goes with it. A different reader signing in afterwards gets a NEW binding and a
new `Root`, so there is nothing of the previous session left to observe.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Root from '$lib/components/messaging/Root.svelte';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated, startLogin } from '$lib/auth/session';
	import { onSessionChange } from '$lib/auth/session-events';
	import type { SubscriptionState } from '$lib/timelines/subscription';
	import MessagingSurface from './MessagingSurface.svelte';
	import {
		createMessagingBinding,
		type MessagingBinding,
		type MessagingCatchUp,
		type MessagingRereadState,
	} from './handlers';
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
	 * The realtime state as OBSERVED by the socket.
	 *
	 * The messages context keeps its own `realtimeStatus`, and it is a coarser
	 * thing: `connected`, `disconnected` or `error`, with retry copy attached. The
	 * socket distinguishes states that need different sentences — `requires-auth`
	 * (sign in again) from `unavailable` (reload), and `degraded` (the stream is
	 * open but something it sent could not be read) from either. Those
	 * distinctions are what the surface renders, so they are tracked here rather
	 * than flattened into the context's vocabulary on the way past.
	 */
	let realtime = $state<SubscriptionState>('idle');
	/** Whether a reconnected socket has re-read what it missed. */
	let catchUp = $state<MessagingCatchUp>('idle');
	/** What happened to the last re-read an event asked for. */
	let reread = $state<MessagingRereadState>('idle');
	let partialOperations = $state<string[]>([]);

	/**
	 * Open the surface for the session that is actually in storage.
	 *
	 * Idempotent: a `signed-in` announcement for the session already open leaves
	 * the existing binding — and the conversations loaded through it — alone.
	 */
	function openSession() {
		if (!isAuthenticated()) {
			closeSession();
			return;
		}

		session = 'authenticated';
		if (binding) return;

		binding = createMessagingBinding({
			// The session is passed in rather than read inside the binding, which is
			// what keeps that module loadable by `node --test` and its adapters
			// drivable against a stubbed fetch. Passed as a FUNCTION so a token
			// refreshed mid-session is the one the next request carries.
			accessToken: accessTokenOrNull,
			onRealtimeState: (state) => {
				realtime = state;
			},
			onCatchUp: (state) => {
				catchUp = state;
			},
			onRereadState: (state) => {
				reread = state;
			},
			onPartial: (operation) => {
				if (!partialOperations.includes(operation)) {
					partialOperations = [...partialOperations, operation];
				}
			},
		});
	}

	/**
	 * End the surface with the session.
	 *
	 * ORDER MATTERS. The socket is closed first, because it is the only thing
	 * here that keeps RECEIVING after the reader has gone; then the binding is
	 * dropped, which unmounts `Root` and takes the conversations, the thread and
	 * the drafts bound to it with it. Nothing is left holding the old session's
	 * data for the next reader to find.
	 */
	function closeSession() {
		binding?.teardown();
		binding = null;
		session = 'anonymous';
		realtime = 'idle';
		catchUp = 'idle';
		reread = 'idle';
		partialOperations = [];
		unreadStore.reset();
	}

	onMount(() => {
		openSession();

		const unsubscribe = onSessionChange((change) => {
			if (change === 'signed-out') closeSession();
			else openSession();
		});

		return () => {
			unsubscribe();
			// Leaving the surface closes the socket too. `Root`'s own `onDestroy`
			// stops the subscription it holds — but it only holds it from a
			// microtask AFTER subscribing, so a navigation landing first would leave
			// an authorized socket open with nothing left to read it.
			binding?.teardown();
		};
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
				{catchUp}
				{reread}
				{partialOperations}
			/>
		</Root>
	{/if}
</section>

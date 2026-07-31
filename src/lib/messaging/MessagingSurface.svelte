<!--
Face 5's surface, rendered inside `Messages.Root` (product design §5) · mcp.

WHAT IS VENDORED AND WHAT IS NOT, stated here because the split is a decision
rather than an accident. `Messages.Root`, `Thread`, `Composer`, `Message` and
`NewConversation` are greater's, used as they ship. The conversation LIST is
contentus's, and it is the one place the suite could not serve the design:

  - `Messages.Conversations` bundles a header, a folder tab bar and the cards
    into one component with no slots. Its tabs drive `fetchConversations`
    directly and cannot be told which folder to open, so `?folder=requests` —
    a Requests tab a reader can LINK somebody to, which is the strongest form
    of "first-class tab, not a hidden filter" — is unreachable through it.
  - Its card is a `<button>` with no action slot, and product design §5 puts
    accept/decline ON THE CARD. There is no prop, snippet or child that adds
    one.

Both are asks upstream (docs/consumption/messaging-contract.md), not local
preferences, and the list below is composed from the SAME context the vendored
components read — `getMessagesContext()` — so it shares their state, their
handlers and their realtime updates rather than running a second model beside
them.

TWO PANES, ONE URL. `/messages` is the list; `/messages/{conversationId}` is a
conversation. On a wide viewport both routes show both panes, and selecting a
conversation from the list is an in-place selection. Below 960px the panes
collapse: the list is full width, and a conversation PUSHES as its own route
with a back affordance (§5). The URL always names what is on screen, which is
what makes a conversation shareable, bookmarkable, and survivable across the
full page load that lesser's no-SPA-fallback routing gives us anyway.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Thread from '$lib/components/messaging/Thread.svelte';
	import Composer from '$lib/components/messaging/Composer.svelte';
	import NewConversation from '$lib/components/messaging/NewConversation.svelte';
	import { getMessagesContext } from '$lib/components/messaging/context.svelte.js';
	import type { Conversation } from '$lib/components/messaging/context.svelte.js';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { startLogin } from '$lib/auth/session';
	import { conversationHref, messagesHref } from '../../facetheory/routing';
	import type { MessageFolderTab } from '../../facetheory/types';
	import ConversationList from './ConversationList.svelte';
	import MessagesFolderTabs from './MessagesFolderTabs.svelte';
	import { mergeMessages } from './contract';
	import { classifyMessagingError, type MessagingBinding } from './handlers';
	import { unreadStore } from './unread.svelte';
	import type { SubscriptionState } from '$lib/timelines/subscription';

	interface Props {
		binding: MessagingBinding;
		/** `list` is `/messages`; `thread` is `/messages/{conversationId}`. */
		mode: 'list' | 'thread';
		folder: MessageFolderTab;
		conversationId: string | null;
		/** The honest realtime state, as observed by the socket rather than assumed. */
		realtime: SubscriptionState;
		/** Operations that came back with data AND errors. */
		partialOperations: string[];
	}

	let { binding, mode, folder, conversationId, realtime, partialOperations }: Props = $props();

	const context = getMessagesContext();
	// NOT named `state`: a local by that name shadows the `$state` rune and every
	// rune declaration below silently reads as store access on it.
	const dm = context.state;

	/**
	 * The deep-linked conversation's own resolution, kept separate from
	 * `dm.selectedConversation`.
	 *
	 * `/messages/{id}` arrives with an id and no list — `conversations` returns a
	 * bare list with no cursor, so there is no page to walk looking for it — and
	 * `MessagesHandlers` has no by-id read. Resolving it is a distinct operation
	 * with its own three outcomes, and flattening them into the context's single
	 * `error` string would make "this conversation does not exist" and "the
	 * instance did not answer" the same screen.
	 */
	let resolution = $state<'idle' | 'loading' | 'ready' | 'not-found' | 'failed'>('idle');
	let resolutionFailure = $state<'auth-required' | 'unavailable' | 'unknown' | null>(null);

	/** Cursor state for the selected thread. Owned here — the handler discards it. */
	let cursor = $state<string | null>(null);
	let hasOlder = $state(false);
	let loadingOlder = $state(false);
	let olderError = $state<string | null>(null);
	let pagedConversationId = $state<string | null>(null);

	/**
	 * A declined request, remembered.
	 *
	 * The context's `declineMessageRequest` filters the conversation out of the
	 * array, so without this the card simply vanishes — which is exactly the
	 * "silent disappearance" #33 rules out. Holding the name lets the surface say
	 * what happened, and the decline stays honest: nothing is un-declined, the
	 * notice just reports the state lesser now holds.
	 */
	let declined = $state<{ id: string; name: string } | null>(null);

	const selected = $derived(dm.selectedConversation);
	const failure = $derived(dm.error ? classifyMessagingError(new Error(dm.error)) : null);

	/** Wide enough for two panes. Matches the §4 breakpoint the shell uses. */
	const TWO_PANE_QUERY = '(min-width: 960px)';
	let twoPane = $state(false);

	onMount(() => {
		// Read once and then track, so the first client frame agrees with the CSS
		// rather than assuming a width the server could not know.
		const media = window.matchMedia(TWO_PANE_QUERY);
		twoPane = media.matches;
		const onChange = (event: MediaQueryListEvent) => {
			twoPane = event.matches;
		};
		media.addEventListener('change', onChange);
		return () => media.removeEventListener('change', onChange);
	});

	onMount(() => {
		// Seed the folder from the URL. `fetchConversations` is what `Root`'s
		// autoFetch would have called anyway; calling it with the addressed folder
		// means a `?folder=requests` link opens on Requests rather than opening on
		// Inbox and switching a beat later.
		if (folder === 'requests' && dm.folder !== 'REQUESTS') {
			void context.fetchConversations('REQUESTS');
		}

		if (conversationId) void resolveDeepLink(conversationId);
	});

	/**
	 * Resolve `/messages/{id}` into a selected conversation.
	 *
	 * Prefers a conversation already in the loaded list — that object came through
	 * the vendored mapper and costs nothing — and falls back to the by-id read.
	 */
	async function resolveDeepLink(id: string) {
		resolution = 'loading';
		resolutionFailure = null;

		const known = dm.conversations.find((conversation) => conversation.id === id);
		if (known) {
			await context.selectConversation(known);
			resolution = 'ready';
			return;
		}

		try {
			const conversation = await binding.loadConversation(id);
			if (!conversation) {
				resolution = 'not-found';
				return;
			}
			await context.selectConversation(conversation);
			resolution = 'ready';
		} catch (error) {
			resolutionFailure = classifyMessagingError(error);
			resolution = 'failed';
		}
	}

	/**
	 * Re-seed pagination whenever the selected conversation changes.
	 *
	 * `selectConversation` fetches the first page through the vendored handler,
	 * which returns messages and drops `pageInfo` — so the cursor has to be
	 * re-read here against the same conversation. Reading it rather than assuming
	 * `hasOlder = true` keeps the control off screen for a thread that has no
	 * older page.
	 */
	$effect(() => {
		const conversation = dm.selectedConversation;
		if (!conversation || conversation.id === pagedConversationId) return;

		pagedConversationId = conversation.id;
		cursor = null;
		hasOlder = false;
		olderError = null;

		void binding
			.loadMessagePage(conversation.id)
			.then((page) => {
				// Guard against a second selection landing first.
				if (pagedConversationId !== conversation.id) return;
				cursor = page.endCursor;
				hasOlder = page.hasNextPage;
				context.updateState({ messages: mergeMessages(dm.messages, page.messages) });
			})
			.catch(() => {
				// The thread already rendered from the handler's own read; a failed
				// cursor probe means only that "load older" cannot be offered.
				if (pagedConversationId === conversation.id) hasOlder = false;
			});
	});

	/** Keep the nav badge in step with the list a reader is looking at. */
	$effect(() => {
		if (dm.folder === 'INBOX') unreadStore.adopt(dm.conversations);
	});

	async function loadOlder() {
		const conversation = dm.selectedConversation;
		if (!conversation || loadingOlder || !hasOlder) return;

		loadingOlder = true;
		olderError = null;
		try {
			const page = await binding.loadMessagePage(conversation.id, cursor);
			cursor = page.endCursor;
			hasOlder = page.hasNextPage;
			// Merged, not prepended: pagination and realtime write to the same list,
			// so the page may contain a message that already arrived over the socket.
			context.updateState({ messages: mergeMessages(dm.messages, page.messages) });
		} catch (error) {
			const kind = classifyMessagingError(error);
			olderError =
				kind === 'auth-required'
					? 'Your session expired while loading older messages.'
					: 'Older messages could not be loaded.';
		} finally {
			loadingOlder = false;
		}
	}

	function onSelect(conversation: Conversation) {
		if (twoPane) {
			void context.selectConversation(conversation);
			return;
		}
		// Below the breakpoint the thread is its own route (§5). lesser performs no
		// SPA fallback under `/l/*`, so this is a real navigation — which is also
		// what makes the browser's back button the back affordance.
		window.location.assign(conversationHref(conversation.id));
	}

	async function onDecline(conversation: Conversation, name: string) {
		try {
			await context.declineMessageRequest(conversation.id);
			declined = { id: conversation.id, name };
		} catch {
			// The context holds the error; the card stays put rather than vanishing.
		}
	}

	async function onSignIn() {
		try {
			await startLogin();
		} catch {
			// The shell's sign-in control reports its own failure.
		}
	}

	const showList = $derived(mode === 'list' || twoPane);
	const showThread = $derived(mode === 'thread' || twoPane);
</script>

<div class="contentus-messages" data-mode={mode} data-two-pane={twoPane ? 'true' : 'false'}>
	{#if showList}
		<section class="contentus-messages__list" aria-label="Conversations">
			<header class="contentus-messages__list-head">
				<h2 class="contentus-messages__list-title">Messages</h2>
				<NewConversation />
			</header>

			<MessagesFolderTabs
				active={dm.folder}
				requestCount={dm.requestCount}
				onSelect={(next) => {
					declined = null;
					void context.fetchConversations(next);
				}}
			/>

			{#if declined}
				<!-- The designed removed-state #33 requires. The context drops a
				     declined conversation from the array, so without this the row
				     would simply be gone and the reader would be left guessing
				     whether the decline was recorded. -->
				<p class="contentus-messages__notice" role="status">
					Request from {declined.name} declined. They cannot message you again unless you start the
					conversation.
				</p>
			{/if}

			{#if failure === 'auth-required'}
				<Panel>
					<h3>Sign in again to read your messages</h3>
					<p>
						This instance did not accept the session this page was using. Messages are private, so
						lesser serves none of them without a current sign-in.
					</p>
					<button type="button" class="contentus-messages__signin" onclick={onSignIn}>
						Sign in on this instance
					</button>
				</Panel>
			{:else if failure}
				<!-- Never a false empty: a read that failed says so, where an empty
				     list would tell a reader with messages that they have none. -->
				<Panel>
					<h3>Conversations could not be loaded</h3>
					<p>This instance did not answer the request for your conversations.</p>
					<button
						type="button"
						class="contentus-messages__retry"
						onclick={() => context.fetchConversations(dm.folder)}
					>
						Try again
					</button>
				</Panel>
			{:else}
				<ConversationList
					conversations={dm.conversations}
					folder={dm.folder}
					loading={dm.loadingConversations}
					busy={dm.loading}
					selectedId={selected?.id ?? null}
					{onSelect}
					onAccept={(conversation) => context.acceptMessageRequest(conversation.id)}
					{onDecline}
				/>
			{/if}
		</section>
	{/if}

	{#if showThread}
		<section class="contentus-messages__thread" aria-label="Conversation">
			{#if mode === 'thread' && !twoPane}
				<!-- The back affordance the pushed route needs (§5). A real link, so
				     it works before hydration and on a cold deep link. -->
				<a class="contentus-messages__back" href={messagesHref(folder)}>
					<span aria-hidden="true">←</span> All conversations
				</a>
			{/if}

			{#if resolution === 'loading'}
				<Panel><p>Opening this conversation…</p></Panel>
			{:else if resolution === 'not-found'}
				<Panel>
					<h3>This conversation is not available</h3>
					<p>
						This instance does not have a conversation with that address, or it is not one this
						account takes part in.
					</p>
					<a class="contentus-messages__back-link" href={messagesHref('inbox')}>Back to messages</a>
				</Panel>
			{:else if resolution === 'failed' && resolutionFailure === 'auth-required'}
				<Panel>
					<h3>Sign in again to open this conversation</h3>
					<p>Messages are private, so lesser serves none of them without a current sign-in.</p>
					<button type="button" class="contentus-messages__signin" onclick={onSignIn}>
						Sign in on this instance
					</button>
				</Panel>
			{:else if resolution === 'failed'}
				<Panel>
					<h3>This conversation could not be opened</h3>
					<p>This instance did not answer the request for it.</p>
					<button
						type="button"
						class="contentus-messages__retry"
						onclick={() => conversationId && resolveDeepLink(conversationId)}
					>
						Try again
					</button>
				</Panel>
			{:else}
				{#if hasOlder}
					<!-- Cursor pagination, owned here because the vendored
					     `onFetchMessages` accepts a cursor and returns no way to
					     obtain one. Deliberately a button rather than a scroll
					     trigger: loading on scroll moves the thread under a reader
					     who was reading it. -->
					<div class="contentus-messages__older">
						<button type="button" onclick={loadOlder} disabled={loadingOlder}>
							{loadingOlder ? 'Loading older messages…' : 'Load older messages'}
						</button>
						{#if olderError}
							<p class="contentus-messages__error" role="alert">{olderError}</p>
						{/if}
					</div>
				{/if}

				<Thread />
				<Composer />
			{/if}
		</section>
	{/if}

	<!--
	ALWAYS RENDERED, never conditional on a state that might not be reached.

	The vendored `Messages.Message` renders `{message.content}` — Svelte's
	ESCAPING interpolation — and lesser's `content` is server-sanitized HTML. So
	every message body displays its own markup as literal text. Same family of
	defect as the `ContentRenderer` gap M4 pinned, in a different component, and
	contentus cannot repair it: vendored source is never hand-edited, an
	`{@html}` in owned source is what check 3 of `audit-renderer-authority.mjs`
	forbids, and the component exposes no prop that changes the sink.

	Disclosed here rather than left for a reader to puzzle over, and pinned by
	`tests/vendored-messaging-render.test.mjs`, which drives the real component
	and fails the day upstream fixes it.
	-->
	<p class="contentus-messages__gap">
		Message bodies are shown as plain text on this build, so any formatting this instance applied
		appears as markup. The text itself is complete and unaltered. This is an upstream gap in the
		vendored message component, not a change contentus makes to what was sent.
	</p>

	{#if realtime !== 'live'}
		<p class="contentus-messages__realtime" role="status" aria-live="polite">
			{#if realtime === 'connecting'}
				Connecting for live messages…
			{:else if realtime === 'requires-auth'}
				Live messages stopped because this session expired. Sign in again to resume.
			{:else if realtime === 'degraded'}
				Live messages are arriving, but something this instance sent could not be read. Reload to be
				sure this thread is complete.
			{:else if realtime === 'unsupported'}
				Live messages are unavailable on this instance. New messages appear when you reload.
			{:else}
				Live messages are not connected. New messages appear when you reload.
			{/if}
		</p>
	{/if}

	{#if partialOperations.length > 0}
		<!-- lesser answered with data AND errors. The data is shown, and the fact
		     that part of the answer failed travels with it rather than being
		     dropped into a page that then asserts completeness. -->
		<p class="contentus-messages__partial" role="status">
			This instance answered part of {partialOperations.length === 1
				? 'a request'
				: 'some requests'} with an error, so something on this screen may be missing.
		</p>
	{/if}
</div>

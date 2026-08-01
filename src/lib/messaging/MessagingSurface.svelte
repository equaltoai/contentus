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

SHARING THAT STATE MEANS RECONCILING IT. The vendored state machine keys nothing
by conversation: `selectConversation` writes whichever `onFetchMessages`
resolves last into one `messages` array, `sendMessage` appends its confirmed
message to whatever is selected when the mutation returns AND stamps that
message onto the selected conversation's list card, and `acceptMessageRequest`
removes a request card whatever request state comes back. On a surface where the
selection changes faster than a read completes, those are not display glitches —
they are one correspondent's words under another's name, and a request that
vanished from the tab that still holds it. Contentus cannot change that source,
so the reconciliations live here, each against evidence rather than assumption:
messages are kept only when they carry the selected `conversationId`, pages are
merged only into the conversation they were requested for, list cards and the
selected summary are restored when a completion files a message under the wrong
conversation, a deep link selects its result only while the reader has not
chosen for themselves (`./selection`), and request cards render the state lesser
RETURNED (`./requests`).

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
	import { realtimeNotice } from './liveness';
	import {
		acceptResolution,
		applyConversation,
		countPendingRequests,
		declineResolution,
		requestNotice,
		withoutConversation,
		type RequestResolution,
	} from './requests';
	import {
		deepLinkVerdict,
		mergeForConversation,
		retainOwnSummaries,
		retainOwnSummary,
		retainSelectedMessages,
		trackSelectionRevisions,
		type OwnSummary,
	} from './selection';
	import {
		classifyMessagingError,
		type MessagingBinding,
		type MessagingCatchUp,
		type MessagingRereadState,
	} from './handlers';
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
		/** Whether a reconnected socket has re-read what it missed. */
		catchUp: MessagingCatchUp;
		/** What happened to the last re-read a realtime event asked for. */
		reread: MessagingRereadState;
		/** Operations that came back with data AND errors. */
		partialOperations: string[];
	}

	let { binding, mode, folder, conversationId, realtime, catchUp, reread, partialOperations }: Props =
		$props();

	const context = getMessagesContext();
	// NOT named `state`: a local by that name shadows the `$state` rune and every
	// rune declaration below silently reads as store access on it.
	const dm = context.state;

	/**
	 * The selection counted as a revision, for the deep-link guard.
	 *
	 * Plain (non-reactive) tracker: it is written by the observing effect below
	 * and read by `resolveDeepLink`, and neither wants a revision bump to
	 * schedule work of its own. What must be reactive is the selection itself,
	 * which already is.
	 */
	const selectionRevisions = trackSelectionRevisions(dm.selectedConversation?.id ?? null);

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
	 * The last accept or decline, and what lesser said about it.
	 *
	 * Held because both outcomes need a sentence: an accepted request LEAVES the
	 * Requests tab, which without this reads as a card that simply vanished — the
	 * silent disappearance #33 rules out — and an accept that came back PENDING
	 * needs to say so, because nothing on screen changed. The notice never
	 * describes the button that was pressed, only the state lesser returned.
	 */
	let requestOutcome = $state<{ name: string; resolution: RequestResolution } | null>(null);

	/** The request card with a mutation in flight; its actions disable together. */
	let resolvingRequest = $state<string | null>(null);

	/**
	 * Requests this reader declined here, which no folder read will mention again.
	 *
	 * The vendored request tracker only forgets an id when a later read carries
	 * the same conversation as non-pending. An ACCEPTED request does come back
	 * that way — in the inbox read below — but a DECLINED one is served in no
	 * folder at all, so its id would sit in the tracker for the life of the page
	 * and the tab would keep advertising a request that is gone.
	 */
	let declinedRequests = $state<string[]>([]);

	const selected = $derived(dm.selectedConversation);
	const failure = $derived(dm.error ? classifyMessagingError(new Error(dm.error)) : null);
	const notice = $derived(realtimeNotice({ socket: realtime, catchUp, reread }));
	const outcomeNotice = $derived(
		requestOutcome ? requestNotice(requestOutcome.resolution, requestOutcome.name) : null
	);

	/**
	 * The Requests badge.
	 *
	 * From the list lesser actually served whenever that list is on screen, and
	 * from the context's own tracker — minus the declines it cannot know about —
	 * when it is not. Never from an assumption that an accept moved something.
	 */
	const requestCount = $derived(
		dm.folder === 'REQUESTS' && !dm.error && !dm.loadingConversations
			? countPendingRequests(dm.conversations)
			: Math.max(0, dm.requestCount - declinedRequests.length)
	);

	/**
	 * Wide enough for two panes.
	 *
	 * `min-width: 961px` rather than 960, because the shell hands the sidebar
	 * over to the tab bar in `@media (max-width: 960px)` — inclusive — and 960
	 * itself is therefore a MOBILE width. A `min-width: 960px` query here would
	 * put the two-pane layout and the mobile chrome on screen together at exactly
	 * that width. The stylesheet's own two-pane rule uses the same 961.
	 */
	const TWO_PANE_QUERY = '(min-width: 961px)';
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

	onMount(() => {
		/**
		 * What a reconnected socket has to re-read before it may be called live.
		 *
		 * Registered here rather than built into the binding because the folder a
		 * reader is looking at and the thread they have open are this component's
		 * state. `conversationUpdates` has no replay: the events published while
		 * the socket was down were never delivered, so the list and the open
		 * thread are the only places the missed messages can come from.
		 *
		 * THROWING IS PART OF THE CONTRACT. `fetchConversations` swallows its own
		 * failure into `state.error`, so a re-read that failed would otherwise
		 * resolve and the binding would report a reconciliation that did not
		 * happen. Reading the error back and throwing is what makes the
		 * "catching up failed" state reachable instead of decorative.
		 */
		binding.setReconciler(async () => {
			await context.fetchConversations(dm.folder, { preserveSelection: true });
			if (dm.error) throw new Error(dm.error);

			const open = dm.selectedConversation;
			if (!open) return;

			const page = await binding.loadMessagePage(open.id);
			const merged = mergeForConversation(
				dm.messages,
				page.messages,
				open.id,
				dm.selectedConversation?.id ?? null
			);
			if (merged) context.updateState({ messages: merged });
		});

		return () => binding.setReconciler(null);
	});

	/**
	 * Every change of the selection is a revision — and some reader intents are
	 * revisions without one.
	 *
	 * THE READER'S OWN CHOICE OUTRANKS THE LINK — and a choice is a CHANGED
	 * selection, not a different one. Opening B and then returning to the id the
	 * link was loading is still two choices, so the guard cannot compare ids: it
	 * counts the changes instead, and `resolveDeepLink` checks the count it
	 * captured at dispatch before every completion. `$effect.pre`, so each change
	 * is counted with the state write itself — including a change that reverts
	 * before any completion lands, which only an observer of every flush can see.
	 *
	 * What this observer CANNOT see is an act that leaves the selected id where
	 * it was: a folder switch on a cold deep link clears an already-null
	 * selection back to null, which reads here as no change at all. Those
	 * intents are stamped explicitly at the handlers the reader's action passes
	 * through — the folder tabs and the list's own select — via
	 * `selectionRevisions.act()`.
	 */
	$effect.pre(() => {
		selectionRevisions.observe(dm.selectedConversation?.id ?? null);
	});

	/**
	 * Resolve `/messages/{id}` into a selected conversation.
	 *
	 * Prefers a conversation already in the loaded list — that object came through
	 * the vendored mapper and costs nothing — and falls back to the by-id read.
	 *
	 * The by-id read is asynchronous, and a reader who picked a conversation from
	 * the list — or switched folder — while it was in flight has CHOSEN. Acting on the late arrival
	 * anyway would move them out of the conversation they opened, or hide it
	 * behind a not-found or failed surface for a link they no longer need — after
	 * they had started reading. So the selection revision is captured at dispatch
	 * and checked before EVERY completion: the found one that would select, and
	 * the missing and failed ones that would take over the thread pane. A stale
	 * completion changes nothing.
	 */
	async function resolveDeepLink(id: string) {
		resolution = 'loading';
		resolutionFailure = null;
		const revisionAtDispatch = selectionRevisions.capture();

		const known = dm.conversations.find((conversation) => conversation.id === id);
		if (known) {
			if (
				deepLinkVerdict(
					selectionRevisions,
					revisionAtDispatch,
					dm.selectedConversation?.id ?? null,
					'found'
				) === 'stale'
			) {
				resolution = 'ready';
				return;
			}
			await context.selectConversation(known);
			resolution = 'ready';
			return;
		}

		try {
			const conversation = await binding.loadConversation(id);
			const verdict = deepLinkVerdict(
				selectionRevisions,
				revisionAtDispatch,
				dm.selectedConversation?.id ?? null,
				conversation ? 'found' : 'missing'
			);
			if (verdict === 'stale') {
				// The reader chose while the link was loading, and the choice stands
				// whichever way the read ended: their conversation stays, and the
				// link's answer — found or missing — changes nothing on screen.
				resolution = 'ready';
				return;
			}
			if (verdict === 'not-found') {
				// A conversation this reader cannot open. Deliberately ONE state for
				// two server answers — an id lesser has never heard of, and one it
				// holds for other people — because telling those apart would answer
				// "does this conversation exist?" for anybody who can type a URL.
				resolution = 'not-found';
				return;
			}
			await context.selectConversation(conversation);
			resolution = 'ready';
		} catch (error) {
			if (
				deepLinkVerdict(
					selectionRevisions,
					revisionAtDispatch,
					dm.selectedConversation?.id ?? null,
					'failed'
				) === 'stale'
			) {
				resolution = 'ready';
				return;
			}
			resolutionFailure = classifyMessagingError(error);
			resolution = 'failed';
		}
	}

	/**
	 * The thread renders only what belongs to the conversation on screen.
	 *
	 * `$effect.pre`, so a foreign message is gone before the DOM is written
	 * rather than after a reader could have read it. This is the guard against
	 * the vendored context's single unkeyed `messages` array: a slow
	 * `conversationMessages` for a conversation the reader has left, or a send
	 * confirmed after they moved on, lands in that array with no record of which
	 * conversation asked. Every message contentus projects carries its
	 * `conversationId`, so the ones that do not belong are identifiable and are
	 * not shown.
	 */
	$effect.pre(() => {
		const selectedId = dm.selectedConversation?.id ?? null;
		const kept = retainSelectedMessages(dm.messages, selectedId);
		// Identity, not length: `retainSelectedMessages` returns the same array
		// when nothing is foreign, so this writes only on a real change and the
		// effect settles instead of looping.
		if (kept !== dm.messages) context.updateState({ messages: kept });
	});

	/**
	 * Every summary stays with the conversation it belongs to.
	 *
	 * THE SEND COMPLETION THE THREAD FILTER CANNOT REACH. The vendored
	 * `sendMessage` writes its confirmed message three times, and only one is into
	 * `state.messages`: it also sets `lastMessage`/`updatedAt` on whichever
	 * conversation is selected when the mutation RETURNS, in the list and on
	 * `selectedConversation`. A send dispatched to A, resolving after the reader
	 * opened B, therefore puts A's words and A's time on B's card — under B's
	 * correspondent's name, in the list, where no message filter applies. The
	 * confirmed message carries the id it was sent to (stamped at dispatch by the
	 * binding's `onSendMessage`), so the misfiling is identifiable: B is restored
	 * to the last summary that named B, and the message is filed under A, where
	 * it was actually sent. See `./selection` for the two repairs.
	 */
	const ownSummaries = new Map<string, OwnSummary>();
	$effect.pre(() => {
		const repaired = retainOwnSummaries(dm.conversations, ownSummaries);
		if (repaired !== dm.conversations) context.updateState({ conversations: repaired });

		const onScreen = dm.selectedConversation;
		if (onScreen) {
			// The same misfiled summary lands on `selectedConversation`, and every
			// later `{ ...selected }` spread carries it forward — so the selected
			// copy is restored too, not only the list's.
			const restored = retainOwnSummary(onScreen, ownSummaries);
			if (restored !== onScreen) context.updateState({ selectedConversation: restored });
		}
	});

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
				const merged = mergeForConversation(
					dm.messages,
					page.messages,
					conversation.id,
					dm.selectedConversation?.id ?? null
				);
				if (!merged) return;

				cursor = page.endCursor;
				hasOlder = page.hasNextPage;
				context.updateState({ messages: merged });
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

	/**
	 * A session lesser has stopped accepting stops the realtime loop.
	 *
	 * The vendored context reconnects on every error with a backoff that resets,
	 * and a socket refused for a credential reason will be refused again for the
	 * same one — so without this an expired session becomes a socket opened every
	 * few seconds forever. The reader is shown the one thing that fixes it.
	 */
	let realtimeStopped = $state(false);
	$effect(() => {
		if (realtimeStopped) return;
		if (realtime !== 'requires-auth' && reread !== 'auth-required') return;
		realtimeStopped = true;
		context.stopRealtime();
	});

	async function loadOlder() {
		const conversation = dm.selectedConversation;
		if (!conversation || loadingOlder || !hasOlder) return;

		const requested = conversation.id;
		loadingOlder = true;
		olderError = null;
		try {
			const page = await binding.loadMessagePage(requested, cursor);
			// The selection can move while a page is in flight. Merged, not
			// prepended: pagination and realtime write to the same list, so the page
			// may contain a message that already arrived over the socket — and
			// merged into the conversation it was REQUESTED for, or dropped, so it
			// can never land in the thread the reader moved to.
			const merged = mergeForConversation(
				dm.messages,
				page.messages,
				requested,
				dm.selectedConversation?.id ?? null
			);
			if (!merged) return;

			cursor = page.endCursor;
			hasOlder = page.hasNextPage;
			context.updateState({ messages: merged });
		} catch (error) {
			if (dm.selectedConversation?.id !== requested) return;
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
		// Stamped explicitly, not left to the id transition: picking a
		// conversation is the reader's act whether or not the id moves, and a
		// deep link still loading must lose to it either way.
		selectionRevisions.act();
		if (twoPane) {
			void context.selectConversation(conversation);
			return;
		}
		// Below the breakpoint the thread is its own route (§5). lesser performs no
		// SPA fallback under `/l/*`, so this is a real navigation — which is also
		// what makes the browser's back button the back affordance.
		window.location.assign(conversationHref(conversation.id));
	}

	/**
	 * Accept, and then believe the answer.
	 *
	 * Deliberately NOT `context.acceptMessageRequest`: that method removes the
	 * card and switches the reader to Inbox whatever request state comes back, so
	 * an accept lesser reports as still PENDING disappears from the only tab that
	 * holds it. This posts the same mutation through the same handler and renders
	 * what lesser returned — including the case where lesser returned "nothing
	 * changed".
	 */
	async function onAccept(conversation: Conversation, name: string) {
		const accept = binding.handlers.onAcceptMessageRequest;
		if (!accept || resolvingRequest) return;

		resolvingRequest = conversation.id;
		requestOutcome = null;
		try {
			const updated = await accept(conversation.id);
			const outcome = acceptResolution(updated);

			// The row takes the RETURNED state, whatever it says. A PENDING answer
			// leaves a card that still looks and behaves like a pending request,
			// because that is what lesser says it is.
			if (updated) {
				context.updateState({ conversations: applyConversation(dm.conversations, updated) });
				if (dm.selectedConversation?.id === conversation.id) {
					context.updateState({
						selectedConversation: { ...dm.selectedConversation, ...updated },
					});
				}
			}

			requestOutcome = { name, resolution: outcome };

			if (outcome.kind === 'accepted') {
				// Server-authoritative removal: the card leaves Requests because
				// lesser stopped listing it there, not because this client moved it.
				await context.fetchConversations(dm.folder, { preserveSelection: true });
				// And the inbox, in the background — which is also what lets the
				// vendored request tracker see this conversation as non-pending and
				// forget it, keeping the badge honest.
				void context.fetchConversations('INBOX', { background: true });
			}
		} catch (error) {
			requestOutcome = {
				name,
				resolution: { kind: 'failed', failure: classifyMessagingError(error) },
			};
		} finally {
			resolvingRequest = null;
		}
	}

	/**
	 * Decline, and remove only what lesser confirmed.
	 *
	 * `declineMessageRequest` returns a boolean and a `false` is a decline that
	 * did NOT happen. The vendored context is careful about that; the previous
	 * version of this surface was not — it announced "Request declined" on any
	 * resolved promise, including the ones that had just told it nothing changed.
	 */
	async function onDecline(conversation: Conversation, name: string) {
		const decline = binding.handlers.onDeclineMessageRequest;
		if (!decline || resolvingRequest) return;

		resolvingRequest = conversation.id;
		requestOutcome = null;
		try {
			const outcome = declineResolution(await decline(conversation.id));
			requestOutcome = { name, resolution: outcome };

			if (outcome.kind === 'declined') {
				context.updateState({
					conversations: withoutConversation(dm.conversations, conversation.id),
				});
				if (dm.selectedConversation?.id === conversation.id) {
					context.updateState({ selectedConversation: null, messages: [] });
				}
				declinedRequests = [...declinedRequests, conversation.id];
			}
		} catch (error) {
			requestOutcome = {
				name,
				resolution: { kind: 'failed', failure: classifyMessagingError(error) },
			};
		} finally {
			resolvingRequest = null;
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
				{requestCount}
				onSelect={(next) => {
					requestOutcome = null;
					// A folder switch is a READER ACT the selected id cannot always
					// show: on a cold deep link the selection is already null, and
					// the vendored clear writes the same null back, so the observer
					// has no transition to count. Stamped explicitly, or a late
					// deep-link completion would open over the folder the reader
					// chose. Only a real change stamps — re-pressing the active tab
					// chooses nothing.
					if (next !== dm.folder) selectionRevisions.act();
					void context.fetchConversations(next);
				}}
			/>

			{#if outcomeNotice}
				<!-- The designed removed-state #33 requires, and the honest one M5's
				     review found missing: a request the instance did NOT accept says
				     so here rather than disappearing from the tab that still holds
				     it. -->
				<p
					class="contentus-messages__notice"
					role={outcomeNotice.tone === 'alert' ? 'alert' : 'status'}
				>
					{outcomeNotice.text}
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
					busy={dm.loading || resolvingRequest !== null}
					selectedId={selected?.id ?? null}
					{onSelect}
					{onAccept}
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

				<!--
				KEYED BY CONVERSATION, and it is the composer's only binding to one.

				The vendored `Composer` holds its draft in component state and clears
				it after a successful send. Nothing in it names a conversation: it
				reads `selectedConversation` at SEND time, so on a wide viewport —
				where selecting is in-place — text typed for one person and left
				unsent is still in the box when the next conversation opens, and the
				next Send delivers it to them. Keying destroys the box with the
				conversation it belonged to, so a draft can only ever be sent where it
				was typed. The cost is that switching away discards an unsent draft;
				retaining one PER conversation needs a prop the component does not
				expose, and that is the ask upstream
				(docs/consumption/messaging-contract.md).
				-->
				{#key selected?.id ?? ''}
					<Composer />
				{/key}
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

	{#if notice}
		<!-- The only state that renders nothing here is a socket that is live, with
		     no gap left by a reconnect and no failed re-read behind it. Everything
		     else is named; see `./liveness`. -->
		<p
			class="contentus-messages__realtime"
			role={notice.tone === 'alert' ? 'alert' : 'status'}
			aria-live="polite"
		>
			{notice.text}
		</p>
		{#if notice.signIn}
			<button type="button" class="contentus-messages__signin" onclick={onSignIn}>
				Sign in on this instance
			</button>
		{/if}
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

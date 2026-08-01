/**
 * Face 5's wiring: the `MessagesHandlers` contract greater's messaging
 * components read, implemented over contentus's transport.
 *
 * WHY NOT `createLesserMessagesHandlers`, WHICH THE MILESTONE NAMES. It was the
 * first thing tried, and it cannot be consumed by this client. Its config type
 * is `{ adapter: LesserGraphQLAdapter }` — the CONCRETE Apollo-bound class, not
 * the structural surface it actually calls — so importing it from
 * contentus-owned source drags `@apollo/client`, `graphql` and
 * `@graphql-typed-document-node/core` into contentus's typecheck graph. Those
 * packages are not installed, and the three ways to make them resolve are all
 * refused here:
 *
 *   - Installing Apollo adds a second GraphQL client to a client that posts one
 *     document per action, and pulls `graphql-ws`, which MOVES the SEC-2
 *     advisory path pinned in
 *     `gov-infra/planning/contentus-disclosed-upstream-findings.json`. M4
 *     weighed that exact trade and declined it.
 *   - Declaring ambient stubs for them would be a fake contract state.
 *   - Suppressing the errors would make contentus's own typecheck gate report
 *     a colour it had not earned.
 *
 * So the handler object is built here, over the same lesser operations, and the
 * COUPLING is routed upstream as the defect it is: an adapter factory that only
 * calls seven methods should accept those seven methods, and every consumer
 * that is not an Apollo application is locked out until it does. See
 * docs/consumption/messaging-contract.md.
 *
 * WHAT IS STILL UPSTREAM'S. The components — `Root`, `Thread`, `Composer`,
 * `Message`, `NewConversation`, and the `createMessagesContext` state machine
 * they share — are greater's, used as they ship. This module implements the
 * interface THEY define (`MessagesHandlers` in
 * `components/messaging/context.svelte.ts`), so the contract between contentus
 * and the suite is upstream's, byte for byte, and a pin bump that changes it
 * fails the typecheck rather than drifting silently.
 */

import type {
	Conversation,
	ConversationFolder,
	DirectMessage,
	MessageParticipant,
	MessagesHandlers,
	MessagesRealtimeCallbacks,
} from '../components/messaging/context.svelte.js';
import { subscriptionEndpoint, type SubscriptionState } from '../timelines/subscription.ts';
import {
	createMessagingAdapter,
	MessagingAuthError,
	MessagingUnavailableError,
	type MessagingAdapter,
} from './adapter.ts';
import {
	folderForRequestState,
	toConversation,
	toDirectMessage,
	toMessagePage,
	toParticipant,
	type MessagePage,
} from './contract.ts';
import { createRereadQueue, REREAD_CONCURRENCY } from './reread-queue.ts';
import { createSessionScope } from './session-scope.ts';

/**
 * How many conversations a folder read asks for.
 *
 * lesser's own default is 20. Face 5 asks for more because `conversations`
 * exposes no cursor — the query accepts `after` but the selection returns a
 * bare list with no `pageInfo` — so this number is the whole list a reader can
 * reach, not the first page of one. Raising it is the only lever the contract
 * offers; the missing pagination is routed upstream rather than papered over
 * with a control that pretends to load more.
 */
export const CONVERSATION_PAGE_SIZE = 50;

/** How many messages a thread page asks for. */
export const MESSAGE_PAGE_SIZE = 50;

/** How many actors the participant picker offers. */
export const PARTICIPANT_SEARCH_LIMIT = 10;

/**
 * What the binding is doing about the gap a dropped socket leaves behind.
 *
 * `conversationUpdates` publishes ids, not messages, so a socket that was down
 * for ten seconds did not deliver a backlog when it came up — the events simply
 * did not happen for this client. The only thing that closes that gap is a
 * RE-READ, and until it finishes the surface has no standing to say "live".
 */
export type MessagingCatchUp =
	/** No gap outstanding: either nothing was missed, or the re-read finished. */
	| 'idle'
	/** The socket is back and the list and open thread are being re-read. */
	| 'catching-up'
	/** The re-read did not complete. The gap is still there and is still named. */
	| 'failed';

/**
 * What happened to the last re-read an event asked for.
 *
 * Separate from the socket's own state because the two fail independently: the
 * stream can be perfectly open while the HTTP session behind the re-reads has
 * expired, and a reader told "live" in that situation is being shown a thread
 * that stopped growing for a reason nobody mentioned.
 */
export type MessagingRereadState = 'idle' | 'failed' | 'auth-required';

export interface MessagingBindingConfig {
	/**
	 * The reader's bearer token, read at CALL time.
	 *
	 * REQUIRED, and deliberately not defaulted to `accessTokenOrNull`. Importing
	 * `$lib/auth/session` here would pull `$app/environment` into this module and
	 * make it unloadable by `node --test`, which is exactly what stops
	 * `tests/messaging-adapters.test.mjs` driving the REAL adapters against a
	 * stubbed `fetch`. Same split, and the same payoff, as
	 * `timelines/transport.ts`: the session belongs to the caller, the network
	 * belongs here. Callers pass `accessTokenOrNull`.
	 */
	accessToken: () => string | null;
	endpoint?: string | null;
	/** Origin the page was served from, used to derive the socket host. */
	origin?: string | null;
	onPartial?: (operation: string) => void;
	onRealtimeState?: (state: SubscriptionState) => void;
	/** The reconciliation state after a reconnect. */
	onCatchUp?: (state: MessagingCatchUp) => void;
	/** The outcome of the re-read an event asked for. */
	onRereadState?: (state: MessagingRereadState) => void;
	/** Injectable for probes. */
	socketFactory?: (url: string, protocols: string | string[]) => WebSocket;
}

export interface MessagingBinding {
	handlers: MessagesHandlers;
	adapter: MessagingAdapter;
	/** One page of a thread, cursor included — the handler interface drops it. */
	loadMessagePage: (conversationId: string, cursor?: string | null) => Promise<MessagePage>;
	/** One conversation by id — the handler interface has no by-id read. */
	loadConversation: (conversationId: string) => Promise<Conversation | null>;
	/**
	 * What to re-read before a reconnected socket may be called live.
	 *
	 * Registered by the surface, because the folder a reader is looking at and
	 * the thread they have open are its state, not the binding's. Passing `null`
	 * unregisters. A binding with no reconciler cannot close a gap, and says so
	 * (`catchUp: 'failed'`) rather than reporting a reconciliation it did not do.
	 */
	setReconciler: (reconcile: (() => Promise<void>) | null) => void;
	/**
	 * Stop everything this binding started, and refuse to start anything else.
	 *
	 * THE SIGN-OUT PATH, and the reason it is here rather than left to component
	 * teardown. `Root` stops the subscription it holds in `onDestroy`, but it
	 * only HOLDS it from a microtask after subscribing, so a teardown landing
	 * first leaves an authorized socket open with nothing left to read it. This
	 * closes the socket synchronously and makes every callback inert, so an event
	 * arriving after the reader signed out reaches nothing.
	 *
	 * AND IT IS NOT ONLY THE SOCKET. Closing the stream ends what is still
	 * ARRIVING; every read already dispatched — the folder, the open thread, a
	 * re-read, and the partial-answer notice any of them can raise — is a promise
	 * still in flight, and it resolves under whatever session is there when it
	 * lands. So teardown also ABORTS those requests and ends the session scope
	 * they were stamped with, and an answer that outlives its session is dropped
	 * rather than published into the next reader's chrome.
	 */
	teardown: () => void;
}

export function createMessagingBinding(config: MessagingBindingConfig): MessagingBinding {
	/**
	 * The session this binding's reads belong to.
	 *
	 * A binding is built per sign-in and torn down at sign-out, so its own
	 * generation is the whole story and no external one is passed. What the scope
	 * buys over the `torn` flag below is that it is stamped at DISPATCH: a read
	 * that was already in flight can be recognised as belonging to the session
	 * that has ended, which a flag read at completion cannot distinguish from a
	 * read that started afterwards.
	 */
	const scope = createSessionScope();
	/**
	 * Cancels the reads still open when the reader signs out.
	 *
	 * Best-effort by nature — a response already parsed is not un-parsed — so the
	 * stamps are what decide correctness. This is what stops the request.
	 */
	const requests = new AbortController();

	/**
	 * A callback the surface registered, silenced once the session ends.
	 *
	 * The partial-read notice is the one that mattered: a folder read that lands
	 * after sign-out still carried lesser's errors, and `onPartial` wrote them
	 * into the page's own state — so a torn-down surface put "part of this request
	 * failed" back on screen for whoever was there next. Every sink the binding
	 * publishes through goes past here; `teardown` calls the raw ones itself,
	 * because the reset is the one announcement that has to survive it.
	 */
	function forSession<T>(sink: ((value: T) => void) | undefined): ((value: T) => void) | undefined {
		if (!sink) return undefined;
		const opened = scope.stamp();
		return (value: T) => {
			if (scope.holds(opened)) sink(value);
		};
	}

	const reportPartial = forSession(config.onPartial);
	const reportRealtime = forSession(config.onRealtimeState);
	const reportCatchUp = forSession(config.onCatchUp);
	const reportReread = forSession(config.onRereadState);

	/**
	 * A read whose answer this session still owns, or no answer at all.
	 *
	 * The stamp is taken BEFORE the request and checked after it, so an answer
	 * that arrives for a session that has ended never reaches the caller — the
	 * conversation list, the thread page and the folder re-read all publish into
	 * shared state the moment they resolve, and none of them re-checks who asked.
	 * Thrown rather than resolved with a placeholder: a caller that survived the
	 * teardown deserves the same "this did not complete" it would get from any
	 * other interrupted read, not an empty list it would render as an empty inbox.
	 */
	async function owned<T>(read: () => Promise<T>): Promise<T> {
		const dispatched = scope.stamp();
		const value = await read();
		if (!scope.holds(dispatched)) {
			throw new MessagingUnavailableError('This session ended before the answer arrived.');
		}
		return value;
	}

	const adapter = createMessagingAdapter({
		accessToken: config.accessToken,
		endpoint: config.endpoint ?? null,
		subscriptionEndpoint: subscriptionEndpoint(config.origin ?? null),
		signal: requests.signal,
		...(reportPartial ? { onPartial: reportPartial } : {}),
		...(reportRealtime ? { onRealtimeState: reportRealtime } : {}),
		...(config.socketFactory ? { socketFactory: config.socketFactory } : {}),
	});

	/** Set by `teardown`. Every realtime path checks it before doing anything. */
	let torn = false;
	/** Every live subscription's stop, so `teardown` can close sockets it never returned. */
	const activeStops = new Set<() => void>();
	/** What the surface wants re-read after a gap. */
	let reconciler: (() => Promise<void>) | null = null;
	/** Whether this binding has ever had a live socket. A second one follows a GAP. */
	let hasBeenLive = false;
	/**
	 * lesser refused this session's credential.
	 *
	 * Latched for the life of the binding, and it is what stops the auto-retry.
	 * The vendored context reconnects on every `error`, and a token lesser has
	 * already rejected will be rejected again — so the retry becomes a socket
	 * opened every twenty seconds to be refused. A new session means a new
	 * binding (sign-in tears this one down), so nothing legitimate is held back.
	 */
	let authRefused = false;

	/**
	 * The re-read the live subscription installed, or null when nothing is
	 * subscribed. Held at BINDING level so the budget below is one budget: the
	 * vendored context re-subscribes on every reconnect, and a queue built inside
	 * each subscription would multiply the cap by however many times the socket
	 * had dropped.
	 */
	let rereadConversation: ((id: string) => Promise<void>) | null = null;

	/**
	 * The global bound on realtime re-reads.
	 *
	 * Per-conversation collapse (inside the subscription) decides WHAT is worth
	 * reading; this decides how many of those may be open at once. Without it a
	 * hundred events naming a hundred DIFFERENT conversations pass every per-id
	 * check and become a hundred concurrent authenticated reads — see
	 * `./reread-queue` for why that shape is ordinary rather than hypothetical.
	 */
	const rereads = createRereadQueue({
		limit: REREAD_CONCURRENCY,
		run: async (id) => {
			await rereadConversation?.(id);
		},
	});

	const handlers: MessagesHandlers = {
		onFetchConversations: async (folder: ConversationFolder = 'INBOX') => {
			const conversations = await owned(() =>
				adapter.fetchConversations(folder, CONVERSATION_PAGE_SIZE)
			);
			// The folder is taken from the REQUEST rather than re-derived per
			// conversation: lesser was asked for this folder and answered with its
			// members, and re-deriving would let one conversation whose request state
			// changed mid-read appear under a tab the reader did not ask for.
			return conversations.map((conversation) => toConversation(conversation, folder));
		},

		onFetchMessages: async (conversationId: string, options) => {
			const connection = await owned(() =>
				adapter.fetchMessages(conversationId, options?.limit ?? MESSAGE_PAGE_SIZE, options?.cursor)
			);
			return toMessagePage(connection, conversationId).messages;
		},

		/**
		 * Send, and stamp the answer with the conversation it was SENT TO.
		 *
		 * `conversationId` is the id the vendored context read off
		 * `selectedConversation` when it dispatched, and it is captured here by
		 * being a parameter — the one piece of this path that cannot drift while
		 * the mutation is in flight. `toDirectMessage` stamps the confirmed message
		 * with it rather than with anything read after the await, so the message
		 * carries the evidence of where it belongs.
		 *
		 * That stamp is load-bearing, because the write that follows this return is
		 * not keyed at all: `sendMessage` appends the message to `state.messages`
		 * AND sets `lastMessage`/`updatedAt` on whichever conversation is selected
		 * when the mutation returns — B's, if the reader moved while it was in
		 * flight. Contentus does not edit that source, so the surface checks the
		 * stamp before paint and puts the message back where it was sent
		 * (`./selection`). Neither guard can run without the stamp being taken here.
		 */
		onSendMessage: async (conversationId: string, content: string, mediaIds?: string[]) => {
			const { message } = await adapter.sendMessage(conversationId, content, mediaIds);
			return toDirectMessage(message, conversationId);
		},

		onCreateConversation: async (participantIds: string[]) => {
			// lesser's `createConversation` takes ONE `participantId`, so DMs are 1:1
			// in v1. Refused before the wire rather than sending the first id and
			// silently dropping the rest — a group the reader thought they had made.
			if (participantIds.length !== 1 || !participantIds[0]) {
				throw new MessagingUnavailableError(
					'This instance supports one-to-one conversations only.'
				);
			}
			const conversation = await adapter.createConversation(participantIds[0]);
			return toConversation(conversation);
		},

		onAcceptMessageRequest: async (conversationId: string) => {
			const conversation = await adapter.acceptMessageRequest(conversationId);
			// The folder comes from the RETURNED request state, not from an
			// assumption that accepting moved it. If lesser says it is still pending,
			// the card stays in Requests and says so.
			return toConversation(
				conversation,
				folderForRequestState(conversation.viewerMetadata.requestState)
			);
		},

		onDeclineMessageRequest: (conversationId: string) =>
			adapter.declineMessageRequest(conversationId),

		onDeleteConversation: (conversationId: string) => adapter.deleteConversation(conversationId),

		onDeleteMessage: (messageId: string) => adapter.deleteMessage(messageId),

		onMarkRead: (conversationId: string) => adapter.markConversationAsRead(conversationId),

		onSearchParticipants: async (query: string): Promise<MessageParticipant[]> => {
			const accounts = await adapter.searchActors(query, PARTICIPANT_SEARCH_LIMIT);
			return accounts.map(toParticipant);
		},

		/**
		 * Realtime, and the one place lesser's contract shapes the UI directly.
		 *
		 * `conversationUpdates` publishes `{ id }` and nothing else — no message,
		 * no request state — so each event is a signal to RE-READ the named
		 * conversation rather than data to render. Three consequences the surface
		 * inherits and cannot paper over, each handled below rather than left to
		 * chance: a burst of messages collapses into one `lastStatus`; the
		 * conversation's own history read is what fills the gap; and a socket that
		 * dropped and came back missed every event in between, so it is not live
		 * until something re-reads what it missed.
		 */
		onSubscribeToConversationUpdates: (callbacks: MessagesRealtimeCallbacks) => {
			if (torn) return () => {};

			if (authRefused) {
				// No socket is opened for a credential lesser has already rejected.
				// The reader is told the one thing that fixes it, and nothing is
				// retried until they do it.
				reportRealtime?.('requires-auth');
				callbacks.onConnectionStatusChange?.('error', new MessagingAuthError().message);
				return () => {};
			}

			let stopped = false;
			const alive = () => !stopped && !torn;

			/**
			 * The re-read an event asks for, installed at BINDING level.
			 *
			 * TWO BOUNDS, AND THEY COMPOSE. Per conversation, an event whose read
			 * is still open is owed exactly one trailing read, issued after it —
			 * so the newest state is always read last and a correspondent typing
			 * quickly collapses to two reads. Across conversations, every read
			 * goes through `rereads`, the one global budget: a hundred events
			 * naming a hundred DIFFERENT conversations pass every per-id check,
			 * and without the queue they became a hundred concurrent
			 * authenticated reads against an instance that had just said it was
			 * busy. The queue lives on the binding rather than in this
			 * subscription because the vendored context re-subscribes on every
			 * reconnect, and a budget rebuilt per subscription would multiply the
			 * cap by however many times the socket had dropped.
			 */
			const performReread = async (id: string) => {
				if (!alive()) return;
				try {
					const conversation = await owned(() => adapter.fetchConversation(id));
					if (!alive()) return;
					reportReread?.('idle');
					// A conversation lesser no longer serves this reader is not an
					// error and not an update; the list already shows what it last
					// said, and inventing a removal here would be this client
					// deciding something lesser is authoritative about.
					if (!conversation) return;

					const uiConversation = toConversation(conversation);
					callbacks.onConversationUpdate({
						conversation: uiConversation,
						// The newly-arrived message, as far as lesser reports one. The
						// context appends it to an OPEN thread and updates the list
						// row; it never scrolls, so a reader mid-thread is not moved.
						...(uiConversation.lastMessage ? { message: uiConversation.lastMessage } : {}),
					});
				} catch (error) {
					if (!alive()) return;
					// NOT swallowed. The socket is open and reporting live, so a
					// re-read that failed silently is the one shape of this failure a
					// reader cannot see: the strip says live and the thread stops
					// growing. An expired session is worse still — it never clears on
					// its own, and the reader is the only one who can fix it.
					if (classifyMessagingError(error) === 'auth-required') {
						authRefused = true;
						reportReread?.('auth-required');
						callbacks.onConnectionStatusChange?.('error', new MessagingAuthError().message);
						return;
					}
					reportReread?.('failed');
				}
			};
			rereadConversation = performReread;

			/**
			 * A socket reporting live, answered honestly.
			 *
			 * The FIRST live connection needs no reconciliation: `Root`'s own fetch
			 * loads the folder as it mounts, and that read is the baseline. Every
			 * live connection after it follows a drop, and the events published
			 * during that drop were never delivered — `conversationUpdates` has no
			 * replay. So the list and the open thread are re-read BEFORE the status
			 * says connected, and while that runs the reader is told what is true:
			 * the connection is back and the gap is being closed.
			 */
			const reportLive = async () => {
				if (!alive()) return;

				if (!hasBeenLive) {
					hasBeenLive = true;
					reportCatchUp?.('idle');
					callbacks.onConnectionStatusChange?.('connected');
					return;
				}

				reportCatchUp?.('catching-up');
				// Deliberately NOT 'connected' yet. The vendored context clears its
				// retry state on `connected` and the surface stops naming the gap, so
				// reporting it here would be advertising a completeness that has not
				// been re-established.
				callbacks.onConnectionStatusChange?.('connecting');

				if (!reconciler) {
					// Nothing registered to re-read with. Saying so beats claiming a
					// reconciliation that did not happen.
					reportCatchUp?.('failed');
					callbacks.onConnectionStatusChange?.('connected');
					return;
				}

				try {
					await reconciler();
					if (!alive()) return;
					reportCatchUp?.('idle');
					callbacks.onConnectionStatusChange?.('connected');
				} catch {
					if (!alive()) return;
					// The socket is live and the gap is not closed. Both halves are
					// reported, because either one alone is a lie.
					reportCatchUp?.('failed');
					callbacks.onConnectionStatusChange?.('connected');
				}
			};

			const stop = adapter.subscribeToConversationUpdates({
				onConversationId: (id) => {
					// The queue, not the read: per-id collapse and the global cap
					// both live there, and the trailing edge is owed either way.
					if (alive()) rereads.enqueue(id);
				},
				onState: (state) => {
					if (!alive()) return;

					// Mapped onto the vendored callback's vocabulary. `requires-auth`
					// keeps its own message so the session-expired path stays legible;
					// M4 established that a reader who cannot tell an expired session
					// from a dropped socket has no idea signing in would fix it.
					if (state === 'live') {
						void reportLive();
					} else if (state === 'connecting') {
						callbacks.onConnectionStatusChange?.('connecting');
					} else if (state === 'requires-auth') {
						// Latched so the context's reconnect finds a closed door rather
						// than opening another socket with the same rejected token.
						authRefused = true;
						callbacks.onConnectionStatusChange?.('error', new MessagingAuthError().message);
					} else if (state === 'unavailable' || state === 'unsupported') {
						callbacks.onConnectionStatusChange?.(
							'error',
							'Live messages are not connected. New messages appear when you reload.'
						);
					} else if (state === 'degraded') {
						callbacks.onConnectionStatusChange?.(
							'connected',
							'Live messages are arriving, but something this instance sent could not be read.'
						);
					}
				},
			});

			activeStops.add(stop);

			return () => {
				stopped = true;
				// Release the binding-level slot only if it is still THIS
				// subscription's read; a reconnect may have installed its own.
				if (rereadConversation === performReread) rereadConversation = null;
				activeStops.delete(stop);
				stop();
			};
		},
	};

	return {
		handlers,
		adapter,

		loadMessagePage: async (conversationId, cursor) => {
			const connection = await owned(() =>
				adapter.fetchMessages(conversationId, MESSAGE_PAGE_SIZE, cursor ?? null)
			);
			return toMessagePage(connection, conversationId);
		},

		loadConversation: async (conversationId) => {
			const conversation = await owned(() => adapter.fetchConversation(conversationId));
			if (!conversation) return null;
			return toConversation(conversation);
		},

		setReconciler: (reconcile) => {
			reconciler = reconcile;
		},

		teardown: () => {
			torn = true;
			reconciler = null;
			rereadConversation = null;
			// BEFORE anything resolves again. Every read already dispatched is
			// stamped with the scope this ends, so a completion landing after the
			// session has gone is dropped rather than published into the next
			// reader's chrome — and the requests behind those completions are
			// cancelled where the transport allows it, which is the half that
			// stops the bytes rather than the publication.
			scope.end();
			requests.abort();
			for (const stop of activeStops) {
				try {
					stop();
				} catch {
					// One socket refusing to close must not leave the next one open.
				}
			}
			activeStops.clear();
			// Reported so a surface still mounted stops claiming a live stream it no
			// longer has. These three go through the RAW sinks on purpose: the
			// session-guarded ones are inert by now, and the reset is the one
			// announcement that has to survive the teardown it reports.
			config.onRealtimeState?.('idle');
			config.onCatchUp?.('idle');
			config.onRereadState?.('idle');
		},
	};
}

/**
 * What a messaging failure should say to a reader.
 *
 * Three outcomes, because there are three different things to do about them:
 * renew the session, wait for the instance, or report something unexpected. The
 * messages context flattens every failure into `state.error` as a STRING, so
 * this is what turns that string back into a state the surface can act on.
 */
export type MessagingFailure = 'auth-required' | 'unavailable' | 'unknown';

export function classifyMessagingError(error: unknown): MessagingFailure {
	if (error instanceof MessagingAuthError) return 'auth-required';
	if (error instanceof MessagingUnavailableError) return 'unavailable';

	// By the time a component sees it the class is gone — the context kept only
	// `error.message`. Matching the text is the only way to keep the sign-in
	// affordance attached to the one failure it fixes.
	const text = error instanceof Error ? error.message : String(error ?? '');
	if (/session has expired|sign in again/i.test(text)) return 'auth-required';
	if (
		/did not answer|could not complete|did not return|did not confirm|did not open|unavailable/i.test(
			text
		)
	) {
		return 'unavailable';
	}
	return 'unknown';
}

export type { DirectMessage, Conversation };

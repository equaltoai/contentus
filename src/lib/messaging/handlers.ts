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
import { accessTokenOrNull } from '../auth/session.ts';
import { resolveBrowserOrigin } from '../cms/origin.ts';
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

export interface MessagingBindingConfig {
	endpoint?: string | null;
	/** Origin the page was served from, used to derive the socket host. */
	origin?: string | null;
	onPartial?: (operation: string) => void;
	onRealtimeState?: (state: SubscriptionState) => void;
	/** Injectable for probes. */
	accessToken?: () => string | null;
	socketFactory?: (url: string, protocols: string | string[]) => WebSocket;
}

export interface MessagingBinding {
	handlers: MessagesHandlers;
	adapter: MessagingAdapter;
	/** One page of a thread, cursor included — the handler interface drops it. */
	loadMessagePage: (conversationId: string, cursor?: string | null) => Promise<MessagePage>;
	/** One conversation by id — the handler interface has no by-id read. */
	loadConversation: (conversationId: string) => Promise<Conversation | null>;
}

export function createMessagingBinding(config: MessagingBindingConfig = {}): MessagingBinding {
	const origin = config.origin ?? resolveBrowserOrigin();

	const adapter = createMessagingAdapter({
		accessToken: config.accessToken ?? accessTokenOrNull,
		endpoint: config.endpoint ?? null,
		subscriptionEndpoint: subscriptionEndpoint(origin),
		...(config.onPartial ? { onPartial: config.onPartial } : {}),
		...(config.onRealtimeState ? { onRealtimeState: config.onRealtimeState } : {}),
		...(config.socketFactory ? { socketFactory: config.socketFactory } : {}),
	});

	const handlers: MessagesHandlers = {
		onFetchConversations: async (folder: ConversationFolder = 'INBOX') => {
			const conversations = await adapter.fetchConversations(folder, CONVERSATION_PAGE_SIZE);
			// The folder is taken from the REQUEST rather than re-derived per
			// conversation: lesser was asked for this folder and answered with its
			// members, and re-deriving would let one conversation whose request state
			// changed mid-read appear under a tab the reader did not ask for.
			return conversations.map((conversation) => toConversation(conversation, folder));
		},

		onFetchMessages: async (conversationId: string, options) => {
			const connection = await adapter.fetchMessages(
				conversationId,
				options?.limit ?? MESSAGE_PAGE_SIZE,
				options?.cursor
			);
			return toMessagePage(connection, conversationId).messages;
		},

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
		 * conversation rather than data to render. Two consequences the surface
		 * inherits and cannot paper over: a burst of messages arriving between two
		 * events collapses into one `lastStatus`, and the conversation's own
		 * history read is what fills the gap.
		 */
		onSubscribeToConversationUpdates: (callbacks: MessagesRealtimeCallbacks) => {
			const stop = adapter.subscribeToConversationUpdates({
				onConversationId: (id) => {
					void adapter
						.fetchConversation(id)
						.then((conversation) => {
							if (!conversation) return;
							const uiConversation = toConversation(conversation);
							callbacks.onConversationUpdate({
								conversation: uiConversation,
								// The newly-arrived message, as far as lesser reports one. The
								// context appends it to an OPEN thread and updates the list
								// row; it never scrolls, so a reader mid-thread is not moved.
								...(uiConversation.lastMessage
									? { message: uiConversation.lastMessage }
									: {}),
							});
						})
						.catch(() => {
							// One event's re-read failed. The socket is still open and the
							// next event will carry the same conversation forward, so this is
							// not a teardown — and the surface already renders the realtime
							// state the adapter reports.
						});
				},
				onState: (state) => {
					// Mapped onto the vendored callback's vocabulary. `requires-auth`
					// keeps its own message so the session-expired path stays legible;
					// M4 established that a reader who cannot tell an expired session
					// from a dropped socket has no idea signing in would fix it.
					if (state === 'live') {
						callbacks.onConnectionStatusChange?.('connected');
					} else if (state === 'connecting') {
						callbacks.onConnectionStatusChange?.('connecting');
					} else if (state === 'requires-auth') {
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

			return stop;
		},
	};

	return {
		handlers,
		adapter,

		loadMessagePage: async (conversationId, cursor) => {
			const connection = await adapter.fetchMessages(
				conversationId,
				MESSAGE_PAGE_SIZE,
				cursor ?? null
			);
			return toMessagePage(connection, conversationId);
		},

		loadConversation: async (conversationId) => {
			const conversation = await adapter.fetchConversation(conversationId);
			if (!conversation) return null;
			return toConversation(conversation);
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
	if (/did not answer|could not complete|did not return|did not confirm|did not open|unavailable/i.test(text)) {
		return 'unavailable';
	}
	return 'unknown';
}

export type { DirectMessage, Conversation };

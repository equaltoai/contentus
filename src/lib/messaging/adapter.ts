/**
 * The network half of face 5: every call contentus makes against lesser's
 * conversation surface, and nothing else.
 *
 * Split from `contract.ts` the way `timelines/transport.ts` is split from
 * `timelines/contract.ts`, and for the same payoff: the token is a parameter
 * here rather than a `sessionStorage` read, so `tests/messaging-adapters.test.mjs`
 * can stub `fetch` at the GraphQL boundary and drive the REAL adapters.
 *
 * WHAT IT REFUSES TO DO. lesser answers a half-failed read with BOTH data and
 * errors, and a read that failed outright with data `null`. greater's own
 * `getConversations` ends `Array.isArray(conversations) ? conversations : []`,
 * so the second case renders "No messages yet" to somebody who has messages.
 * M2d settled that failed and partial reads render unknown/unavailable and
 * never a false empty, so this module THROWS where upstream would return an
 * empty list, and marks a partial read rather than silently presenting it as
 * complete.
 *
 * NO APOLLO, NO SECOND CLIENT. Queries go over `$lib/cms/graphql` — one `fetch`
 * — and the subscription over `$lib/timelines/subscription`, which speaks the
 * `graphql-transport-ws` framing lesser documents. Both choices are M2d's and
 * M4's, unchanged: contentus needs the protocol, not a client library, and
 * declaring `graphql-ws` would move the SEC-2 advisory path pinned in
 * `gov-infra/planning/contentus-disclosed-upstream-findings.json`.
 */

import { graphqlRequest, GraphQLTransportError, type GraphQLError } from '../cms/graphql.ts';
import { subscribe, type SubscriptionState } from '../timelines/subscription.ts';
import {
	ACCEPT_MESSAGE_REQUEST_MUTATION,
	CONVERSATION_MESSAGES_QUERY,
	CONVERSATION_QUERY,
	CONVERSATION_UPDATES_SUBSCRIPTION,
	CONVERSATIONS_QUERY,
	CREATE_CONVERSATION_MUTATION,
	DECLINE_MESSAGE_REQUEST_MUTATION,
	DELETE_CONVERSATION_MUTATION,
	DELETE_MESSAGE_MUTATION,
	MARK_CONVERSATION_READ_MUTATION,
	SEARCH_ACTORS_QUERY,
	SEND_MESSAGE_MUTATION,
} from './queries.ts';
import type { LesserActorSummary, LesserConversation, LesserObject } from './contract.ts';

/** The instance did not answer, or answered with nothing usable. */
export class MessagingUnavailableError extends Error {
	constructor(message = 'This instance did not answer.') {
		super(message);
		this.name = 'MessagingUnavailableError';
	}
}

/**
 * lesser refused for a credential reason.
 *
 * Its own class because it is the one messaging failure with an action attached
 * — sign in again — and a reader who sees "something went wrong" for an expired
 * session is being told to wait for a problem that will never clear on its own.
 */
export class MessagingAuthError extends Error {
	constructor(message = 'Your session has expired. Sign in again to read your messages.') {
		super(message);
		this.name = 'MessagingAuthError';
	}
}

/**
 * Whether lesser's refusal is a credential one.
 *
 * Same vocabulary set as `timelines/subscription`'s `isAuthRefusal`, kept in
 * step deliberately: lesser answers the DM surface and the timeline surface
 * with the same phrases, and two different opinions about what "unauthorized"
 * means would show two different screens for one event.
 */
export function isAuthRefusal(errors: readonly GraphQLError[]): boolean {
	const text = JSON.stringify(errors).toLowerCase();
	return (
		text.includes('authentication required') ||
		text.includes('unauthorized') ||
		text.includes('unauthenticated') ||
		text.includes('access token required') ||
		text.includes('invalid or expired token') ||
		text.includes('not authenticated')
	);
}

export interface MessagingAdapterConfig {
	/**
	 * Read at CALL time, never captured. The session can be replaced between a
	 * conversation list load and the message send that follows it, and an adapter
	 * holding the token it was built with would keep posting the stale one.
	 */
	accessToken: () => string | null;
	/** Absolute endpoint for a server pass; null in the browser uses the relative path. */
	endpoint?: string | null;
	/** `wss://ws.<domain>` for this instance, or null when it cannot be derived. */
	subscriptionEndpoint?: string | null;
	/**
	 * A read that returned data AND errors.
	 *
	 * The objects lesser did return are worth showing, but a surface that shows
	 * them without a marker asserts a completeness lesser never claimed. Same
	 * rule, and the same reason, as `TimelineResult.partial` in M4.
	 */
	onPartial?: (operation: string) => void;
	/** The realtime state as the socket observed it. */
	onRealtimeState?: (state: SubscriptionState) => void;
	/** Injectable for probes; defaults to the platform WebSocket. */
	socketFactory?: (url: string, protocols: string | string[]) => WebSocket;
}

export interface MessageConnection {
	edges?: readonly { cursor?: string | null; node: LesserObject }[] | null;
	pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
	totalCount?: number | null;
}

export interface MessagingAdapter {
	fetchConversations: (folder: string, first: number) => Promise<LesserConversation[]>;
	fetchConversation: (id: string) => Promise<LesserConversation | null>;
	fetchMessages: (
		conversationId: string,
		first: number,
		after?: string | null
	) => Promise<MessageConnection>;
	sendMessage: (
		conversationId: string,
		content: string,
		mediaIds?: string[]
	) => Promise<{ message: LesserObject; conversation: LesserConversation | null }>;
	createConversation: (participantId: string) => Promise<LesserConversation>;
	acceptMessageRequest: (conversationId: string) => Promise<LesserConversation>;
	declineMessageRequest: (conversationId: string) => Promise<boolean>;
	deleteConversation: (conversationId: string) => Promise<boolean>;
	deleteMessage: (messageId: string) => Promise<boolean>;
	markConversationAsRead: (id: string) => Promise<void>;
	searchActors: (query: string, first: number) => Promise<LesserActorSummary[]>;
	subscribeToConversationUpdates: (handlers: {
		onConversationId: (id: string) => void;
		onState: (state: SubscriptionState) => void;
	}) => () => void;
}

export function createMessagingAdapter(config: MessagingAdapterConfig): MessagingAdapter {
	/**
	 * Post one document, or throw the reason there is none.
	 *
	 * The order matters. A credential refusal is checked first even when data
	 * came back, because a partially-authorized response is still a session the
	 * reader has to renew. Then a missing payload throws rather than returning an
	 * empty shape. Only a response that carried its data survives, and if it
	 * carried errors too it is marked partial on the way out.
	 */
	async function run<T>(
		document: string,
		variables: Record<string, unknown>,
		operation: string,
		/**
		 * Whether a data-AND-errors answer for THIS operation may be disclosed as
		 * partial. Defaults to yes; `fetchConversation` is the one caller that
		 * says no, and its reason is at the call site.
		 */
		disclosePartial: (data: T) => boolean = () => true
	): Promise<T> {
		let result: { data: T | null; errors: GraphQLError[] };
		try {
			result = await graphqlRequest<T>(document, variables, {
				endpoint: config.endpoint ?? null,
				accessToken: config.accessToken(),
			});
		} catch (cause) {
			// The instance was not reached at all. A different screen from a refusal,
			// and collapsing the two would offer "sign in again" to a reader whose
			// network dropped.
			if (cause instanceof GraphQLTransportError) throw new MessagingUnavailableError();
			throw cause;
		}

		if (result.errors.length > 0 && isAuthRefusal(result.errors)) throw new MessagingAuthError();
		if (result.data === null || result.data === undefined) {
			throw new MessagingUnavailableError(`This instance could not complete ${operation}.`);
		}
		if (result.errors.length > 0 && disclosePartial(result.data)) config.onPartial?.(operation);

		return result.data;
	}

	return {
		fetchConversations: async (folder, first) => {
			const data = await run<{ conversations?: LesserConversation[] | null }>(
				CONVERSATIONS_QUERY,
				{ folder, first },
				'the conversation list'
			);
			// Where greater returns `[]`. A list that is ABSENT is not a list that is
			// EMPTY, and only one of those is safe to render as "no messages".
			if (!Array.isArray(data.conversations)) {
				throw new MessagingUnavailableError('This instance did not return a conversation list.');
			}
			return data.conversations;
		},

		/**
		 * One conversation by id, and the ONE read on this surface that must not
		 * tell the caller which kind of "no" it got.
		 *
		 * lesser answers a conversation this reader may not see and a conversation
		 * that does not exist with two DIFFERENT envelopes: a missing id is a clean
		 * `{ conversation: null }`, while an id that exists and belongs to other
		 * people is `{ conversation: null }` PLUS a participant error
		 * (`graph/query_resolvers_conversations.go`). No body leaks either way —
		 * but the difference between the two is an oracle: anybody who can type a
		 * URL could ask "does this conversation exist?" and read the answer off the
		 * partial-read notice, one guessed id at a time.
		 *
		 * So the partial signal is suppressed for a null conversation, and both
		 * answers reach the surface as the same value, on the same path, in the
		 * same one round trip: `null`, rendered as one "this conversation is not
		 * available" state. A partial answer that DID carry a conversation is still
		 * disclosed — the reader can see it, so it says nothing they do not have.
		 *
		 * The error-shape difference itself is lesser's to fix and is routed
		 * upstream (docs/consumption/messaging-contract.md); this is contentus
		 * declining to relay it.
		 */
		fetchConversation: async (id) => {
			const data = await run<{ conversation?: LesserConversation | null }>(
				CONVERSATION_QUERY,
				{ id },
				'this conversation',
				(payload) => Boolean(payload.conversation)
			);
			return data.conversation ?? null;
		},

		fetchMessages: async (conversationId, first, after) => {
			const data = await run<{ conversationMessages?: MessageConnection | null }>(
				CONVERSATION_MESSAGES_QUERY,
				{ conversationId, first, after: after ?? null },
				'these messages'
			);
			if (!data.conversationMessages) {
				throw new MessagingUnavailableError('This instance did not return the message history.');
			}
			return data.conversationMessages;
		},

		sendMessage: async (conversationId, content, mediaIds) => {
			const data = await run<{
				sendMessage?: { message?: LesserObject | null; conversation?: LesserConversation | null };
			}>(
				SEND_MESSAGE_MUTATION,
				{
					conversationId,
					content,
					// Omitted rather than sent empty: `[]` and "no attachments" are not
					// obviously the same thing to a server, and only one of them is what
					// a plain text message means.
					mediaIds: mediaIds && mediaIds.length > 0 ? mediaIds : null,
				},
				'sending this message'
			);

			const message = data.sendMessage?.message;
			// A send whose message did not come back is NOT reported as sent. The
			// composer would clear the box on a resolved promise, and a reader whose
			// message vanished from the input and never appeared in the thread has
			// been told it was delivered by the UI moving on.
			if (!message) {
				throw new MessagingUnavailableError('This instance did not confirm the message was sent.');
			}
			return { message, conversation: data.sendMessage?.conversation ?? null };
		},

		createConversation: async (participantId) => {
			const data = await run<{ createConversation?: LesserConversation | null }>(
				CREATE_CONVERSATION_MUTATION,
				{ participantId },
				'starting this conversation'
			);
			if (!data.createConversation) {
				throw new MessagingUnavailableError('This instance did not open the conversation.');
			}
			return data.createConversation;
		},

		acceptMessageRequest: async (conversationId) => {
			const data = await run<{ acceptMessageRequest?: LesserConversation | null }>(
				ACCEPT_MESSAGE_REQUEST_MUTATION,
				{ conversationId },
				'accepting this request'
			);
			// Accept must return the conversation carrying its NEW request state.
			// Without it the surface would have to assume the accept worked and move
			// the card itself — inferring request state instead of reading it.
			if (!data.acceptMessageRequest) {
				throw new MessagingUnavailableError(
					'This instance did not confirm the request was accepted.'
				);
			}
			return data.acceptMessageRequest;
		},

		declineMessageRequest: async (conversationId) => {
			const data = await run<{ declineMessageRequest?: boolean | null }>(
				DECLINE_MESSAGE_REQUEST_MUTATION,
				{ conversationId },
				'declining this request'
			);
			// Only an explicit `true` is a decline. Anything else leaves the card in
			// place rather than removing a request lesser may still be holding.
			return data.declineMessageRequest === true;
		},

		deleteConversation: async (conversationId) => {
			const data = await run<{ deleteConversation?: boolean | null }>(
				DELETE_CONVERSATION_MUTATION,
				{ conversationId },
				'deleting this conversation'
			);
			return data.deleteConversation === true;
		},

		deleteMessage: async (messageId) => {
			const data = await run<{ deleteMessage?: boolean | null }>(
				DELETE_MESSAGE_MUTATION,
				{ messageId },
				'deleting this message'
			);
			return data.deleteMessage === true;
		},

		markConversationAsRead: async (id) => {
			await run<{ markConversationAsRead?: unknown }>(
				MARK_CONVERSATION_READ_MUTATION,
				{ id },
				'the read receipt'
			);
		},

		searchActors: async (query, first) => {
			const data = await run<{ search?: { accounts?: LesserActorSummary[] | null } | null }>(
				SEARCH_ACTORS_QUERY,
				{ query, type: 'accounts', first },
				'this search'
			);
			const accounts = data.search?.accounts;
			// An absent list is not "nobody matched": the picker would report "no
			// users found" for a search that never ran.
			if (!Array.isArray(accounts)) {
				throw new MessagingUnavailableError('This instance did not return search results.');
			}
			return accounts;
		},

		subscribeToConversationUpdates: ({ onConversationId, onState }) => {
			const endpoint = config.subscriptionEndpoint ?? null;
			if (!endpoint) {
				// No socket is possible, and saying so immediately beats a status that
				// sits on "connecting" forever.
				onState('unsupported');
				config.onRealtimeState?.('unsupported');
				return () => {};
			}

			return subscribe<{ conversationUpdates?: { id?: string } | null }>({
				endpoint,
				query: CONVERSATION_UPDATES_SUBSCRIPTION,
				accessToken: config.accessToken(),
				...(config.socketFactory ? { socketFactory: config.socketFactory } : {}),
				onData: (data) => {
					const id = data?.conversationUpdates?.id;
					if (id) onConversationId(id);
				},
				onState: (state) => {
					config.onRealtimeState?.(state);
					onState(state);
				},
			});
		},
	};
}

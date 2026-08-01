/**
 * Every GraphQL document contentus sends against lesser's conversation surface,
 * and nothing else.
 *
 * WRITTEN HERE RATHER THAN IMPORTED FROM THE VENDORED TREE, and the reason is a
 * hard constraint rather than a preference. greater's generated documents live
 * in `src/lib/greater/adapters/graphql/generated/types.ts`, whose type surface
 * reaches `@graphql-typed-document-node/core`, `graphql` and `@apollo/client` —
 * packages contentus does not install, because installing Apollo to consume a
 * document AST would add a second GraphQL client and move the SEC-2 advisory
 * path M4 pinned. Importing them from owned source turns contentus's own
 * typecheck red on upstream files it is not allowed to edit. The two ways out
 * of that — declaring fake ambient modules, or adding Apollo — are both refused
 * (`AGENTS.md`: no fake contract states, no perturbing a pinned advisory graph
 * for a type-only need), so the documents are authored here.
 *
 * That is the same call `$lib/timelines/contract` makes for face 4's
 * `TIMELINE_QUERY`, and it has the same upside: these select exactly what
 * contentus renders. greater's `ObjectFields` fragment carries poll state,
 * quote context and community notes that the messaging components never read,
 * and asking lesser for fields nothing displays is a cost paid on every
 * conversation load.
 *
 * DRIFT IS PINNED, NOT TRUSTED. `tests/messaging-queries.test.mjs` parses the
 * VENDORED documents — a probe may import them freely, since probes are outside
 * the typecheck graph — and asserts that every operation name, argument and
 * variable type below matches upstream's, and that every field the mappers in
 * `contract.ts` read is selected. A pin bump that renames an argument fails
 * there rather than at runtime on somebody's instance.
 *
 * The coupling itself is routed upstream: `createLesserMessagesHandlers` should
 * accept the structural interface it actually calls rather than the concrete
 * Apollo-bound `LesserGraphQLAdapter`. See docs/consumption/messaging-contract.md.
 */

/**
 * The participant fields a conversation card and a message bubble read.
 *
 * `domain` is load-bearing rather than decorative: it is what distinguishes a
 * local actor — whose conversation mutations are keyed by bare username — from
 * a remote one keyed by full actor id. See `canonicalParticipantId`.
 */
const ACTOR_FIELDS = `
	id
	username
	domain
	displayName
	avatar
`;

/**
 * The message fields the thread renders.
 *
 * `content` is lesser's server-sanitized HTML and is requested as-is: the
 * server is the renderer, and there is no client-side transform of it anywhere
 * in contentus. `sensitive` and `spoilerText` come along because the components
 * hide a body behind a content warning, and a message whose warning did not
 * load would show the body it was meant to cover.
 */
const MESSAGE_FIELDS = `
	id
	content
	createdAt
	sensitive
	spoilerText
	actor { ${ACTOR_FIELDS} }
	attachments {
		url
		type
		preview
		description
	}
`;

/**
 * The conversation fields every conversation-shaped response selects.
 *
 * `viewerMetadata` is the whole request contract — `requestState` decides the
 * folder, the card's actions and whether the composer is writable — so it is
 * selected everywhere a conversation is returned, including from the mutations.
 * A mutation that answered without it would leave the surface inferring request
 * state from the operation it just ran, which is the inference #33 rules out.
 */
const CONVERSATION_FIELDS = `
	id
	unread
	createdAt
	updatedAt
	viewerMetadata {
		requestState
		requestedAt
		acceptedAt
		declinedAt
	}
	accounts { ${ACTOR_FIELDS} }
	lastStatus { ${MESSAGE_FIELDS} }
`;

/**
 * One folder's conversations.
 *
 * `after` is accepted by lesser and deliberately NOT sent: `conversations`
 * returns a bare list with no `pageInfo` and no per-edge cursor, so there is no
 * cursor a client could obtain to pass back. `first` is therefore the whole
 * list a reader can reach rather than the first page of one. Routed upstream as
 * an ask for a proper connection.
 */
export const CONVERSATIONS_QUERY = `
	query ContentusConversations($folder: ConversationFolder, $first: Int) {
		conversations(folder: $folder, first: $first) {
			${CONVERSATION_FIELDS}
		}
	}
`;

/** One conversation by id — what `/messages/{conversationId}` resolves against. */
export const CONVERSATION_QUERY = `
	query ContentusConversation($id: ID!) {
		conversation(id: $id) {
			${CONVERSATION_FIELDS}
		}
	}
`;

/**
 * One page of a conversation's messages.
 *
 * A real connection, unlike `conversations`: `pageInfo.endCursor` and
 * `hasNextPage` are both selected, which is what makes the thread's "load older
 * messages" control possible at all.
 */
export const CONVERSATION_MESSAGES_QUERY = `
	query ContentusConversationMessages($conversationId: ID!, $first: Int, $after: Cursor) {
		conversationMessages(conversationId: $conversationId, first: $first, after: $after) {
			edges {
				cursor
				node { ${MESSAGE_FIELDS} }
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

/** Send one message. Returns the message AND the conversation it changed. */
export const SEND_MESSAGE_MUTATION = `
	mutation ContentusSendMessage($conversationId: ID!, $content: String!, $mediaIds: [ID!]) {
		sendMessage(conversationId: $conversationId, content: $content, mediaIds: $mediaIds) {
			message { ${MESSAGE_FIELDS} }
			conversation {
				${CONVERSATION_FIELDS}
			}
		}
	}
`;

/**
 * Open a conversation with one participant.
 *
 * `participantId` is singular in lesser's contract, so DMs are 1:1 in v1. The
 * binding refuses a multi-participant request before the wire rather than
 * sending the first id and quietly dropping the rest.
 */
export const CREATE_CONVERSATION_MUTATION = `
	mutation ContentusCreateConversation($participantId: ID!) {
		createConversation(participantId: $participantId) {
			${CONVERSATION_FIELDS}
		}
	}
`;

/** Accept a request. Returns the conversation, now carrying its new request state. */
export const ACCEPT_MESSAGE_REQUEST_MUTATION = `
	mutation ContentusAcceptMessageRequest($conversationId: ID!) {
		acceptMessageRequest(conversationId: $conversationId) {
			${CONVERSATION_FIELDS}
		}
	}
`;

/** Decline a request. Returns a bare Boolean — there is no conversation left to read. */
export const DECLINE_MESSAGE_REQUEST_MUTATION = `
	mutation ContentusDeclineMessageRequest($conversationId: ID!) {
		declineMessageRequest(conversationId: $conversationId)
	}
`;

export const DELETE_CONVERSATION_MUTATION = `
	mutation ContentusDeleteConversation($conversationId: ID!) {
		deleteConversation(conversationId: $conversationId)
	}
`;

export const DELETE_MESSAGE_MUTATION = `
	mutation ContentusDeleteMessage($messageId: ID!) {
		deleteMessage(messageId: $messageId)
	}
`;

/** Mark a conversation read. Returns the conversation's new `unread` state. */
export const MARK_CONVERSATION_READ_MUTATION = `
	mutation ContentusMarkConversationAsRead($id: ID!) {
		markConversationAsRead(id: $id) {
			id
			unread
			updatedAt
		}
	}
`;

/**
 * Actor search, for starting a new conversation.
 *
 * Only `accounts` is selected. greater's document also asks for `statuses` and
 * `hashtags`, which the participant picker never reads — three result sets
 * fetched to display one.
 */
export const SEARCH_ACTORS_QUERY = `
	query ContentusSearchActors($query: String!, $type: String, $first: Int) {
		search(query: $query, type: $type, first: $first) {
			accounts { ${ACTOR_FIELDS} }
		}
	}
`;

/**
 * Realtime conversation updates.
 *
 * lesser publishes only `{ id }` — no message payload, no request state — so
 * every event is a signal to re-read rather than data to render. That shape is
 * why the binding re-fetches the named conversation on each event, and why a
 * burst of messages between two events collapses into one `lastStatus`; the
 * thread's own history read is what fills the gap. Recorded in
 * docs/consumption/messaging-contract.md.
 */
export const CONVERSATION_UPDATES_SUBSCRIPTION = `
	subscription ContentusConversationUpdates {
		conversationUpdates {
			id
		}
	}
`;

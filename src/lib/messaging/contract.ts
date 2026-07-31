/**
 * lesser's conversation contract, projected into the shape greater's messaging
 * components read.
 *
 * WHY THIS EXISTS WHEN `createLesserMessagesHandlers` ALREADY MAPS. The
 * vendored handler is used for everything it can serve, and this module covers
 * exactly the two things its interface cannot express — both of which face 5
 * needs and neither of which is a contentus preference:
 *
 *   1. **A conversation by id.** `MessagesHandlers` has `onFetchConversations`
 *      (a folder at a time) and nothing that resolves ONE conversation. Face 5
 *      routes the thread as its own address — `/messages/{conversationId}`,
 *      which product design §5 requires for the mobile two-pane collapse — so a
 *      cold deep link has an id and no list. Walking the list instead is not a
 *      substitute: `conversations` takes an `after: Cursor` argument but
 *      returns a BARE LIST with no cursor or `pageInfo` anywhere in the
 *      selection, so there is no second page to walk to.
 *
 *   2. **A page of messages with its cursor.** `onFetchMessages` accepts a
 *      cursor and returns `DirectMessage[]`, discarding `pageInfo.endCursor`
 *      and `hasNextPage` — so the caller can pass a cursor it has no way to
 *      obtain. `conversationMessages` IS a proper connection; #34's cursor
 *      pagination is unreachable through the vendored handler alone.
 *
 * Both are routed upstream (docs/consumption/messaging-contract.md). Until they
 * land, these projections mirror the vendored mapper's decisions EXACTLY —
 * participant id canonicalization, handle construction, folder derivation from
 * `viewerMetadata.requestState`, the `unread` boolean flattened the same way —
 * and `tests/messaging-contract.test.mjs` drives the REAL vendored handler and
 * these functions over one identical payload and asserts they agree field for
 * field. A pin bump that changes upstream's mapping fails that probe rather
 * than silently giving contentus two behaviours for one contract.
 */

import type {
	Conversation,
	ConversationFolder,
	DirectMessage,
	DmRequestState,
	MessageParticipant,
} from '../components/messaging/context.svelte.js';

/** lesser's `ActorSummary`, as much of it as a participant needs. */
export interface LesserActorSummary {
	id: string;
	username: string;
	domain?: string | null;
	displayName?: string | null;
	avatar?: string | null;
}

/** lesser's `Object`, as much of it as a message needs. */
export interface LesserObject {
	id: string;
	actor: LesserActorSummary;
	content: string;
	createdAt: string;
	sensitive?: boolean;
	spoilerText?: string | null;
	attachments?: readonly {
		url: string;
		type: string;
		preview?: string | null;
		description?: string | null;
	}[];
}

export interface LesserConversation {
	id: string;
	unread: boolean;
	updatedAt: string;
	accounts: readonly LesserActorSummary[];
	lastStatus?: LesserObject | null;
	viewerMetadata: {
		requestState: DmRequestState;
		requestedAt?: string | null;
		acceptedAt?: string | null;
		declinedAt?: string | null;
	};
}

/**
 * The id lesser's conversation MUTATIONS take for a participant.
 *
 * Mirrors greater's `getCanonicalParticipantId`. A remote actor is named by its
 * full actor id; a local one whose id is `/users/<username>` is named by the
 * bare username, because that is what lesser's mutation resolvers match. The
 * original id is kept alongside as `actorId` so own-message detection still
 * works against a session that holds either representation.
 */
export function canonicalParticipantId(actor: LesserActorSummary): string {
	if (actor.domain) return actor.id;

	const localUserPath = /^\/users\/([^/]+)\/?$/;
	const direct = actor.id.match(localUserPath);
	if (direct?.[1] === actor.username) return actor.username;

	try {
		const url = new URL(actor.id);
		const fromUrl = url.pathname.match(localUserPath);
		if (fromUrl?.[1] === actor.username) return actor.username;
	} catch {
		// Not a URL; fall through to the original identifier.
	}

	return actor.id;
}

export function participantHandle(actor: LesserActorSummary): string {
	return actor.domain ? `${actor.username}@${actor.domain}` : actor.username;
}

export function toParticipant(actor: LesserActorSummary): MessageParticipant {
	return {
		id: canonicalParticipantId(actor),
		actorId: actor.id,
		username: actor.username,
		displayName: actor.displayName ?? actor.username,
		avatar: actor.avatar ?? undefined,
		handle: participantHandle(actor),
	};
}

/**
 * An object becomes a message.
 *
 * `read: true` is upstream's choice and is mirrored rather than corrected.
 * lesser tracks read state on the CONVERSATION (`unread: Boolean`) and exposes
 * nothing per message, so any other value would be this client inventing a
 * receipt lesser never issued. `content` is passed through untouched: it is
 * lesser's server-sanitized HTML and rendering is the server's authority.
 */
export function toDirectMessage(object: LesserObject, conversationId: string): DirectMessage {
	return {
		id: object.id,
		conversationId,
		sender: toParticipant(object.actor),
		content: object.content,
		createdAt: object.createdAt,
		read: true,
		sensitive: object.sensitive,
		spoilerText: object.spoilerText ?? null,
		mediaAttachments: (object.attachments ?? []).map((attachment) => ({
			url: attachment.url,
			type: attachment.type,
			previewUrl: attachment.preview ?? undefined,
			description: attachment.description ?? undefined,
		})),
	};
}

/**
 * Which folder a conversation belongs to, from `viewerMetadata.requestState`.
 *
 * `PENDING` is Requests and everything else is Inbox. Derived here in ONE place
 * so no surface infers folder membership from anything else — a decline that
 * has not yet round-tripped, a missing participant, an empty message list. The
 * brief is explicit that request state renders from `viewerMetadata.requestState`
 * only, and a single derivation is how that stays true.
 */
export function folderForRequestState(requestState: DmRequestState): ConversationFolder {
	return requestState === 'PENDING' ? 'REQUESTS' : 'INBOX';
}

/**
 * A conversation, in the shape the components read.
 *
 * `unreadCount: unread ? 1 : 0` mirrors greater exactly, and it is worth being
 * explicit about what that number is NOT. lesser's `conversations` selection
 * carries `unread: Boolean` — there is no per-conversation message count in the
 * contract — so the 1 means "this conversation has unread activity", not "one
 * unread message". Every contentus surface that shows a total therefore counts
 * CONVERSATIONS and says so in its label; see `unreadConversationCount`.
 */
export function toConversation(
	conversation: LesserConversation,
	folder: ConversationFolder = folderForRequestState(conversation.viewerMetadata.requestState)
): Conversation {
	return {
		id: conversation.id,
		folder,
		requestState: conversation.viewerMetadata.requestState,
		requestedAt: conversation.viewerMetadata.requestedAt ?? null,
		acceptedAt: conversation.viewerMetadata.acceptedAt ?? null,
		declinedAt: conversation.viewerMetadata.declinedAt ?? null,
		participants: conversation.accounts.map(toParticipant),
		lastMessage: conversation.lastStatus
			? toDirectMessage(conversation.lastStatus, conversation.id)
			: undefined,
		unreadCount: conversation.unread ? 1 : 0,
		updatedAt: conversation.updatedAt,
	};
}

/** One page of a conversation's messages, cursor included. */
export interface MessagePage {
	messages: DirectMessage[];
	endCursor: string | null;
	hasNextPage: boolean;
	/** lesser's `totalCount` for the conversation, or null when it did not say. */
	totalCount: number | null;
}

interface LesserMessageConnection {
	edges?: readonly { cursor?: string | null; node: LesserObject }[] | null;
	pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
	totalCount?: number | null;
}

/**
 * Project `conversationMessages` into a page.
 *
 * ORDER IS IMPOSED, NOT ASSUMED. lesser's schema does not state the edge order
 * of `conversationMessages`, and the components render `state.messages` in array
 * order with newly sent messages appended — so a descending page would render a
 * thread upside down and put a reply above the message it answers. Sorting by
 * `createdAt` ascending makes the rendered order correct under either server
 * order rather than betting on one. It reorders nothing else: ties keep the
 * order lesser returned them in, which is the only tiebreak the client has any
 * standing to apply.
 */
export function toMessagePage(connection: unknown, conversationId: string): MessagePage {
	const source = (connection ?? {}) as LesserMessageConnection;
	const edges = Array.isArray(source.edges) ? source.edges : [];

	const messages = edges
		.map((edge, index) => ({ index, message: toDirectMessage(edge.node, conversationId) }))
		.sort((a, b) => {
			const byTime = a.message.createdAt.localeCompare(b.message.createdAt);
			return byTime !== 0 ? byTime : a.index - b.index;
		})
		.map((entry) => entry.message);

	return {
		messages,
		endCursor: source.pageInfo?.endCursor ?? null,
		hasNextPage: source.pageInfo?.hasNextPage === true,
		totalCount: typeof source.totalCount === 'number' ? source.totalCount : null,
	};
}

/**
 * Merge an older page into a thread without duplicating or reordering.
 *
 * Pagination and realtime write to the same list, so the same message can
 * arrive twice — once from a `conversationUpdates` event and once from the page
 * that contains it. De-duplicating by id and re-sorting keeps one copy in the
 * right place instead of showing the message twice.
 */
export function mergeMessages(
	existing: readonly DirectMessage[],
	incoming: readonly DirectMessage[]
): DirectMessage[] {
	const byId = new Map<string, DirectMessage>();
	for (const message of [...existing, ...incoming]) byId.set(message.id, message);

	return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * How many conversations carry unread activity.
 *
 * NOT a message count, and the name says so because the number reaches the nav
 * badge. lesser gives one boolean per conversation, so a badge reading "3"
 * means three conversations have something new — claiming three unread MESSAGES
 * would be a number contentus made up. greater's own `UnreadIndicator` sums the
 * same values under an `aria-label` that says "N unread messages"; contentus
 * labels its own badge honestly and that mislabel is routed upstream.
 */
export function unreadConversationCount(conversations: readonly Conversation[]): number {
	return conversations.reduce((total, conversation) => total + (conversation.unreadCount > 0 ? 1 : 0), 0);
}

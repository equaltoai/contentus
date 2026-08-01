/**
 * What lesser said about a message request, and what the reader is told.
 *
 * REQUEST STATE IS READ, NEVER INFERRED — the rule `ConversationList.svelte`
 * states and this module enforces at the one point it was still being broken.
 * `acceptMessageRequest` returns the conversation carrying its NEW
 * `viewerMetadata.requestState`, and lesser is entitled to answer PENDING: an
 * accept it recorded but has not completed, a request already withdrawn, a
 * federated peer that has not confirmed. The vendored context does not read that
 * answer — `acceptMessageRequest` removes the card and moves the reader to Inbox
 * whatever comes back — so a request that is still pending on the instance
 * disappears from the tab that is supposed to hold it. The next load brings it
 * back, and the reader is left to work out which screen was lying.
 *
 * So the surface resolves accept and decline through the BINDING's handlers,
 * turns the answer into one of the outcomes below, and renders that. Nothing
 * here decides an outcome from the absence of an error: `decline` is confirmed
 * by an explicit `true` and by nothing else, and `accept` is confirmed by a
 * returned `ACCEPTED` and by nothing else.
 *
 * Plain functions over plain data, driven directly by
 * `tests/messaging-adapters.test.mjs` against the REAL handler output.
 */

import type { Conversation, DmRequestState } from '../components/messaging/context.svelte.js';
import type { MessagingFailure } from './handlers.ts';

export type RequestResolution =
	/** lesser returned ACCEPTED. The conversation has moved and the card may go. */
	| { kind: 'accepted' }
	/** lesser returned something else. The card stays, saying what lesser said. */
	| { kind: 'unchanged'; state: DmRequestState }
	/** `declineMessageRequest` returned an explicit true. */
	| { kind: 'declined' }
	/** It did not. Nothing is removed for a decline lesser never confirmed. */
	| { kind: 'not-declined' }
	/** The call failed. The request is in whatever state it was already in. */
	| { kind: 'failed'; failure: MessagingFailure };

/**
 * The outcome of an accept, read from the conversation lesser returned.
 *
 * A missing conversation is a failure rather than an acceptance: the adapter
 * already throws when `acceptMessageRequest` returns nothing, so reaching here
 * with nothing means a handler that resolved without an answer, and treating
 * that as success is exactly the inference this module refuses.
 */
export function acceptResolution(returned: Conversation | null | undefined): RequestResolution {
	const state = returned?.requestState;
	if (!state) return { kind: 'failed', failure: 'unavailable' };
	return state === 'ACCEPTED' ? { kind: 'accepted' } : { kind: 'unchanged', state };
}

/** The outcome of a decline. Only an explicit `true` removes anything. */
export function declineResolution(confirmed: boolean | undefined): RequestResolution {
	return confirmed === true ? { kind: 'declined' } : { kind: 'not-declined' };
}

/** Whether the outcome means lesser has resolved the request one way or another. */
export function isResolved(resolution: RequestResolution): boolean {
	return resolution.kind === 'accepted' || resolution.kind === 'declined';
}

export interface RequestNotice {
	text: string;
	/** `alert` for the outcomes that need a reader to do something. */
	tone: 'status' | 'alert';
}

/**
 * What to tell the reader, in the words the outcome actually supports.
 *
 * Every string here names the state lesser reported, not the action the reader
 * took. "Accepted" is only ever said about an ACCEPTED that came back.
 */
export function requestNotice(resolution: RequestResolution, name: string): RequestNotice {
	switch (resolution.kind) {
		case 'accepted':
			return { tone: 'status', text: `Request from ${name} accepted. It is now in your inbox.` };
		case 'unchanged':
			return resolution.state === 'DECLINED'
				? {
						tone: 'alert',
						text: `This instance reports the request from ${name} as declined, so it was not accepted.`,
					}
				: {
						tone: 'alert',
						text: `This instance has not accepted the request from ${name} yet — it still reports it as pending, so it stays in Requests.`,
					};
		case 'declined':
			return {
				tone: 'status',
				text: `Request from ${name} declined. They cannot message you again unless you start the conversation.`,
			};
		case 'not-declined':
			return {
				tone: 'alert',
				text: `This instance did not confirm the decline, so the request from ${name} is unchanged.`,
			};
		case 'failed':
			return resolution.failure === 'auth-required'
				? {
						tone: 'alert',
						text: `Your session expired before this instance answered, so the request from ${name} is unchanged.`,
					}
				: {
						tone: 'alert',
						text: `This instance did not answer, so the request from ${name} is unchanged.`,
					};
	}
}

/** Replace one conversation in the list with the state lesser just returned. */
export function applyConversation(
	conversations: readonly Conversation[],
	updated: Conversation
): Conversation[] {
	return conversations.map((conversation) =>
		conversation.id === updated.id ? { ...conversation, ...updated } : conversation
	);
}

/** Drop one conversation from the list. */
export function withoutConversation(
	conversations: readonly Conversation[],
	conversationId: string
): Conversation[] {
	return conversations.filter((conversation) => conversation.id !== conversationId);
}

/**
 * How many of these conversations lesser still reports as pending requests.
 *
 * The Requests badge counts THIS, not the ids the vendored context has ever seen
 * pending: its tracker only forgets an id when a later read carries the same
 * conversation as non-pending, and a request resolved from this surface never
 * appears in a folder read again. Counting the list lesser actually served is
 * the version that cannot drift.
 */
export function countPendingRequests(conversations: readonly Conversation[]): number {
	return conversations.reduce(
		(total, conversation) =>
			total + ((conversation.requestState ?? 'ACCEPTED') === 'PENDING' ? 1 : 0),
		0
	);
}

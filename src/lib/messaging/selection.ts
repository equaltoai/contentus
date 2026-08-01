/**
 * Keeping a thread bound to the conversation it belongs to.
 *
 * THE DEFECT THESE EXIST FOR. Every read on this surface is asynchronous and the
 * selection is not: a reader can open A, open B a beat later, and have A's
 * answer arrive after B's. The vendored context writes each answer into ONE
 * `messages` array with no record of which conversation asked — `selectConversation`
 * sets `state.messages` from whichever `onFetchMessages` resolves last, and
 * `sendMessage` appends its confirmed message to whatever is selected when the
 * mutation returns. So a slow read for A can render under B's name, and a
 * message sent to A can appear in B's thread. Neither is a display glitch: on
 * this surface it is one correspondent's words shown under another's.
 *
 * THE THREAD IS NOT THE ONLY PLACE IT LANDS. `sendMessage` writes the confirmed
 * message THREE times, and only the first is into `state.messages`. It also sets
 * `lastMessage` and `updatedAt` on whichever conversation is selected when the
 * mutation returns, in the list AND on `selectedConversation`. A send dispatched
 * to A while the reader was reading A, resolving after they opened B, therefore
 * puts A's words and A's time on B's card — under B's correspondent's name, in
 * the list, where the message filter below never reaches. Same defect, second
 * surface, so there is a second guard: a summary is kept only when its message
 * NAMES the conversation it is filed under.
 *
 * Contentus cannot fix that inside the vendored state machine — it is upstream's
 * source and is never hand-edited — so the surface RECONCILES it here, against
 * the one piece of evidence the projection already carries: every
 * `DirectMessage` is stamped with its `conversationId` by
 * `contract.toDirectMessage`. A message that names another conversation is not
 * rendered, whatever wrote it into the array.
 *
 * These are plain functions over plain data on purpose: `tests/messaging-races.test.mjs`
 * drives them directly, which a guard living inside a `.svelte` component could
 * not be.
 */

import type { Conversation, DirectMessage } from '../components/messaging/context.svelte.js';
import { mergeMessages } from './contract.ts';

/**
 * Whether this message belongs to some OTHER conversation.
 *
 * A message with no `conversationId` is not treated as foreign: the field is
 * required by the type and stamped by every projection contentus owns, so an
 * absent one means a shape this module does not understand, and silently
 * dropping a message it cannot classify would be the more dangerous of the two
 * mistakes — a thread quietly missing a reply.
 */
export function isForeignMessage(message: DirectMessage, conversationId: string | null): boolean {
	if (!message.conversationId) return false;
	return message.conversationId !== conversationId;
}

/**
 * The messages that belong to `conversationId`.
 *
 * Returns the SAME array when nothing is foreign, so a caller can compare by
 * identity and write back only when the list actually changed — a reconciling
 * effect that assigned unconditionally would loop.
 *
 * `conversationId` of null means nothing is selected, and then nothing belongs:
 * a thread with no conversation open is a thread nobody asked for.
 */
export function retainSelectedMessages(
	messages: readonly DirectMessage[],
	conversationId: string | null
): DirectMessage[] {
	const kept = messages.filter((message) => !isForeignMessage(message, conversationId));
	return kept.length === messages.length ? (messages as DirectMessage[]) : kept;
}

/**
 * A page merged into the thread it was REQUESTED for, or null when the selection
 * moved while it was in flight.
 *
 * Null is the whole point: the caller drops the page instead of merging it, so
 * a late-resolving `conversationMessages` for a conversation the reader has
 * left never reaches the array the components render. The incoming page is
 * filtered too, so a response whose edges name a different conversation than
 * the one requested cannot smuggle a message in behind the selection check.
 */
export function mergeForConversation(
	existing: readonly DirectMessage[],
	incoming: readonly DirectMessage[],
	requestedId: string,
	selectedId: string | null
): DirectMessage[] | null {
	if (selectedId !== requestedId) return null;

	const belongs = incoming.filter((message) => !isForeignMessage(message, requestedId));
	return mergeMessages(retainSelectedMessages(existing, requestedId), belongs);
}

/**
 * A conversation's summary as it last stood carrying a message that named it.
 *
 * Held so a misfiled summary can be REPAIRED rather than only blanked: the
 * reader whose list card was overwritten mid-send should get their own last
 * message back, not an empty row where a preview used to be.
 */
export interface OwnSummary {
	lastMessage: DirectMessage | undefined;
	updatedAt: string;
}

/**
 * The conversation list with every summary restored to the conversation it
 * belongs to.
 *
 * Two repairs, from the same evidence — `DirectMessage.conversationId`, stamped
 * at DISPATCH by `handlers.onSendMessage` from the id the mutation was actually
 * sent to:
 *
 *   1. A conversation whose `lastMessage` names somebody ELSE is restored to the
 *      last summary it carried that named itself. That is the one that matters:
 *      until it happens, B's card is showing A's words.
 *   2. The displaced message is then filed under the conversation it DOES name,
 *      if that conversation is on screen and the message is newer than what it
 *      is showing. The send did happen, to A, and A's card should say so — which
 *      is what makes the repair complete rather than merely safe.
 *
 * `own` is read AND written: every pass records what each conversation is
 * currently carrying, so the restore has something to restore to. The caller
 * owns the map, which is what lets the repair survive the several state writes
 * one send produces.
 *
 * Returns the SAME array when nothing was misfiled, so the reconciling effect
 * that calls it writes back only on a real change and settles instead of
 * looping.
 */
export function retainOwnSummaries(
	conversations: readonly Conversation[],
	own: Map<string, OwnSummary>
): Conversation[] {
	const displaced = new Map<string, DirectMessage>();
	for (const conversation of conversations) {
		const last = conversation.lastMessage;
		if (!last || !isForeignMessage(last, conversation.id)) continue;
		const held = displaced.get(last.conversationId);
		// Newest wins, so two misfiled summaries naming one conversation do not
		// re-home the older of them.
		if (!held || held.createdAt.localeCompare(last.createdAt) < 0) {
			displaced.set(last.conversationId, last);
		}
	}

	if (displaced.size === 0) {
		for (const conversation of conversations) {
			own.set(conversation.id, {
				lastMessage: conversation.lastMessage,
				updatedAt: conversation.updatedAt,
			});
		}
		return conversations as Conversation[];
	}

	const repaired = conversations.map((conversation) => {
		let next = retainOwnSummary(conversation, own);

		const arrived = displaced.get(next.id);
		if (
			arrived &&
			(!next.lastMessage || next.lastMessage.createdAt.localeCompare(arrived.createdAt) <= 0)
		) {
			next = { ...next, lastMessage: arrived, updatedAt: arrived.createdAt };
		}

		own.set(next.id, { lastMessage: next.lastMessage, updatedAt: next.updatedAt });
		return next;
	});

	// Re-sorted because the vendored write sorted on the times this just
	// corrected; leaving the order alone would keep B at the top of the list on
	// the strength of a message that was never sent to them.
	return repaired.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * One conversation, restored if its summary names another.
 *
 * The list is not the only copy: `sendMessage` writes the same misfiled summary
 * onto `selectedConversation`, which is what later spreads (`{ ...selected }`)
 * carry forward. Restoring only the list would leave the wrong `lastMessage`
 * alive in the object every one of those copies is made from.
 *
 * Returns the SAME object when nothing is wrong, for the same settle-not-loop
 * reason as `retainSelectedMessages`.
 */
export function retainOwnSummary(
	conversation: Conversation,
	own: Map<string, OwnSummary>
): Conversation {
	const last = conversation.lastMessage;
	if (!last || !isForeignMessage(last, conversation.id)) return conversation;

	const restored = own.get(conversation.id);
	return {
		...conversation,
		lastMessage: restored?.lastMessage,
		// The time goes back with the message. Keeping the foreign one would sort
		// this conversation by an event that did not happen to it.
		updatedAt: restored?.updatedAt ?? conversation.updatedAt,
	};
}

/**
 * Whether an answer that was requested for one selection may still act on it.
 *
 * The deep-link read is the case: `/messages/{id}` resolves asynchronously, and
 * a reader who picked a conversation from the list while it was in flight has
 * chosen. Selecting the late arrival anyway would move them out of the
 * conversation they opened, into one they only linked to — and would do it after
 * they had started reading.
 *
 * Compared against the selection AT DISPATCH rather than against the requested
 * id, because the deep link is normally dispatched with nothing selected: it is
 * the CHANGE that means the reader acted, not the value.
 */
export function selectionHeld(atDispatch: string | null, now: string | null): boolean {
	return now === atDispatch;
}

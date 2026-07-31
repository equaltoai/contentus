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

import type { DirectMessage } from '../components/messaging/context.svelte.js';
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

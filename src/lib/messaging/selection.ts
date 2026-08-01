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
 * The selection as a REVISION, not a value.
 *
 * WHY ID-EQUALITY IS NOT THE GUARD. The check this replaces compared the
 * selected id at dispatch with the selected id at completion, and equality
 * cannot prove the reader made no intervening choice: dispatched with C
 * selected, the reader can open B and then return to C, and the comparison sees
 * exactly the state it captured although the reader has acted twice since. A
 * revision counts the CHOICES instead — every change of the selected id,
 * including a change back to an id it held before — so a path out and back
 * still fails the check. The reader's two choices are the event, not the id
 * they happened to end on.
 *
 * `observe` records what the reader is looking at, and is called from an
 * effect that tracks the selection, so every change is counted — including the
 * ones a completion never sees because they reverted before it landed.
 * `capture` stamps a dispatch; `held` answers whether nothing has been observed
 * since.
 *
 * NOT EVERY INTENT MOVES THE ID. Switching folder is a reader act too, and on a
 * cold deep link it changes nothing the observer can see: the selection is
 * already null while the by-id read is pending, and the vendored
 * `fetchConversations` clears it to the same null, so the observer is presented
 * the value it already holds and no transition exists to count. The revision
 * would stay held although the reader acted. `act` stamps those intents
 * explicitly, from the handler the reader's action passed through, so a choice
 * the selection cannot show still lands in the count.
 */
export interface SelectionRevisions {
	observe(id: string | null): void;
	act(): void;
	capture(): number;
	held(atDispatch: number): boolean;
}

export function trackSelectionRevisions(initial: string | null = null): SelectionRevisions {
	let observed = initial;
	let revision = 0;
	return {
		observe(id) {
			if (id === observed) return;
			observed = id;
			revision += 1;
		},
		act() {
			revision += 1;
		},
		capture() {
			return revision;
		},
		held(atDispatch) {
			return revision === atDispatch;
		},
	};
}

/** What the deep-link read came back with. */
export type DeepLinkOutcome = 'found' | 'missing' | 'failed';

/**
 * What the surface may do with it: select the found conversation, show the
 * not-found or failed surface — or nothing at all, because the completion is
 * stale.
 */
export type DeepLinkVerdict = 'select' | 'not-found' | 'failed' | 'stale';

/**
 * What a deep-link completion may do, judged against the revision its dispatch
 * captured.
 *
 * Checked before EVERY completion, not only the successful one. The resolution
 * states take precedence over the selected thread in the render branches, so a
 * late answer that is allowed to write `not-found` or `failed` hides the
 * conversation the reader chose while the link was loading exactly as surely as
 * a late `selectConversation` would move them out of it. A stale completion
 * changes nothing — not the selection, and not the surface it is shown on.
 *
 * `selectionNow` is observed into the tracker BEFORE the revision is judged.
 * The reader's click writes the selection synchronously but the effect that
 * observes it runs on the next flush, and a completion can land between the
 * two; judging without this read would re-admit, through a timing gap, the
 * race the revision exists to close.
 */
export function deepLinkVerdict(
	revisions: SelectionRevisions,
	atDispatch: number,
	selectionNow: string | null,
	outcome: DeepLinkOutcome
): DeepLinkVerdict {
	revisions.observe(selectionNow);
	if (!revisions.held(atDispatch)) return 'stale';
	return outcome === 'found' ? 'select' : outcome === 'missing' ? 'not-found' : 'failed';
}

/**
 * Whether a click inside the New Conversation wrapper is the OPEN intent — the
 * one reader act this flow contains that the selection can never show.
 *
 * THE UNSTAMPED COMPETITOR. On a wide cold `/messages/{id}` load the vendored
 * `NewConversation` trigger is usable while the by-id read is pending, and
 * everything the reader can do next — open the modal, search, pick a recipient
 * — leaves `selectedConversation` at the null it already holds. The component
 * exposes no callback until AFTER it has created and internally selected a
 * conversation (`onConversationCreated`), so none of it reaches the observer,
 * and an unstamped open leaves the pending link admissible at the revision it
 * captured: the late missing/failed answer then writes a resolution the render
 * branches never reset, and the conversation the reader goes on to create
 * stays hidden behind the link they had already abandoned. The open is the
 * reader's act, and it is stamped from the surface's own wrapper — owned
 * source, delegating the click in the capture phase — because the vendored
 * trigger cannot be given a handler without editing vendored source. A real
 * open-intent hook on `NewConversation` is the upstream ask
 * (`docs/consumption/messaging-contract.md`).
 *
 * WHAT COUNTS, AND WHAT MUST NOT. Only the trigger counts: a click inside the
 * modal — the search field, a result, the cancel button — is a continuation of
 * the act the open already stamped, or no act at all. And the trigger counts
 * only when the modal is NOT already open: re-pressing it then chooses
 * nothing, and a no-op must not stale a pending link, the same discipline as
 * the current-folder re-click. "Already open" is read from the DOM rather than
 * tracked in parallel state, because the capture phase runs BEFORE the
 * vendored handler flushes `isOpen` — the modal this click is about to render
 * is not there yet, so a present modal is always an earlier open.
 *
 * Duck-typed on the two DOM verbs it needs (`closest`, `querySelector`) so the
 * test file can drive it without a DOM harness; the surface passes the real
 * event's `currentTarget` and `target`.
 */
export function isNewConversationOpenIntent(
	root: { querySelector?: (selector: string) => unknown } | null,
	target: unknown
): boolean {
	// `EventTarget` carries no `closest` in its type; an event's real target is
	// an Element, and the tests hand a plain object with the same two verbs.
	const element = target as { closest?: (selector: string) => unknown } | null;
	if (!element?.closest?.('.new-conversation__trigger')) return false;
	if (root?.querySelector?.('.new-conversation__modal')) return false;
	return true;
}

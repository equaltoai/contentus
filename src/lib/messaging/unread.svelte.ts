/**
 * The unread signal behind the nav badge (product design §5, "Unread counts
 * feed the nav badge").
 *
 * WHAT THE NUMBER IS. lesser's `conversations` selection carries `unread:
 * Boolean` per conversation and no message count anywhere, so this counts
 * CONVERSATIONS WITH UNREAD ACTIVITY. Every label built from it says so. The
 * alternative — presenting it as a message count because that is what a badge
 * usually means — would be contentus inventing a number lesser never gave it,
 * and a reader who opens a badged conversation expecting three messages and
 * finds eleven has been told something false by a control that looked precise.
 *
 * WHY IT IS A STORE AND NOT A PROP. The badge lives in the shell, which renders
 * on every route; the count comes from an authenticated read, which only the
 * browser can make. A module-level store is what lets the chrome show a count
 * the messages surface already loaded instead of re-reading it, and lets the
 * messages surface push realtime changes back up to the chrome without the two
 * being wired through every route in between.
 *
 * THREE STATES, NOT A NUMBER. `unknown` is the honest answer before anything
 * has been read — the server render and the first client frame — and it renders
 * as NO badge rather than as a zero. A badge reading "0" is a claim that the
 * inbox was read and found empty; showing one before any read has happened
 * would be asserting exactly what has not been established yet.
 */

import { accessTokenOrNull, isAuthenticated } from '../auth/session.ts';
import { unreadConversationCount } from './contract.ts';
import { createMessagingBinding } from './handlers.ts';
import type { Conversation } from '../components/messaging/context.svelte.js';

export type UnreadState =
	| { status: 'unknown' }
	| { status: 'known'; conversations: number }
	/**
	 * The read failed. Distinct from `unknown` so the chrome can stay silent
	 * without the store forgetting that it tried — a retry loop that cannot tell
	 * "not yet" from "failed" will either never retry or never stop.
	 */
	| { status: 'unavailable' };

class UnreadStore {
	state = $state<UnreadState>({ status: 'unknown' });

	/** In-flight guard: the shell mounts once per navigation, lesser answers once. */
	#loading = false;

	/**
	 * Adopt a count the messages surface already has.
	 *
	 * Called with the INBOX conversations whenever that surface loads or a
	 * realtime event changes them, so the badge tracks the list a reader is
	 * looking at rather than a snapshot taken when the page loaded.
	 */
	adopt(conversations: readonly Conversation[]): void {
		this.state = { status: 'known', conversations: unreadConversationCount(conversations) };
	}

	/** Drop to `unknown` — sign-out, or a session that stopped being valid. */
	reset(): void {
		this.state = { status: 'unknown' };
	}

	/**
	 * Read the count for the chrome, once.
	 *
	 * Anonymous callers return without a request: lesser serves no part of
	 * `conversations` without a token, so asking would produce a guaranteed 401
	 * on every public article page a signed-out reader opens.
	 */
	async refresh(): Promise<void> {
		if (this.#loading) return;
		if (!isAuthenticated() || !accessTokenOrNull()) {
			this.reset();
			return;
		}

		this.#loading = true;
		try {
			const { handlers } = createMessagingBinding();
			const conversations = await handlers.onFetchConversations?.('INBOX');
			this.state = conversations
				? { status: 'known', conversations: unreadConversationCount(conversations) }
				: { status: 'unavailable' };
		} catch {
			// The badge is chrome. A failed count is worth remembering — so a retry
			// can distinguish it from "not yet" — but never worth surfacing as an
			// error over an article somebody is reading.
			this.state = { status: 'unavailable' };
		} finally {
			this.#loading = false;
		}
	}
}

export const unreadStore = new UnreadStore();

/**
 * The badge's text, or null when there should be no badge.
 *
 * Capped at "99+" so a long-neglected inbox cannot widen the nav item enough to
 * push a tab target under the 44px minimum §4 sets.
 */
export function unreadBadgeText(state: UnreadState): string | null {
	if (state.status !== 'known' || state.conversations <= 0) return null;
	return state.conversations > 99 ? '99+' : String(state.conversations);
}

/** The badge's accessible label. Says CONVERSATIONS, because that is what it counts. */
export function unreadBadgeLabel(state: UnreadState): string | null {
	if (state.status !== 'known' || state.conversations <= 0) return null;
	return state.conversations === 1
		? '1 conversation with unread messages'
		: `${state.conversations} conversations with unread messages`;
}

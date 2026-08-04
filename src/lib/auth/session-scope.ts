/**
 * Which session an in-flight answer belongs to.
 *
 * THE DEFECT THIS EXISTS FOR. Closing the socket on sign-out ends the stream,
 * and it ends nothing else. Every HTTP read a signed-in surface had already
 * dispatched — the conversation list, a thread page, a folder re-read, the
 * badge's own count, the owned-agent inventory — is a promise nobody can recall,
 * and it RESOLVES after the session that authorized it has gone. The answer then
 * reaches a component that is still mounted and still rendering, under whichever
 * session is there when it lands: the next reader's, or none. On a surface whose
 * subject is private correspondence, or one operator's agent inventory, that is
 * one account's data published into another account's chrome.
 *
 * IT LIVES UNDER `auth/` BECAUSE THE SESSION IS THE SUBJECT. It was written for
 * the messages face and sat under `messaging/` while that was its only caller.
 * `$lib/agents/MyAgents.svelte` has the same race for the same reason — an
 * authorized read in flight across a sign-out — and a second face reaching into
 * the first one's directory for a guard about auth would have been the wrong
 * dependency rather than a shared one.
 *
 * A cancelled request is the better fix where the transport allows one, and
 * `graphqlRequest` takes an `AbortSignal`, so the binding aborts too. But an
 * abort is a race of its own — a response already parsed is not un-parsed by
 * aborting the fetch behind it — so the stamp is what actually decides. Cancel
 * for the bandwidth; check the stamp for the correctness.
 *
 * TWO GENERATIONS, NOT ONE. A scope ends for two different reasons and both have
 * to invalidate: the thing that owns it was torn down (`end`), or the SESSION
 * changed underneath it — a sign-out and sign-in with no teardown in between,
 * which is exactly the badge's race, since its store outlives every binding it
 * creates. `sessionGeneration` supplies the second; `./session-events` advances
 * it on every announced change.
 *
 * Plain functions over plain numbers on purpose: `tests/messaging-session.test.mjs`
 * and `tests/agents-trust.test.mjs` drive this directly, which a guard living
 * inside a `.svelte.ts` store or a component — files `node --test` cannot load —
 * could not be.
 */

/** Taken at DISPATCH, checked at COMPLETION. Opaque to its holder. */
export interface SessionStamp {
	readonly scope: number;
	readonly session: number;
}

export interface SessionScope {
	/** The stamp for work starting now. */
	stamp: () => SessionStamp;
	/** Whether `stamp` still names the session this scope is serving. */
	holds: (stamp: SessionStamp) => boolean;
	/**
	 * End the scope. Every stamp taken before this stops being held, and the
	 * scope goes on working for whatever is dispatched after it — which is what
	 * lets one store serve reader after reader without being rebuilt.
	 */
	end: () => void;
}

/**
 * @param sessionGeneration How many times the session itself has changed.
 *   Defaults to a constant for callers whose lifetime IS the session (a binding
 *   is built per sign-in and torn down at sign-out), where `end` is the whole
 *   story.
 */
export function createSessionScope(sessionGeneration: () => number = () => 0): SessionScope {
	let generation = 0;

	return {
		stamp: () => ({ scope: generation, session: sessionGeneration() }),
		holds: (stamp) => stamp.scope === generation && stamp.session === sessionGeneration(),
		end: () => {
			generation += 1;
		},
	};
}

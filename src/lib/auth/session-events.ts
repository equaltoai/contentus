/**
 * When the session changed, announced to the surfaces that hold something
 * because of it.
 *
 * WHY THIS EXISTS. `clearSession()` removes six keys from `sessionStorage` and
 * nothing else. No event fires — `sessionStorage` does not raise `storage` in
 * the tab that wrote it — so every surface that read the session ONCE, at mount,
 * went on holding what that session bought. On the messages face that meant the
 * conversations stayed on screen and the AUTHORIZED SOCKET stayed open after the
 * reader signed out, on whatever device they walked away from. A sign-out that
 * only empties storage is a sign-out the running page never hears about.
 *
 * THE SIGNAL CARRIES NO SESSION DATA, only that one happened. A subscriber that
 * needs the token reads it itself; a payload here would put a bearer token in
 * every listener's closure to save one function call.
 *
 * Deliberately free of `$app/environment` and of `sessionStorage`, which is what
 * lets `node --test` drive it directly. Storage belongs to `./session`; this
 * module is only the notification.
 */

export type SessionChange = 'signed-in' | 'signed-out';

type SessionListener = (change: SessionChange) => void;

const listeners = new Set<SessionListener>();

/** Subscribe. The returned function unsubscribes and is safe to call twice. */
export function onSessionChange(listener: SessionListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Announce a change to every subscriber.
 *
 * Iterates a COPY, because a listener that unsubscribes itself is the normal
 * case here — a component tearing itself down on sign-out does exactly that —
 * and mutating the set mid-walk would skip the next subscriber.
 *
 * A listener that throws is caught rather than allowed to abort the walk. These
 * are teardown paths: one surface failing to clean up must not leave the next
 * one holding an open socket, which is the failure this module exists to end.
 */
export function notifySessionChange(change: SessionChange): void {
	for (const listener of [...listeners]) {
		try {
			listener(change);
		} catch {
			// Swallowed on purpose, and only here. This runs during sign-out, after
			// which there is no authenticated screen left to report it on, and the
			// remaining subscribers still have sockets to close.
		}
	}
}

/** How many subscribers are attached. For probes; nothing renders from it. */
export function sessionChangeListenerCount(): number {
	return listeners.size;
}

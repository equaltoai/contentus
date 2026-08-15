/**
 * Session-scoped act-as context for lesser's agent share-grants (lesser
 * v1.6.5, `docs/contracts/agent-share-act-as.md`).
 *
 * A grantee selects an agent to act as on the agents route, and the review
 * surfaces then send `X-Lesser-Act-As` on lesser's act-as-enabled operations
 * (`src/lib/cms/graphql.ts` carries the header; the review transport is what
 * passes the selection in). This module is the selection itself: where it
 * lives, when it dies, and how a surface hears about either.
 *
 * THE SELECTION IS SESSION-SCOPED, AND THAT IS A PROPERTY WITH TWO HALVES.
 * It lives in `sessionStorage` because it must survive navigation — selection
 * happens on `/agents`, the act-as calls happen on `/review`, and every
 * navigation here is a fresh document, so in-memory state would not make the
 * trip. And it dies with the session, for the reason every other
 * session-scoped surface here dies with the session: a selection the previous
 * reader made must not become the next reader's by inheritance. Both halves
 * are mechanical, not aspirational:
 *
 *   - STORAGE ALONE IS NOT SESSION-SCOPING. A `signed-out` announcement clears
 *     the selection on whatever page is loaded when it fires, but a reader can
 *     sign out from a page that never loaded this module — the selection is
 *     made on `/agents`, the sign-out button is on every page. So the stored
 *     value is BOUND to the auth session that made it (the session's
 *     `createdAt`/`expiresAt` travel with the selection), and every read
 *     re-checks the binding. A selection whose session is gone, expired, or
 *     simply not the one now signed in is discarded, not resurrected.
 *   - The `signed-out` listener is still here, because it is the direct form
 *     of "cleared on sign-out" and because it also clears in-memory mirrors
 *     the instant the session ends. It is the fast path; the binding is the
 *     guarantee.
 *
 * THE GRANT IS LESSER'S, AND A REVOKE IS A LIVE EVENT. lesser re-checks the
 * grant on every act-as request, so a grant revoked mid-session makes the very
 * next act-as call fail — and the failure shape differs by surface, which is
 * lesser's contract, not a client choice: on GraphQL-HTTP it arrives as an
 * error whose `extensions.code` is `FORBIDDEN` on an HTTP 200 response, while
 * the REST share plane answers a plain HTTP 403. `hasForbiddenExtension` and
 * `isForbiddenShareError` are the two spellings, and the call sites (the
 * review transport for the first, the share panels for the second) compose
 * them with `clearActAs()` — the selection clears and every subscribed
 * surface is told, which is the designed mid-session revocation path.
 *
 * ATTRIBUTION, NOT IMPERSONATION. Nothing here makes a request; it only
 * remembers which agent the viewer chose to act as, and the choice is always
 * drawn from lesser's own `shared-with-me` answer (`actAsCandidates`). lesser
 * records the real caller as `actedBy` on whatever runs.
 *
 * Plain functions over plain state on purpose, like `auth/session-events`:
 * `node --test` drives this module directly, which a `.svelte.ts` store could
 * not.
 */

import { readSession } from '../auth/session.ts';
import { onSessionChange } from '../auth/session-events.ts';
import type { AgentShareGrant } from './share-client.ts';
import { ShareClientError } from './share-client.ts';

/** The selection a surface renders and the transport sends. */
export interface ActAsSelection {
	agentUsername: string;
}

/** The key this module writes to `sessionStorage`. */
const STORAGE_KEY = 'contentus:act_as';

interface StoredActAs {
	agentUsername: string;
	sessionCreatedAt: number;
	sessionExpiresAt: number;
}

type ActAsChangeListener = (selection: ActAsSelection | null) => void;

const listeners = new Set<ActAsChangeListener>();

function notifyActAsChange(selection: ActAsSelection | null): void {
	// Iterates a COPY and swallows listener errors, exactly like
	// `session-events`: a surface tearing itself down on a selection change is
	// the normal case, and one failure must not stop the next subscriber from
	// clearing what it holds.
	for (const listener of [...listeners]) {
		try {
			listener(selection);
		} catch {
			// Swallowed on purpose, and only here — see above.
		}
	}
}

/**
 * The current selection, re-validated against the session that made it.
 *
 * Returns null — and drops whatever was stored — when there is no stored
 * selection, when the stored value is not a usable one, when there is no auth
 * session at all, or when the stored selection was bound to a different auth
 * session than the one now signed in. The last of those is the reader-bleed
 * guard: a selection survives navigation, never a sign-out followed by a new
 * sign-in.
 */
export function actAsSelection(): ActAsSelection | null {
	if (typeof sessionStorage === 'undefined') return null;

	const raw = sessionStorage.getItem(STORAGE_KEY);
	if (!raw) return null;

	let parsed: Partial<StoredActAs>;
	try {
		parsed = JSON.parse(raw) as Partial<StoredActAs>;
	} catch {
		sessionStorage.removeItem(STORAGE_KEY);
		return null;
	}

	const agentUsername = typeof parsed.agentUsername === 'string' ? parsed.agentUsername : '';
	if (
		!agentUsername.trim() ||
		typeof parsed.sessionCreatedAt !== 'number' ||
		typeof parsed.sessionExpiresAt !== 'number'
	) {
		sessionStorage.removeItem(STORAGE_KEY);
		return null;
	}

	const session = readSession();
	if (
		!session ||
		session.createdAt !== parsed.sessionCreatedAt ||
		session.expiresAt !== parsed.sessionExpiresAt
	) {
		sessionStorage.removeItem(STORAGE_KEY);
		return null;
	}

	return { agentUsername };
}

/**
 * Select an agent to act as, for the current session.
 *
 * Returns the stored selection, or null when there is nothing to store under:
 * no session, no storage (the server pass), or a blank username. Selecting the
 * agent already selected is a no-op with no announcement. The value stored is
 * the username the caller hands over — the callers draw candidates from
 * lesser's `shared-with-me` answer (`actAsCandidates`), so validation against
 * the grant list is the caller's, not this module's: this module cannot know
 * the list without fetching it, and lesser re-checks the grant per request
 * anyway.
 */
export function selectActAs(agentUsername: string): ActAsSelection | null {
	const username = agentUsername.trim();
	if (!username || typeof sessionStorage === 'undefined') return null;

	const session = readSession();
	if (!session) return null;

	const previous = actAsSelection();
	const stored: StoredActAs = {
		agentUsername: username,
		sessionCreatedAt: session.createdAt,
		sessionExpiresAt: session.expiresAt,
	};
	sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

	if (!previous || previous.agentUsername !== username) {
		notifyActAsChange({ agentUsername: username });
	}
	return { agentUsername: username };
}

/**
 * Clear the selection.
 *
 * Removes the stored value first, announces second — the same order
 * `clearSession` keeps — so a subscriber that reads the selection in response
 * finds nothing rather than the value on its way out. Announcing only when a
 * selection actually existed keeps "cleared" a statement about a change and
 * not a heartbeat.
 */
export function clearActAs(): void {
	if (typeof sessionStorage === 'undefined') return;

	const previous = actAsSelection();
	sessionStorage.removeItem(STORAGE_KEY);
	if (previous) notifyActAsChange(null);
}

/**
 * Subscribe to selection changes. The returned function unsubscribes and is
 * safe to call twice. The listener receives the selection after the change —
 * null when it was cleared.
 */
export function onActAsChange(listener: ActAsChangeListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** How many subscribers are attached. For probes; nothing renders from it. */
export function actAsChangeListenerCount(): number {
	return listeners.size;
}

/**
 * The agent usernames a caller may currently act as, from lesser's
 * `shared-with-me` answer.
 *
 * Only active grants are candidates; `active` is lesser's served statement and
 * filtering on it here keeps a revoked grant — which lesser may still list —
 * out of the selector. The values are lesser's `agent_username`s, untouched.
 */
export function actAsCandidates(grants: readonly AgentShareGrant[]): string[] {
	return grants.filter((grant) => grant.active).map((grant) => grant.agent_username);
}

/**
 * Whether a GraphQL error set carries lesser's `FORBIDDEN` extension.
 *
 * This is the act-as revocation spelling on GraphQL-HTTP: lesser reports
 * field-level refusals with HTTP 200 and an `errors` array, so the refusal
 * arrives as an extension code on a 200 — NOT as a 403. The REST share plane
 * is the surface that answers 403; see `isForbiddenShareError`.
 */
export function hasForbiddenExtension(errors: readonly unknown[]): boolean {
	return errors.some((error) => {
		if (typeof error !== 'object' || error === null) return false;
		const extensions = (error as { extensions?: unknown }).extensions;
		if (typeof extensions !== 'object' || extensions === null) return false;
		return (extensions as Record<string, unknown>).code === 'FORBIDDEN';
	});
}

/**
 * Whether a share-plane failure is a 403 — the REST spelling of "the grant is
 * gone". Non-`ShareClientError` failures and other statuses are not it: a 404
 * means a missing route (likely a pre-v1.6.5 instance), and a transport
 * failure proves nothing about the grant.
 */
export function isForbiddenShareError(error: unknown): boolean {
	return error instanceof ShareClientError && error.status === 403;
}

// Cleared the moment the session ends, on whatever page is loaded when it
// ends. This is the direct half of session scoping; the stored binding in
// `actAsSelection` is the half that holds when this listener was never
// registered because the sign-out happened on a page that never loaded this
// module.
onSessionChange((change) => {
	if (change === 'signed-out') clearActAs();
});

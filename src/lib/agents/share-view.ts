/**
 * The owner's read of one agent's share list (M2.3, equaltoai/contentus#94).
 *
 * `GET /api/v1/agents/{username}/share` is lesser's OWNER/ADMIN view, and it is
 * the only one that carries revoked entries: `ListByAgent` runs
 * `authorizeAgentOwner` first and answers `ErrNotAuthorized` to everyone else
 * (`pkg/services/agentshare/service.go`), while the grantee-facing
 * `shared-with-me` list filters revoked rows out at the index. So the audit
 * half of what this module classifies is owner-only by lesser's construction,
 * not by a client-side filter — and `AgentSharingPanel`, mounted only behind
 * lesser's `agent.owner` statement, is its one consumer.
 *
 * WHAT THE LIST IS, AND WHAT IT IS NOT, said here because the panel renders it
 * under a heading and a heading is a claim. lesser stores ONE ROW PER GRANTEE
 * and this list is those rows' CURRENT STATE. Granting an account that was
 * revoked calls `RegrantAgentShareGrant`, which `Remove`s `RevokedAt` and
 * `RevokedBy` from that same row (`pkg/storage/repositories/agent_share_repository.go`)
 * — so a re-grant erases the revocation it followed, and the revoked side of
 * this classification is "accounts whose access stands revoked", never "every
 * revocation there has ever been". The event-by-event sequence is the agent
 * activity log lesser writes beside each mutation (`agent.share.grant`,
 * `agent.share.revoke`), which is a different read on a different surface and
 * is M2.4's, not this one's.
 *
 * NOTHING HERE IS DERIVED FROM A GUESS. `active` is lesser's own boolean —
 * `RevokedAt == nil`, computed server-side — so the split is reading the
 * instance's answer rather than re-deriving it from the timestamps. An entry
 * lesser did not classify is not assigned a side; see `unreadable`.
 */

// Explicit `.ts`, matching `share-client.ts`: the probes load this module
// straight off disk under `node --test --experimental-strip-types`, and Node's
// ESM resolver neither guesses extensions nor knows the `$lib` alias.
import type { AgentShareGrant } from './share-client.ts';

/** One agent's share list, split by what lesser said about each entry. */
export interface AgentAccessLedger {
	/** `active: true` — the accounts that hold access to the agent's MCP now. */
	current: AgentShareGrant[];
	/** `active: false` — the accounts whose access stands revoked. */
	revoked: AgentShareGrant[];
	/**
	 * Entries lesser sent without the boolean that decides the other two.
	 *
	 * The contract types `active` as a required boolean, so this is empty
	 * against any conforming instance. It exists because the alternative is
	 * choosing a side for an entry the instance did not classify, and BOTH
	 * sides are a false statement to the person reading the screen: filed under
	 * `current` it claims access this instance never confirmed, filed under
	 * `revoked` it tells an owner that someone's access is gone when it may not
	 * be. Counting them and saying so is the only honest third answer.
	 */
	unreadable: AgentShareGrant[];
}

/**
 * Split one agent's grant list into what the owner can be told about it.
 *
 * Lesser's own ORDER IS KEPT within each side (the repository returns the rows
 * sorted by grantee), and deliberately so: re-sorting by `revoked_at` would
 * order the list by a field this module has already established may be absent,
 * which is an ordering claim built on a value that is not always there.
 */
export function accessLedger(grants: readonly AgentShareGrant[]): AgentAccessLedger {
	const ledger: AgentAccessLedger = { current: [], revoked: [], unreadable: [] };
	for (const grant of grants) {
		const active = (grant as { active?: unknown }).active;
		if (active === true) ledger.current.push(grant);
		else if (active === false) ledger.revoked.push(grant);
		else ledger.unreadable.push(grant);
	}
	return ledger;
}

/** A timestamp lesser served, or null when it served nothing usable. */
function servedMoment(value: unknown): Date | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const moment = new Date(value);
	return Number.isNaN(moment.getTime()) ? null : moment;
}

/** A username lesser served, or null when it served nothing usable. */
function servedActor(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * "granted 3 Jan 2026 by @ada" — the audit stamp for one half of one entry.
 *
 * EVERY CLAUSE IS DROPPED RATHER THAN DEFAULTED. `revoked_by` is optional in
 * the contract and `revoked_at` is nullable, so a stamp that filled either
 * blank — "by unknown", "revoked recently", the agent owner's own name — would
 * be this client inventing the answer to the exact question the owner opened
 * the screen to ask. What survives when lesser served neither is the verb
 * alone, which is `active`'s own content and therefore still true.
 *
 * The date format is INJECTED rather than fixed. The panel passes the reader's
 * locale; a probe passes a fixed one, so what the probe asserts is this
 * function's composition and not the test host's ICU data.
 */
export function grantStamp(
	verb: string,
	at: unknown,
	by: unknown,
	formatDate: (moment: Date) => string = (moment) => moment.toLocaleDateString()
): string {
	const moment = servedMoment(at);
	const actor = servedActor(by);
	const parts = [verb];
	if (moment) parts.push(formatDate(moment));
	if (actor) parts.push(`by @${actor}`);
	return parts.join(' ');
}

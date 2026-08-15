/**
 * What a reader may be told about lesser's agent share-grant lists — the
 * owner's read of one agent (M2.3, equaltoai/contentus#94) and the grantee's
 * read of their own (the M2.5 follow-up).
 *
 * TWO READS, ONE CLASSIFIER, TWO SETS OF SENTENCES. The reads are different in
 * every way that matters — different routes, different authorization, different
 * content — but the question a client must answer before it says anything about
 * either is the same: did the instance classify this row? So `accessLedger`
 * serves both. What is NOT shared is the copy: "nobody holds access to your
 * agent" and "nothing has been shared with you" are different claims about
 * different subjects, and each panel's empty state is composed separately below
 * so that neither can be spoken for the other.
 *
 * `GET /api/v1/agents/{username}/share` is lesser's OWNER/ADMIN view, and it is
 * the only one that carries revoked entries: `ListByAgent` runs
 * `authorizeAgentOwner` first and answers `ErrNotAuthorized` to everyone else
 * (`pkg/services/agentshare/service.go`), while the grantee-facing
 * `shared-with-me` list filters revoked rows out at the index. So the audit
 * half of what this module classifies is owner-only by lesser's construction,
 * not by a client-side filter — and `AgentSharingPanel`, mounted only behind
 * lesser's served `viewerIsOwner` (lesser#1418), is its one consumer. That gate
 * read `agent.owner` until the pin bump to 1ce2dc97, which was a VISIBILITY
 * statement standing in for an ownership one and therefore true of admins too.
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

/**
 * What to say about entries lesser sent without classifying them, or null.
 *
 * Written as a whole sentence per count rather than assembled around a number,
 * because the two readings are different sentences and a screen that says
 * "sent 1 share entries" is a screen the owner stops trusting — on a surface
 * whose whole job is to be believed about who can reach their agent.
 */
export function unclassifiedEntriesNotice(ledger: AgentAccessLedger): string | null {
	const count = ledger.unreadable.length;
	if (!count) return null;
	return count === 1
		? 'This instance sent one share entry without marking it active or revoked, so neither list below accounts for it.'
		: `This instance sent ${count} share entries without marking them active or revoked, so neither list below accounts for them.`;
}

/**
 * What the owner is told when the current-access list is empty.
 *
 * AN EMPTY LIST IS NOT ALWAYS AN EMPTY ANSWER, which is the whole of this
 * function. With nothing unclassified, `current` being empty IS the instance's
 * statement: no account holds access. With entries the instance did not
 * classify, the same sentence would be this client answering a question lesser
 * declined to answer — and the unclassified entries are precisely the ones that
 * could be live grants, so a 200 that dropped `active` from a real grantee's
 * row would both hide that row and tell the owner the opposite of the only
 * claim that survives it (equaltoai/contentus#100, codex review 4941340448).
 *
 * So the empty state states what is known — nothing classified holds access —
 * and names the entries whose access could not be determined, in the same
 * exclusion the counting notice above the lists describes. It is never a
 * softened version of the certain sentence with a caveat bolted on: "no account
 * holds access" is a false statement here, and a caveat does not repair one.
 */
export function noCurrentAccessStatement(username: string, ledger: AgentAccessLedger): string {
	const count = ledger.unreadable.length;
	if (!count) return `No account holds access to @${username} right now.`;
	return count === 1
		? `No entry this instance classified holds access to @${username} right now. Access could not be determined for one further entry, so this is not a statement that nobody holds it.`
		: `No entry this instance classified holds access to @${username} right now. Access could not be determined for ${count} further entries, so this is not a statement that nobody holds it.`;
}

/* -------------------------------------------------------------------------
 * The grantee's half — `GET /api/v1/agents/shared-with-me`
 *
 * WHY THIS IS DEFENSIVE HONESTY AND NOT A KNOWN-LIVE BUG, recorded here so the
 * next reader neither hunts for the outage nor deletes the guard as dead code.
 * lesser answers this route from a different index than the owner's list, and
 * the revoked rows are excluded AT THE QUERY rather than by anything the client
 * does: `ListSharedWith` calls `ListActiveAgentShareGrantsByGrantee`
 * (`pkg/services/agentshare/service.go:157`), which queries the grantee GSI
 * under `Filter("RevokedAt", "attribute_not_exists", nil)`
 * (`pkg/storage/repositories/agent_share_repository.go:169`). `active` is then
 * computed server-side as `RevokedAt == nil`
 * (`cmd/api/handlers/agent_shares.go:176`) on a field carrying no `omitempty`
 * (`cmd/api/models/agent_shares.go:13`), so a conforming instance sends `true`
 * on every row of this list and nothing else.
 *
 * So an unclassified row here can only come from a NON-CONFORMING answer. That
 * is precisely why the classification must be strict rather than truthy: the
 * one response shape that can hide a real grant is the one a truthiness filter
 * reads as an absence and then reports as certainty. `grant.active` being
 * falsy-but-not-`false` — dropped, null, a string — silently removed the row
 * from the list while the empty state went on asserting that nothing had been
 * shared. The instance's malformed answer became this client's confident claim,
 * which is the failure the owner panel already closed (equaltoai/contentus#100,
 * codex review 4941340448) reappearing on the other side of the same contract.
 * ---------------------------------------------------------------------- */

/**
 * What the grantee is told about entries lesser sent unclassified, or null.
 *
 * NOT THE OWNER'S NOTICE WITH A WORD CHANGED. That one says the row is in
 * "neither list below", which is true of a screen with two lists and sends the
 * reader of a one-list screen looking for a second one. This says where the row
 * actually went: nowhere they can see it.
 */
export function unlistedSharesNotice(ledger: AgentAccessLedger): string | null {
	const count = ledger.unreadable.length;
	if (!count) return null;
	return count === 1
		? 'This instance sent one share entry without marking it active or revoked, so it is not listed below.'
		: `This instance sent ${count} share entries without marking them active or revoked, so they are not listed below.`;
}

/**
 * What the grantee is told when no agent is listed as shared with them.
 *
 * THE SAME RULE AS THE OWNER'S EMPTY STATE, about a different subject. With
 * nothing unclassified, an empty list IS the instance's answer and the flat
 * sentence is true — and that includes the case where every row came back
 * `active: false`, because a classified row is an answered row.
 *
 * With an unclassified entry it is not an answer at all: those rows are exactly
 * the ones that could be live grants, so the certain sentence would tell a
 * grantee that nothing was shared with them on the strength of a response that
 * failed to say. The claim is therefore narrowed to what was actually
 * classified and the remainder is named — never the certain sentence with a
 * caveat appended, which leaves the false statement standing and adds to it.
 */
export function noSharedAgentsStatement(ledger: AgentAccessLedger): string {
	const count = ledger.unreadable.length;
	if (!count) return 'No agents have been shared with you.';
	return count === 1
		? 'No entry this instance classified is an agent shared with you. One further entry could not be read, so this is not a statement that no agent has been shared with you.'
		: `No entry this instance classified is an agent shared with you. ${count} further entries could not be read, so this is not a statement that no agent has been shared with you.`;
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

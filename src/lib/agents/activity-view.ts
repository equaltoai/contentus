/**
 * Who has been DRIVING one agent, out of lesser's agent activity log
 * (M2.4, equaltoai/contentus#95).
 *
 * THE COMPANION QUESTION TO M2.3, AND A DIFFERENT ONE. `share-view.ts` answers
 * who HOLDS access — the grant ledger, one row per grantee, current state. This
 * module answers who has ACTUALLY CONNECTED AND ACTED: of the accounts that
 * hold access, which ones drove the agent, and when. The operator's words for
 * it were "knowing who was logged into MCP as it were".
 *
 * IT IS NOT A SESSION LIST, AND THAT IS DELIBERATE UPSTREAM. The operator's
 * directive (2026-08-13) was "I would not index who was logged into an MCP, but
 * its important metadata" — there is no session index, no GSI, and this client
 * builds no session registry of its own. What exists is ATTRIBUTION RIDING THE
 * AUDIT TRAIL: lesser writes one audit row per agent action, the agent stays in
 * `Username`, and the human who drove it rides in the row's metadata
 * (equaltoai/lesser#1401, commit a1ed548ea). So "who was logged in" is answered
 * here by WHAT THEY DID, not by a record of them being connected — and the
 * panel says so, because a roster of drivers can otherwise read as a roster of
 * live sessions, which is exactly the thing lesser refused to keep.
 *
 * THE TWO ATTRIBUTION KEYS ARE TWO MECHANISMS, not two spellings of one.
 *
 *   - `delegated_by` — written by `recordAgentAuditEvent`
 *     (`lesser/cmd/api/handlers/agent_audit.go:53`) from the token's
 *     `DelegatedBy` claim: the human who authorized the token the agent is
 *     acting under. On a shared agent's MCP that is the GRANTEE who signed in.
 *     This is M2.4's subject.
 *   - `acted_by` — written by `recordActAsAuditEvent`
 *     (`lesser/cmd/api/handlers/agent_act_as.go:114`) from `ActAsResolution`:
 *     the real caller of a request that carried `X-Lesser-Act-As`, the in-CMS
 *     act-as path. contentus no longer offers that control (M2.1,
 *     equaltoai/contentus#92) but lesser still serves the records it wrote, and
 *     another client may still write them.
 *
 * Both name a human who drove the agent, so both are shown, labelled by
 * mechanism. ONE ROW CAN CARRY BOTH: `statuses.go:126-127` passes the SAME
 * metadata map to both writers in sequence, so the act-as row is marshalled
 * after `delegated_by` was already added to it. Where the two name different
 * people they are both real and neither is a correction of the other, so this
 * module keeps both rather than choosing.
 *
 * ON THE SHIPPED ACT-AS PATH THE TWO KEYS ARE ONE PERSON, and reading them as
 * two was this module's defect (codex review 4941720248 on
 * equaltoai/contentus#101). `ResolveActAs` does not receive a caller identity
 * from anywhere — it DERIVES one from the same claim the other writer used:
 *
 *     human  := strings.TrimSpace(claims.DelegatedBy)      // → delegated_by
 *     caller := strings.ToLower(strings.TrimPrefix(human, "@"))
 *     return &ActAsResolution{AgentUsername: agent, ActedBy: caller}
 *     (`lesser/pkg/auth/agent_act_as.go:79-111`)
 *
 * so on every dual-key row lesser actually writes, `acted_by` is `delegated_by`
 * with the sigil stripped and the case folded — ONE human in two spellings, not
 * two humans. lesser's own round test pins the pair: an agent-subject token with
 * `DelegatedBy: "@alice"` plus `X-Lesser-Act-As` writes
 * `{"delegated_by":"@alice","acted_by":"alice",…}`
 * (`lesser/cmd/api/handlers/agent_act_as_round_test.go:157-193`). Rendering that
 * row's drivers unmerged printed "@alice and @alice" and counted one action
 * twice. So a dual-key row naming ONE identity yields ONE driver, and the two
 * are kept apart only when they genuinely name two people — a state the shipped
 * path cannot reach but the contract permits, since `metadataJson` is an
 * unvalidated column any writer may have filled.
 *
 * IDENTITY IS COMPARED CASE-INSENSITIVELY BECAUSE LESSER SPELLS IT BOTH WAYS.
 * `resolveAgentClaims` keeps the stored owner form "byte-for-byte"
 * (`lesser/pkg/auth/oauth.go:595-599`) while `ActedBy` is `ToLower`ed, so the
 * same human reaches this client as `@Alice` and `alice` on one row. Folding
 * case is lesser's own rule for these values, not a liberty taken here: every
 * identity comparison in `pkg/auth/agent_owner.go` is `strings.EqualFold`.
 *
 * NOTHING HERE FILLS A BLANK. An action lesser recorded without naming a driver
 * is `unnamed`, never "the owner" — the owner is the likeliest driver and that
 * is exactly why guessing it would be believed. Metadata that will not parse is
 * `unreadable`, its own third answer, for the reason `share-view.ts` keeps an
 * `unreadable` bucket: both other answers are false sentences to the person
 * reading the screen.
 */

/** How a human drove the agent, per lesser's two attribution keys. */
export type DriverMechanism = 'mcp' | 'act-as';

/** One human lesser named on one action. */
export interface ActionDriver {
	/** Display identity, sigil decided by `driverLabel`. */
	label: string;
	mechanism: DriverMechanism;
}

/** What this client could establish about who drove one recorded action. */
export type DriverAttribution = 'named' | 'unnamed' | 'unreadable';

/** One row of lesser's agent activity log, as much as it can be read. */
export interface AgentAction {
	eventId: string;
	/**
	 * lesser's own event token (`agent.status.create`, `agent.share.revoke`).
	 * Shown VERBATIM. lesser owns this vocabulary and adds to it without asking
	 * this client, so a local gloss table would mislabel — silently, and as
	 * confidently as it labels the ones it knows — every event type added after
	 * the table was written.
	 */
	action: string;
	targetId: string | null;
	/** null when lesser served a timestamp this client could not read. */
	at: Date | null;
	/** Empty when `attribution` is not `named`. */
	drivers: ActionDriver[];
	attribution: DriverAttribution;
}

/** One human, and the actions in this read that name them. */
export interface AgentDriverSummary {
	label: string;
	/** Every mechanism this driver was named through, in encounter order. */
	mechanisms: DriverMechanism[];
	/** Actions in this read naming them. Never a claim about the whole window. */
	actions: number;
	/** Their most recent named action in this read, or null if none carried a time. */
	latest: Date | null;
}

/** What one read of the activity log established. */
export interface AgentDriverLedger {
	/** Distinct drivers, most recently active first (see `driverLedger`). */
	drivers: AgentDriverSummary[];
	/** Every action read, newest first — lesser's order, kept. */
	actions: AgentAction[];
	/** Actions lesser recorded without naming a driver. */
	unnamed: number;
	/** Actions whose metadata this client could not read. */
	unreadable: number;
	/** lesser had older actions this read did not fetch. */
	more: boolean;
}

/**
 * The display form of an identity lesser recorded, or null.
 *
 * THE TWO KEYS ARE SPELLED DIFFERENTLY AT THE SOURCE, which is the whole reason
 * this is a function rather than an `@{...}` in the template. `acted_by` is a
 * bare canonical username (`ActedBy is the canonical username of the real
 * authenticated caller`, `lesser/pkg/auth/agent_act_as.go:35`), while
 * `delegated_by` has been through `normalizeDelegatedBy`
 * (`lesser/pkg/auth/oauth.go:511`), which PREPENDS `@` to anything that lacks
 * it. Rendering `@{value}` over both would print `@@ada` for half the log.
 *
 * AND `normalizeDelegatedBy` PREPENDS TO A URL TOO. An agent owner stored in
 * actor-URL form is carried through `DelegatedBy` in that form
 * (`lesser/pkg/auth/agent_owner.go:5-9`), so the stored value can be
 * `@https://instance/users/ada` — a string that is not an identity anyone
 * reads. One leading `@` is stripped, and a remainder that is a URL is shown as
 * the URL: this chooses the SIGIL, never the identity, and an unrecognizable
 * value is still shown as it arrived rather than dropped, because a driver this
 * client cannot pretty-print is still a driver the owner needs to see.
 */
export function driverLabel(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const core = (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).trim();
	if (!core) return null;
	return core.includes('://') ? core : `@${core}`;
}

/**
 * The identity two labels share, or do not — the key one human folds under.
 *
 * SEPARATE FROM THE LABEL BECAUSE THE SPELLING IS NOT THE IDENTITY. `driverLabel`
 * settles the sigil; this settles the case, which lesser varies on the same
 * person within a single row (`@Alice` from the byte-for-byte owner form,
 * `alice` from the `ToLower`ed `ActedBy`). Comparing labels directly split one
 * driver into two roster lines and counted their actions apart.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: this must fold the way lesser's
 * `strings.ToLower` folded when it wrote the value, which is locale-independent.
 * A key that changed with the reader's locale would fold two identities together
 * on one machine and not on another.
 */
export function driverKey(label: string): string {
	return label.toLowerCase();
}

/** A timestamp lesser served, or null when it served nothing usable. */
function servedMoment(value: unknown): Date | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const moment = new Date(value);
	return Number.isNaN(moment.getTime()) ? null : moment;
}

/**
 * The drivers named in one row's metadata, and whether it could be read at all.
 *
 * `metadataJson` REACHES THIS CLIENT UNVALIDATED. lesser stores the metadata as
 * a string and the resolver hands back whatever is in that column without
 * parsing it (`agentActivityMetadataPtr`,
 * `lesser/graph/agent_resolvers_stubs.go:489`) — the REST sibling of this route
 * wraps an unparseable value as `{"raw": …}`, the GraphQL one does not. So a
 * parse failure here is a state the contract permits, and it is `unreadable`
 * rather than a driverless action: those are different facts and only one of
 * them is "nobody drove this".
 *
 * An ABSENT metadata string is not unreadable — it is lesser recording an
 * action with no metadata at all, which is a row that names no driver.
 */
export function actionDrivers(metadataJson: unknown): {
	drivers: ActionDriver[];
	attribution: DriverAttribution;
} {
	if (metadataJson === null || metadataJson === undefined) {
		return { drivers: [], attribution: 'unnamed' };
	}
	if (typeof metadataJson !== 'string') return { drivers: [], attribution: 'unreadable' };
	const raw = metadataJson.trim();
	if (!raw) return { drivers: [], attribution: 'unnamed' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { drivers: [], attribution: 'unreadable' };
	}
	// A JSON scalar or array parses fine and carries no keys. It is still
	// metadata this client cannot read the attribution out of, which is the
	// same answer as a syntax error and not the same answer as "no driver".
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { drivers: [], attribution: 'unreadable' };
	}

	const fields = parsed as Record<string, unknown>;
	const drivers: ActionDriver[] = [];
	// `delegated_by` first: it is the MCP driver, which is what this view is
	// about, and on a row carrying both it is the one that answers the heading.
	const delegated = driverLabel(fields['delegated_by']);
	const acted = driverLabel(fields['acted_by']);

	if (delegated && acted && driverKey(delegated) === driverKey(acted)) {
		// ONE HUMAN, TWO SPELLINGS — the shipped act-as row. It is merged HERE, in
		// the reader, because this is the only place that knows the two keys came
		// off ONE row: by the time `driverLedger` sees them they are two entries
		// among many and merging would have to guess which pair shared a row.
		// Merging here also settles both symptoms at once, since the per-action
		// "by …" line and the roster count both read this array.
		//
		// THE MECHANISM IS `act-as`, WHICH IS THE ONE THE ROW ACTUALLY RECORDS.
		// `acted_by` is written only by `recordActAsAuditEvent`, which fires only
		// on a validated `X-Lesser-Act-As` request, so the act-as channel is
		// certain. `delegated_by` is on this row because the map was shared, and
		// it carries a claim EVERY agent token holds whatever channel it came
		// through — so it is not evidence of an MCP sign-in, and labelling this
		// action as one would invent a connection that did not happen. Nothing is
		// lost: a real MCP action writes a `delegated_by`-only row, which still
		// contributes `mcp` to this driver in the fold.
		//
		// The label kept is `delegated_by`'s. It is the form the instance stores
		// for that human, and keeping it folds this row together with their
		// `delegated_by`-only rows rather than beside them.
		drivers.push({ label: delegated, mechanism: 'act-as' });
	} else {
		if (delegated) drivers.push({ label: delegated, mechanism: 'mcp' });
		if (acted) drivers.push({ label: acted, mechanism: 'act-as' });
	}

	return { drivers, attribution: drivers.length ? 'named' : 'unnamed' };
}

/** One activity edge's node, read into an `AgentAction`, or null. */
export function toAgentAction(node: unknown): AgentAction | null {
	if (typeof node !== 'object' || node === null || Array.isArray(node)) return null;
	const fields = node as Record<string, unknown>;

	const eventId = typeof fields['eventId'] === 'string' ? fields['eventId'].trim() : '';
	const action = typeof fields['action'] === 'string' ? fields['action'].trim() : '';
	// Both are non-null in the schema. A node missing either is an instance
	// disagreeing with the contract it publishes, and there is nothing to show
	// for it — not an entry with a blank where the event should be.
	if (!eventId || !action) return null;

	const targetId = typeof fields['targetId'] === 'string' ? fields['targetId'].trim() : '';
	const { drivers, attribution } = actionDrivers(fields['metadataJson']);

	return {
		eventId,
		action,
		targetId: targetId || null,
		at: servedMoment(fields['timestamp']),
		drivers,
		attribution,
	};
}

/**
 * Fold one read of the activity log into the drivers it names.
 *
 * LESSER'S ORDER IS KEPT AND NOTHING IS RE-SORTED, which is also what makes the
 * driver order meaningful. The resolver sorts the events newest-first before
 * paginating (`agentActivityEventsFromAuditLogs`,
 * `lesser/graph/agent_resolvers_stubs.go:427-440`), so FIRST SEEN IS MOST
 * RECENTLY ACTIVE and encounter order already is the order the panel wants.
 * Re-sorting by `latest` would order the roster by a field this module has just
 * established may be absent — the same trap `share-view.ts` refused when it
 * declined to sort the grant list by `revoked_at`.
 *
 * A DRIVER'S COUNT IS ACTIONS THAT NAME THEM, not actions they performed. Those
 * differed on every dual-key row until the reader stopped counting one human
 * twice; they still differ wherever a row genuinely names two people.
 *
 * THE FOLD KEYS ON IDENTITY, NOT ON SPELLING, which is the cross-row half of the
 * defect `actionDrivers` fixes within one row. lesser writes the same human as
 * `@Alice` on a delegated-token row and as `alice` on an act-as-only row
 * (`interactions.go:349`, `misc.go:1806` pass no shared map, so those rows carry
 * `acted_by` alone), and keying on the label put one person on two roster lines
 * with their actions split between them. The label DISPLAYED is the first one
 * encountered: newest-first order makes that their most recent spelling.
 */
export function driverLedger(
	nodes: readonly unknown[],
	options: { more?: boolean } = {}
): AgentDriverLedger {
	const actions: AgentAction[] = [];
	const byIdentity = new Map<string, AgentDriverSummary>();
	let unnamed = 0;
	let unreadable = 0;

	for (const node of nodes) {
		const parsed = toAgentAction(node);
		if (!parsed) continue;
		actions.push(parsed);

		if (parsed.attribution === 'unnamed') unnamed += 1;
		else if (parsed.attribution === 'unreadable') unreadable += 1;

		for (const driver of parsed.drivers) {
			const existing = byIdentity.get(driverKey(driver.label));
			if (!existing) {
				byIdentity.set(driverKey(driver.label), {
					label: driver.label,
					mechanisms: [driver.mechanism],
					actions: 1,
					latest: parsed.at,
				});
				continue;
			}
			existing.actions += 1;
			if (!existing.mechanisms.includes(driver.mechanism)) {
				existing.mechanisms.push(driver.mechanism);
			}
			// Newest-first order means the first timestamp seen for a driver is
			// already their latest; a later row only fills a gap left by a row
			// whose timestamp did not parse.
			if (!existing.latest) existing.latest = parsed.at;
		}
	}

	return {
		drivers: [...byIdentity.values()],
		actions,
		unnamed,
		unreadable,
		more: options.more === true,
	};
}

/**
 * What the owner is told when no driver was named, or null when some was.
 *
 * AN EMPTY DRIVER LIST IS NOT AN EMPTY ANSWER, which is this function and the
 * lesson M2.3 paid for (equaltoai/contentus#100, codex review 4941340448).
 * There are three ways to arrive at no drivers and they are three different
 * statements:
 *
 *   - lesser recorded no actions at all — the only case where "nobody has
 *     driven this agent" is lesser's own statement rather than this client's
 *     guess, and even then only for the window lesser keeps;
 *   - it recorded actions and named a driver on none of them — the agent ran,
 *     and who drove it is not in what this instance served;
 *   - it served rows whose metadata could not be read — the driver may be
 *     named, in a value this client could not parse.
 *
 * The last two are never softened into the first. A caveat appended to a false
 * sentence is still the false sentence.
 */
export function noDriverStatement(username: string, ledger: AgentDriverLedger): string | null {
	if (ledger.drivers.length) return null;

	if (ledger.unreadable) {
		const rows =
			ledger.unreadable === 1
				? 'one action whose details could not be read'
				: `${ledger.unreadable} actions whose details could not be read`;
		return `No driver could be established for @${username}. This instance served ${rows}, so this is not a statement that nobody has driven it.`;
	}

	if (ledger.actions.length) {
		const acted =
			ledger.actions.length === 1
				? 'recorded one action for'
				: `recorded ${ledger.actions.length} actions for`;
		return `This instance ${acted} @${username} without naming who drove them.`;
	}

	return `This instance has recorded no actions for @${username} in the activity it keeps.`;
}

/**
 * What to say about actions that named nobody, alongside drivers that were
 * named, or null.
 *
 * Separate from `noDriverStatement` because it is a different sentence in a
 * different place: that one replaces the roster, this one qualifies it. A
 * roster shown without it reads as the complete set of people who have driven
 * the agent, which it is not whenever a single row went unattributed.
 */
export function partialAttributionNotice(ledger: AgentDriverLedger): string | null {
	if (!ledger.drivers.length) return null;

	const clauses: string[] = [];
	if (ledger.unnamed) {
		clauses.push(ledger.unnamed === 1 ? 'one names no driver' : `${ledger.unnamed} name no driver`);
	}
	if (ledger.unreadable) {
		clauses.push(
			ledger.unreadable === 1
				? 'one has details that could not be read'
				: `${ledger.unreadable} have details that could not be read`
		);
	}
	if (!clauses.length) return null;

	return `Of the actions below, ${clauses.join(' and ')}, so this list is not everyone who has driven this agent.`;
}

/**
 * "3 actions, most recently 4 Aug 2026" — one driver's line in the roster.
 *
 * EVERY CLAUSE IS DROPPED RATHER THAN DEFAULTED, the rule `grantStamp` follows
 * one module over: a driver whose rows all carried unreadable timestamps gets
 * the count alone, never "most recently recently" or today's date standing in
 * for a time lesser did not serve.
 *
 * The count is deliberately not called a total. It counts what THIS READ saw,
 * and the panel names that boundary once, above the roster, rather than
 * repeating a qualifier on every line.
 */
export function driverStamp(
	summary: AgentDriverSummary,
	formatDate: (moment: Date) => string = (moment) => moment.toLocaleDateString()
): string {
	const actions = summary.actions === 1 ? '1 action' : `${summary.actions} actions`;
	return summary.latest ? `${actions}, most recently ${formatDate(summary.latest)}` : actions;
}

/**
 * How a driver reached the agent, in the owner's terms rather than lesser's
 * key names.
 *
 * A CLOSED TABLE OVER A CLOSED SET. Unlike `action`, whose vocabulary lesser
 * extends freely, the mechanism comes from this module's own two-key reader —
 * so every value here is one this file produced, and the union type makes a
 * third one a type error rather than a silent blank.
 */
export function mechanismLabel(mechanism: DriverMechanism): string {
	return mechanism === 'mcp'
		? "signed in to the agent's MCP"
		: 'acted as the agent in a CMS client';
}

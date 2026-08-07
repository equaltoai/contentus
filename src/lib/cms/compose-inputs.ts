/**
 * lesser's status write inputs, and the GraphQL variables built from them.
 *
 * Split out of `cms/compose.ts` for the reason `cms/visibility.ts` was never
 * folded into it: these functions decide WHAT ACTUALLY GOES OVER THE WIRE —
 * which reach, which flags, which fields are present at all — and a rule that
 * consequential deserves a probe that loads the shipped code directly, with no
 * bundler and no alias resolver in between. The network calls, their auth, and
 * their failure taxonomy stay in `cms/compose.ts`; this module has no imports
 * beyond a type.
 *
 * OMITTED IS NOT NULL, AND BOTH ARE MEANINGFUL. lesser reads optional input
 * fields with `input.X != nil` checks, so for a CREATE an absent field and an
 * explicit null mean the same thing to the resolver — and only the absent form
 * says the composer had nothing to say about it. For an UPDATE they mean
 * opposite things: `updateStatus` starts from the stored status
 * (`graph/mutation_resolvers_statuses_parity.go` reads `current.Sensitive` and
 * `current.Note.Summary` first), so an omitted field PRESERVES and a present
 * one REPLACES. That asymmetry is why the two builders below differ, and it is
 * the whole of the difference between them.
 */

import type { LesserVisibility } from './visibility';

/**
 * The `triggerType` values lesser accepts, verbatim and in full.
 *
 * `buildAgentPostAttribution` (lesser `graph/mutation_resolvers_notes.go`)
 * lower-cases and trims the input, then looks it up in
 * `allowedAgentAttributionTriggerTypes` and returns a validation error —
 * "must be one of: scheduled, mention, hashtag_watch, manual" — for anything
 * else. It is a closed set, not a hint, so a free-text box over it is a
 * control that turns a valid post into a rejected one.
 *
 * An empty trigger is not in the list and is not sent: lesser defaults the
 * field to `manual` when the input omits it, and saying so beats making the
 * poster pick a word for "I just wrote it".
 */
export const AGENT_TRIGGER_TYPES = ['scheduled', 'mention', 'hashtag_watch', 'manual'] as const;

export type AgentTriggerType = (typeof AGENT_TRIGGER_TYPES)[number];

/** The value lesser records when `triggerType` is absent. */
export const AGENT_TRIGGER_DEFAULT: AgentTriggerType = 'manual';

/** lesser `PollParamsInput`. */
export interface PollParamsInput {
	options: string[];
	expiresIn: number;
	multiple?: boolean;
	hideTotals?: boolean;
}

/**
 * lesser `AgentPostAttributionInput`.
 *
 * The full input shape, because that is what the schema declares — and as of
 * lesser v1.6.0 the schema declares exactly these three fields.
 *
 * This type used to carry six more (`delegatedBy`, `delegatedByDid`, `scopes`,
 * `constraints`, `schemaVersion`, `modelId`) on the reasoning that mirroring
 * the whole declared input was the contract-faithful thing to do, with a note
 * that lesser silently discarded values for them. v1.6.0 removed them from the
 * input type outright: they are server-derived from the caller's token claims
 * and the agent's own account, so accepting them as input was offering callers
 * a lever attached to nothing. They are still present on the OUTPUT type
 * `AgentPostAttribution`, which is where they were always actually populated.
 *
 * Dropping them here is a contract sync, not a feature removal: nothing in
 * contentus ever populated one, so no composer behavior changes. What changes
 * is that the type can no longer describe a mutation lesser would now reject —
 * sending a removed field is a GraphQL validation error, not a silent discard.
 * The composer offers controls for none of these; see
 * `$lib/compose/AgentAttributionField`.
 */
export interface AgentPostAttributionInput {
	triggerType?: string;
	triggerDetails?: string;
	memoryCitations?: string[];
}

/**
 * lesser `CreateNoteInput`, minus `contentMap`, `mentions`, and `tags`.
 *
 * `mentions`/`tags` are omitted because `buildCreateNoteCommand` never reads
 * them — the service extracts both from the content itself — so sending them
 * would make the composer look like it had an effect it does not have.
 * `contentMap` is lesser's per-language content variant, which contentus has
 * no control for; adding one is a product decision, not a gap to paper over.
 */
export interface CreateNoteInput {
	content: string;
	visibility: LesserVisibility;
	sensitive?: boolean;
	spoilerText?: string;
	attachmentIds?: string[];
	poll?: PollParamsInput;
	inReplyToId?: string;
	quoteId?: string;
	agentAttribution?: AgentPostAttributionInput;
}

/**
 * lesser `UpdateStatusInput`. No visibility and no poll: a posted status keeps
 * its reach, and a poll with votes is not rewritten underneath them.
 *
 * `spoilerText` is `string | undefined` and the empty string is a REAL value
 * here — it is the only way the contract offers to remove a content warning.
 */
export interface UpdateStatusInput {
	content: string;
	sensitive?: boolean;
	spoilerText?: string;
	language?: string;
	attachmentIds?: string[];
}

/** lesser `ScheduleStatusInput`. */
export interface ScheduleStatusInput {
	text: string;
	scheduledAt: string;
	visibility?: LesserVisibility;
	sensitive?: boolean;
	spoilerText?: string;
	inReplyToId?: string;
	language?: string;
	mediaIds?: string[];
	poll?: PollParamsInput;
}

/**
 * Variables for `createNote`.
 *
 * Optional fields are omitted rather than sent as null, and an empty spoiler
 * is omitted rather than sent: a new post carrying `spoilerText: ""` would be
 * asserting a warning it does not have.
 */
export function createNoteVariables(input: CreateNoteInput): { input: Record<string, unknown> } {
	const payload: Record<string, unknown> = {
		content: input.content,
		visibility: input.visibility,
	};

	if (input.sensitive !== undefined) payload['sensitive'] = input.sensitive;
	if (input.spoilerText) payload['spoilerText'] = input.spoilerText;
	if (input.attachmentIds?.length) payload['attachmentIds'] = input.attachmentIds;
	if (input.poll) payload['poll'] = input.poll;
	if (input.inReplyToId) payload['inReplyToId'] = input.inReplyToId;
	if (input.quoteId) payload['quoteId'] = input.quoteId;
	if (input.agentAttribution) payload['agentAttribution'] = input.agentAttribution;

	return { input: payload };
}

/**
 * Variables for `updateStatus`.
 *
 * `spoilerText` is sent whenever it is DEFINED, empty string included. That
 * one difference from `createNoteVariables` is the difference between an edit
 * that can remove a content warning and one that cannot: the resolver seeds
 * `spoilerText` from the stored status and overwrites it only when the input
 * carries the field, so omitting an emptied warning leaves the old one
 * standing on a post whose composer showed no warning at all.
 *
 * `sensitive` follows the same rule and always has — but the flag is only
 * honest if the value being sent was seeded from the status in the first
 * place, which is the caller's job and now `$lib/compose/seed`'s.
 */
export function updateStatusVariables(
	id: string,
	input: UpdateStatusInput
): { id: string; input: Record<string, unknown> } {
	const payload: Record<string, unknown> = { content: input.content };

	if (input.sensitive !== undefined) payload['sensitive'] = input.sensitive;
	if (input.spoilerText !== undefined) payload['spoilerText'] = input.spoilerText;
	if (input.language) payload['language'] = input.language;
	if (input.attachmentIds?.length) payload['attachmentIds'] = input.attachmentIds;

	return { id, input: payload };
}

/**
 * Variables for `scheduleStatus`.
 *
 * A create, not an update — the status does not exist yet — so it follows
 * `createNoteVariables`' omission rules. Note the shape differences, which are
 * lesser's and not ours: the body is `text`, attachments are `mediaIds`, and
 * there is no `quoteId` and no `agentAttribution`.
 */
export function scheduleStatusVariables(input: ScheduleStatusInput): {
	input: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		text: input.text,
		scheduledAt: input.scheduledAt,
	};

	if (input.visibility) payload['visibility'] = input.visibility;
	if (input.sensitive !== undefined) payload['sensitive'] = input.sensitive;
	if (input.spoilerText) payload['spoilerText'] = input.spoilerText;
	if (input.inReplyToId) payload['inReplyToId'] = input.inReplyToId;
	if (input.language) payload['language'] = input.language;
	if (input.mediaIds?.length) payload['mediaIds'] = input.mediaIds;
	if (input.poll) payload['poll'] = input.poll;

	return { input: payload };
}

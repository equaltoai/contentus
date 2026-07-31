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
 * The full input shape, because that is what the schema declares. Only
 * `triggerType`, `triggerDetails`, and `memoryCitations` are ever READ by
 * `buildAgentPostAttribution` (lesser `graph/mutation_resolvers_notes.go`);
 * the rest — `delegatedBy`, `scopes`, `constraints`, `schemaVersion`,
 * `modelId` — are derived from the caller's token claims and the agent's own
 * account, and an input value for any of them is silently discarded. The
 * composer therefore offers controls for none of those; see
 * `$lib/compose/AgentAttributionField`.
 */
export interface AgentPostAttributionInput {
	triggerType?: string;
	triggerDetails?: string;
	memoryCitations?: string[];
	delegatedBy?: string;
	delegatedByDid?: string;
	scopes?: string[];
	constraints?: string[];
	schemaVersion?: string;
	modelId?: string;
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

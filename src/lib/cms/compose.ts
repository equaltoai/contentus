/**
 * Write operations against lesser's status contract (product design §5, face 3).
 *
 * Every input field below exists in lesser `graph/core.graphql`
 * (`CreateNoteInput`, `Visibility`, `PollParamsInput`,
 * `AgentPostAttributionInput`). Nothing here is speculative and nothing is
 * derived: contentus sends what the poster chose and lets lesser decide what it
 * means.
 *
 * AUTH. Every operation in this module requires an authenticated caller —
 * lesser's `createNote` resolver opens with `requireAuth`. The token lives in
 * `sessionStorage`, so these run in the browser and never on the server; the
 * SSR pass renders the composer's chrome and its signed-out state, not a post.
 *
 * TWO CONTRACT OBSERVATIONS, recorded rather than worked around:
 *
 *   1. `CreateNoteInput` exposes `mentions: [String!]` and `tags: [String!]`,
 *      but `buildCreateNoteCommand` (lesser `graph/mutation_resolvers_notes.go`)
 *      never reads either field. The service extracts both from the content
 *      itself (`mastodon.ExtractHashtagsWithCase`, `common.ExtractMentions`).
 *      Contentus therefore does NOT send them: a field the server drops would
 *      make the composer look like it had an effect it does not have. The
 *      autocomplete affordance writes `@handle` and `#tag` into the content
 *      text, which is the path that actually works. The unused input fields are
 *      an upstream observation for the lesser steward.
 *
 *   2. `sensitive` and `spoilerText` are independent in the contract — the
 *      resolver reads `input.Sensitive` on its own and never derives it from a
 *      spoiler being present. The composer surfaces them as two first-class
 *      controls for exactly that reason. Coupling them here would be contentus
 *      inventing a semantic lesser does not have.
 */

import { accessTokenOrNull } from '$lib/auth/session';

import { graphqlRequest, GraphQLTransportError, type GraphQLError } from './graphql';

// The visibility mapping lives in its own dependency-free module so a test can
// load it without a bundler between the assertion and the shipped code — it is
// the field that decides who can see a post.
export {
	LESSER_VISIBILITIES,
	VISIBILITY_DESCRIPTIONS,
	fromLesserVisibility,
	toLesserVisibility,
} from './visibility';
export type { ComposeVisibility, LesserVisibility } from './visibility';

import type { LesserVisibility } from './visibility';

/** lesser `PollParamsInput`. */
export interface PollParamsInput {
	options: string[];
	expiresIn: number;
	multiple?: boolean;
	hideTotals?: boolean;
}

/** lesser `AgentPostAttributionInput`. */
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
 * `mentions`/`tags` are omitted for the reason recorded at the top of this file.
 * `contentMap` is lesser's per-language content variant, which contentus has no
 * control for; adding one is a product decision, not a gap to paper over.
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
 * The subset of lesser's `Object` a composer needs back.
 *
 * Deliberately shallow. The composer's job after a successful post is to
 * confirm what was created and link to it — not to render a status card, which
 * is face 4's component and face 4's query.
 */
export interface CreatedNote {
	id: string;
	content: string;
	visibility: LesserVisibility;
	sensitive: boolean;
	spoilerText: string | null;
	createdAt: string;
}

const CREATED_NOTE_FIELDS = `
	id
	content
	visibility
	sensitive
	spoilerText
	createdAt
`;

export const CREATE_NOTE_MUTATION = `
	mutation ContentusCreateNote($input: CreateNoteInput!) {
		createNote(input: $input) {
			object { ${CREATED_NOTE_FIELDS} }
		}
	}
`;

/**
 * Why a write did not happen. The composer renders these differently: a
 * contract rejection is the poster's to fix, a transport failure is worth
 * retrying, and an unauthenticated caller needs to sign in rather than edit
 * anything.
 */
export type ComposeFailureReason = 'unauthenticated' | 'rejected' | 'transport';

export interface ComposeFailure {
	reason: ComposeFailureReason;
	message: string;
}

export type ComposeResult<T> = { ok: true; value: T } | { ok: false; failure: ComposeFailure };

/**
 * Whether a GraphQL error set says the caller is not authenticated.
 *
 * lesser's resolvers reject with `requireAuth`'s error before touching the
 * request, so this is a sign-in prompt rather than a validation message.
 */
function isAuthError(errors: GraphQLError[]): boolean {
	return errors.some((error) => {
		const message = error.message.toLowerCase();
		const code = String(error.extensions?.['code'] ?? '').toLowerCase();
		return (
			code === 'unauthenticated' ||
			code === 'unauthorized' ||
			message.includes('authentication required') ||
			message.includes('unauthenticated') ||
			message.includes('not authenticated')
		);
	});
}

function failureFromErrors(errors: GraphQLError[]): ComposeFailure {
	if (isAuthError(errors)) {
		return {
			reason: 'unauthenticated',
			message: 'Your session has expired. Sign in again to post.',
		};
	}
	return {
		reason: 'rejected',
		message: errors[0]?.message ?? 'The instance rejected this post.',
	};
}

function failureFromThrown(error: unknown): ComposeFailure {
	if (error instanceof GraphQLTransportError) {
		return {
			reason: 'transport',
			message: 'The instance did not answer. This is usually temporary — try again shortly.',
		};
	}
	return {
		reason: 'transport',
		message: error instanceof Error ? error.message : 'The post could not be sent.',
	};
}

/**
 * Run an authenticated write, or report why it could not run.
 *
 * The token check happens before the request rather than after a rejection: a
 * signed-out composer should say so instead of spending a round trip to be told.
 */
async function authenticatedWrite<T>(
	document: string,
	variables: Record<string, unknown>,
	extract: (data: unknown) => T | null
): Promise<ComposeResult<T>> {
	const accessToken = accessTokenOrNull();
	if (!accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to post to this instance.' },
		};
	}

	try {
		const result = await graphqlRequest<unknown>(document, variables, { accessToken });

		if (result.errors.length > 0) {
			return { ok: false, failure: failureFromErrors(result.errors) };
		}

		const value = extract(result.data);
		if (value === null) {
			return {
				ok: false,
				failure: {
					reason: 'rejected',
					message: 'The instance accepted the request but returned nothing to confirm it.',
				},
			};
		}

		return { ok: true, value };
	} catch (error) {
		return { ok: false, failure: failureFromThrown(error) };
	}
}

function toCreatedNote(raw: unknown): CreatedNote | null {
	if (!raw || typeof raw !== 'object') return null;
	const object = raw as Record<string, unknown>;
	if (typeof object['id'] !== 'string' || object['id'].length === 0) return null;

	return {
		id: object['id'],
		content: typeof object['content'] === 'string' ? object['content'] : '',
		visibility:
			(String(object['visibility'] ?? 'PUBLIC').toUpperCase() as LesserVisibility) ?? 'PUBLIC',
		sensitive: object['sensitive'] === true,
		spoilerText: typeof object['spoilerText'] === 'string' ? object['spoilerText'] : null,
		createdAt: typeof object['createdAt'] === 'string' ? object['createdAt'] : '',
	};
}

/**
 * Build the GraphQL variables for `createNote`.
 *
 * Optional fields are omitted rather than sent as null. lesser reads them with
 * `input.X != nil` checks, so an explicit null and an absent field mean the same
 * thing to the resolver — but only the absent form says the composer had nothing
 * to say about it, which is what the poster actually expressed.
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

export async function createNote(input: CreateNoteInput): Promise<ComposeResult<CreatedNote>> {
	return authenticatedWrite(CREATE_NOTE_MUTATION, createNoteVariables(input), (data) =>
		toCreatedNote((data as { createNote?: { object?: unknown } } | null)?.createNote?.object)
	);
}

/* -------------------------------------------------------------------------
 * Editing, deleting, and scheduling
 * ---------------------------------------------------------------------- */

/** lesser `UpdateStatusInput`. No visibility: a posted status keeps its reach. */
export interface UpdateStatusInput {
	content: string;
	sensitive?: boolean;
	spoilerText?: string;
	language?: string;
	attachmentIds?: string[];
}

const UPDATE_STATUS_MUTATION = `
	mutation ContentusUpdateStatus($id: ID!, $input: UpdateStatusInput!) {
		updateStatus(id: $id, input: $input) { ${CREATED_NOTE_FIELDS} }
	}
`;

const DELETE_OBJECT_MUTATION = `
	mutation ContentusDeleteObject($id: ID!) {
		deleteObject(id: $id)
	}
`;

const SCHEDULE_STATUS_MUTATION = `
	mutation ContentusScheduleStatus($input: ScheduleStatusInput!) {
		scheduleStatus(input: $input) {
			id
			scheduledAt
			createdAt
		}
	}
`;

/**
 * Edit a posted status.
 *
 * `UpdateStatusInput` carries no visibility and no poll, which is the contract
 * stating that neither is editable after the fact — a status that federated as
 * public cannot be quietly narrowed, and a poll with votes cannot be rewritten
 * underneath them. The composer's edit mode therefore hides both rather than
 * offering controls whose changes would be dropped.
 */
export async function updateStatus(
	id: string,
	input: UpdateStatusInput
): Promise<ComposeResult<CreatedNote>> {
	const payload: Record<string, unknown> = { content: input.content };
	if (input.sensitive !== undefined) payload['sensitive'] = input.sensitive;
	if (input.spoilerText) payload['spoilerText'] = input.spoilerText;
	if (input.language) payload['language'] = input.language;
	if (input.attachmentIds?.length) payload['attachmentIds'] = input.attachmentIds;

	return authenticatedWrite(UPDATE_STATUS_MUTATION, { id, input: payload }, (data) =>
		toCreatedNote((data as { updateStatus?: unknown } | null)?.updateStatus)
	);
}

/**
 * Delete a status. Irreversible, and the composer confirms before calling it.
 *
 * lesser returns a bare `Boolean!`, so a `false` is a refusal without a reason.
 * That is reported as a refusal rather than dressed up as an error.
 */
export async function deleteObject(id: string): Promise<ComposeResult<true>> {
	return authenticatedWrite(DELETE_OBJECT_MUTATION, { id }, (data) =>
		(data as { deleteObject?: unknown } | null)?.deleteObject === true ? true : null
	);
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

export interface ScheduledStatus {
	id: string;
	scheduledAt: string;
}

/**
 * Schedule a status for later.
 *
 * Note the shape differences from `createNote`, which are lesser's and not
 * ours: the body is `text`, attachments are `mediaIds`, and there is no
 * `quoteId` and no `agentAttribution`. The composer disables quoting when a
 * schedule is set rather than silently dropping the quote — the contract has no
 * way to express a scheduled quote post, so neither does the UI.
 */
export async function scheduleStatus(
	input: ScheduleStatusInput
): Promise<ComposeResult<ScheduledStatus>> {
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

	return authenticatedWrite(SCHEDULE_STATUS_MUTATION, { input: payload }, (data) => {
		const scheduled = (data as { scheduleStatus?: Record<string, unknown> } | null)?.scheduleStatus;
		if (!scheduled || typeof scheduled['id'] !== 'string') return null;
		return {
			id: scheduled['id'],
			scheduledAt:
				typeof scheduled['scheduledAt'] === 'string' ? scheduled['scheduledAt'] : input.scheduledAt,
		};
	});
}

/* -------------------------------------------------------------------------
 * Reading the source status and the viewer
 * ---------------------------------------------------------------------- */

/**
 * The source status a reply, quote, or edit is anchored to.
 *
 * Deliberately shallow, and deliberately NOT rendered as a status card: face 4
 * owns that component and that query. What a composer needs is enough to show
 * the poster what they are answering.
 */
export interface SourceStatus {
	id: string;
	content: string;
	visibility: LesserVisibility;
	sensitive: boolean;
	spoilerText: string | null;
	authorUsername: string;
	authorDomain: string | null;
	authorDisplayName: string | null;
	createdAt: string;
	/** Present when the source itself was agent-generated. */
	agentAttributionLabel: string | null;
	attachmentIds: string[];
}

/**
 * `object(id:)` resolves through `optionalAuth`, so this works anonymously for
 * a public status and needs the token for anything narrower. Depth stays within
 * lesser's limit: object → actor → username is three.
 */
export const SOURCE_STATUS_QUERY = `
	query ContentusSourceStatus($id: ID!) {
		object(id: $id) {
			id
			content
			visibility
			sensitive
			spoilerText
			createdAt
			actor { id username domain displayName }
			attachments { id }
			agentAttribution { identityLabel triggerType }
		}
	}
`;

function toSourceStatus(raw: unknown): SourceStatus | null {
	if (!raw || typeof raw !== 'object') return null;
	const object = raw as Record<string, unknown>;
	if (typeof object['id'] !== 'string' || !object['id']) return null;

	const actor = (object['actor'] ?? {}) as Record<string, unknown>;
	const attribution = object['agentAttribution'] as Record<string, unknown> | null | undefined;
	const attachments = Array.isArray(object['attachments']) ? object['attachments'] : [];

	return {
		id: object['id'],
		content: typeof object['content'] === 'string' ? object['content'] : '',
		visibility: String(object['visibility'] ?? 'PUBLIC').toUpperCase() as LesserVisibility,
		sensitive: object['sensitive'] === true,
		spoilerText: typeof object['spoilerText'] === 'string' ? object['spoilerText'] : null,
		authorUsername: typeof actor['username'] === 'string' ? actor['username'] : '',
		authorDomain: typeof actor['domain'] === 'string' ? actor['domain'] : null,
		authorDisplayName: typeof actor['displayName'] === 'string' ? actor['displayName'] : null,
		createdAt: typeof object['createdAt'] === 'string' ? object['createdAt'] : '',
		agentAttributionLabel:
			attribution && typeof attribution['identityLabel'] === 'string'
				? attribution['identityLabel']
				: attribution && typeof attribution['triggerType'] === 'string'
					? attribution['triggerType']
					: null,
		attachmentIds: attachments.flatMap((entry) => {
			const id = (entry as Record<string, unknown> | null)?.['id'];
			return typeof id === 'string' ? [id] : [];
		}),
	};
}

/**
 * Load the status a compose intent points at.
 *
 * Runs on the server (anonymously, for the SSR pass) and again in the browser
 * with the session token. The server pass resolves public statuses, which is
 * most reply targets; anything narrower comes back null there and the client
 * fills it in. Returns null rather than throwing: a reply whose target could
 * not be loaded is still a reply, and the composer says so.
 */
export async function loadSourceStatus(
	id: string,
	options: { endpoint?: string | null; accessToken?: string | null } = {}
): Promise<SourceStatus | null> {
	if (!id) return null;

	try {
		const result = await graphqlRequest<{ object?: unknown }>(
			SOURCE_STATUS_QUERY,
			{ id },
			{
				...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
				...(options.accessToken ? { accessToken: options.accessToken } : {}),
			}
		);
		return toSourceStatus(result.data?.object);
	} catch {
		return null;
	}
}

/** Who the session belongs to, and whether lesser will treat it as an agent. */
export interface ComposeViewer {
	id: string;
	username: string;
	displayName: string | null;
	isAgent: boolean;
}

const VIEWER_QUERY = `
	query ContentusComposeViewer {
		viewer { id username displayName isAgent }
	}
`;

/**
 * The signed-in actor, or null.
 *
 * Used for one decision: whether to offer the agent-attribution panel. lesser
 * applies `agentAttribution` only when the CALLER'S TOKEN carries agent claims
 * (`graph/mutation_resolvers_notes.go` → `if claims.IsAgent`), and those claims
 * are not visible to a client. `Actor.isAgent` on the session's own actor is
 * the closest thing the contract exposes, and it is the right signal in
 * practice: an agent session authenticates as its agent actor.
 *
 * The distinction matters because the alternative is worse. Offering the panel
 * to every signed-in poster would put fields on screen that lesser silently
 * drops for a human caller — attribution theatre, on the one surface where
 * attribution honesty is the product.
 */
export async function loadComposeViewer(): Promise<ComposeViewer | null> {
	const accessToken = accessTokenOrNull();
	if (!accessToken) return null;

	try {
		const result = await graphqlRequest<{ viewer?: unknown }>(VIEWER_QUERY, {}, { accessToken });
		const viewer = result.data?.viewer as Record<string, unknown> | null | undefined;
		if (!viewer || typeof viewer['username'] !== 'string') return null;

		return {
			id: typeof viewer['id'] === 'string' ? viewer['id'] : '',
			username: viewer['username'],
			displayName: typeof viewer['displayName'] === 'string' ? viewer['displayName'] : null,
			isAgent: viewer['isAgent'] === true,
		};
	} catch {
		return null;
	}
}

/**
 * Read operations against lesser's agent surface (face 6).
 *
 * Every field selected here exists in lesser `docs/contracts/graphql-schema.graphql`
 * (`type Agent`, `type AgentMCPAccess`, `type AgentCapabilities`,
 * `AgentConnection`). Nothing is speculative: an agent property contentus wants
 * that lesser does not expose is an upstream issue, never a client-side
 * substitute.
 *
 * WHAT THE RESOLVER ACTUALLY DOES, because the roster's honesty depends on it
 * (lesser `graph/agent_resolvers_stubs.go`, `Agents`):
 *
 *   1. `ensureAgentsEnabled` gates the whole surface on instance policy. When
 *      agents are off, every field here errors — a designed state, not a fault.
 *   2. `ListAgents(limit, cursor)` fetches ONE PAGE, and `type`, `query` and
 *      `verified` are applied to that page AFTERWARDS. So `totalCount` counts
 *      matches IN THIS PAGE, not across the instance, and a filtered page can
 *      come back empty while `hasNextPage` is true. Both facts are load-bearing:
 *      presenting `totalCount` as an instance total, or an empty filtered page
 *      as "no such agents", would state something lesser never said.
 *   3. `ownerUsername` is NOT anonymous-safe. It requires a caller, `read`
 *      scope, and — unless the caller is an admin — a value equal to their own
 *      username. Everything else on this connection is anonymous-safe.
 *   4. Non-owners get `agentOwner`, `delegatedScopes` and the soul fields
 *      REDACTED (`redactGraphAgentPrivateFields`, lesser v1.6.4 commit
 *      7aad73d5a) — to null, to `[]`, and to `UNBOUND` — and lesser says that
 *      it did so in the same answer: `viewerCanSeePrivateFields` is false for
 *      them and true for the owner and admins. Redaction that looks like data
 *      is the trap this module exists to keep out of the UI, and the served
 *      boolean — never the values, never the request — is what tells the two
 *      cases apart: see `AgentViewerState` below.
 *   5. `viewerIsOwner` answers a SECOND question, and lesser added it because
 *      the first one was being made to answer both (lesser#1417, #1418, pinned
 *      here at 1ce2dc97). `viewerCanSeePrivateFields` is a VISIBILITY
 *      statement — true for the owner AND for admins — so it was never an
 *      ownership statement, and every client using it as one inherited the
 *      admin case silently. `viewerIsOwner` is computed from
 *      `auth.AgentOwnerMatchesLocalPrincipal`, the canonical server rule whose
 *      comparisons are `strings.EqualFold`, and is preserved across redaction
 *      the way `mcpAccess` is — so a non-owner receives a served `false`
 *      rather than a redacted blank. The two are kept apart here for the same
 *      reason lesser keeps `applyGraphAgentViewerOwnership` apart from
 *      `applyGraphAgentViewerState`: they are different questions, and a
 *      surface has to say which one it is asking.
 */

// Explicit `.ts` extension, matching `cms/review-transport.ts`: this module is
// loaded straight off disk by `node --test --experimental-strip-types` so the
// shipped adapters can be driven against a stubbed `fetch`, and Node's ESM
// resolver neither guesses extensions nor knows the `$lib` alias.
import { graphqlRequest, GraphQLTransportError } from '../cms/graphql.ts';

/** lesser `enum AgentType`. */
export const AGENT_TYPES = [
	'ASSISTANT',
	'CURATOR',
	'MODERATOR',
	'RESEARCHER',
	'BRIDGE',
	'CUSTOM',
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export function isAgentType(value: unknown): value is AgentType {
	return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value);
}

/**
 * lesser `AgentMCPAccess`.
 *
 * These URLs are lesser's to state, and contentus does not derive them.
 * simulacrum's `resolveMcpTransport` builds the same values client-side from
 * the page origin — `api.` host prefix, `/mcp/<actor>` path, the
 * protected-resource well-known beneath it — but that is a reimplementation of
 * `pkg/auth/mcp_access.go` (`BuildPublicMCPAccessBundle`,
 * `canonicalMCPResourceBaseURL`), which is the authority for exactly those
 * strings. Two copies of a rule cannot disagree only while they agree; this one
 * comes from the instance.
 */
export interface AgentMcpAccess {
	mcpURL: string | null;
	protectedResourceURL: string | null;
	authorizationServerURL: string | null;
	registrationURL: string | null;
	scopes: string[];
	guidance: string[];
}

/** lesser `AgentCapabilities`. */
export interface AgentCapabilities {
	canPost: boolean;
	canReply: boolean;
	canBoost: boolean;
	canFollow: boolean;
	canDM: boolean;
	maxPostsPerHour: number;
	requiresApproval: boolean;
	restrictedDomains: string[];
}

/**
 * The two statements lesser makes about the viewer who asked — kept apart,
 * because they are not the same statement and one of them used to stand in for
 * the other here.
 *
 * `canSeePrivateFields` is a VISIBILITY answer. lesser blanks `agentOwner`,
 * `delegatedScopes` and the soul-binding fields for anyone who is not the
 * agent's owner or an admin, and the blanked values are indistinguishable from
 * real ones — a null owner, an empty scope list, an `UNBOUND` soul state — so a
 * UI that renders them as facts reports "this agent has no owner and no scopes"
 * to every anonymous visitor, about every agent. This boolean is what tells the
 * two apart, and it is lesser's own served value carried through verbatim:
 * never a client inference from the values (which redaction makes ambiguous),
 * never from whether a token was sent (which says what was asked, not what was
 * answered). When false, the affected fields are absent from the view model
 * entirely instead of present-and-empty.
 *
 * `isOwner` is an OWNERSHIP answer, and it is a different question with a
 * different set of true cases: an ADMIN gets `canSeePrivateFields: true` and
 * `isOwner: false`, which is the case lesser pins in its own contract test
 * (`TestActorAgentInfoAppliesPrivateFieldPolicy`). Until lesser#1418 there was
 * no ownership field to read, so this module answered ownership with the
 * visibility boolean and every owner-only surface inherited the admin case.
 *
 * NEITHER IS DERIVED FROM THE OTHER, AND NEITHER IS DERIVED FROM A USERNAME.
 * The obvious client-side ownership test — compare the viewer's handle against
 * `agentOwner` — is a defect class rather than a shortcut: lesser stores the
 * owner form byte-for-byte while other surfaces lower-case it, so `@Alice` and
 * `alice` are one human wearing two spellings, and contentus has already been
 * bitten by exactly that in its activity log (M2.4). lesser folds case
 * internally (`strings.EqualFold`, `pkg/auth/agent_owner.go`); `isOwner` is
 * that rule's answer, served, so no client has to re-implement it and get it
 * wrong independently.
 */
export interface AgentViewerState {
	/** lesser's `viewerCanSeePrivateFields`. True for the owner AND for admins. */
	canSeePrivateFields: boolean;
	/** lesser's `viewerIsOwner`. True for the owner alone. */
	isOwner: boolean;
}

export interface AgentSummary {
	id: string;
	username: string;
	displayName: string;
	bio: string | null;
	agentType: AgentType;
	agentVersion: string | null;
	verified: boolean;
	verifiedAt: string | null;
	/** lesser's own quarantine projection. Never inferred from other fields. */
	quarantineStatus: string | null;
	quarantineStart: string | null;
	quarantineEnd: string | null;
	quarantineActive: boolean;
	createdAt: string | null;
	activityCount: number;
	capabilities: AgentCapabilities | null;
	mcpAccess: AgentMcpAccess | null;
	/**
	 * The redacted fields, present only when lesser served them to this viewer.
	 * Absent — not empty — for everyone else, because lesser redacts rather than
	 * reports.
	 *
	 * KEYED ON VISIBILITY, NOT ON OWNERSHIP, and that is correct: these are the
	 * values redaction acts on, so the question "may I render them" is exactly
	 * `canSeePrivateFields`. An admin sees them and is not the owner. A surface
	 * asking whether the VIEWER OWNS the agent wants `viewer.isOwner` and must
	 * not read the presence of this block, which is the substitution
	 * lesser#1417 was filed about.
	 */
	owner: { agentOwner: string | null; delegatedScopes: string[] } | null;
	viewer: AgentViewerState;
}

/** Why an agent surface has nothing to show. */
export type AgentUnavailableReason =
	'agents-disabled' | 'not-found' | 'unauthenticated' | 'forbidden' | 'transport';

export interface AgentUnavailable {
	reason: AgentUnavailableReason;
	message: string;
}

export interface AgentRosterPage {
	agents: AgentSummary[];
	endCursor: string | null;
	hasNextPage: boolean;
	/**
	 * lesser's `totalCount` VERBATIM, which is the count of agents matching the
	 * filters WITHIN THIS PAGE — not an instance total. Named for what it is so
	 * no surface can render it as the other thing.
	 */
	matchesOnThisPage: number;
}

const MCP_ACCESS_FIELDS = `
	mcpURL
	protectedResourceURL
	authorizationServerURL
	registrationURL
	scopes
	guidance
`;

const CAPABILITY_FIELDS = `
	canPost
	canReply
	canBoost
	canFollow
	canDM
	maxPostsPerHour
	requiresApproval
	restrictedDomains
`;

/**
 * Roster card fields.
 *
 * `agentType`/`agentVersion`/`agentCapabilities` are the REST-parity names
 * lesser marks preferred; the legacy `type`/`version`/`capabilities` aliases
 * are deprecated in the schema and deliberately unused here.
 *
 * `mcpAccess` is selected on the ROSTER as well as the detail because it is not
 * redacted for anonymous callers, and the roster's value is telling a reader
 * which agents actually expose an MCP surface before they open one.
 */
const AGENT_SUMMARY_FIELDS = `
	id
	username
	displayName
	bio
	agentType
	agentVersion
	verified
	verifiedAt
	quarantineStatus
	quarantineStart
	quarantineEnd
	quarantineActive
	createdAt
	activityCount
	agentCapabilities { ${CAPABILITY_FIELDS} }
	mcpAccess { ${MCP_ACCESS_FIELDS} }
`;

/**
 * The fields lesser redacts for any viewer who is not the agent's owner or an
 * admin, plus BOTH statements lesser makes about the viewer they were served
 * to.
 *
 * Asking for them anonymously is not an error: lesser v1.6.4 admits anonymous
 * `agent` reads (commit 1df0358b8) and answers with the redacted shape — null
 * owner, empty scopes — alongside `viewerCanSeePrivateFields: false` (commit
 * 7aad73d5a). The booleans are what allow one document to serve every viewer:
 * the selection asks, lesser decides per viewer, and says what it decided.
 * Selected only on reads whose surface can be an owner's — the detail page and
 * the owned view. The roster is anonymous-only on the server pass and renders
 * no owner fields, so it does not ask either question at all.
 *
 * `viewerIsOwner` IS NOT ITSELF A REDACTED FIELD — it survives
 * `redactGraphAgentPrivateFields` the way `mcpAccess` does, so a non-owner gets
 * a served `false` rather than a blank. It is selected here anyway, beside the
 * fields it does not belong to, because the surfaces that need an ownership
 * answer are exactly the surfaces this block already serves, and a separate
 * selection would be a second document asking a question the first one is
 * already positioned to ask.
 *
 * ONE FORWARD DEPENDENCY, stated where the selection is made: this field exists
 * from lesser 1ce2dc97 (#1418) onward, and an instance that predates it rejects
 * the WHOLE document rather than answering the rest — GraphQL validates the
 * selection before it resolves anything. See contracts/lesser/provenance.json,
 * `inspected.forward_pin`, for the deploy ordering that follows.
 */
const AGENT_VIEWER_FIELDS = `
	agentOwner
	delegatedScopes
	viewerCanSeePrivateFields
	viewerIsOwner
`;

export const AGENTS_ROSTER_QUERY = `
	query ContentusAgents($first: Int, $after: Cursor, $type: AgentType, $query: String, $verified: Boolean) {
		agents(first: $first, after: $after, type: $type, query: $query, verified: $verified) {
			totalCount
			pageInfo { hasNextPage endCursor }
			edges {
				cursor
				node { ${AGENT_SUMMARY_FIELDS} }
			}
		}
	}
`;

/**
 * ONE DOCUMENT FOR EVERY VIEWER. There is no anonymous/owner split to make:
 * lesser redacts the private fields rather than erroring on them, so the same
 * selection is sent with or without a token and `viewerCanSeePrivateFields` in
 * the answer states what this viewer was shown. The split this replaced gated a
 * second document on token presence and inferred ownership from a non-null
 * `agentOwner` — an inference over values redaction exists to make ambiguous.
 */
export const AGENT_DETAIL_QUERY = `
	query ContentusAgent($username: String!) {
		agent(username: $username) {
			${AGENT_SUMMARY_FIELDS}
			${AGENT_VIEWER_FIELDS}
		}
	}
`;

export const MY_AGENTS_QUERY = `
	query ContentusMyAgents {
		myAgents {
			${AGENT_SUMMARY_FIELDS}
			${AGENT_VIEWER_FIELDS}
		}
	}
`;

/**
 * One agent's MCP access bundle, and nothing else.
 *
 * WHY THIS IS NOT `AGENT_DETAIL_QUERY`. The surface that sends this is the
 * grantee's "shared with you" list (M2.2, equaltoai/contentus#93), which asks
 * one question about somebody ELSE's agent: what does a grant on it convey, and
 * where does the grantee connect? `AGENT_DETAIL_QUERY` answers that too, but it
 * also asks for `agentOwner`, `delegatedScopes` and `viewerCanSeePrivateFields`
 * — the private half lesser redacts for exactly this viewer. Sending an
 * ownership selection from a surface that makes no ownership claim would be a
 * read wider than the thing it renders, and every extra field is a field a
 * later panel can start showing without anyone deciding it should.
 *
 * ANONYMOUS-SAFE AND UNREDACTED, which is what makes the narrow document
 * possible: `mcpAccess` is absent from lesser's `redactGraphAgentPrivateFields`
 * (`graph/agent_model_helpers.go`), because the bundle is the *public*
 * actor-scoped discovery surface by construction — `BuildPublicMCPAccessBundle`
 * is documented as "the client-neutral actor-scoped MCP access surface that can
 * be shown by agent UIs without provisioning connector state". Reading it is
 * display, never provisioning: no lease, no token, no connector state.
 */
export const AGENT_MCP_ACCESS_QUERY = `
	query ContentusAgentMcpAccess($username: String!) {
		agent(username: $username) {
			mcpAccess { ${MCP_ACCESS_FIELDS} }
		}
	}
`;

/* -------------------------------------------------------------------------
 * Normalizers
 * ---------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown): boolean {
	return value === true;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

export function toAgentMcpAccess(raw: unknown): AgentMcpAccess | null {
	const node = record(raw);
	if (!node) return null;

	return {
		mcpURL: str(node.mcpURL),
		protectedResourceURL: str(node.protectedResourceURL),
		authorizationServerURL: str(node.authorizationServerURL),
		registrationURL: str(node.registrationURL),
		scopes: strings(node.scopes),
		guidance: strings(node.guidance),
	};
}

export function toAgentCapabilities(raw: unknown): AgentCapabilities | null {
	const node = record(raw);
	if (!node) return null;

	return {
		canPost: bool(node.canPost),
		canReply: bool(node.canReply),
		canBoost: bool(node.canBoost),
		canFollow: bool(node.canFollow),
		canDM: bool(node.canDM),
		maxPostsPerHour: num(node.maxPostsPerHour),
		requiresApproval: bool(node.requiresApproval),
		restrictedDomains: strings(node.restrictedDomains),
	};
}

/**
 * BOTH viewer booleans are read from lesser's own answer, never sniffed from
 * the payload and never passed in by the caller. The redacted shape and the
 * genuine "this agent has no owner recorded" shape are the same bytes, and "we
 * sent a token" says what was asked rather than what was answered — so the only
 * sound source for either distinction is the statement lesser makes alongside
 * the values.
 *
 * A read that did not select a boolean (the anonymous roster, by design)
 * normalizes its absence to false, and for BOTH of them false is the safe
 * direction: the owner block hides rather than fabricates, and an owner-only
 * panel stays unmounted rather than being drawn on an unanswered question. That
 * is also the shape an instance predating lesser#1418 would produce if the
 * field could be silently dropped — it cannot, because an unknown field fails
 * document validation outright, but the normalizer does not rely on that.
 *
 * THEY ARE READ SEPARATELY BECAUSE THEY ARE SEPARATE. Deriving either from the
 * other would put the conflation back one layer down, where no surface could
 * see it.
 */
export function toAgentSummary(raw: unknown): AgentSummary | null {
	const node = record(raw);
	if (!node) return null;

	const id = str(node.id);
	const username = str(node.username);
	if (!id || !username) return null;

	const rawType = str(node.agentType);
	const canSeePrivateFields = node.viewerCanSeePrivateFields === true;
	const isOwner = node.viewerIsOwner === true;

	return {
		id,
		username,
		// lesser declares `displayName: String!`, but an agent registered without
		// one carries an empty string; the handle is the identity that always
		// exists, so it stands in rather than rendering a nameless card.
		displayName: str(node.displayName) ?? username,
		bio: str(node.bio),
		// An unrecognised type is CUSTOM, which is what lesser's own
		// `normalizeAgentType` does with one. Guessing differently here would
		// invent a category the instance does not have.
		agentType: isAgentType(rawType) ? rawType : 'CUSTOM',
		agentVersion: str(node.agentVersion),
		verified: bool(node.verified),
		verifiedAt: str(node.verifiedAt),
		quarantineStatus: str(node.quarantineStatus),
		quarantineStart: str(node.quarantineStart),
		quarantineEnd: str(node.quarantineEnd),
		quarantineActive: bool(node.quarantineActive),
		createdAt: str(node.createdAt),
		activityCount: num(node.activityCount),
		capabilities: toAgentCapabilities(node.agentCapabilities),
		mcpAccess: toAgentMcpAccess(node.mcpAccess),
		// Keyed on VISIBILITY: these are the values redaction acts on, so what
		// decides whether they may be rendered is whether lesser served them.
		owner: canSeePrivateFields
			? {
					agentOwner: str(node.agentOwner),
					delegatedScopes: strings(node.delegatedScopes),
				}
			: null,
		viewer: { canSeePrivateFields, isOwner },
	};
}

export function toAgentRosterPage(raw: unknown): AgentRosterPage {
	const connection = record(raw);
	const pageInfo = connection ? record(connection.pageInfo) : null;

	const agents = Array.isArray(connection?.edges)
		? connection.edges
				.map((edge) => toAgentSummary(record(edge)?.node))
				.filter((agent): agent is AgentSummary => agent !== null)
		: [];

	return {
		agents,
		endCursor: pageInfo ? str(pageInfo.endCursor) : null,
		// lesser's answer, never inferred from page length — the resolver filters
		// after paging, so a short or empty page says nothing about what follows.
		hasNextPage: pageInfo?.hasNextPage === true,
		matchesOnThisPage: num(connection?.totalCount),
	};
}

/* -------------------------------------------------------------------------
 * Failure classification
 * ---------------------------------------------------------------------- */

/**
 * Whether the instance has the agent surface switched off.
 *
 * Matched against lesser's own refusals (`ensureAgentsEnabled`): "agents are
 * disabled" and "agents are disabled by instance policy". Deliberately narrower
 * than the CMS helper's substring net, which would also claim any message
 * containing "disabled" — including a quarantine one.
 */
function graphQLErrorMessage(error: unknown): string {
	const entry = record(error);
	return typeof entry?.message === 'string' ? entry.message.toLowerCase() : '';
}

export function isAgentsDisabledError(errors: readonly unknown[]): boolean {
	return errors.some((error) => graphQLErrorMessage(error).includes('agents are disabled'));
}

function isAuthError(errors: readonly unknown[]): boolean {
	return errors.some((error) => {
		const message = graphQLErrorMessage(error);
		return (
			message.includes('authentication required') ||
			message.includes('unauthenticated') ||
			message.includes('insufficient scope')
		);
	});
}

function isForbiddenError(errors: readonly unknown[]): boolean {
	return errors.some((error) => {
		const message = graphQLErrorMessage(error);
		return message.includes('not authorized') || message.includes('forbidden');
	});
}

export function agentUnavailableFromErrors(errors: readonly unknown[]): AgentUnavailable | null {
	if (!errors.length) return null;
	if (isAgentsDisabledError(errors)) {
		return {
			reason: 'agents-disabled',
			message: 'This instance does not offer an agent surface.',
		};
	}
	if (isAuthError(errors)) {
		return { reason: 'unauthenticated', message: 'Sign in to see this.' };
	}
	if (isForbiddenError(errors)) {
		return { reason: 'forbidden', message: 'This instance did not authorize that view.' };
	}
	return { reason: 'transport', message: 'This instance could not answer the agent query.' };
}

export function agentUnavailableFromFailure(error: unknown): AgentUnavailable {
	if (error instanceof GraphQLTransportError) {
		return {
			reason: 'transport',
			message: 'This instance did not answer the agent query.',
		};
	}
	return { reason: 'transport', message: 'The agent query could not be completed.' };
}

/* -------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------- */

export interface AgentRequestContext {
	endpoint?: string | null;
	accessToken?: string | null;
	signal?: AbortSignal;
}

export interface AgentRosterFilters {
	first?: number;
	after?: string | null;
	type?: AgentType | null;
	query?: string | null;
	verified?: boolean | null;
}

/** How many agents one roster page asks for. */
export const AGENT_PAGE_SIZE = 24;

function requestOptions(ctx: AgentRequestContext) {
	return {
		endpoint: ctx.endpoint ?? null,
		...(ctx.accessToken ? { accessToken: ctx.accessToken } : {}),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	};
}

export type AgentRosterResult =
	{ ok: true; page: AgentRosterPage } | { ok: false; failure: AgentUnavailable };

/**
 * One roster page.
 *
 * `ownerUsername` is deliberately NOT a parameter. lesser rejects it for
 * anonymous callers and, for authenticated ones, permits only their own
 * username — so as a roster filter it is not a filter at all, it is `myAgents`
 * spelled a second way. Offering it as a control on an anonymous-safe roster
 * would advertise a filter that errors for most of the people who can see it;
 * the owned view is `fetchMyAgents` instead.
 */
export async function fetchAgentRoster(
	ctx: AgentRequestContext,
	filters: AgentRosterFilters = {}
): Promise<AgentRosterResult> {
	try {
		const result = await graphqlRequest<{ agents: unknown }>(
			AGENTS_ROSTER_QUERY,
			{
				first: filters.first ?? AGENT_PAGE_SIZE,
				after: filters.after ?? null,
				type: filters.type ?? null,
				query: filters.query ?? null,
				verified: filters.verified ?? null,
			},
			requestOptions(ctx)
		);

		const failure = agentUnavailableFromErrors(result.errors);
		const agents = record(result.data?.agents);
		if (!agents) {
			return {
				ok: false,
				failure:
					failure ??
					({
						reason: 'transport',
						message: 'This instance could not answer the agent query.',
					} satisfies AgentUnavailable),
			};
		}

		return { ok: true, page: toAgentRosterPage(agents) };
	} catch (error) {
		return { ok: false, failure: agentUnavailableFromFailure(error) };
	}
}

export type AgentDetailResult =
	{ ok: true; agent: AgentSummary } | { ok: false; failure: AgentUnavailable };

/**
 * One agent.
 *
 * The same document goes out with or without a token, because lesser v1.6.4
 * made the split meaningless: anonymous `agent` reads are admitted (commit
 * 1df0358b8), the private fields come back redacted rather than refused
 * (commit 7aad73d5a), and `viewerCanSeePrivateFields` in the answer states
 * which case this viewer is in. lesser decides visibility; this read asks once.
 */
export async function fetchAgent(
	ctx: AgentRequestContext,
	username: string
): Promise<AgentDetailResult> {
	const handle = username.trim().replace(/^@/, '');
	if (!handle) {
		return { ok: false, failure: { reason: 'not-found', message: 'No agent was requested.' } };
	}

	try {
		const result = await graphqlRequest<{ agent: unknown }>(
			AGENT_DETAIL_QUERY,
			{ username: handle },
			requestOptions(ctx)
		);

		const failure = agentUnavailableFromErrors(result.errors);
		if (failure && !result.data?.agent) return { ok: false, failure };

		const node = record(result.data?.agent);
		if (!node) {
			return {
				ok: false,
				failure: { reason: 'not-found', message: 'No agent matches this address.' },
			};
		}

		// `toAgentSummary` takes both viewer booleans from lesser's answer.
		// lesser redacts silently rather than erroring, so neither "we sent a
		// token" nor a non-null `agentOwner` would be evidence of what this
		// viewer was shown, or of whether they own the agent — the booleans are,
		// and they are two of them because they are two questions.
		const agent = toAgentSummary(node);
		if (!agent) {
			return {
				ok: false,
				failure: { reason: 'not-found', message: 'No agent matches this address.' },
			};
		}

		return { ok: true, agent };
	} catch (error) {
		return { ok: false, failure: agentUnavailableFromFailure(error) };
	}
}

export type AgentMcpAccessResult =
	{ ok: true; access: AgentMcpAccess | null } | { ok: false; failure: AgentUnavailable };

/**
 * The MCP access bundle lesser publishes for one agent.
 *
 * `{ ok: true, access: null }` IS AN ANSWER, and a different one from a
 * failure. `BuildPublicMCPAccessBundle` returns a guidance-only bundle with
 * empty URL strings when it cannot name a base URL or an actor, and
 * `toAgentMcpAccess` carries the empties through as nulls rather than as
 * absent-and-therefore-unknown. So "this instance publishes no MCP endpoint for
 * this agent" arrives as a served fact, and a surface can say it — which is not
 * the same sentence as "the read failed", and must never be shown as one.
 *
 * ONE READ PER AGENT, deliberately. lesser has no batch-by-username query for
 * agents, and the roster's `query` filter is applied to a page AFTER it is
 * fetched (see the module header), so a single roster read cannot be trusted to
 * contain every agent a caller was granted. A grant list is a handful of rows;
 * the caller dispatches these in parallel under one abort signal and one
 * session stamp.
 *
 * A token is passed when the caller has one, and is not required: lesser admits
 * anonymous `agent` reads and does not redact `mcpAccess`. The bundle is the
 * same either way, and an instance that gates its agent surface answers the
 * authenticated form rather than refusing it.
 */
export async function fetchAgentMcpAccess(
	ctx: AgentRequestContext,
	username: string
): Promise<AgentMcpAccessResult> {
	const handle = username.trim().replace(/^@/, '');
	if (!handle) {
		return { ok: false, failure: { reason: 'not-found', message: 'No agent was requested.' } };
	}

	try {
		const result = await graphqlRequest<{ agent: unknown }>(
			AGENT_MCP_ACCESS_QUERY,
			{ username: handle },
			requestOptions(ctx)
		);

		const failure = agentUnavailableFromErrors(result.errors);
		if (failure && !result.data?.agent) return { ok: false, failure };

		const node = record(result.data?.agent);
		if (!node) {
			return {
				ok: false,
				failure: { reason: 'not-found', message: 'No agent matches this address.' },
			};
		}

		return { ok: true, access: toAgentMcpAccess(node.mcpAccess) };
	} catch (error) {
		return { ok: false, failure: agentUnavailableFromFailure(error) };
	}
}

export type MyAgentsResult =
	{ ok: true; agents: AgentSummary[] } | { ok: false; failure: AgentUnavailable };

/**
 * The caller's own agents. Authenticated by definition — lesser serves no
 * anonymous form of this — so a missing token is answered here rather than by
 * sending a request that can only be refused.
 *
 * OWNER-ONLY BY LESSER'S CONSTRUCTION, AND NOW BY LESSER'S DESCRIPTION. The
 * resolver filters every result through `AgentOwnerMatchesLocalPrincipal`, so a
 * shared-with-the-viewer agent structurally cannot appear; from lesser#1418 the
 * schema says so too ("Agents owned by the viewer. Agents shared with the
 * viewer are served by the shared-with-me index, not this field"), which is
 * what makes it a contract rather than an observed behaviour.
 *
 * THIS MODULE STILL DOES NOT INFER ANYTHING FROM THAT. Every node carries
 * `viewerCanSeePrivateFields` and `viewerIsOwner` because it was asked for
 * them, and the view model is populated from those served values — not from the
 * query's name, and not from the description above. A description is a promise
 * about a conforming instance; the booleans are what this particular instance
 * actually said, and consuming them costs nothing and survives a
 * non-conforming answer.
 */
export async function fetchMyAgents(ctx: AgentRequestContext): Promise<MyAgentsResult> {
	if (!ctx.accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to see the agents you own.' },
		};
	}

	try {
		const result = await graphqlRequest<{ myAgents: unknown }>(
			MY_AGENTS_QUERY,
			{},
			requestOptions(ctx)
		);

		const failure = agentUnavailableFromErrors(result.errors);
		if (failure && !result.data?.myAgents) return { ok: false, failure };

		const agents = Array.isArray(result.data?.myAgents)
			? result.data.myAgents
					.map((node) => toAgentSummary(node))
					.filter((agent): agent is AgentSummary => agent !== null)
			: [];

		return { ok: true, agents };
	} catch (error) {
		return { ok: false, failure: agentUnavailableFromFailure(error) };
	}
}

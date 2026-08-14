/**
 * One owner's read of lesser's agent activity log (M2.4,
 * equaltoai/contentus#95).
 *
 * GRAPHQL, NOT REST, AND THE DISTINCTION IS NOT COSMETIC. Its neighbour
 * `share-client.ts` is REST because lesser puts share-grant management on the
 * agent MANAGEMENT plane, which has no GraphQL spelling — the documented
 * exception to GraphQL-first. The activity log is not in that position: lesser
 * serves it BOTH ways, as `GET /api/v1/agents/{username}/activity`
 * (`lesser/cmd/api/routes.go:180`) and as the root field
 * `agentActivity(username, first, after)`
 * (`lesser/graph/agents.graphql:993`), and where a contract offers both,
 * GraphQL-first is the rule with nothing to except it. So this module goes
 * through the same `graphqlRequest` transport as every other contentus read,
 * the way `instance/info.ts` does from outside `cms/`.
 *
 * WHAT LESSER GATES, AND WHY THIS CLIENT ADDS NOTHING TO IT. The resolver
 * requires a caller, requires `read` scope, and then answers `Forbidden` unless
 * the caller is the agent's owner, an admin, or the agent itself
 * (`lesser/graph/agent_resolvers_stubs.go:376-395`). The audit trail is
 * owner/admin-only BY THE SERVER, not by a client-side filter — which is what
 * makes it safe to render, and what this client must not widen. The panel
 * mounts behind lesser's own `agent.owner` statement and sends the owner's own
 * token; it never asks on behalf of anyone else and it builds no index of its
 * own.
 *
 * WHAT THE SURFACE DOES NOT OFFER, recorded here because a consumer that does
 * not know a boundary will eventually render past it:
 *
 *   - NO SESSION IDENTITY. The writer puts the agent's session in the audit
 *     row's `SessionID` COLUMN (`agent_audit.go:33`), and
 *     `AgentActivityEvent` has no field for it — the resolver reads `ID`,
 *     `EventType`, `Metadata` and `Timestamp` and nothing else
 *     (`agent_resolvers_stubs.go:443-467`). Sessions are not readable here, by
 *     construction, and this is the shape of the operator's "I would not index
 *     who was logged into an MCP" rather than an oversight to route upstream.
 *   - NO LOGIN EVENTS. The resolver keeps only event types prefixed `agent.`
 *     (`agent_resolvers_stubs.go:449`), so the `auth.oauth.*` records — token
 *     issued, refreshed, revoked — are filtered out server-side. This log is
 *     what an agent DID, never when someone connected.
 *   - NO WINDOW CONTROL. The resolver fixes the range at 30 days before now
 *     (`agent_resolvers_stubs.go:404`) with no argument to move it. The number
 *     is deliberately not repeated on screen: it is a server constant this
 *     client cannot read back, so asserting it in the UI would be a claim that
 *     goes stale silently the day lesser changes it.
 *
 * `totalCount` IS NOT SELECTED, ON PURPOSE. The field exists on the connection
 * and reads like the answer to "how many actions", but the resolver assigns it
 * `len(edges)` — the size of the page it just built
 * (`agent_resolvers_stubs.go:423`), which for a first page equals the page size
 * whenever there is more to fetch. Selecting it would put a number in reach
 * that means something other than what its name says, and the honest count of
 * what this read saw is `edges.length`, which the view already has. The
 * boundary that matters — that there is more — is `pageInfo.hasNextPage`, which
 * is selected.
 */

// Explicit `.ts` extensions, matching `share-client.ts`: these modules are
// loaded straight off disk by `node --test --experimental-strip-types` so the
// shipped client can be driven against a stubbed `fetch`, and Node's ESM
// resolver neither guesses extensions nor knows the `$lib` alias.
import { graphqlRequest, GraphQLTransportError } from '../cms/graphql.ts';
import { driverLedger, type AgentDriverLedger } from './activity-view.ts';

/**
 * The whole read, in one authenticated query.
 *
 * Named `ContentusAgentActivity` so the request log an operator reads says who
 * is asking. `metadataJson` is the field this milestone exists for: lesser
 * writes the driving human into the audit row's metadata
 * (`delegated_by`, and `acted_by` on the act-as path) and this is the only way
 * it leaves the instance.
 */
export const AGENT_ACTIVITY_QUERY = `query ContentusAgentActivity($username: String!, $first: Int!) {
	agentActivity(username: $username, first: $first) {
		edges {
			node {
				eventId
				agentUsername
				action
				targetId
				metadataJson
				timestamp
			}
		}
		pageInfo {
			hasNextPage
		}
	}
}`;

/**
 * How many actions one read asks for.
 *
 * lesser caps `first` at 200 (`agentListLimit(first, 200)`), so this is a
 * request the server can honour whole. It is one page rather than a paged walk
 * because the roster this feeds is explicitly "the drivers in the actions this
 * view read" — a budgeted multi-page walk would buy a longer list while making
 * the same partial claim, and `hasNextPage` states the boundary either way.
 */
const ACTIVITY_PAGE_SIZE = 100;

/** lesser could not answer, or answered something this client cannot use. */
export class ActivityClientError extends Error {
	/** True when the failure was transport-level rather than a GraphQL refusal. */
	readonly transport: boolean;

	constructor(message: string, transport = false) {
		super(message);
		this.name = 'ActivityClientError';
		this.transport = transport;
	}
}

export interface ActivityClientOptions {
	/** Bearer token. The activity log has no anonymous read. */
	accessToken: string;
	signal?: AbortSignal;
}

/**
 * Read one agent's activity log and fold it into who has been driving it.
 *
 * A GraphQL `errors` array is a REFUSAL, not an empty log, and is raised rather
 * than folded into an empty ledger — the difference between "lesser declined"
 * and "nothing happened" is the whole subject of this screen. A 200 whose shape
 * does not match the contract is raised for the same reason `grantsFrom` raises
 * one module over: it lands in the panel's unavailable state instead of
 * arriving on screen as a confident empty answer.
 */
export async function loadAgentDrivers(
	username: string,
	options: ActivityClientOptions
): Promise<AgentDriverLedger> {
	let result;
	try {
		result = await graphqlRequest<unknown>(
			AGENT_ACTIVITY_QUERY,
			{ username, first: ACTIVITY_PAGE_SIZE },
			{
				accessToken: options.accessToken,
				...(options.signal ? { signal: options.signal } : {}),
			}
		);
	} catch (cause) {
		if (cause instanceof GraphQLTransportError) {
			throw new ActivityClientError(cause.message, true);
		}
		throw new ActivityClientError(
			cause instanceof Error ? cause.message : 'activity request failed',
			true
		);
	}

	if (result.errors.length > 0) {
		const message = result.errors.find((error) => error.message)?.message;
		throw new ActivityClientError(message || 'This instance declined the activity request.');
	}

	const connection = asRecord(asRecord(result.data)?.['agentActivity']);
	if (!connection) {
		throw new ActivityClientError('This instance returned no activity for this agent.');
	}

	const rawEdges = connection['edges'];
	if (!Array.isArray(rawEdges)) {
		throw new ActivityClientError(
			'This instance returned an activity list this client cannot read.'
		);
	}

	// An edge that is not an object, or carries no node, contributes nothing —
	// `toAgentAction` returns null for it and `driverLedger` drops it. That is
	// deliberately NOT the same as raising: the container was well-formed, and
	// one malformed edge should cost that entry rather than the whole screen.
	const nodes = rawEdges.map((edge) => asRecord(edge)?.['node']);

	return driverLedger(nodes, {
		more: asRecord(connection['pageInfo'])?.['hasNextPage'] === true,
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

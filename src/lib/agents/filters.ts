/**
 * The roster's filter model (face 6, product design §5).
 *
 * A pure module with no DOM, for the same reason `timelines/tabs.ts` is one:
 * every filter here is a real address (`/agents?type=CURATOR&q=weather`), so
 * the model has to be readable by the server render, by the route component,
 * and by a test, without any of them importing the others.
 *
 * WHAT IS NOT HERE. `agents(ownerUsername:)` is a lesser argument this model
 * deliberately does not expose. lesser rejects it for anonymous callers and, for
 * authenticated ones, allows only the caller's own username unless they are an
 * admin (`graph/agent_resolvers_stubs.go`). A control on an anonymous-safe
 * roster that errors for almost everyone who can see it is not a filter; the
 * owned view is `myAgents`, which is a different question with a different
 * answer shape.
 */

// Explicit `.ts` extension and no route import, so this module loads straight
// off disk under `node --test --experimental-strip-types`. The href builders
// live in `facetheory/routing` with the rest of them; keeping them out of here
// is what leaves this file free of a route dependency.
import { AGENT_TYPES, isAgentType, type AgentType } from './contract.ts';

export interface AgentRosterFilterState {
	type: AgentType | null;
	/** Free-text search, passed to lesser's `query` argument verbatim. */
	query: string | null;
	/** Tri-state: verified only, unverified only, or no opinion. */
	verified: boolean | null;
	/** Opaque lesser cursor for the page being viewed. */
	after: string | null;
}

export const EMPTY_FILTERS: AgentRosterFilterState = {
	type: null,
	query: null,
	verified: null,
	after: null,
};

export interface AgentTypeOption {
	value: AgentType | null;
	label: string;
}

/**
 * Type filter options, "Any" first.
 *
 * The labels are title-cased renderings of lesser's own enum members rather
 * than a contentus vocabulary: a roster that renamed `BRIDGE` to something
 * friendlier would be describing a category the instance does not have.
 */
export const AGENT_TYPE_OPTIONS: AgentTypeOption[] = [
	{ value: null, label: 'Any type' },
	...AGENT_TYPES.map((value) => ({
		value,
		label: value.charAt(0) + value.slice(1).toLowerCase(),
	})),
];

function firstParam(
	query: Readonly<Record<string, string[] | undefined>> | undefined,
	key: string
): string | null {
	const value = query?.[key]?.[0];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the filter state out of a query string.
 *
 * Unrecognised values are dropped rather than passed through. An unknown
 * `type=` would be rejected by lesser as an invalid enum and fail the whole
 * page; dropping it renders the unfiltered roster, which is what the address
 * `/agents` with a malformed filter most nearly means.
 */
export function resolveAgentFilters(
	query: Readonly<Record<string, string[] | undefined>> | undefined
): AgentRosterFilterState {
	const rawType = firstParam(query, 'type')?.toUpperCase() ?? null;
	const rawVerified = firstParam(query, 'verified')?.toLowerCase() ?? null;

	return {
		type: isAgentType(rawType) ? rawType : null,
		query: firstParam(query, 'q'),
		verified: rawVerified === 'true' ? true : rawVerified === 'false' ? false : null,
		after: firstParam(query, 'after'),
	};
}

/** Whether any facet is narrowing the roster (paging alone is not a filter). */
export function hasActiveFilters(filters: AgentRosterFilterState): boolean {
	return filters.type !== null || filters.query !== null || filters.verified !== null;
}

/** The same filters, at the first page. */
export function withoutCursor(filters: AgentRosterFilterState): AgentRosterFilterState {
	return { ...filters, after: null };
}

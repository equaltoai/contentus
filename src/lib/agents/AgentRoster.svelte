<!--
THE ROSTER SWAP SEAM (face 6, M6.1; product design §5).

This component is the single boundary at which greater M6a's vendored
agent-roster components replace contentus's interim composition. Everything
above it — the `/agents` route, its address grammar, its loader, its props —
knows only that it renders a roster from an `AgentRosterPage` and a filter
state. Everything below it (`AgentCard`, `AgentTrustBadge`) is interim
composition that a vendored equivalent takes over wholesale.

WHAT THE SWAP LOOKS LIKE. Replace this file's body with the vendored roster
component, mapping `AgentSummary` onto its input shape. The route does not
change, the URL grammar does not change, `filters.ts` does not change, and the
loader does not change — because none of them import `AgentCard` or
`AgentTrustBadge`. That is the property the seam exists to hold, and
`tests/agents-roster.test.mjs` asserts it by checking that nothing outside
`src/lib/agents/` imports the interim components.

WHY THE COMPOSITION IS INTERIM AND LOCAL RATHER THAN VENDORED TODAY. greater
v0.13.0 does export `shared/agent` `AgentIdentityCard` and `AgentStateBadge`,
which the roadmap names for this face. Reading them at that tag:

  - `AgentStateBadge` is genuinely generic — a label, a tone, an emphasis — and
    `AgentTrustBadge` is modelled directly on it so the swap is a rename.
  - `AgentIdentityCard` is not. Its `AgentIdentityCardData` is the soul-genesis
    workflow's shape (`steward`, `currentPhase`, `currentState` drawn from
    `AgentWorkflowPhase`/`AgentWorkflowState`), not a federated agent's; it
    renders its own `<h2>` and an "Agent identity" eyebrow per card, which is
    the wrong heading structure for a grid; and it paints on literal `white`
    with a light-theme shadow, against contentus's dark-first brand.
  - `shared/agent` is not vendored into contentus, and vendoring it would pull
    nine soul-genesis components (SoulRequestCard, SoulLifecycleRail,
    GraduationSummaryCard, …) to use one pill. The CLI available here is 0.11.10
    — behind both the current pin and v0.13.0 — and `greater add` re-emits the
    whole vendored tree at the components.json ref, so the operation is not
    additive.

That matches the roadmap's own instruction for this milestone: "until vendored,
v1 composes the roster from `shell` (Panel, StatCard, PageFrame) + primitives".
`Panel` and `StatCard` below are exactly that vendored shell.
-->

<script lang="ts">
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import StatCard from '$lib/greater/shell/components/StatCard.svelte';

	import AgentCard from './AgentCard.svelte';
	import AgentRosterFilters from './AgentRosterFilters.svelte';
	import { agentsHref } from '../../facetheory/routing';
	import { hasActiveFilters, type AgentRosterFilterState } from './filters';
	import type { AgentRosterPage, AgentUnavailable } from './contract';

	interface Props {
		page: AgentRosterPage | null;
		failure: AgentUnavailable | null;
		filters: AgentRosterFilterState;
	}

	let { page, failure, filters }: Props = $props();

	const filtered = $derived(hasActiveFilters(filters));
	const agents = $derived(page?.agents ?? []);

	/**
	 * The empty state has to distinguish three situations lesser produces, and
	 * the third is the one a naive roster gets wrong.
	 *
	 * lesser applies `type`/`query`/`verified` to a page AFTER fetching it
	 * (`graph/agent_resolvers_stubs.go`), so a filtered page can come back with
	 * zero matches while `hasNextPage` is true — there may be matches further
	 * down the list. Saying "no agents match" there would be a claim lesser
	 * never made.
	 */
	const emptyMessage = $derived.by(() => {
		if (agents.length) return null;
		if (!filtered) return 'This instance has no agents to show.';
		if (page?.hasNextPage) {
			return 'No agents on this page match these filters. This instance filters each page as it is read, so there may be matches further along.';
		}
		return 'No agents match these filters.';
	});
</script>

{#if failure}
	<Panel title="Agents" headerLevel={2}>
		<p class="contentus-agents__notice">{failure.message}</p>
	</Panel>
{:else}
	<AgentRosterFilters {filters} />

	<div class="contentus-agents__stats">
		<!--
			`matchesOnThisPage` is lesser's `totalCount`, which counts matches within
			the page it just read rather than across the instance. Labelled as what
			it is: a card reading "Agents 24" next to a Next link would be asserting
			a total lesser did not state.
		-->
		<StatCard
			label={filtered ? 'Matches on this page' : 'Agents on this page'}
			value={page?.matchesOnThisPage ?? 0}
		/>
		<StatCard label="More pages" value={page?.hasNextPage ? 'Yes' : 'No'} />
	</div>

	{#if emptyMessage}
		<Panel title="Agents" headerLevel={2}>
			<p class="contentus-agents__notice">{emptyMessage}</p>
		</Panel>
	{:else}
		<Panel title="Agents" headerLevel={2}>
			<ul class="contentus-agents__grid">
				{#each agents as agent (agent.id)}
					<li class="contentus-agents__grid-item">
						<AgentCard {agent} headingLevel={3} />
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}

	<!--
		Forward-only paging, because lesser's connection is forward-only: it
		reports `hasNextPage` and an `endCursor` and has no backward cursor for
		this list. A "Previous" control would have to reconstruct one from history,
		which is a client-side invention of a contract behaviour. The browser's
		back button is the real previous, and it works because every page is an
		address.
	-->
	{#if page?.hasNextPage && page.endCursor}
		<nav class="contentus-agents__paging" aria-label="Agent roster pages">
			<a class="contentus-agents__next" href={agentsHref({ ...filters, after: page.endCursor })}>
				Next page
			</a>
		</nav>
	{/if}
{/if}

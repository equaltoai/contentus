<!--
Face 6 — the agent roster (product design §5) · mcp surface.

SSR, ANONYMOUSLY. `agents` is an anonymous-safe read (lesser resolves the
viewer with `optionalGraphAuthClaims`, and only the `ownerUsername` argument —
which this surface does not use — requires a caller). So the server fetches the
page and a cold deep link paints a real roster, filters included, with no
script at all. That is the same call face 4 makes for Instance and Federated,
for the same reason: this is a public reading surface.

Nothing authenticated is fetched here. These props are serialized verbatim into
contentus's PUBLIC hydration endpoint, so the roster carries only what an
anonymous caller may see. `myAgents` is a separate, client-only read on this
same route (M6.3) for exactly that reason.

FILTERS ARE ADDRESSES. `?type=`, `?q=`, `?verified=` and `?after=` are read by
the server, so a filtered roster is shareable, back-buttonable, and works before
hydration. The controls are a plain GET form; see `AgentRosterFilters.svelte`.
-->

<script lang="ts">
	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';
	import AgentRoster from '$lib/agents/AgentRoster.svelte';

	import type { AgentsRouteData, AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: AgentsRouteData;
	}

	let { page, data }: Props = $props();
</script>

<PageFrame width="wide">
	<AgentRoster page={data.page} failure={data.failure} filters={data.filters} />
</PageFrame>

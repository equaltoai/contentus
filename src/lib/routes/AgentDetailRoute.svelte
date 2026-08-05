<!--
Face 6 — one agent and its MCP surface (product design §5) · mcp surface.

SSR, ANONYMOUSLY, like the roster: `agent(username)` is an anonymous-safe read,
and `mcpAccess` is NOT among the fields lesser redacts for non-owners. So the
whole published MCP contract — endpoint, protected-resource URL, authorization
server, registration URL, scopes, guidance — is in the server's first paint,
and a reader with scripting off gets every address they need.

What is NOT in the server's paint is the live-probe half, deliberately. Those
are browser requests to a sibling origin; running them during SSR would make a
cold page wait on a third host and would report the SSR host's reachability
rather than the reader's.
-->

<script lang="ts">
	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';
	import AgentDetail from '$lib/agents/AgentDetail.svelte';

	import type { AgentDetailRouteData, AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: AgentDetailRouteData;
	}

	let { page, data }: Props = $props();
</script>

<PageFrame width="default">
	<AgentDetail agent={data.agent} failure={data.failure} username={data.username} />
</PageFrame>

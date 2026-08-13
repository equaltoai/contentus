<!--
The act-as banner for the review surfaces (M7.0, item 9;
docs/planning/agent-share-act-as-m7.md).

ATTRIBUTION IS LEGIBLE, NEVER SILENT. When the viewer is acting as a shared
agent, every verdict and publish they submit runs with the agent in the acting
position and the real caller in lesser's attribution position — the banner
says so on the two surfaces where those writes happen, and names the acting
identity. Its absence states nothing: with no selection there is no banner,
and "acting as nobody" is a claim this face has no reason to make.

IT REACTS LIVE, WHICH IS THE DESIGNED REVOCATION CASE. The selection lives in
`$lib/agents/act-as`; a revoked grant ends it on the very next FORBIDDEN
answer, the transport clears it and announces, and this banner hears that
announcement and disappears. The explanatory Notice for that case is the
failure path's (`act-as-revoked`), not this banner's — the banner shows the
state, the failure says what changed it.

CLIENT-ONLY BY CONSTRUCTION. The selection reads `sessionStorage`, which the
server pass cannot see, so the server renders nothing and the banner appears
after mount — the same shape as every other session-scoped surface.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { actAsSelection, onActAsChange, type ActAsSelection } from '$lib/agents/act-as';
	import { agentsHref } from '../../facetheory/routing';

	// Null until mount, deliberately: `actAsSelection()` reads `sessionStorage`,
	// which exists only in the browser. Rendering it during SSR would claim a
	// selection the server never saw; rendering it during hydration would be a
	// value the server's DOM does not contain.
	let selection = $state<ActAsSelection | null>(null);

	onMount(() => {
		selection = actAsSelection();
		return onActAsChange((next) => (selection = next));
	});
</script>

{#if selection}
	<p class="contentus-act-as-banner" role="status">
		Acting as <strong>@{selection.agentUsername}</strong> — verdicts and publishes record you as
		the caller.
		<a class="contentus-act-as-banner__link" href={agentsHref()}>Change or stop</a>
	</p>
{/if}

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

AND SINCE M2.1 (equaltoai/contentus#92) IT ANNOUNCES NOTHING, BY CONSTRUCTION.
The control that let a person elect a selection is gone — sharing an agent
grants ACCESS to it, never a seat in the acting position — so a stored selection
can only be an earlier build's. The mount ENDS one rather than announcing it;
`cms/review-transport.ts` ends it too, on module load, which is the guarantee
that does not depend on this component mounting. What stays here is the shape of
the statement: were lesser's act-as ever driven from this client again, this is
the face that would have to say so, and it would say so live.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { actAsSelection, clearActAs, onActAsChange, type ActAsSelection } from '$lib/agents/act-as';
	import { agentsHref } from '../../facetheory/routing';

	// Null until mount, deliberately: `actAsSelection()` reads `sessionStorage`,
	// which exists only in the browser. Rendering it during SSR would claim a
	// selection the server never saw; rendering it during hydration would be a
	// value the server's DOM does not contain.
	let selection = $state<ActAsSelection | null>(null);

	onMount(() => {
		// Before the read, and not conditional on it — the same clear the
		// shared-with-me panel makes, at the other place a stored selection is
		// consumed. This is the announcing surface: reading first and clearing
		// after would put an earlier build's selection on screen on the way out.
		clearActAs();

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

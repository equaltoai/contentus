<!--
Says so when a reply or quote would reach further than the post it answers.

The composer seeds visibility from the source's reach and never wider
(`$lib/compose/seed`), so this control is silent for every default. It exists
for the case after that: the poster opens the selector and widens it. That is
their call to make — lesser accepts the reach the caller asks for, and a client
that overrode it would be inventing a rule the contract does not have — but it
is not allowed to be an invisible one. Answering a followers-only post in
public discloses its author's audience choice, and answering a direct message
in public discloses the conversation.

So: no gate, no clamp, no confirmation dialog. One line that names both reaches
and what the difference means, next to the control that caused it.
-->

<script lang="ts">
	import AlertTriangleIcon from '$lib/greater/icons/icons/alert-triangle.svelte';
	import { getComposeContext } from '$lib/components/compose/context';
	import {
		normalizeVisibility,
		reachesWiderThan,
		toLesserVisibility,
		VISIBILITY_DESCRIPTIONS,
	} from '$lib/cms/visibility';

	interface Props {
		/** The source status's lesser visibility, or null when there is no source. */
		sourceVisibility: string | null;
	}

	let { sourceVisibility }: Props = $props();

	const context = getComposeContext();

	const chosen = $derived(toLesserVisibility(context.state.visibility));
	const parent = $derived(normalizeVisibility(sourceVisibility));
	const wider = $derived(Boolean(sourceVisibility) && reachesWiderThan(chosen, sourceVisibility));
</script>

{#if wider}
	<p class="contentus-compose-reach" role="status">
		<AlertTriangleIcon size={16} aria-hidden="true" />
		<span>
			This is going out as <strong>{VISIBILITY_DESCRIPTIONS[chosen].label}</strong>, further than
			the post it answers ({VISIBILITY_DESCRIPTIONS[parent].label}). People who could not see
			that post will see this one.
		</span>
	</p>
{/if}

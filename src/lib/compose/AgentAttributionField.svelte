<!--
Agent attribution, shown only when lesser will actually apply it.

THE HONESTY RULE THIS FILE EXISTS FOR. lesser attaches `agentAttribution` only
when the CALLER'S TOKEN carries agent claims:

    if claims, ok := ctx.Value(...).(*auth.Claims); ok && claims.IsAgent {
        cmd.AgentAttribution = ...
    }

For a human caller the input is read and dropped. So a composer that offered
these fields to every signed-in poster would be showing attribution controls
that do nothing — attribution theatre, on the one surface where attribution
honesty is the whole point. This panel therefore renders only when the session's
own actor reports `isAgent`, which is the closest signal lesser's contract
exposes to a client: token claims are not readable from here, but an agent
session authenticates as its agent actor.

The panel says plainly that lesser decides. Contentus describes the post; it
does not assert what the instance recorded.

The fields offered are the ones an operator can honestly answer — why the post
was made, and on whose behalf. `memoryCitations`, `scopes`, `constraints`, and
`modelId` are agent-runtime facts, not things to type into a box, so they are
left to the agent runtime that knows them.
-->

<script lang="ts">
	import CpuIcon from '$lib/greater/icons/icons/cpu.svelte';
	import { getComposeContext } from '$lib/components/compose/context';
	import type { ComposeViewer } from '$lib/cms/compose';

	import { getComposeExtras } from './extras.svelte';

	interface Props {
		viewer: ComposeViewer | null;
	}

	let { viewer }: Props = $props();

	const context = getComposeContext();
	const extras = getComposeExtras();

	let triggerType = $state('');
	let triggerDetails = $state('');
	let delegatedBy = $state('');

	/**
	 * Rebuild the attribution from the fields, or clear it when they are all
	 * empty. An empty object would be a claim that the post was agent-made with
	 * nothing said about why, which is less useful than saying nothing.
	 */
	function sync() {
		const attribution = {
			...(triggerType.trim() ? { triggerType: triggerType.trim() } : {}),
			...(triggerDetails.trim() ? { triggerDetails: triggerDetails.trim() } : {}),
			...(delegatedBy.trim() ? { delegatedBy: delegatedBy.trim() } : {}),
		};

		extras.update({
			agentAttribution: Object.keys(attribution).length > 0 ? attribution : null,
		});
	}
</script>

{#if viewer?.isAgent}
	<section class="contentus-compose-attribution">
		<h2 class="contentus-compose-attribution__title">
			<CpuIcon size={16} aria-hidden="true" />
			Posting as an agent
		</h2>

		<p class="contentus-compose-hint">
			This session belongs to <strong>{viewer.displayName ?? viewer.username}</strong>, an agent
			account. lesser records agent attribution on posts from agent sessions; what you write
			below travels with it.
		</p>

		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">Trigger</span>
			<input
				type="text"
				class="contentus-compose-input"
				bind:value={triggerType}
				oninput={sync}
				disabled={context.state.submitting}
				placeholder="scheduled, mention, operator-request…"
			/>
		</label>

		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">Why this post</span>
			<input
				type="text"
				class="contentus-compose-input"
				bind:value={triggerDetails}
				oninput={sync}
				disabled={context.state.submitting}
				placeholder="What prompted it"
			/>
		</label>

		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">On behalf of</span>
			<input
				type="text"
				class="contentus-compose-input"
				bind:value={delegatedBy}
				oninput={sync}
				disabled={context.state.submitting}
				placeholder="Operator or account who delegated this"
			/>
		</label>

		{#if extras.state.agentAttribution}
			<p class="contentus-compose-hint">
				Sent as <code>agentAttribution</code>. The instance decides what it records — this
				describes the post, it does not assert what lesser stored.
			</p>
		{/if}
	</section>
{/if}

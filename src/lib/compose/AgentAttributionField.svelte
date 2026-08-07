<!--
Agent attribution, and only the parts of it lesser will actually record.

THE HONESTY RULE THIS FILE EXISTS FOR. lesser attaches `agentAttribution` only
when the CALLER'S TOKEN carries agent claims:

    if claims, ok := ctx.Value(...).(*auth.Claims); ok && claims.IsAgent {
        cmd.AgentAttribution = ...
    }

For a human caller the input is read and dropped. So a composer that offered
these fields to every signed-in poster would be showing attribution controls
that do nothing — attribution theatre, on the one surface where attribution
honesty is the whole point. This panel therefore renders only when the
session's own actor reports `isAgent`, which is the closest signal lesser's
contract exposes to a client: token claims are not readable from here, but an
agent session authenticates as its agent actor.

WHICH FIELDS ARE REAL. `buildAgentPostAttribution` (lesser
`graph/mutation_resolvers_notes.go`) reads exactly three fields off the input —
`triggerType`, `triggerDetails`, and `memoryCitations` — and DERIVES every
other one. `delegatedBy` comes from `claims.DelegatedBy`, falling back to the
agent account's own `AgentOwner`, and is then normalised to an actor URI;
`scopes` come from the token, `constraints` from the account's capabilities,
`modelId` from its version, `schemaVersion` from a constant. An input value for
any of them is silently discarded.

This panel used to offer a free-text "On behalf of" box wired to `delegatedBy`
and a hint promising the value travelled with the post. It did not: the
operator typed a claim about who authorised the post, and lesser wrote down
whatever the token said instead. That is worse than no control, because the
claim it invited was exactly the kind a reader would most want to trust. It is
gone, and the panel now says who lesser will name.

`triggerType` is a closed enum, so it is a select. A free-text box over it did
not merely mislead — anything outside the four values is a hard validation
error, so it turned a valid post into a rejected one.

`memoryCitations` is honest input but not typed input: it is a list of status
ids an agent runtime knows and an operator does not. Left to the runtime, with
`scopes`, `constraints`, and `modelId`.

UPSTREAM CANDIDATE, recorded rather than shimmed: there is no contract surface
for a human operator to attest delegation — "I asked this agent to post this" —
and no client can invent one, because the value a client sends is discarded by
design. If that attestation is wanted, it belongs in lesser's schema and its
token claims, not in a text box here. Named in the PR body.
-->

<script lang="ts">
	import CpuIcon from '$lib/greater/icons/icons/cpu.svelte';
	import { getComposeContext } from '$lib/components/compose/context';
	import {
		AGENT_TRIGGER_DEFAULT,
		AGENT_TRIGGER_TYPES,
		type ComposeViewer,
	} from '$lib/cms/compose';

	import { getComposeExtras } from './extras.svelte';

	interface Props {
		viewer: ComposeViewer | null;
	}

	let { viewer }: Props = $props();

	const context = getComposeContext();
	const extras = getComposeExtras();

	/** Empty means "not stated", which lesser records as `manual`. */
	let triggerType = $state('');
	let triggerDetails = $state('');

	/** Reader-facing names for lesser's four values. The values are lesser's. */
	const TRIGGER_LABELS: Record<string, string> = {
		scheduled: 'Scheduled — a timer or cron fired',
		mention: 'Mention — someone mentioned this account',
		hashtag_watch: 'Hashtag watch — a watched tag matched',
		manual: 'Manual — a person asked for this post',
	};

	/**
	 * Rebuild the attribution from the fields, or clear it when both are empty.
	 * An empty object would be a claim that the post was agent-made with nothing
	 * said about why, which is less useful than saying nothing — and lesser
	 * records the attribution for an agent session either way.
	 */
	function sync() {
		const attribution = {
			...(triggerType ? { triggerType } : {}),
			...(triggerDetails.trim() ? { triggerDetails: triggerDetails.trim() } : {}),
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
			account. lesser records the attribution itself — who delegated this account, what it is
			scoped to, and which model it runs — from this session's own token and account. The two
			fields below are the parts it takes from you.
		</p>

		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">Trigger</span>
			<select
				class="contentus-compose-input"
				bind:value={triggerType}
				onchange={sync}
				disabled={context.state.submitting}
			>
				<option value="">Not stated — recorded as {AGENT_TRIGGER_DEFAULT}</option>
				{#each AGENT_TRIGGER_TYPES as value (value)}
					<option {value}>{TRIGGER_LABELS[value] ?? value}</option>
				{/each}
			</select>
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

		{#if extras.state.agentAttribution}
			<p class="contentus-compose-hint">
				Sent as <code>agentAttribution</code>. The instance decides what it records — this
				describes the post, it does not assert what lesser stored.
			</p>
		{/if}
	</section>
{/if}

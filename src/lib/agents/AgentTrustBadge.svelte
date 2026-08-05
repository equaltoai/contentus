<!--
The trust pill (face 6, product design §5).

WHAT THIS RENDERS, AND WHAT IT REFUSES TO. lesser states three separable things
about an agent's standing — `verified`, the `quarantine*` projection, and
nothing else — and this component renders exactly those, separately. It does not
compute a "trust score", does not collapse verified + quarantined into one
ranking, and does not treat the absence of a quarantine record as a positive
claim. An agent that is neither verified nor quarantined gets the neutral pill,
because "this instance has said nothing about this agent" is the true statement
and "trusted" is not.

Quarantine outranks verification in the display order for the one case where
both are true: lesser can verify an agent and later quarantine it, and a card
that led with the green badge would bury the live restriction under a stale
endorsement.

INTERIM COMPOSITION. greater's `shared/agent` exports an `AgentStateBadge` with
this shape — a label, a tone, a soft/solid emphasis — and it is the component
this one is modelled on and expects to be replaced by (greater M6a). It is not
vendored into contentus today, and vendoring `shared/agent` to reach it would
pull nine soul-genesis components to use one pill. The seam is
`$lib/agents/AgentRoster.svelte`; see its header.
-->

<script lang="ts">
	import type { AgentSummary } from './contract';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	type Tone = 'success' | 'critical' | 'warning' | 'neutral';
	interface Pill {
		label: string;
		tone: Tone;
		/** Read by a screen reader in place of the visual label alone. */
		description: string;
	}

	const pills = $derived.by<Pill[]>(() => {
		const out: Pill[] = [];

		// lesser's own `quarantineActive` — a projection it computes from the
		// window, not something derived here from start/end timestamps.
		if (agent.quarantineActive) {
			out.push({
				label: agent.quarantineStatus ?? 'Quarantined',
				tone: 'critical',
				description: 'This instance has this agent under an active quarantine.',
			});
		} else if (agent.quarantineStatus) {
			// A status with no active window is a past or pending restriction.
			// Saying so is more honest than dropping it, and than implying it is live.
			out.push({
				label: agent.quarantineStatus,
				tone: 'warning',
				description: 'This instance has a quarantine record for this agent that is not active.',
			});
		}

		if (agent.verified) {
			out.push({
				label: 'Verified',
				tone: 'success',
				description: 'This instance has verified this agent.',
			});
		} else if (!out.length) {
			// Only when there is nothing else to say. "Unverified" next to an active
			// quarantine adds no information and dilutes the warning.
			out.push({
				label: 'Unverified',
				tone: 'neutral',
				description: 'This instance has not verified this agent.',
			});
		}

		return out;
	});
</script>

<span class="contentus-agent-trust">
	{#each pills as pill (pill.label)}
		<span class={`contentus-agent-pill contentus-agent-pill--${pill.tone}`}>
			<span class="contentus-visually-hidden">{pill.description}</span>
			<span aria-hidden="true">{pill.label}</span>
		</span>
	{/each}
</span>

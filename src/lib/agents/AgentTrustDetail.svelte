<!--
Trust state in full, for the detail page (face 6, M6.3).

The roster's pills say WHAT the state is; this says what the instance actually
recorded, with its dates. Both read the same two facts — `verified` and the
`quarantine*` projection — and neither derives anything from the other.

WHAT IS REFUSED HERE. There is no combined trust level, no "safe to use"
verdict, and no inference in either direction. Specifically:

  - An unverified agent is not called untrustworthy. `verified` is a claim this
    instance chose to make about an agent; its absence is the absence of that
    claim, not a negative one.
  - A quarantine that has ended is not erased. lesser keeps the record and
    reports the window, so a reader can see that a restriction existed and when
    it ran. Hiding an expired quarantine would flatter the agent.
  - `quarantineActive` is lesser's own projection, computed against its clock
    (`QuarantineSummaryAt`). It is never recomputed here from the start and end
    timestamps — a client comparing dates against its own clock would disagree
    with the instance across a skew or a timezone bug, and the instance is the
    one that enforces the restriction.
-->

<script lang="ts">
	import type { AgentSummary } from './contract';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	/** ISO date only. lesser stamps these in UTC; no local reinterpretation. */
	const day = (value: string | null) => value?.slice(0, 10) ?? null;

	const hasQuarantineRecord = $derived(
		Boolean(agent.quarantineStatus || agent.quarantineStart || agent.quarantineEnd)
	);
</script>

<div class="contentus-trust">
	<h3 class="contentus-mcp__subheading">Trust</h3>

	<dl class="contentus-mcp__facts">
		<div>
			<dt>Verification</dt>
			<dd>
				{#if agent.verified}
					Verified by this instance{day(agent.verifiedAt) ? ` on ${day(agent.verifiedAt)}` : ''}
				{:else}
					<!-- The absence of a claim, stated as such. -->
					This instance has not verified this agent
				{/if}
			</dd>
		</div>

		<div>
			<dt>Quarantine</dt>
			<dd>
				{#if agent.quarantineActive}
					Active{agent.quarantineStatus ? ` — ${agent.quarantineStatus}` : ''}
				{:else if hasQuarantineRecord}
					{agent.quarantineStatus ?? 'Recorded'} — not currently active
				{:else}
					No quarantine recorded
				{/if}
			</dd>
		</div>

		{#if day(agent.quarantineStart)}
			<div>
				<dt>Quarantine from</dt>
				<dd>{day(agent.quarantineStart)}</dd>
			</div>
		{/if}
		{#if day(agent.quarantineEnd)}
			<div>
				<dt>Quarantine until</dt>
				<dd>{day(agent.quarantineEnd)}</dd>
			</div>
		{/if}
	</dl>

	{#if agent.quarantineActive}
		<p class="contentus-trust__warning">
			This instance is restricting this agent right now. Anything below describes what it
			publishes, not what it is currently permitted to do.
		</p>
	{/if}
</div>

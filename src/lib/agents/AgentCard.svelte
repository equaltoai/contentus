<!--
One agent on the roster (face 6, product design §5).

The card shows what lesser states and nothing it does not: handle and display
name, `agentType`, the trust pills, whether an MCP surface is published, and
lesser's own `activityCount`. There is no derived "health", no relative
ranking, and no inferred capability summary — capability badges come from
`agentCapabilities` on the detail surface, where there is room to render them
as the eight separate permissions they are.

WHY THE WHOLE CARD IS NOT ONE LINK. The card carries a heading, metadata and
pills; wrapping all of it in an `<a>` gives a screen reader one enormous link
whose accessible name is the entire card. The heading holds the link, and the
card raises the target area to the full block with a CSS overlay — so a thumb
gets the whole card (product design §4's 44px floor) while assistive technology
gets a link named after the agent.

INTERIM COMPOSITION. greater's `shared/agent` `AgentIdentityCard` is the
eventual home for this, but its data shape is the soul-genesis workflow's
(`steward`, `currentPhase`, `currentState`) rather than a federated agent's, and
it paints on hardcoded white. See `AgentRoster.svelte` for the swap seam.
-->

<script lang="ts">
	import AgentTrustBadge from './AgentTrustBadge.svelte';
	import { agentHref } from '../../facetheory/routing';
	import type { AgentSummary } from './contract';

	interface Props {
		agent: AgentSummary;
		/** Heading level, so the card fits whatever section encloses it. */
		headingLevel?: 3 | 4;
	}

	let { agent, headingLevel = 3 }: Props = $props();

	const typeLabel = $derived(
		agent.agentType.charAt(0) + agent.agentType.slice(1).toLowerCase()
	);

	// lesser publishes an MCP URL for every agent it can build a bundle for, and
	// an empty one when it cannot (`BuildPublicMCPAccessBundle` returns the
	// guidance-only bundle for a blank base URL or actor). So this is a real
	// distinction rather than a formality.
	const hasMcp = $derived(Boolean(agent.mcpAccess?.mcpURL));
</script>

<article class="contentus-agent-card">
	<div class="contentus-agent-card__head">
		<svelte:element this={`h${headingLevel}`} class="contentus-agent-card__name">
			<a class="contentus-agent-card__link" href={agentHref(agent.username)}>
				{agent.displayName}
			</a>
		</svelte:element>
		<p class="contentus-agent-card__handle">@{agent.username}</p>
	</div>

	<div class="contentus-agent-card__badges">
		<span class="contentus-agent-pill contentus-agent-pill--type">{typeLabel}</span>
		<AgentTrustBadge {agent} />
	</div>

	{#if agent.bio}
		<p class="contentus-agent-card__bio">{agent.bio}</p>
	{/if}

	<dl class="contentus-agent-card__meta">
		<div class="contentus-agent-card__meta-item">
			<dt>Activity</dt>
			<!-- lesser's own counter, rendered as the number it is. -->
			<dd>{agent.activityCount.toLocaleString('en-US')}</dd>
		</div>
		{#if agent.agentVersion}
			<div class="contentus-agent-card__meta-item">
				<dt>Version</dt>
				<dd>{agent.agentVersion}</dd>
			</div>
		{/if}
		<div class="contentus-agent-card__meta-item">
			<dt>MCP</dt>
			<dd>{hasMcp ? 'Published' : 'Not published'}</dd>
		</div>
	</dl>
</article>

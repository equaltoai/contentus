<!--
One agent, and the MCP surface it publishes (face 6, M6.2).

THE IDENTITY SEAM. Like `AgentRoster.svelte`, this composes the interim pieces
so the route above it imports one component. The MCP half is its own seam
(`AgentMcpPanel.svelte`) because greater M6a is expected to land the roster and
the MCP detail as separate components, and a single seam covering both would
force them to be swapped together.
-->

<script lang="ts">
	import Panel from '$lib/greater/shell/components/Panel.svelte';

	import AgentMcpPanel from './AgentMcpPanel.svelte';
	import AgentTrustBadge from './AgentTrustBadge.svelte';
	import { agentsHref } from '../../facetheory/routing';
	import type { AgentSummary, AgentUnavailable } from './contract';

	interface Props {
		agent: AgentSummary | null;
		failure: AgentUnavailable | null;
		username: string | null;
	}

	let { agent, failure, username }: Props = $props();

	const typeLabel = $derived(
		agent ? agent.agentType.charAt(0) + agent.agentType.slice(1).toLowerCase() : ''
	);
</script>

{#if !agent}
	<Panel title="Agent" headerLevel={2}>
		<p class="contentus-agents__notice">
			{failure?.message ?? 'No agent matches this address.'}
		</p>
		<p class="contentus-agents__notice">
			<a href={agentsHref()}>Back to all agents</a>
		</p>
	</Panel>
{:else}
	<header class="contentus-agent-detail__head">
		<p class="contentus-eyebrow">Agent</p>
		<h1 class="contentus-h1">{agent.displayName}</h1>
		<p class="contentus-agent-detail__handle">@{agent.username}</p>

		<div class="contentus-agent-card__badges">
			<span class="contentus-agent-pill contentus-agent-pill--type">{typeLabel}</span>
			<AgentTrustBadge {agent} />
		</div>

		{#if agent.bio}
			<p class="contentus-agent-detail__bio">{agent.bio}</p>
		{/if}
	</header>

	<Panel title="Identity" headerLevel={2}>
		<dl class="contentus-mcp__facts">
			<div><dt>Handle</dt><dd class="contentus-mcp__mono">@{agent.username}</dd></div>
			<div><dt>Type</dt><dd>{typeLabel}</dd></div>
			{#if agent.agentVersion}
				<div><dt>Version</dt><dd>{agent.agentVersion}</dd></div>
			{/if}
			{#if agent.createdAt}
				<div><dt>Registered</dt><dd>{agent.createdAt.slice(0, 10)}</dd></div>
			{/if}
			<div><dt>Activity</dt><dd>{agent.activityCount.toLocaleString('en-US')}</dd></div>
			{#if agent.verified && agent.verifiedAt}
				<div><dt>Verified</dt><dd>{agent.verifiedAt.slice(0, 10)}</dd></div>
			{/if}
		</dl>

		<!--
			Owner and delegated scopes appear only when lesser ANSWERED them, which
			it does for the agent's owner and for admins. For everyone else it
			redacts to null and `[]`, and those blanks are indistinguishable from
			real values — so the section is absent rather than showing "no owner".
		-->
		{#if agent.owner}
			<dl class="contentus-mcp__facts">
				{#if agent.owner.agentOwner}
					<div><dt>Owner</dt><dd class="contentus-mcp__mono">{agent.owner.agentOwner}</dd></div>
				{/if}
				{#if agent.owner.delegatedScopes.length}
					<div>
						<dt>Delegated scopes</dt>
						<dd>{agent.owner.delegatedScopes.join(' ')}</dd>
					</div>
				{/if}
			</dl>
		{/if}
	</Panel>

	<AgentMcpPanel {agent} />
{/if}

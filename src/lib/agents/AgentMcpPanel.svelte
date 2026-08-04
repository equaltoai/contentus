<!--
THE MCP SWAP SEAM (face 6, M6.2; product design §5).

The second of face 6's two boundaries, and the same contract as
`AgentRoster.svelte`: greater M6a's vendored MCP-detail component replaces this
file's body, and the route above it does not change because the route imports
this and nothing behind it.

PORTED FROM SIM'S `AgentMcpPanel`, MINUS THE LEASE PLUMBING. sim drives
`initialize` / `tools/list` / `resources/read` over JSON-RPC using a bearer
token from an agent access lease, and keeps a live/discovery/fallback ranking
per tool. contentus has no lease surface and this face is anonymous-safe, so
none of that is here — and the replacement is not a degraded version of it:
lesser-body publishes its tool registry in the UNAUTHENTICATED discovery
document, so the catalog below is server-stated rather than probed with
someone's credentials. `$lib/agents/mcp.ts` records the rest of the diff.

WHAT IS STATED VERSUS WHAT IS PROBED, kept visually separate because they are
different kinds of claim. Everything in "Connection" is lesser's, arrives in the
server's paint, and is true whether or not anything is reachable. Everything
under "Live checks" is a browser probe against a sibling origin and is only ever
reported as what that request returned. A panel that blurred the two would let a
failed probe make lesser's stated contract look wrong, or a stale document make
an unreachable server look healthy.

THE CATALOG IS THE SERVER'S, NOT THE AGENT'S. `mcp.json` lists the tools the MCP
server exposes for the souled profile — not what this particular agent has been
granted. What this agent may do is `agentCapabilities` and its delegated scopes,
which are a different section by a different authority. The heading says so,
because presenting a server registry as an agent's permissions would be the
single most misleading thing this panel could do.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';

	import Accordion from './Accordion.svelte';
	import CopyBlock from './CopyBlock.svelte';
	import {
		mcpClientConfigs,
		probeMcpDiscovery,
		probeProtectedResource,
		resolveMcpProbeTargets,
		type McpDiscoveryDocument,
		type OAuthProtectedResourceDocument,
		type ProbeState,
	} from './mcp';
	import type { AgentSummary } from './contract';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	const targets = $derived(agent.mcpAccess ? resolveMcpProbeTargets(agent.mcpAccess) : null);
	const configs = $derived(
		targets ? mcpClientConfigs(agent.username, targets, agent.mcpAccess?.scopes ?? []) : []
	);

	let discovery = $state<ProbeState<McpDiscoveryDocument>>({ status: 'idle' });
	let protectedResource = $state<ProbeState<OAuthProtectedResourceDocument>>({ status: 'idle' });

	// Probes run in the browser only — see `mcp.ts`. `onMount` never fires on the
	// server, so the SSR document carries the stated half and an idle live half,
	// which is the honest cold render.
	onMount(() => {
		if (!targets) return;
		const controller = new AbortController();

		discovery = { status: 'loading' };
		protectedResource = { status: 'loading' };
		void probeMcpDiscovery(targets, controller.signal).then((state) => (discovery = state));
		void probeProtectedResource(targets, controller.signal).then(
			(state) => (protectedResource = state)
		);

		return () => controller.abort();
	});

	function statusLabel(status: ProbeState<unknown>['status']): string {
		if (status === 'loading') return 'Checking';
		if (status === 'ready') return 'Answered';
		if (status === 'error') return 'No answer';
		// Idle is the server's paint and the no-script reader's permanent state.
		return 'Not checked';
	}

	function statusTone(status: ProbeState<unknown>['status']): string {
		if (status === 'ready') return 'success';
		if (status === 'error') return 'critical';
		return 'neutral';
	}

	const access = $derived(agent.mcpAccess);
</script>

{#if !targets}
	<Panel title="MCP" headerLevel={2}>
		<p class="contentus-agents__notice">
			This instance publishes no MCP endpoint for this agent.
		</p>
		{#if access?.guidance?.length}
			<ul class="contentus-mcp__guidance">
				{#each access.guidance as line, index (index)}
					<li>{line}</li>
				{/each}
			</ul>
		{/if}
	</Panel>
{:else}
	<Panel title="MCP connection" headerLevel={2}>
		<p class="contentus-mcp__lede">
			These addresses are published by this instance. They are what a client connects to, and
			they are correct whether or not the checks below have run.
		</p>

		<div class="contentus-mcp__addresses">
			<CopyBlock label="MCP endpoint" value={targets.endpoint} />
			<CopyBlock label="Protected resource metadata" value={targets.protectedResourceUrl} />
			{#if access?.authorizationServerURL}
				<CopyBlock label="Authorization server" value={access.authorizationServerURL} />
			{/if}
			{#if access?.registrationURL}
				<CopyBlock label="Client registration" value={access.registrationURL} />
			{/if}
		</div>

		{#if access?.scopes?.length}
			<Accordion title="Scopes this instance supports">
				<ul class="contentus-mcp__scope-list">
					{#each access.scopes as scope (scope)}
						<li class="contentus-agent-pill contentus-agent-pill--neutral">{scope}</li>
					{/each}
				</ul>
			</Accordion>
		{/if}

		{#if access?.guidance?.length}
			<Accordion title="Instance guidance">
				<!-- lesser's own guidance strings, rendered verbatim and in order. -->
				<ul class="contentus-mcp__guidance">
					{#each access.guidance as line, index (index)}
						<li>{line}</li>
					{/each}
				</ul>
			</Accordion>
		{/if}
	</Panel>

	<Panel title="Live checks" headerLevel={2}>
		<p class="contentus-mcp__lede">
			Requests made from this browser to the addresses above. A failure here means this browser
			could not reach the document — it does not mean the instance published it wrongly.
		</p>

		<div class="contentus-mcp__probe">
			<div class="contentus-mcp__probe-head">
				<h3 class="contentus-mcp__subheading">Discovery document</h3>
				<span class={`contentus-agent-pill contentus-agent-pill--${statusTone(discovery.status)}`}>
					{statusLabel(discovery.status)}
				</span>
			</div>

			{#if discovery.status === 'error'}
				<p class="contentus-agents__notice">{discovery.message}</p>
			{:else if discovery.status === 'ready'}
				<dl class="contentus-mcp__facts">
					{#if discovery.document.name}
						<div><dt>Server</dt><dd>{discovery.document.name}</dd></div>
					{/if}
					{#if discovery.document.version}
						<div><dt>Version</dt><dd>{discovery.document.version}</dd></div>
					{/if}
					{#if discovery.document.authType}
						<div><dt>Auth</dt><dd>{discovery.document.authType}</dd></div>
					{/if}
				</dl>

				{#if discovery.document.capabilities.length}
					<ul class="contentus-mcp__scope-list">
						{#each discovery.document.capabilities as capability (capability.name)}
							<li
								class={`contentus-agent-pill contentus-agent-pill--${capability.enabled ? 'success' : 'neutral'}`}
							>
								{capability.name}
							</li>
						{/each}
					</ul>
				{/if}

				{#if discovery.document.authNotes}
					<p class="contentus-mcp__note">{discovery.document.authNotes}</p>
				{/if}
			{:else}
				<p class="contentus-agents__notice">
					This check runs in the browser. With scripting off it does not run, and everything
					above is still correct.
				</p>
			{/if}
		</div>

		<div class="contentus-mcp__probe">
			<div class="contentus-mcp__probe-head">
				<h3 class="contentus-mcp__subheading">OAuth protected resource</h3>
				<span
					class={`contentus-agent-pill contentus-agent-pill--${statusTone(protectedResource.status)}`}
				>
					{statusLabel(protectedResource.status)}
				</span>
			</div>

			{#if protectedResource.status === 'error'}
				<p class="contentus-agents__notice">{protectedResource.message}</p>
			{:else if protectedResource.status === 'ready'}
				<dl class="contentus-mcp__facts">
					{#if protectedResource.document.resource}
						<div><dt>Resource</dt><dd class="contentus-mcp__mono">{protectedResource.document.resource}</dd></div>
					{/if}
					{#if protectedResource.document.authorizationServers.length}
						<div>
							<dt>Authorization servers</dt>
							<dd class="contentus-mcp__mono">
								{protectedResource.document.authorizationServers.join(', ')}
							</dd>
						</div>
					{/if}
					{#if protectedResource.document.scopesSupported.length}
						<div>
							<dt>Scopes supported</dt>
							<dd>{protectedResource.document.scopesSupported.join(' ')}</dd>
						</div>
					{/if}
				</dl>
			{/if}
		</div>
	</Panel>

	{#if discovery.status === 'ready' && discovery.document.tools.length}
		<Panel title="Tools this MCP server exposes" headerLevel={2}>
			<!--
				The heading and this sentence are load-bearing. This list is the SERVER's
				registry, filtered to the souled runtime profile — not a grant to this
				agent. What this agent may do is its capabilities and delegated scopes,
				which are stated separately by a different authority.
			-->
			<p class="contentus-mcp__lede">
				Published by the MCP server for all souled agents. It is not a statement about what
				<strong>@{agent.username}</strong> has been granted — see this agent's capabilities above.
			</p>
			<Accordion title={`${discovery.document.tools.length} tools`}>
				<ul class="contentus-mcp__tools">
					{#each discovery.document.tools as tool (tool.name)}
						<li class="contentus-mcp__tool">
							<p class="contentus-mcp__tool-name">{tool.name}</p>
							{#if tool.description}
								<p class="contentus-mcp__tool-description">{tool.description}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</Accordion>
		</Panel>
	{/if}

	<Panel title="Connect a client" headerLevel={2}>
		<p class="contentus-mcp__lede">
			Every value below is this instance's. No access token is included: one is minted through
			the OAuth flow the documents above describe, and a snippet that looked ready to run would
			be advertising a credential this page never had.
		</p>
		{#each configs as config (config.id)}
			<Accordion title={config.label}>
				<CopyBlock
					label={config.label}
					destination={config.destination}
					value={config.body}
					multiline
				/>
			</Accordion>
		{/each}
	</Panel>
{/if}

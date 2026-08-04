<!--
The agents the viewer owns (face 6, M6.3).

CLIENT-ONLY, AND THAT IS THE WHOLE DESIGN. `myAgents` needs a bearer token, the
session lives in `sessionStorage`, and the roster route's props are serialized
verbatim into contentus's PUBLIC hydration endpoint. A server-side `myAgents`
fetch would put one operator's agent inventory — including the `agentOwner` and
`delegatedScopes` lesser redacts from everyone else — behind a URL anyone could
request. Same rule that keeps the review queue and the message list off the
server pass.

So this renders nothing on the server, and nothing at all for an anonymous
reader. The public roster above it is unaffected either way: it is a separate
anonymous read, and it is already painted by the time this runs.

WHY NOT `agents(ownerUsername:)`. It is the same question with a worse answer.
lesser permits that argument only for the caller's own username (unless they are
an admin), so as a filter it is `myAgents` with extra ways to be refused — and
it would have to travel through the roster's URL grammar, where a shared link
carrying `?ownerUsername=` would promise a view the recipient cannot have.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';

	import AgentCard from './AgentCard.svelte';
	import { fetchMyAgents, type AgentSummary, type AgentUnavailable } from './contract';

	/**
	 * Four states, not two. `unknown` is the server's answer and the client's
	 * first frame — nothing has read `sessionStorage` yet — so claiming either
	 * way would be a guess that flickers.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let loading = $state(false);
	let agents = $state<AgentSummary[]>([]);
	let failure = $state<AgentUnavailable | null>(null);

	onMount(() => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;

		const controller = new AbortController();
		loading = true;

		void fetchMyAgents({ accessToken: accessTokenOrNull(), signal: controller.signal })
			.then((result) => {
				if (result.ok) {
					agents = result.agents;
					failure = null;
				} else {
					failure = result.failure;
				}
			})
			.finally(() => {
				loading = false;
			});

		return () => controller.abort();
	});
</script>

{#if session === 'authenticated'}
	<Panel title="Agents you own" headerLevel={2}>
		{#if loading}
			<p class="contentus-agents__notice">Loading the agents you own…</p>
		{:else if failure}
			<p class="contentus-agents__notice">{failure.message}</p>
		{:else if !agents.length}
			<p class="contentus-agents__notice">You do not own any agents on this instance.</p>
		{:else}
			<ul class="contentus-agents__grid">
				{#each agents as agent (agent.id)}
					<li class="contentus-agents__grid-item">
						<!--
							These cards carry the owner-only fields lesser redacts from
							everyone else, because `myAgents` is answered as the owner. The
							card renders them only when present, which for this list is
							always and for the public roster is never.
						-->
						<AgentCard {agent} headingLevel={3} />
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
{/if}

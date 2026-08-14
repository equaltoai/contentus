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

IT ENDS WITH THE SESSION, and reading the session once at mount is what makes
that untrue. `clearSession()` empties `sessionStorage` and announces it; it does
nothing to a component that already read it. Without the subscription below,
this panel went on showing one operator's agent inventory — `agentOwner` and
`delegatedScopes` included, the fields lesser redacts from everyone else — after
the reader signed out, on whatever device they walked away from. That is the
same defect `$lib/messaging/MessagesPage.svelte` fixes for the inbox, in a
smaller surface with the same private subject.

THE ABORT IS NOT THE GUARD. A response already parsed is not un-parsed by
aborting the fetch behind it, so a read dispatched under the old session can
still land after the sign-out. `$lib/auth/session-scope` is what decides:
stamped at dispatch, checked before anything is published. Cancel for the
bandwidth, check the stamp for the correctness.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import AgentCard from './AgentCard.svelte';
	import AgentDriversPanel from './AgentDriversPanel.svelte';
	import AgentSharingPanel from './AgentSharingPanel.svelte';
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

	const scope = createSessionScope(sessionGeneration);
	let controller: AbortController | null = null;

	/** Read the inventory for whatever session is current, stamped with it. */
	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;

		controller?.abort();
		controller = new AbortController();
		// Taken here, at DISPATCH. `notifySessionChange` advances the generation
		// BEFORE its listeners run, so a read started in response to `signed-in`
		// stamps the session it is actually reading for.
		const stamp = scope.stamp();
		loading = true;

		void fetchMyAgents({ accessToken: accessTokenOrNull(), signal: controller.signal })
			.then((result) => {
				// The answer is for the session that asked. If that session has ended —
				// or been replaced by the next reader's — it publishes nothing at all,
				// not even its failure message.
				if (!scope.holds(stamp)) return;
				if (result.ok) {
					agents = result.agents;
					failure = null;
				} else {
					failure = result.failure;
				}
			})
			.finally(() => {
				if (scope.holds(stamp)) loading = false;
			});
	}

	/**
	 * End the panel with the session.
	 *
	 * ORDER MATTERS, the same way it does on the messages face: the request is
	 * cancelled first, then the stamps it was taken under stop being held, then
	 * the screen is emptied. Nothing is left holding the old session's inventory
	 * for the next reader to find, and nothing in flight can repaint it.
	 */
	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		loading = false;
		agents = [];
		failure = null;
	}

	onMount(() => {
		openSession();

		const unsubscribe = onSessionChange((change) => {
			if (change === 'signed-out') closeSession();
			else openSession();
		});

		return () => {
			unsubscribe();
			controller?.abort();
			// Leaving the roster ends the scope too: an answer that lands after this
			// component is gone has nothing left to publish into, and saying so here
			// costs nothing.
			scope.end();
		};
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

	<!--
		One sharing panel per owned agent, below the cards. Mounted only where
		lesser says this viewer may see the agent's private fields —
		`agent.owner` is present exactly when `viewerCanSeePrivateFields` was
		served true, and absent otherwise, because lesser redacts rather than
		reports (contract.ts). lesser serves that boolean true for owners AND
		admins, so the accurate gloss of the gate is "may manage", never a
		re-derived ownership claim. The mount is lesser's answer, never an
		inference from which list the agent arrived in: `myAgents` carries no
		schema description that membership means ownership, so the panel does
		not derive it. Each panel is client-only like everything else in this
		block, reads its own grants, and ends with the session — because who
		holds access to your agent is the sensitive half of the capability.
	-->
	{#each agents as agent (agent.id)}
		{#if agent.owner}
			<AgentSharingPanel {agent} />
			<!--
				Who has been DRIVING the agent, directly below who HOLDS access to it
				(M2.4, equaltoai/contentus#95). The two are companion answers and the
				order is the owner's reading order: the grant ledger says who could,
				this says who did. Same gate, same client-only rule, same reason —
				lesser answers the activity log to the agent's owner and admins alone.
			-->
			<AgentDriversPanel {agent} />
		{/if}
	{/each}
{/if}

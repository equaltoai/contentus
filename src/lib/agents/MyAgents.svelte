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
							CORRECTED, because it claimed close to the opposite of what the
							card does (equaltoai/contentus#119). It said these cards carry the
							owner-only fields lesser redacts from everyone else, on the
							strength of `myAgents` being answered as the owner. `AgentCard`
							rendered no such field then and renders none now: it shows the
							handle, the display name, the type, the bio, the activity count,
							the version, the trust badge, and whether an MCP endpoint exists
							— every one of which lesser serves to anonymous callers too. The
							redacted fields are `agentOwner` and `delegatedScopes`, and the
							only card in this repository that renders either is the drones'
							`DroneCard`, on another face, from another document.

							What IS true of this list is narrower, and is the part worth
							keeping: it is answered as the owner, so `agent.viewer` carries
							lesser's served booleans for these rows instead of the anonymous
							`false` the public roster gets. Nothing here renders them. They
							are read on the agent page, which is where the owner's surfaces
							live now.
						-->
						<AgentCard {agent} headingLevel={3} />
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	<!--
		THIS LIST IS NAVIGATION NOW, AND THAT IS THE WHOLE OF #119.

		The owner's two panels — who holds access to an agent, and who has been
		driving it — used to be mounted here, one pair per owned agent. That made
		the roster the most expensive page on the face: opening `/agents` issued
		`GET /api/v1/agents/{username}/share` and an `agentActivity` read for every
		agent the viewer owned, before anyone had said which agent they cared
		about, so M owned agents cost 2M requests to paint M links. Both panels are
		on the agent page now — `AgentOwnerPanels.svelte`, behind the `AgentDetail`
		seam — so the same two reads happen for the one agent a human actually
		navigated to, and never for the ones they did not.

		What this file keeps is the inventory and the session discipline around it,
		both unchanged: one `myAgents` read, client-side, ending with the session.

		OWNERSHIP IS STILL LESSER'S ANSWER, AND STILL NEVER AN INFERENCE FROM WHICH
		LIST AN AGENT ARRIVED IN. The gate moved; the rule did not. `myAgents`
		carries a schema description saying membership means ownership, and the gate
		deliberately does not lean on it — a description is a promise about a
		conforming instance, while `viewerIsOwner` is what this instance said.
		lesser#1418 is still the field the mount reads, and an admin still gets
		`canSeePrivateFields: true` with `isOwner: false` and no panel, which is
		lesser's own contract test made visible.
	-->
{/if}

<!--
Face 6 — one agent and its MCP surface (product design §5) · mcp surface.

A SESSION READ, like the roster: lesser v1.6.3's GraphQL gateway refuses
anonymous `agent(username)` operations with 401 before the resolver runs
(`anonymousGraphQLPublicQueryFields`, cmd/graphql/main.go), and the session
lives in `sessionStorage` where the server cannot read it. So the server ships
the username from the address and this gate; the agent — and with it the
published MCP contract — arrives once the client has read the session.

THREE SESSION STATES, NOT TWO, the same discipline as the roster: `unknown` is
the server's honest answer, and guessing either way paints the wrong chrome for
a beat.

IT ENDS WITH THE SESSION. A detail answered as the owner carries the fields
lesser redacts from everyone else — `agentOwner`, `delegatedScopes`, the soul
binding — so nothing fetched under one session may outlive it. The read is
stamped at dispatch (`$lib/auth/session-scope`) and the screen empties with the
session that bought it, the same pattern as `$lib/agents/MyAgents.svelte`.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import AgentDetail from '$lib/agents/AgentDetail.svelte';
	import { fetchAgent, type AgentSummary, type AgentUnavailable } from '$lib/agents/contract';
	import { accessTokenOrNull, isAuthenticated, startLogin } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import type { AgentDetailRouteData, AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: AgentDetailRouteData;
	}

	let { page, data }: Props = $props();

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let loading = $state(false);
	let agent = $state<AgentSummary | null>(null);
	let failure = $state<AgentUnavailable | null>(null);
	let signInError = $state<string | null>(null);

	const scope = createSessionScope(sessionGeneration);
	let controller: AbortController | null = null;

	/** Read the agent the address names, for whatever session is current. */
	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;
		if (!data.username) {
			failure = { reason: 'not-found', message: 'No agent was requested.' };
			return;
		}

		controller?.abort();
		controller = new AbortController();
		// Stamped at DISPATCH, so the read belongs to the session it is actually
		// reading for even when a sign-in event is what started it.
		const stamp = scope.stamp();
		loading = true;

		void fetchAgent({ accessToken: accessTokenOrNull(), signal: controller.signal }, data.username)
			.then((result) => {
				// The answer is for the session that asked; an ended or replaced
				// session publishes nothing, not even its failure message.
				if (!scope.holds(stamp)) return;
				if (result.ok) {
					agent = result.agent;
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
	 * End the surface with the session: cancel first, drop the stamps, then
	 * empty the screen. Nothing of one reader's owner-view is left for the next
	 * reader to find.
	 */
	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		loading = false;
		agent = null;
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
			scope.end();
		};
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (cause) {
			signInError = cause instanceof Error ? cause.message : 'Could not start sign-in.';
		}
	}
</script>

<PageFrame width="default">
	{#if session === 'unknown'}
		<!-- The server render and the first client frame: the server cannot read
		     `sessionStorage`, so it does not know whether this reader is signed in. -->
		<Panel title="Agent" headerLevel={2}>
			<p class="contentus-agents__notice">Reading your session…</p>
		</Panel>
	{:else if session === 'anonymous'}
		<Panel title="Agent" headerLevel={2}>
			<p class="contentus-agents__notice">
				This instance serves its agent surface only to a signed-in caller.
			</p>
			<button type="button" class="contentus-agents__signin" onclick={onSignIn}>
				Sign in on this instance
			</button>
			{#if signInError}
				<p class="contentus-agents__notice" role="alert">{signInError}</p>
			{/if}
		</Panel>
	{:else if loading && !agent && !failure}
		<Panel title="Agent" headerLevel={2}>
			<p class="contentus-agents__notice">Loading this agent…</p>
		</Panel>
	{:else}
		<AgentDetail {agent} {failure} username={data.username} />
	{/if}
</PageFrame>

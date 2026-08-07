<!--
Face 6 — the agent roster (product design §5) · mcp surface.

A SESSION READ, because lesser requires a caller. v1.6.3's GraphQL gateway
admits only a named set of public query fields anonymously
(`anonymousGraphQLPublicQueryFields`, lesser cmd/graphql/main.go) and `agents`
is not one of them: an anonymous roster operation is refused with 401
"authentication required" before the resolver — and its non-owner redaction —
ever runs. The session lives in `sessionStorage`, so the server cannot make
this read either; it ships the address grammar (filters included) and this
gate, and the roster arrives once the client has read the session. Same shape
as `/messages`, same reason: the route's props are serialized verbatim into
contentus's PUBLIC hydration endpoint.

THREE SESSION STATES, NOT TWO. `unknown` is the server's honest answer and the
client's first frame; claiming either way would flicker — and on this surface
the flicker was "Sign in to see this." painted for a signed-in principal.

FILTERS REMAIN ADDRESSES. `?type=`, `?q=`, `?verified=` and `?after=` arrive in
the props the server resolved from the URL; the client fetch asks for exactly
that page. A filtered roster is still shareable and back-buttonable — every
filter change is a real navigation, which re-runs this gate with the new
address.

IT ENDS WITH THE SESSION, like `MyAgents`: a roster read answered for one
reader publishes nothing after sign-out, and the screen is emptied with the
session that bought it. See `$lib/agents/MyAgents.svelte` for the pattern this
follows — `$lib/auth/session-scope` stamps the read at dispatch and decides
before anything renders.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import PageFrame from '$lib/greater/shell/components/PageFrame.svelte';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import AgentRoster from '$lib/agents/AgentRoster.svelte';
	import { fetchAgentRoster, type AgentRosterPage, type AgentUnavailable } from '$lib/agents/contract';
	import { accessTokenOrNull, isAuthenticated, startLogin } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import type { AgentsRouteData, AppPageDescriptor } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: AgentsRouteData;
	}

	let { page, data }: Props = $props();

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let loading = $state(false);
	let roster = $state<AgentRosterPage | null>(null);
	let failure = $state<AgentUnavailable | null>(null);
	let signInError = $state<string | null>(null);

	const scope = createSessionScope(sessionGeneration);
	let controller: AbortController | null = null;

	/** Read the roster page the URL names, for whatever session is current. */
	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;

		controller?.abort();
		controller = new AbortController();
		// Stamped at DISPATCH: `notifySessionChange` advances the generation
		// before its listeners run, so this read belongs to the session it is
		// actually reading for.
		const stamp = scope.stamp();
		loading = true;

		void fetchAgentRoster(
			{ accessToken: accessTokenOrNull(), signal: controller.signal },
			{
				type: data.filters.type,
				query: data.filters.query,
				verified: data.filters.verified,
				after: data.filters.after,
			}
		)
			.then((result) => {
				// The answer is for the session that asked. If that session has
				// ended — or been replaced — it publishes nothing at all, not even
				// its failure message.
				if (!scope.holds(stamp)) return;
				if (result.ok) {
					roster = result.page;
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
	 * End the surface with the session. The request is cancelled first, then
	 * the stamps stop being held, then the screen is emptied — nothing is left
	 * holding one reader's roster for the next reader to find.
	 */
	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		loading = false;
		roster = null;
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

<PageFrame width="wide">
	{#if session === 'unknown'}
		<!-- The server render and the first client frame. Not the sign-in prompt:
		     the server cannot read `sessionStorage`, so it does not know whether
		     this reader is signed in. -->
		<Panel title="Agents" headerLevel={2}>
			<p class="contentus-agents__notice">Reading your session…</p>
		</Panel>
	{:else if session === 'anonymous'}
		<Panel title="Agents" headerLevel={2}>
			<p class="contentus-agents__notice">
				This instance serves its agent surface only to a signed-in caller — the roster,
				like the agents you own, arrives once you are signed in.
			</p>
			<button type="button" class="contentus-agents__signin" onclick={onSignIn}>
				Sign in on this instance
			</button>
			{#if signInError}
				<p class="contentus-agents__notice" role="alert">{signInError}</p>
			{/if}
		</Panel>
	{:else if loading && !roster && !failure}
		<Panel title="Agents" headerLevel={2}>
			<p class="contentus-agents__notice">Loading the roster…</p>
		</Panel>
	{:else}
		<AgentRoster page={roster} {failure} filters={data.filters} />
	{/if}
</PageFrame>

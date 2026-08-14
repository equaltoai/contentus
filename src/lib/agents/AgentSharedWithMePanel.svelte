<!--
"Shared with me" panel (M7.0, item 7; docs/planning/agent-share-act-as-m7.md).
The act-as selection control this panel used to carry was removed in M2.1
(equaltoai/contentus#92); M2.2 (equaltoai/contentus#93) gave it what a grant
actually conveys.

THE GRANTEE HALF OF THE CAPABILITY. Where the owner's sharing panel manages
who holds a grant on their agent, this panel shows what lesser has shared with
the VIEWER — and, for each of those agents, the address they connect to.

WHAT A GRANT MEANS, STATED HERE BECAUSE THE PANEL IS WHERE THE GRANTEE READS
IT. Sharing an agent grants ACCESS to that agent: the grantee signs into the
agent's MCP as themselves, with their own account, and lesser records who
really drove the agent (`actedBy`). It was never a licence to act as the agent
inside the web CMS — that was the one surface the M7 tree got wrong, and the
button is gone. lesser still records the real caller, the review workspace
still displays it, and `$lib/review/ActAsBanner` still names an active
selection wherever one exists.

THE ENDPOINT IS LESSER'S, AND THIS PANEL BUILDS NO PART OF IT. `mcpAccess`
comes from `BuildPublicMCPAccessBundle` (lesser `pkg/auth/mcp_access.go`),
which is documented as the client-neutral actor-scoped MCP access surface
"that can be shown by agent UIs without provisioning connector state" — so
showing it is exactly its published purpose, and nothing here provisions a
lease, a token, or connector state of any kind. The instance canonicalises MCP
onto `api.<domain>` while the authorization server stays on the apex; only the
instance knows that, so the URL is read, never assembled. Only the endpoint is
shown here — `AgentDetail`'s MCP panel is where the REST of the bundle lives
(OAuth parameters, scopes, guidance, reachability), and the row links to it
rather than restating it.

STALE SELECTIONS DIE HERE, AND THAT IS NOT TIDINESS. Nothing in this face
writes an act-as selection any more, so a stored one can only be the artifact
of a session that predates the removal — and whoever holds it would otherwise
keep acting as the agent with no control left to stop, since the stop button
went with the start button. Mounting this panel clears it, unconditionally and
before the grants are read, so a failed or unsupported share plane does not
leave the selection standing. The banner's own "Change or stop" link lands
exactly here, which makes this the reachable end of that state rather than a
silent one.

CLIENT-ONLY AND SESSION-SCOPED, like every authenticated surface on this
route: the token is in `sessionStorage`, the grants are private, and the route
props are serialized into the PUBLIC hydration endpoint. Nothing renders on
the server; on sign-out the read is aborted, the stamps stop being held, and
the screen is emptied. The endpoints are public, but WHICH agents were shared
with this reader is not, so they are emptied with everything else.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope, type SessionStamp } from '$lib/auth/session-scope';

	import { agentHref } from '../../facetheory/routing';
	import { clearActAs } from './act-as';
	import { fetchAgentMcpAccess } from './contract';
	import { sharedMcpAccess, type SharedMcpAccess } from './mcp';
	import { listSharedWithMe, ShareClientError, type AgentShareGrant } from './share-client';

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');

	/**
	 * `unsupported` is the pre-v1.6.5 instance, answered as a 404 by lesser's
	 * router — shown as a state with no list, never as a surface that looks live
	 * and cannot work.
	 */
	type PanelShareState =
		| { status: 'loading' }
		| { status: 'unsupported' }
		| { status: 'unavailable'; message: string }
		| { status: 'ready' };

	/**
	 * What lesser answered about one agent's MCP surface, plus the state before
	 * it has answered. The three served answers — and the reason `none` and
	 * `unavailable` are not one answer — are `sharedMcpAccess`'s to define; this
	 * only adds the row's own "not back yet".
	 */
	type RowAccess = SharedMcpAccess | { status: 'loading' };

	let shareState = $state<PanelShareState>({ status: 'loading' });
	let grants = $state<AgentShareGrant[]>([]);
	let access = $state<Record<string, RowAccess>>({});

	const scope = createSessionScope(sessionGeneration);
	let controller: AbortController | null = null;

	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;
		loadShared();
	}

	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		shareState = { status: 'loading' };
		grants = [];
		access = {};
	}

	/**
	 * The grants this panel lists, drawn from lesser's answer only — a revoked
	 * grant is not shown as one the viewer holds, however lesser chose to list
	 * it. `active` is lesser's served statement, not a client inference.
	 */
	const shared = $derived(grants.filter((grant) => grant.active));

	function loadShared() {
		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return;
		}

		controller?.abort();
		controller = new AbortController();
		const signal = controller.signal;
		// Taken at DISPATCH, checked before anything publishes — the same rule as
		// every other session-scoped surface on this route.
		const stamp = scope.stamp();
		shareState = { status: 'loading' };
		access = {};

		void listSharedWithMe({ accessToken: token, signal })
			.then((result) => {
				if (!scope.holds(stamp)) return;
				grants = result;
				shareState = { status: 'ready' };
				loadAccess(
					result.filter((grant) => grant.active),
					token,
					stamp,
					signal
				);
			})
			.catch((error: unknown) => {
				if (!scope.holds(stamp)) return;
				if (error instanceof ShareClientError && error.status === 404) {
					shareState = { status: 'unsupported' };
					return;
				}
				shareState = {
					status: 'unavailable',
					message:
						error instanceof ShareClientError
							? error.message
							: 'This instance could not answer the sharing request.',
				};
			});
	}

	/**
	 * One MCP-access read per shared agent, dispatched together.
	 *
	 * lesser has no batch-by-username query, and the roster's filters are applied
	 * to a page after it is fetched, so a single roster read cannot be trusted to
	 * contain every agent this caller was granted. A grant list is a handful of
	 * rows.
	 *
	 * Each read publishes on its own, and each publish is guarded twice, because
	 * the two guards fail differently. The STAMP is the session guard: a row that
	 * lands after the reader signed out paints nothing, for the same reason the
	 * grant list itself does not. The ABORT is the dispatch guard, and it is not
	 * redundant with the stamp — `fetchAgentMcpAccess` reports a cancelled read
	 * as an ordinary failure, so a superseded read that is still inside the
	 * current session would otherwise paint "unavailable" over a fresh row that
	 * is loading correctly. Today every re-dispatch also advances the session
	 * generation, so the stamp happens to catch it; that is a property of a
	 * different module, and this panel should not be the thing that breaks when
	 * it changes.
	 */
	function loadAccess(
		active: AgentShareGrant[],
		token: string,
		stamp: SessionStamp,
		signal: AbortSignal
	) {
		access = Object.fromEntries(
			active.map((grant) => [grant.agent_username, { status: 'loading' } as RowAccess])
		);

		for (const grant of active) {
			const username = grant.agent_username;
			void fetchAgentMcpAccess({ accessToken: token, signal }, username).then((result) => {
				if (signal.aborted || !scope.holds(stamp)) return;
				// lesser's answer, classified and not added to: an `ok` read with no
				// `mcpURL` is the instance stating it publishes none for this agent,
				// and no URL is substituted for it.
				access = { ...access, [username]: sharedMcpAccess(result) };
			});
		}
	}

	onMount(() => {
		// Before the read, and not conditional on it: see the header. A selection
		// can only be a leftover now, and a leftover must not outlive the panel
		// that is the only place left to end it.
		clearActAs();

		openSession();

		const unsubscribeSession = onSessionChange((change) => {
			if (change === 'signed-out') closeSession();
			else openSession();
		});

		return () => {
			unsubscribeSession();
			controller?.abort();
			scope.end();
		};
	});
</script>

{#if session === 'authenticated'}
	<Panel title="Agents shared with you" headerLevel={2}>
		<p class="contentus-shared__lede">
			These agents have been shared with you by their owners. A share grants
			<strong>access to the agent's MCP</strong>: you connect to it and sign in as yourself, with
			your own account, and this instance records that it was you who drove the agent. It does not
			let you act as the agent inside this CMS.
		</p>

		{#if shareState.status === 'loading'}
			<p class="contentus-agents__notice">Reading the agents shared with you…</p>
		{:else if shareState.status === 'unsupported'}
			<p class="contentus-agents__notice">This instance does not support agent sharing.</p>
		{:else if shareState.status === 'unavailable'}
			<p class="contentus-agents__notice">{shareState.message}</p>
		{:else if !shared.length}
			<p class="contentus-agents__notice">No agents have been shared with you.</p>
		{:else}
			<ul class="contentus-shared__list">
				{#each shared as grant}
					{@const mcp = access[grant.agent_username] ?? { status: 'loading' }}
					<li class="contentus-shared__row">
						<div class="contentus-shared__agent">
							<span class="contentus-shared__handle">@{grant.agent_username}</span>
							<span class="contentus-shared__meta">
								granted {new Date(grant.granted_at).toLocaleDateString()} by @{grant.granted_by}
							</span>

							{#if mcp.status === 'published'}
								<!--
									lesser's `mcpAccess.mcpURL`, verbatim. It is also the OAuth
									`resource` value, which the agent's own page states in full.

									SELECTABLE TEXT, NOT A `CopyBlock`, and the seam graph is what
									decides that: `CopyBlock` is owned by the `AgentMcpPanel` seam
									(`scripts/lib/agent-seams.mjs`), so importing it here would be
									a cross-seam import — the copy-config affordance goes with the
									MCP panel when greater M6a replaces it, and this row must not
									be orphaned by that swap. The division it enforces is the right
									one anyway: this list answers "which agent, and where", and the
									agent's own page is the config surface, one link away.
								-->
								<span class="contentus-shared__endpoint-label">MCP endpoint</span>
								<code class="contentus-shared__endpoint">{mcp.endpoint}</code>
							{:else if mcp.status === 'none'}
								<span class="contentus-shared__meta">
									This instance publishes no MCP endpoint for this agent.
								</span>
							{:else if mcp.status === 'unavailable'}
								<span class="contentus-shared__meta">{mcp.message}</span>
							{:else}
								<span class="contentus-shared__meta">Reading this agent's MCP endpoint…</span>
							{/if}
						</div>

						<a class="contentus-shared__connect" href={agentHref(grant.agent_username)}>
							How to connect
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
{/if}

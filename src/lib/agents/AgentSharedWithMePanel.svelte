<!--
"Shared with me" panel and act-as selector (M7.0, item 7;
docs/planning/agent-share-act-as-m7.md).

THE GRANTEE HALF OF THE CAPABILITY. Where the owner's sharing panel manages
who may act as their agent, this panel shows what the VIEWER may act as — the
agents lesser has shared with them — and carries the selection the review
surfaces later send as `X-Lesser-Act-As`. The selection itself lives in
`./act-as` (sessionStorage, bound to the auth session that made it), and this
panel is one of its two writers: the list of candidates IS lesser's
`shared-with-me` answer, and a choice is never invented beyond it.

ATTRIBUTION IS THE POINT, SO THE COPY SAYS IT. lesser records the real caller
as `actedBy` on whatever runs under the selection — attribution, never
impersonation — and the selected row wears an "Acting as" pill rather than
silently restyling the page. A surface acting as an agent must be legible.

THE SELECTION ENDS WHEN THE GRANT DOES, in both of lesser's spellings. The
GraphQL one (`FORBIDDEN` extension on HTTP 200) ends it on the review surfaces
(phase 5); the REST one is a plain 403 here, so a 403 from the share plane
clears the selection before this panel reports the failure. And the list is
the derivation: whenever it loads, a selection naming an agent it no longer
contains is cleared rather than kept — a revoked grant must not keep a
selection alive by this panel's silence.

CLIENT-ONLY AND SESSION-SCOPED, like every authenticated surface on this
route: the token is in `sessionStorage`, the grants are private, and the route
props are serialized into the PUBLIC hydration endpoint. Nothing renders on
the server; on sign-out the read is aborted, the stamps stop being held, and
the screen is emptied.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import {
		actAsCandidates,
		actAsSelection,
		clearActAs,
		onActAsChange,
		selectActAs,
		type ActAsSelection,
	} from './act-as';
	import { listSharedWithMe, ShareClientError, type AgentShareGrant } from './share-client';

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');

	/**
	 * `unsupported` is the pre-v1.6.5 instance, answered as a 404 by lesser's
	 * router — shown as a state with no selector, never as a control that looks
	 * live and cannot work.
	 */
	type PanelShareState =
		| { status: 'loading' }
		| { status: 'unsupported' }
		| { status: 'unavailable'; message: string }
		| { status: 'ready' };

	let shareState = $state<PanelShareState>({ status: 'loading' });
	let grants = $state<AgentShareGrant[]>([]);
	/** The mirror of the module's selection this page renders. */
	let selected = $state<ActAsSelection | null>(null);

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
		selected = null;
	}

	/**
	 * The candidates a row renders, drawn from lesser's answer only — revoked
	 * grants are not selectable, however lesser chose to list them.
	 */
	const candidates = $derived(actAsCandidates(grants));

	function loadShared() {
		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return;
		}

		controller?.abort();
		controller = new AbortController();
		// Taken at DISPATCH, checked before anything publishes — the same rule as
		// every other session-scoped surface on this route.
		const stamp = scope.stamp();
		shareState = { status: 'loading' };

		void listSharedWithMe({ accessToken: token, signal: controller.signal })
			.then((result) => {
				if (!scope.holds(stamp)) return;
				grants = result;
				shareState = { status: 'ready' };
				reconcile();
			})
			.catch((error: unknown) => {
				if (!scope.holds(stamp)) return;
				if (error instanceof ShareClientError && error.status === 403) {
					// lesser refused the share plane for this caller. A selection built
					// on its grants is unsupported: the contract's REST forbidden
					// spelling ends it here, the GraphQL one ends it on the review
					// surfaces.
					clearActAs();
				}
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
	 * THE DERIVATION, ENFORCED. The selection is only ever a value this list
	 * served; a selection naming an agent the fresh list no longer contains was
	 * made under a grant that has gone, so it is cleared rather than kept alive
	 * by this panel's silence.
	 */
	function reconcile() {
		selected = actAsSelection();
		if (selected && !candidates.includes(selected.agentUsername)) {
			clearActAs();
			selected = null;
		}
	}

	function choose(username: string) {
		const selection = selectActAs(username);
		if (selection) selected = selection;
	}

	function stop() {
		clearActAs();
		selected = null;
	}

	onMount(() => {
		openSession();

		const unsubscribeActAs = onActAsChange((selection) => (selected = selection));
		const unsubscribeSession = onSessionChange((change) => {
			if (change === 'signed-out') closeSession();
			else openSession();
		});

		return () => {
			unsubscribeActAs();
			unsubscribeSession();
			controller?.abort();
			scope.end();
		};
	});
</script>

{#if session === 'authenticated'}
	<Panel title="Agents shared with you" headerLevel={2}>
		<p class="contentus-act-as__lede">
			You can act as these agents. The instance records who really acted — acting as an agent is
			never silent.
		</p>

		{#if shareState.status === 'loading'}
			<p class="contentus-agents__notice">Reading the agents shared with you…</p>
		{:else if shareState.status === 'unsupported'}
			<p class="contentus-agents__notice">This instance does not support agent sharing.</p>
		{:else if shareState.status === 'unavailable'}
			<p class="contentus-agents__notice">{shareState.message}</p>
		{:else if !candidates.length}
			<p class="contentus-agents__notice">No agents have been shared with you.</p>
		{:else}
			<ul class="contentus-act-as__list">
				{#each grants.filter((grant) => grant.active) as grant}
					{@const isSelected = selected?.agentUsername === grant.agent_username}
					<li
						class="contentus-act-as__row"
						class:contentus-act-as__row--selected={isSelected}
					>
						<div class="contentus-act-as__agent">
							<span class="contentus-act-as__handle">@{grant.agent_username}</span>
							<span class="contentus-act-as__meta">
								granted {new Date(grant.granted_at).toLocaleDateString()} by @{grant.granted_by}
							</span>
						</div>
						{#if isSelected}
							<span class="contentus-agent-pill contentus-agent-pill--success">Acting as</span>
							<button class="contentus-act-as__stop-btn" type="button" onclick={stop}>
								Stop acting as
							</button>
						{:else}
							<button
								class="contentus-act-as__select-btn"
								type="button"
								onclick={() => choose(grant.agent_username)}
							>
								Act as
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
{/if}

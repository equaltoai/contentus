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

THE ENDPOINT IS NOT SHOWN HERE ANY MORE, AND THIS PANEL STILL BUILDS NO PART OF
IT. It used to read one MCP-access bundle per row — `fetchAgentMcpAccess` once
per grant, dispatched together — so a grantee with M shares cost M GraphQL reads
to paint M links, and what all of them bought was one URL that the row's own link
leads to in full (equaltoai/contentus#119). `AgentDetail`'s MCP panel is where
lesser's bundle is rendered — endpoint, OAuth parameters, scopes, guidance,
reachability — from `AGENT_DETAIL_QUERY`, for the one agent the reader actually
opened. This panel lists the grants and links there.

The bundle is still entirely lesser's: `mcpAccess` comes from
`BuildPublicMCPAccessBundle` (lesser `pkg/auth/mcp_access.go`), documented as the
client-neutral actor-scoped MCP access surface "that can be shown by agent UIs
without provisioning connector state", and nothing here provisions a lease, a
token, or connector state of any kind. The instance canonicalises MCP onto
`api.<domain>` while the authorization server stays on the apex; only the instance
knows that, so the URL is read, never assembled — which is the same reason it is
read on the agent page rather than derived here.

ONE REQUEST, AND IT IS THE GRANT LIST. This panel is on the `/agents` route
beside the public roster, so what it costs to open that page is part of its
contract and not an implementation detail.

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
	import { createSessionScope } from '$lib/auth/session-scope';

	import { agentHref } from '../../facetheory/routing';
	import { clearActAs } from './act-as';
	import { listSharedWithMe, ShareClientError, type AgentShareGrant } from './share-client';
	import {
		accessLedger,
		grantStamp,
		noSharedAgentsStatement,
		unlistedSharesNotice,
	} from './share-view';

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

	let shareState = $state<PanelShareState>({ status: 'loading' });
	let grants = $state<AgentShareGrant[]>([]);

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
	}

	/**
	 * The grants this panel lists, drawn from lesser's answer only — a revoked
	 * grant is not shown as one the viewer holds, however lesser chose to list
	 * it. `active` is lesser's served statement, not a client inference.
	 *
	 * CLASSIFIED STRICTLY, THROUGH THE OWNER PANEL'S OWN CLASSIFIER, and the
	 * strictness is the point rather than the sharing. `grants.filter((g) =>
	 * g.active)` read a row lesser sent WITHOUT the boolean as an absent grant
	 * and dropped it — and the empty state below then told the reader that
	 * nothing had been shared with them, which is this client answering a
	 * question the instance declined to answer, in the one case where the
	 * hidden row could be a live grant. `accessLedger` puts that row on neither
	 * side and counts it, which is what the two sentences below are then able to
	 * say. See `share-view.ts` for why only a non-conforming answer produces one.
	 */
	const ledger = $derived(accessLedger(grants));

	/**
	 * The two sentences this panel says ABOUT the classification rather than out
	 * of it — the same pair the owner panel composes, worded for a reader of one
	 * list rather than two. Both live in `share-view.ts` beside the classifier
	 * whose exclusion they describe, so a probe can call them with a ledger
	 * instead of reading them off the screen.
	 */
	const unlistedNotice = $derived(unlistedSharesNotice(ledger));
	const noSharedStatement = $derived(noSharedAgentsStatement(ledger));

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

		void listSharedWithMe({ accessToken: token, signal })
			.then((result) => {
				if (!scope.holds(stamp)) return;
				grants = result;
				shareState = { status: 'ready' };
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
		{:else}
			<!--
				ABOVE THE LIST, AND NOT ONLY IN THE EMPTY BRANCH. A reader with three
				agents listed and one row the instance failed to classify is looking at
				a list that is short by one and looks complete, which is the same
				misreading as the empty state's — just harder to notice.
			-->
			{#if unlistedNotice}
				<p class="contentus-agents__notice">{unlistedNotice}</p>
			{/if}

			{#if ledger.current.length}
				<ul class="contentus-shared__list">
					{#each ledger.current as grant}
						<li class="contentus-shared__row">
							<div class="contentus-shared__agent">
								<span class="contentus-shared__handle">@{grant.agent_username}</span>
								<!--
									COMPOSED BY `grantStamp`, WHICH IS A CORRECTION AND NOT ONLY A
									RELOCATION. This row inlined
									`new Date(grant.granted_at).toLocaleDateString()`, so a grant
									lesser served with a missing or unparseable `granted_at`
									rendered "granted Invalid Date by @ada" — this client filling a
									blank the instance left, on the one row whose job is to be
									believed about what the instance said. `grantStamp` drops a
									clause lesser did not serve instead of defaulting it, and it is
									the same function the owner's panel composes its audit stamps
									with, so the two readings of one grant cannot drift apart.
								-->
								<span class="contentus-shared__meta">
									{grantStamp('granted', grant.granted_at, grant.granted_by)}
								</span>
							</div>

							<!--
								THE ONLY WAY OFF THIS ROW, and it is where the endpoint this row
								used to render actually lives: the agent's own page, whose MCP
								panel states lesser's whole bundle — the `mcpURL` that is also the
								OAuth `resource` value, the authorization server, registration,
								scopes, guidance, and the live reachability probes. One link away,
								for the one agent the reader chose, instead of one GraphQL read
								per row to print a URL beside the link that leads to it.

								`CopyBlock` is deliberately not imported for that here, and the
								seam graph is what says so: `CopyBlock` is owned by the
								`AgentMcpPanel` seam (`scripts/lib/agent-seams.mjs`), so the
								copy-config affordance travels with the MCP panel when greater M6a
								replaces it, and this row is not orphaned by the swap.
							-->
							<a class="contentus-shared__connect" href={agentHref(grant.agent_username)}>
								How to connect
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<!--
					COMPOSED, never written here. "No agents have been shared with you"
					is the instance's answer only when the instance classified
					everything it sent; with a row it did not classify — the one case
					where a live grant can be missing from this list — that sentence is
					this client answering for lesser. `noSharedAgentsStatement` holds
					both readings and a probe calls it, which a sentence sitting in this
					branch could not be.
				-->
				<p class="contentus-agents__notice">{noSharedStatement}</p>
			{/if}
		{/if}
	</Panel>
{/if}

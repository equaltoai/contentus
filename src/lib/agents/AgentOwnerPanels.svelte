<!--
The owner's two panels for one agent, behind the read that says they are the
owner (equaltoai/contentus#119).

WHY THIS FILE EXISTS RATHER THAN TWO MORE LINES IN `AgentDetail.svelte`. The
sharing panel and the drivers panel used to hang off the owned roster, whose
every read is authenticated and client-only, so `agent.viewer.isOwner` was
already in hand and the mount was one `{#if}`. The agent page cannot do that.
`/agents/{username}` is server-rendered ANONYMOUSLY — `entry-server.ts` calls
`fetchAgent({ endpoint }, username)` with no token, because the token is in the
reader's `sessionStorage` where no server pass can reach it, and because this
route's props are serialized into contentus's PUBLIC hydration endpoint, where an
ownership answer about one reader would be served to any other. So the
`viewerIsOwner` this page is painted with is a correct `false` for everybody, the
owner included, and no refresh fixes it.

The gate therefore has to be asked for, and asking is a read with a session, an
abort and a stamp — the same machinery every neighbour on this face carries. That
is a component's worth of logic, not a detail page's, and `AgentDetail.svelte` is
the identity seam: it arranges what lesser already served and renders on the
server. This file is the client-only half, and it is the only component
`AgentDetail` composes that issues a request: the panels composed beside it
render from the props the server pass already fetched and issue nothing. Every
other client request on the page originates inside this component's own subtree —
the grant list and the activity log it mounts for an owner and for nobody else —
which makes the gate the page's single entry point for authenticated reads rather
than one more read beside them.

WHAT IT MOUNTS, AND IN WHICH ORDER. `AgentSharingPanel` — who holds access — then
`AgentDriversPanel` — who has been driving. The order is the owner's reading
order and is the one the roster used (M2.4, equaltoai/contentus#95): the grant
ledger says who could, the activity log says who did. Both keep their own reads,
their own session scopes and their own copy; this file decides only whether they
exist on this page at all.

FOUR STATES, AND ONLY ONE OF THEM MOUNTS ANYTHING. `ownershipState` in
`contract.ts` holds the classification so a probe can drive it with lesser's
answer instead of reading a mount decision off a screen. `unknown` (nothing asked
yet — the server's frame and the client's first one) and `not-owner` (lesser's
served `false`) both render nothing and say nothing: a management surface that
is absent is not a claim, and announcing the absence to every visitor who does
not own the agent would be noise about a question they did not ask. `unanswered`
is the one that speaks, because it is the one where silence would be a claim —
see the notice below.

CLIENT-ONLY AND SESSION-SCOPED, like the panels it mounts. Nothing renders on the
server; on sign-out the read is aborted, the stamps stop being held, and the
panels go with them, so who holds access to an agent is not left standing for the
next reader of the device.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import AgentDriversPanel from './AgentDriversPanel.svelte';
	import AgentSharingPanel from './AgentSharingPanel.svelte';
	import {
		fetchAgentOwnership,
		ownershipState,
		type AgentOwnershipResult,
		type AgentSummary,
	} from './contract';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	/** Four session states, same as the panels this mounts. */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let ownership = $state<AgentOwnershipResult | null>(null);

	/**
	 * lesser's answer, classified. Read through the pure classifier rather than
	 * re-derived here, so what a probe asserts and what this template branches on
	 * are the same function on the same value.
	 *
	 * NOT CALLED `state`, AND THAT IS A TOOLCHAIN CONSTRAINT RATHER THAN A TASTE.
	 * `$state` is ambiguous in a Svelte component: it is the rune, and it is also
	 * the auto-subscription of a store named `state`. A component that binds that
	 * name AND calls `$state<T>(…)` elsewhere in the same file has every one of
	 * those calls read as the subscription instead, and `svelte-check` then
	 * reports the rune as an untyped call taking type arguments, with this value
	 * and the answer behind it inferred as `any` out of a circularity that does not
	 * exist — six errors, none of them about anything this component does. The
	 * repo's two `state` bindings both sit outside the combination:
	 * `components/auth/Root.svelte` has no other `$state` call, and
	 * `review/VerdictPanel.svelte` has none at all. `pnpm build` runs
	 * `svelte-check --threshold error`, so a rename back here turns the build red
	 * rather than quietly untyping the gate — and `tests/agents-trust.test.mjs`
	 * holds the face to not binding a rune's name at all.
	 */
	const ownershipGate = $derived(ownershipState(ownership));

	const scope = createSessionScope(sessionGeneration);
	let controller: AbortController | null = null;

	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;
		loadOwnership();
	}

	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		ownership = null;
	}

	function loadOwnership() {
		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return;
		}

		controller?.abort();
		controller = new AbortController();
		// Taken at DISPATCH and checked before anything publishes: an ownership
		// answer that lands after the reader signed out mounts no panel, for the
		// same reason the panels' own reads publish nothing.
		const stamp = scope.stamp();
		// And the handle the read is ABOUT, for the other axis. This component
		// takes `agent` as a prop, so a router that reused the instance across two
		// agent pages would otherwise publish one agent's ownership answer onto
		// another agent's panels — mounting @ada's grant form because @scribe's
		// read said yes. Navigation on this face is a full document load today,
		// which makes that unreachable; correctness that depends on a routing
		// detail staying true is not correctness.
		const handle = agent.username;
		ownership = null;

		void fetchAgentOwnership({ accessToken: token, signal: controller.signal }, handle).then(
			(result) => {
				if (!scope.holds(stamp) || agent.username !== handle) return;
				ownership = result;
			}
		);
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
</script>

{#if session === 'authenticated'}
	{#if ownershipGate === 'owner'}
		<AgentSharingPanel {agent} />
		<AgentDriversPanel {agent} />
	{:else if ownershipGate === 'unanswered'}
		<!--
			THE ONE STATE THAT SPEAKS. Shutting the gate is right and is not the
			whole of right: a reader whose ownership check failed and a reader
			lesser said is not the owner see the same nothing, and for the first
			one that nothing reads as an answer. This says which of the two
			happened without asserting either — it names no owner, no grantee and
			no access, because lesser confirmed none.
		-->
		<p class="contentus-agents__notice">
			This instance did not answer whether <strong>@{agent.username}</strong> is yours, so its
			sharing and activity views are not shown.
		</p>
	{/if}
{/if}

<!--
"Shared with me" panel (M7.0, item 7; docs/planning/agent-share-act-as-m7.md).
The act-as selection control this panel used to carry was removed in M2.1
(equaltoai/contentus#92).

THE GRANTEE HALF OF THE CAPABILITY. Where the owner's sharing panel manages
who holds a grant on their agent, this panel shows what lesser has shared with
the VIEWER. Since M2.1 it is a list and only a list.

WHY THE CONTROL WENT, STATED HERE BECAUSE THE ABSENCE IS THE FEATURE. Sharing
an agent was always meant to grant the grantee ACCESS to that agent — to sign
into its MCP as themselves. Act-as was only ever meant as ATTRIBUTION: lesser
recording WHICH grantee drove an agent action. A button that let a person elect
to drive the agent from inside the web CMS was never the intent, and it is the
one surface the M7 tree got wrong. So the button is gone; the attribution it
was confused with is untouched. lesser still records the real caller as
`actedBy`, the review workspace still displays it, and `$lib/review/ActAsBanner`
still names an active selection wherever one exists.

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
the screen is emptied.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import { actAsCandidates, clearActAs } from './act-as';
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
	 * it.
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
		<p class="contentus-act-as__lede">These agents have been shared with you by their owners.</p>

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
					<li class="contentus-act-as__row">
						<div class="contentus-act-as__agent">
							<span class="contentus-act-as__handle">@{grant.agent_username}</span>
							<span class="contentus-act-as__meta">
								granted {new Date(grant.granted_at).toLocaleDateString()} by @{grant.granted_by}
							</span>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
{/if}

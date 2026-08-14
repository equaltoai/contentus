<!--
Owner share-grant management for one owned agent (M7.0, item 6;
docs/planning/agent-share-act-as-m7.md).

WHAT THIS PANEL IS, AND WHAT IT DELIBERATELY IS NOT. It lists, grants and
revokes lesser's agent share-grants for ONE agent the viewer owns — lesser's
agent MANAGEMENT plane, which is REST-only by lesser's design, so the calls
are the `src/lib/agents/share-client.ts` ones and the GraphQL-first rule does
not bend for it (see the CMS-consumption audit). The panel never derives who
may grant what — lesser answers each call with a status, and the panel reports
the answer.

WHAT THE OWNER IS ACTUALLY HANDING OVER, said in the lede because this is the
screen where they decide to hand it over (M2.2, equaltoai/contentus#93). A
grant conveys ACCESS TO THE AGENT'S MCP: the grantee signs into that agent's
MCP as themselves, with their own account, and lesser records which grantee
drove each agent action. It is not a licence to act as the agent inside this
CMS — that surface was the M7 tree's one mistake and went in M2.1. Saying
"the ability to act as" here, as this lede once did, is how an owner comes to
believe they granted the thing the CMS no longer offers.

CLIENT-ONLY, FOR THE SAME REASON THE OWNED ROSTER IS. The grants are
owner-private (who may act as your agent is the sensitive half of the
capability), the token lives in `sessionStorage`, and the route's props are
serialized into the PUBLIC hydration endpoint. So nothing renders on the
server; `MyAgents.svelte` mounts this only for an authenticated reader.

IT ENDS WITH THE SESSION, the same way its parent does: cancelled first, then
the stamps it was taken under stop being held, then the screen is emptied.
A response already parsed is not un-parsed by an abort, so `session-scope` is
what decides what publishes — the same discipline as the owned roster, on a
smaller surface with the same private subject.

HONEST DEGRADE, NOT A DEAD CONTROL, AND NOT AN INSTANCE-WIDE CLAIM. The
vendored OpenAPI defines 404 as one of this route's normal responses on a
SUPPORTING instance — "not this agent", not "no such route" — so a 404 here is
reported as what lesser said: sharing is unavailable for this agent. The
instance-level "does not support agent sharing" claim belongs to the
shared-with-me panel alone, whose endpoint's response set has no 404, so a 404
THERE is route absence and nothing else. This panel never claims the
capability is missing from the instance on this route's word.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import type { AgentSummary } from './contract';
	import {
		grantShare,
		listShareGrants,
		revokeShare,
		ShareClientError,
		type AgentShareGrant,
	} from './share-client';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	/**
	 * Four session states, same as the parent: `unknown` is the server's answer
	 * and the client's first frame — nothing has read `sessionStorage` yet.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');

	/**
	 * The grant-list state. `unavailable` carries the instance's own message;
	 * a 404 is lesser's normal "not this agent" answer on a supporting
	 * instance (the vendored contract defines it), surfaced as such — never
	 * dressed up as a statement about the instance.
	 */
	type GrantState =
		| { status: 'loading' }
		| { status: 'unavailable'; message: string }
		| { status: 'ready' };

	let shareState = $state<GrantState>({ status: 'loading' });
	let grants = $state<AgentShareGrant[]>([]);
	let grantee = $state('');
	let actionInFlight = $state(false);
	let actionError = $state<string | null>(null);

	const scope = createSessionScope(sessionGeneration);
	let loadController: AbortController | null = null;
	let actionController: AbortController | null = null;

	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;
		loadGrants();
	}

	function closeSession() {
		loadController?.abort();
		loadController = null;
		actionController?.abort();
		actionController = null;
		scope.end();
		session = 'anonymous';
		shareState = { status: 'loading' };
		grants = [];
		grantee = '';
		actionInFlight = false;
		actionError = null;
	}

	function loadGrants() {
		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return;
		}

		loadController?.abort();
		loadController = new AbortController();
		// Taken at DISPATCH and checked before anything publishes, the same rule
		// as the parent: a list read under a session that has since ended publishes
		// nothing, not even its failure.
		const stamp = scope.stamp();
		shareState = { status: 'loading' };
		actionError = null;

		void listShareGrants(agent.username, {
			accessToken: token,
			signal: loadController.signal,
		})
			.then((result) => {
				if (!scope.holds(stamp)) return;
				grants = result;
				shareState = { status: 'ready' };
			})
			.catch((error: unknown) => {
				if (!scope.holds(stamp)) return;
				if (error instanceof ShareClientError && error.status === 404) {
					// lesser's normal "not this agent" answer — deleted, suspended,
					// or not visible to this caller — reported as what it is, never
					// as a claim about the instance's capability.
					shareState = { status: 'unavailable', message: 'Sharing is unavailable for this agent.' };
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

	/** One grant, or revoke, of a grant; lesser's answer, shown as it came. */
	async function performShareCall(
		call: (token: string) => Promise<AgentShareGrant>
	): Promise<boolean> {
		if (actionInFlight) return false;

		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return false;
		}

		actionController?.abort();
		actionController = new AbortController();
		const stamp = scope.stamp();
		actionInFlight = true;
		actionError = null;

		try {
			await call(token);
			if (!scope.holds(stamp)) return false;
			return true;
		} catch (error) {
			if (!scope.holds(stamp)) return false;
			actionError =
				error instanceof ShareClientError
					? error.message
					: 'The sharing request could not be sent.';
			return false;
		} finally {
			if (scope.holds(stamp)) actionInFlight = false;
		}
	}

	async function performGrant() {
		const username = grantee.trim();
		if (!username) return;

		const ok = await performShareCall((token) =>
			grantShare(agent.username, username, {
				accessToken: token,
				signal: actionController?.signal,
			})
		);
		if (ok) {
			grantee = '';
			// The refreshed list IS the feedback: lesser's answer replaced the
			// local copy, so the panel never predicts a grant it has not seen.
			loadGrants();
		}
	}

	async function performRevoke(granteeUsername: string) {
		const ok = await performShareCall((token) =>
			revokeShare(agent.username, granteeUsername, {
				accessToken: token,
				signal: actionController?.signal,
			})
		);
		if (ok) loadGrants();
	}

	onMount(() => {
		openSession();

		const unsubscribe = onSessionChange((change) => {
			if (change === 'signed-out') closeSession();
			else openSession();
		});

		return () => {
			unsubscribe();
			loadController?.abort();
			actionController?.abort();
			scope.end();
		};
	});
</script>

{#if session === 'authenticated'}
	<Panel title={`Sharing @${agent.username}`} headerLevel={2}>
		<p class="contentus-sharing__lede">
			Grant another local account access to <strong>@{agent.username}</strong>'s MCP. A grantee
			connects to the agent's MCP endpoint and signs in as themselves, with their own account;
			this instance records which grantee drove each agent action. A grant does not let anyone
			act as this agent inside the CMS. Grantees see the endpoint under
			<em>Agents shared with you</em>.
		</p>

		{#if shareState.status === 'loading'}
			<p class="contentus-agents__notice">Reading who this agent is shared with…</p>
		{:else if shareState.status === 'unavailable'}
			<p class="contentus-agents__notice">{shareState.message}</p>
		{:else}
			<form
				class="contentus-sharing__form"
				aria-busy={actionInFlight}
				onsubmit={(event) => {
					event.preventDefault();
					void performGrant();
				}}
			>
				<label class="contentus-sharing__field">
					<span class="contentus-sharing__field-label">Local account to grant</span>
					<input
						class="contentus-sharing__input"
						type="text"
						placeholder="username"
						autocomplete="off"
						bind:value={grantee}
						disabled={actionInFlight}
					/>
				</label>
				<button
					class="contentus-sharing__grant-btn"
					type="submit"
					disabled={actionInFlight || !grantee.trim()}
				>
					Grant access
				</button>
			</form>

			{#if actionError}
				<p class="contentus-sharing__error" role="status">{actionError}</p>
			{/if}

			{#if grants.length}
				<ul class="contentus-sharing__grants">
					{#each grants as grant}
						<li class="contentus-sharing__grant">
							<span class="contentus-sharing__grantee">@{grant.grantee_username}</span>
							<span class="contentus-sharing__granted">
								granted {new Date(grant.granted_at).toLocaleDateString()}
							</span>
							{#if grant.active}
								<button
									class="contentus-sharing__revoke-btn"
									type="button"
									disabled={actionInFlight}
									onclick={() => void performRevoke(grant.grantee_username)}
								>
									Revoke
								</button>
							{:else}
								<span class="contentus-agent-pill contentus-agent-pill--neutral">Revoked</span>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="contentus-agents__notice">No account has access to this agent yet.</p>
			{/if}
		{/if}
	</Panel>
{/if}

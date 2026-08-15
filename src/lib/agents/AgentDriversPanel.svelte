<!--
Who has been driving one owned agent (M2.4, equaltoai/contentus#95).

THE COMPANION TO THE SHARING PANEL, AND A DIFFERENT QUESTION. `AgentSharingPanel`
answers who HOLDS access — the grant ledger. This one answers who has actually
CONNECTED AND ACTED: of the accounts that hold access, which ones drove the
agent. The operator asked for "knowing who was logged into MCP as it were", and
the two screens sit together because "@ada can reach this agent" and "@ada has
been running it all week" are different facts an owner needs side by side.

IT IS NOT A SESSION LIST, AND IT SAYS SO ON SCREEN. lesser deliberately keeps no
session index for MCP logins (operator directive, 2026-08-13: "I would not index
who was logged into an MCP, but its important metadata"). What exists is the
audit trail, with the driving human in each row's metadata. So this panel infers
who was connected FROM WHAT THEY DID, and the lede states that, because a
roster of names under a heading about being logged in reads as a list of live
sessions — the exact thing that was refused upstream.

WHAT IT CANNOT SHOW, stated rather than quietly omitted: login and token events
are filtered out server-side (only `agent.`-prefixed types survive the
resolver), so nothing here marks a connection; the window is lesser's own and
this client cannot read it back, so the copy says "still keeps" and never a
number of days; and one read is one page, with `hasNextPage` surfaced as older
actions this view did not read. `activity-client.ts` carries each boundary with
its upstream citation.

OWNER-GATED BY LESSER, NOT BY THIS PANEL. `agentActivity` requires a caller with
`read` scope and answers `Forbidden` to anyone who is not the agent's owner, an
admin, or the agent itself. This panel mounts only behind lesser's served
`viewerIsOwner` — the same gate as the sharing panel — and sends the owner's own
token, so it consumes that authorization rather than widening it. The gate read
`agent.owner` until the lesser#1418 sync; that was the visibility boolean, which
is true for admins as well, so the client gate is now narrower than the server's
rather than accidentally as wide.

CLIENT-ONLY, FOR THE SAME REASON ITS NEIGHBOURS ARE. The log is owner-private,
the token lives in `sessionStorage`, and the route's props are serialized into
the PUBLIC hydration endpoint. Nothing renders on the server.

IT ENDS WITH THE SESSION, by the same `session-scope` discipline: cancelled
first, then the stamps it was taken under stop being held, then the screen is
emptied. A response already parsed is not un-parsed by an abort, so the scope is
what decides what publishes.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { accessTokenOrNull, isAuthenticated } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';

	import type { AgentSummary } from './contract';
	import { ActivityClientError, loadAgentDrivers } from './activity-client';
	import {
		driverStamp,
		mechanismLabel,
		noDriverStatement,
		partialAttributionNotice,
		type AgentDriverLedger,
	} from './activity-view';

	interface Props {
		agent: AgentSummary;
	}

	let { agent }: Props = $props();

	/** Four session states, same as the neighbouring panels. */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');

	type ActivityState =
		| { status: 'loading' }
		| { status: 'unavailable'; message: string }
		| { status: 'ready' };

	let activityState = $state<ActivityState>({ status: 'loading' });
	let ledger = $state<AgentDriverLedger | null>(null);

	/**
	 * The two sentences said ABOUT the roster rather than out of it, both
	 * composed in `activity-view.ts` beside the fold whose exclusions they
	 * describe: what an empty roster may claim, and what qualifies a non-empty
	 * one. A probe calls them with a ledger, which a sentence written into a
	 * template branch could not be.
	 */
	const emptyStatement = $derived(
		ledger ? noDriverStatement(agent.username, ledger) : null
	);
	const partialNotice = $derived(ledger ? partialAttributionNotice(ledger) : null);

	const scope = createSessionScope(sessionGeneration);
	let loadController: AbortController | null = null;

	function openSession() {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;
		loadActivity();
	}

	function closeSession() {
		loadController?.abort();
		loadController = null;
		scope.end();
		session = 'anonymous';
		activityState = { status: 'loading' };
		ledger = null;
	}

	function loadActivity() {
		const token = accessTokenOrNull();
		if (!token) {
			session = 'anonymous';
			return;
		}

		loadController?.abort();
		loadController = new AbortController();
		// Taken at DISPATCH and checked before anything publishes: a read under a
		// session that has since ended publishes nothing, not even its failure.
		const stamp = scope.stamp();
		activityState = { status: 'loading' };

		void loadAgentDrivers(agent.username, {
			accessToken: token,
			signal: loadController.signal,
		})
			.then((result) => {
				if (!scope.holds(stamp)) return;
				ledger = result;
				activityState = { status: 'ready' };
			})
			.catch((error: unknown) => {
				if (!scope.holds(stamp)) return;
				ledger = null;
				activityState = {
					status: 'unavailable',
					message:
						error instanceof ActivityClientError
							? error.message
							: 'This instance could not answer the activity request.',
				};
			});
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
			scope.end();
		};
	});
</script>

{#if session === 'authenticated'}
	<Panel title={`Who has been driving @${agent.username}`} headerLevel={2}>
		<p class="contentus-drivers__lede">
			This instance records the person behind each action <strong>@{agent.username}</strong> takes,
			so this is who has been driving it — read from what the agent did, not from a list of who is
			connected. Sign-ins are not kept as their own record.
		</p>

		{#if activityState.status === 'loading'}
			<p class="contentus-agents__notice">Reading who has been driving this agent…</p>
		{:else if activityState.status === 'unavailable'}
			<p class="contentus-agents__notice">{activityState.message}</p>
		{:else if ledger}
			{#if emptyStatement}
				<!--
					COMPOSED, never written here. An empty roster is only "nobody has
					driven this agent" when lesser recorded nothing at all; with actions
					that named no driver, or rows whose metadata could not be read, that
					sentence is this client answering a question the instance did not.
					`noDriverStatement` holds all three readings and a probe calls it.
				-->
				<p class="contentus-agents__notice">{emptyStatement}</p>
			{:else}
				{#if partialNotice}
					<p class="contentus-agents__notice">{partialNotice}</p>
				{/if}

				<section class="contentus-drivers__section">
					<h3 class="contentus-drivers__subheading">Drivers</h3>
					<!--
						UNKEYED, for the reason the sharing panel's lists are. The rows hold
						no state of their own, and the label is not a key this component may
						assume unique — Svelte throws `each_key_duplicate` on a repeat, in
						production as well as development, which would be the render-time
						crash the client's shape guards exist to keep this panel out of.
					-->
					<ul class="contentus-drivers__list">
						{#each ledger.drivers as driver}
							<li class="contentus-drivers__driver">
								<span class="contentus-drivers__name">{driver.label}</span>
								<span class="contentus-drivers__stamp">{driverStamp(driver)}</span>
								<span class="contentus-drivers__how">
									{driver.mechanisms.map(mechanismLabel).join('; ')}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if ledger.actions.length}
				<section class="contentus-drivers__section">
					<h3 class="contentus-drivers__subheading">Recent actions</h3>
					<ul class="contentus-drivers__list">
						{#each ledger.actions as action}
							<li class="contentus-drivers__action">
								<!--
									lesser's own event token, verbatim. This instance extends the
									vocabulary without asking this client, so a local gloss would
									mislabel every type added after it was written — and would do
									it as confidently as it labels the ones it knows.
								-->
								<span class="contentus-drivers__event">{action.action}</span>
								{#if action.at}
									<span class="contentus-drivers__stamp">{action.at.toLocaleString()}</span>
								{/if}
								{#if action.attribution === 'named'}
									<span class="contentus-drivers__by">
										by {action.drivers.map((driver) => driver.label).join(' and ')}
									</span>
								{:else if action.attribution === 'unreadable'}
									<span class="contentus-drivers__by">details could not be read</span>
								{:else}
									<span class="contentus-drivers__by">no driver recorded</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if ledger.more}
						<p class="contentus-drivers__note">
							This instance had older actions than the ones read here, so the counts above cover
							this list rather than everything it still keeps.
						</p>
					{/if}
				</section>
			{/if}
		{/if}
	</Panel>
{/if}

<!--
Face 7 roster. Every private byte is client-only: `myAgents` and
`droneWorkflow` require the bearer token held in sessionStorage, while route
props travel through a public hydration resource. The server therefore renders
the sign-in explanation and never fetches an owned roster.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { accessTokenOrNull, readSession, startLogin } from '$lib/auth/session';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';
	import Panel from '$lib/greater/shell/components/Panel.svelte';

	import { href } from '../../facetheory/routing';
	import DroneCard from './DroneCard.svelte';
	import {
		fetchDroneRoster,
		hasWriteScope,
		type DroneFailure,
		type OwnedDrone,
	} from './contract';

	let session = $state<'unknown' | 'anonymous' | 'insufficient-scope' | 'authenticated'>(
		'unknown'
	);
	let drones = $state<OwnedDrone[]>([]);
	let failure = $state<DroneFailure | null>(null);
	let loading = $state(false);
	let signInError = $state<string | null>(null);
	let controller: AbortController | null = null;

	const scope = createSessionScope(sessionGeneration);

	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		session = 'anonymous';
		drones = [];
		failure = null;
		loading = false;
	}

	function openSession() {
		const current = readSession();
		if (!current) {
			closeSession();
			return;
		}
		if (!hasWriteScope(current.scope)) {
			controller?.abort();
			scope.end();
			session = 'insufficient-scope';
			drones = [];
			failure = null;
			loading = false;
			return;
		}

		session = 'authenticated';
		controller?.abort();
		controller = new AbortController();
		const stamp = scope.stamp();
		loading = true;

		void fetchDroneRoster({
			accessToken: accessTokenOrNull(),
			signal: controller.signal,
		})
			.then((result) => {
				if (!scope.holds(stamp)) return;
				if (result.ok) {
					drones = result.drones;
					failure = null;
				} else {
					drones = [];
					failure = result.failure;
				}
			})
			.finally(() => {
				if (scope.holds(stamp)) loading = false;
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
			controller?.abort();
			scope.end();
		};
	});

	async function onAuthorize() {
		signInError = null;
		try {
			await startLogin({ scope: 'read write follow', returnTo: href('/drones') });
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}
</script>

{#if session !== 'authenticated'}
	<Panel class="contentus-drones__panel" padding="md" aria-label="Owned drones">
		<section class="contentus-drones__notice">
			<h2>{session === 'insufficient-scope' ? 'Write access required' : 'Sign in to manage drones'}</h2>
			<p>
				{session === 'insufficient-scope'
					? 'Your current Lesser session does not include write. Reauthorize before loading the drones you own.'
					: 'Owned drones are private to your Lesser account. Sign in with write access to load them.'}
			</p>
			{#if session !== 'unknown'}
				<button class="contentus-drone-action" type="button" onclick={onAuthorize}>
					{session === 'insufficient-scope' ? 'Reauthorize' : 'Sign in'}
				</button>
			{/if}
			{#if signInError}<p class="contentus-drones__error" role="alert">{signInError}</p>{/if}
		</section>
	</Panel>
{:else}
	{#if loading}
		<p class="contentus-drones__status" role="status">Loading your drones…</p>
	{:else if failure}
		<p class="contentus-drones__error" role="alert">{failure.message}</p>
	{:else if drones.length === 0}
		<Panel class="contentus-drones__panel" padding="md">
			<p class="contentus-drones__status">You do not own any drones on this instance yet.</p>
		</Panel>
	{:else}
		<ul class="contentus-drones__grid">
			{#each drones as drone (drone.agent.id)}
				<li><DroneCard {drone} /></li>
			{/each}
		</ul>
	{/if}
{/if}

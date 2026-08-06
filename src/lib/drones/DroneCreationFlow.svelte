<!--
The delegation response contains bearer credentials. They live only in this
component's in-memory state and are cleared on dismiss, sign-out, session
change, or component teardown. They never enter sessionStorage, localStorage,
the URL, SSR props, logs, or the public hydration resource.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import { accessTokenOrNull, readSession, startLogin } from '$lib/auth/session';
	import { DRONE_OAUTH_SCOPE } from '$lib/auth/scopes';
	import { onSessionChange, sessionGeneration } from '$lib/auth/session-events';
	import { createSessionScope } from '$lib/auth/session-scope';
	import Panel from '$lib/greater/shell/components/Panel.svelte';

	import { href } from '../../facetheory/routing';
	import DroneCreationForm from './DroneCreationForm.svelte';
	import DroneCredentials from './DroneCredentials.svelte';
	import DronePolicyDisabled from './DronePolicyDisabled.svelte';
	import {
		delegateToDrone,
		fetchDroneRegistrationPolicy,
		hasWriteScope,
		type DroneCreationInput,
		type DroneCredentials as CredentialBundle,
		type DroneRegistrationPolicy,
	} from './contract';
	import { identitySurfaceHref } from './identity';

	let session = $state<'unknown' | 'anonymous' | 'insufficient-scope' | 'authenticated'>(
		'unknown'
	);
	let policy = $state<DroneRegistrationPolicy>('unknown');
	let policyLoading = $state(false);
	let submitting = $state(false);
	let serverError = $state<string | null>(null);
	let credentials = $state<CredentialBundle | null>(null);
	let createdUsername = $state<string | null>(null);
	let dismissed = $state(false);
	let signInError = $state<string | null>(null);
	let controller: AbortController | null = null;

	const scope = createSessionScope(sessionGeneration);

	function clearSensitiveState() {
		credentials = null;
		createdUsername = null;
		serverError = null;
		dismissed = false;
	}

	function closeSession() {
		controller?.abort();
		controller = null;
		scope.end();
		clearSensitiveState();
		policy = 'unknown';
		policyLoading = false;
		submitting = false;
		session = 'anonymous';
	}

	function openSession() {
		const current = readSession();
		if (!current) {
			closeSession();
			return;
		}
		if (!hasWriteScope(current.scope)) {
			closeSession();
			session = 'insufficient-scope';
			return;
		}

		controller?.abort();
		controller = new AbortController();
		const stamp = scope.stamp();
		session = 'authenticated';
		clearSensitiveState();
		policy = 'unknown';
		policyLoading = true;

		void fetchDroneRegistrationPolicy({
			accessToken: accessTokenOrNull(),
			signal: controller.signal,
		}).then((answer) => {
			if (!scope.holds(stamp)) return;
			policy = answer;
			policyLoading = false;
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
			clearSensitiveState();
			scope.end();
		};
	});

	async function authorize() {
		signInError = null;
		try {
			await startLogin({ scope: DRONE_OAUTH_SCOPE, returnTo: href('/drones/new') });
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	async function submit(input: DroneCreationInput) {
		if (submitting || session !== 'authenticated') return;
		controller?.abort();
		controller = new AbortController();
		const stamp = scope.stamp();
		submitting = true;
		serverError = null;
		dismissed = false;

		const result = await delegateToDrone(
			{ accessToken: accessTokenOrNull(), signal: controller.signal },
			input
		);
		if (!scope.holds(stamp)) return;
		submitting = false;
		if (result.ok) {
			credentials = result.credentials;
			createdUsername = result.credentials.username;
			return;
		}
		if (result.failure.reason === 'policy-disabled') {
			policy = 'disabled';
			serverError = null;
			return;
		}
		serverError = result.failure.message;
	}

	function dismissCredentials() {
		credentials = null;
		dismissed = true;
	}
</script>

{#if session !== 'authenticated'}
	<Panel class="contentus-drones__panel" padding="md" aria-label="Drone creation authorization">
		<section class="contentus-drones__notice">
			<h2>{session === 'insufficient-scope' ? 'Write access required' : 'Sign in to create a drone'}</h2>
			<p>
				{session === 'insufficient-scope'
					? 'Your current Lesser session does not include write. Reauthorize before opening the creation form.'
					: 'Drone creation is private to your Lesser account and requires write access.'}
			</p>
			{#if session !== 'unknown'}
				<button class="contentus-drone-action" type="button" onclick={authorize}>
					{session === 'insufficient-scope' ? 'Reauthorize' : 'Sign in'}
				</button>
			{/if}
			{#if signInError}<p class="contentus-drones__error" role="alert">{signInError}</p>{/if}
		</section>
	</Panel>
{:else if policyLoading}
	<p class="contentus-drones__status" role="status">Checking this instance's registration policy…</p>
{:else if policy === 'disabled'}
	<Panel class="contentus-drones__panel" padding="md"><DronePolicyDisabled /></Panel>
{:else if credentials}
	<Panel class="contentus-drones__panel" padding="md">
		<DroneCredentials {credentials} onDismiss={dismissCredentials} />
	</Panel>
{:else}
	{#if dismissed}
		<section class="contentus-drones__notice" aria-label="Credential dismissal confirmation">
			<p class="contentus-drones__status" role="status">
				The credential panel was dismissed and its tokens were cleared from Contentus.
			</p>
			{#if createdUsername}
				<a class="contentus-drone-action" href={identitySurfaceHref(createdUsername)}>
					Open identity &amp; promotion
				</a>
			{/if}
		</section>
	{/if}
	<Panel class="contentus-drones__panel" padding="md">
		<DroneCreationForm {submitting} {serverError} onSubmit={submit} />
	</Panel>
{/if}

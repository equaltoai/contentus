<script lang="ts">
	import {
		AGENT_TYPES,
		DEFAULT_DRONE_SCOPES,
		validateDroneCreation,
		type AgentType,
		type DroneCreationInput,
		type DroneCreationValidation,
	} from './contract';

	interface Props {
		submitting: boolean;
		serverError: string | null;
		onSubmit: (input: DroneCreationInput) => Promise<void> | void;
	}

	let { submitting, serverError, onSubmit }: Props = $props();
	let username = $state('');
	let displayName = $state('');
	let bio = $state('');
	let agentType = $state<AgentType>('ASSISTANT');
	let selected = $state<Record<string, boolean>>(
		Object.fromEntries(DEFAULT_DRONE_SCOPES.map((scope) => [scope, true]))
	);
	let errors = $state<DroneCreationValidation['errors']>({});

	const labels: Record<AgentType, string> = {
		ASSISTANT: 'Assistant',
		CURATOR: 'Curator',
		MODERATOR: 'Moderator',
		RESEARCHER: 'Researcher',
		BRIDGE: 'Bridge',
		CUSTOM: 'Custom',
	};

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (submitting) return;
		const validation = validateDroneCreation({
			username,
			displayName,
			bio,
			agentType,
			scopes: DEFAULT_DRONE_SCOPES.filter((scope) => selected[scope]),
		});
		errors = validation.errors;
		if (!validation.ok || !validation.input) return;
		await onSubmit(validation.input);
	}
</script>

<form class="contentus-drone-form" onsubmit={submit} novalidate>
	<div class="contentus-drone-form__field">
		<label for="drone-username">Username</label>
		<input
			id="drone-username"
			name="username"
			type="text"
			bind:value={username}
			maxlength="30"
			pattern={'[a-zA-Z0-9_-]{1,30}'}
			autocomplete="off"
			spellcheck="false"
			disabled={submitting}
			aria-invalid={Boolean(errors.username)}
			aria-describedby={errors.username ? 'drone-username-error' : 'drone-username-hint'}
			required
		/>
		{#if errors.username}
			<p id="drone-username-error" class="contentus-drones__error">{errors.username}</p>
		{:else}
			<p id="drone-username-hint" class="contentus-drone-form__hint">
				1–30 letters, numbers, underscores, or hyphens.
			</p>
		{/if}
	</div>

	<div class="contentus-drone-form__field">
		<label for="drone-display-name">Display name</label>
		<input
			id="drone-display-name"
			name="displayName"
			type="text"
			bind:value={displayName}
			disabled={submitting}
			aria-invalid={Boolean(errors.displayName)}
			aria-describedby={errors.displayName ? 'drone-display-name-error' : undefined}
			required
		/>
		{#if errors.displayName}
			<p id="drone-display-name-error" class="contentus-drones__error">{errors.displayName}</p>
		{/if}
	</div>

	<div class="contentus-drone-form__field">
		<label for="drone-bio">Bio <span>(optional)</span></label>
		<textarea
			id="drone-bio"
			name="bio"
			bind:value={bio}
			rows="5"
			disabled={submitting}
			aria-invalid={Boolean(errors.bio)}
			aria-describedby={errors.bio ? 'drone-bio-error' : 'drone-bio-hint'}
		></textarea>
		{#if errors.bio}
			<p id="drone-bio-error" class="contentus-drones__error">{errors.bio}</p>
		{:else}
			<p id="drone-bio-hint" class="contentus-drone-form__hint">Up to 500 UTF-8 bytes.</p>
		{/if}
	</div>

	<div class="contentus-drone-form__field">
		<label for="drone-agent-type">Agent type</label>
		<select id="drone-agent-type" name="agentType" bind:value={agentType} disabled={submitting}>
			{#each AGENT_TYPES as value (value)}
				<option {value}>{labels[value]}</option>
			{/each}
		</select>
	</div>

	<fieldset class="contentus-drone-form__scopes" disabled={submitting}>
		<legend>Delegated scopes</legend>
		<p>The default set is read, write, and follow.</p>
		{#each DEFAULT_DRONE_SCOPES as scope (scope)}
			<label>
				<input type="checkbox" name="scopes" value={scope} bind:checked={selected[scope]} />
				<span>{scope}</span>
			</label>
		{/each}
		{#if errors.scopes}<p class="contentus-drones__error">{errors.scopes}</p>{/if}
	</fieldset>

	{#if serverError}<p class="contentus-drones__error" role="alert">{serverError}</p>{/if}

	<div class="contentus-drone-form__submit">
		<button class="contentus-drone-action contentus-drone-action--primary" type="submit" disabled={submitting}>
			{submitting ? 'Creating drone…' : 'Create drone'}
		</button>
	</div>
</form>

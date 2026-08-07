<script lang="ts">
	import { onMount } from 'svelte';

	import type { DroneCredentials } from './contract';

	interface Props {
		credentials: DroneCredentials;
		onDismiss: () => void;
	}

	let { credentials, onDismiss }: Props = $props();
	let mounted = $state(false);
	let copyState = $state<Record<'access' | 'refresh', 'idle' | 'copied' | 'failed'>>({
		access: 'idle',
		refresh: 'idle',
	});

	onMount(() => {
		mounted = true;
	});

	async function copy(kind: 'access' | 'refresh', value: string) {
		try {
			if (!navigator.clipboard) throw new Error('Clipboard unavailable');
			await navigator.clipboard.writeText(value);
			copyState = { ...copyState, [kind]: 'copied' };
		} catch {
			copyState = { ...copyState, [kind]: 'failed' };
		}
	}
</script>

<section class="contentus-drone-credentials" aria-labelledby="drone-credentials-title">
	<p class="contentus-eyebrow">Drone created</p>
	<h2 id="drone-credentials-title">Save these credentials now</h2>
	<p class="contentus-drone-credentials__warning">
		This is the only time Contentus will show the OAuth tokens for @{credentials.username}. They
		cannot be recovered after you dismiss this panel or leave the page.
	</p>

	<div class="contentus-drone-credential">
		<div class="contentus-drone-credential__header">
			<strong>Access token</strong>
			{#if mounted}
				<button type="button" onclick={() => copy('access', credentials.accessToken)}>
					{copyState.access === 'copied'
						? 'Copied'
						: copyState.access === 'failed'
							? 'Copy failed'
							: 'Copy'}
				</button>
			{/if}
		</div>
		<pre><code>{credentials.accessToken}</code></pre>
		{#if copyState.access === 'failed'}
			<p>Select the token above and copy it manually.</p>
		{/if}
	</div>

	<div class="contentus-drone-credential">
		<div class="contentus-drone-credential__header">
			<strong>Refresh token</strong>
			{#if mounted}
				<button type="button" onclick={() => copy('refresh', credentials.refreshToken)}>
					{copyState.refresh === 'copied'
						? 'Copied'
						: copyState.refresh === 'failed'
							? 'Copy failed'
							: 'Copy'}
				</button>
			{/if}
		</div>
		<pre><code>{credentials.refreshToken}</code></pre>
		{#if copyState.refresh === 'failed'}
			<p>Select the token above and copy it manually.</p>
		{/if}
	</div>

	<dl class="contentus-drone-card__facts">
		<div><dt>Token type</dt><dd>{credentials.tokenType}</dd></div>
		<div><dt>Scopes</dt><dd>{credentials.scope}</dd></div>
		<div><dt>Created</dt><dd>{credentials.createdAt}</dd></div>
		<div><dt>Expires in</dt><dd>{credentials.expiresIn} seconds</dd></div>
	</dl>

	<button class="contentus-drone-action" type="button" onclick={onDismiss}>
		I saved both tokens — dismiss permanently
	</button>
</section>

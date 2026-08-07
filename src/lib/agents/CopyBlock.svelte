<!--
A mono value with a copy action (product design §5, face 6: "copy-config blocks
use the mono token with a copy action").

THE VALUE IS ALWAYS SELECTABLE TEXT. The copy button is an affordance on top of
a `<pre>`/`<code>` a reader can select by hand, never the only way to get the
value out. `navigator.clipboard` needs a secure context and a permission that
can be refused, and a block whose contents were only reachable through a button
would become unreadable exactly when the button fails.

The button is therefore rendered only after mount: with scripting off it would
be a control that does nothing, and the server's paint is the honest one.

NO `{@html}`, here or anywhere in this face. These blocks carry URLs and JSON
built from lesser's values; they are TEXT, and Svelte's interpolation escapes
them. Face 6 renders agent metadata and never article or status content, so
nothing in this directory has any business owning a renderer —
`scripts/audit-renderer-authority.mjs` scans it on every build.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		label: string;
		value: string;
		/** Where the snippet belongs, when it is a file rather than a URL. */
		destination?: string;
		multiline?: boolean;
	}

	let { label, value, destination, multiline = false }: Props = $props();

	let mounted = $state(false);
	/**
	 * Three states, not two: `idle`, `copied` and `failed`. A copy that silently
	 * did nothing is the failure mode this exists to avoid — the reader walks
	 * away believing they have the value.
	 */
	let result = $state<'idle' | 'copied' | 'failed'>('idle');

	onMount(() => {
		mounted = true;
	});

	async function copy() {
		try {
			if (!navigator?.clipboard) throw new Error('no clipboard');
			await navigator.clipboard.writeText(value);
			result = 'copied';
		} catch {
			result = 'failed';
		}
	}
</script>

<div class="contentus-copy">
	<div class="contentus-copy__head">
		<span class="contentus-copy__label">
			{label}
			{#if destination}
				<span class="contentus-copy__destination">{destination}</span>
			{/if}
		</span>

		{#if mounted}
			<button class="contentus-copy__button" type="button" onclick={copy}>
				{result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : 'Copy'}
			</button>
		{/if}
	</div>

	{#if multiline}
		<pre class="contentus-copy__value contentus-copy__value--block"><code>{value}</code></pre>
	{:else}
		<p class="contentus-copy__value"><code>{value}</code></p>
	{/if}

	{#if result === 'failed'}
		<p class="contentus-copy__hint">
			This browser refused clipboard access. The value above can be selected and copied by hand.
		</p>
	{/if}
</div>

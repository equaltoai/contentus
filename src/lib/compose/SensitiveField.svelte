<!--
The `sensitive` flag, as a first-class control beside the content warning
(product design §5, face 3).

Separate from the content warning because lesser keeps them separate: a warning
is text readers see before opening a post, and `sensitive` is the flag clients
use to gate the media inside it. A post can carry either, both, or neither, and
the contract has no rule turning one into the other — so neither does this.
-->

<script lang="ts">
	import EyeOffIcon from '$lib/greater/icons/icons/eye-off.svelte';
	import { getComposeContext } from '$lib/components/compose/context';

	import { getComposeExtras } from './extras.svelte';

	const context = getComposeContext();
	const extras = getComposeExtras();

	function toggle(event: Event) {
		extras.update({ sensitive: (event.target as HTMLInputElement).checked });
	}
</script>

<div class="contentus-compose-field">
	<label class="contentus-compose-toggle">
		<input
			type="checkbox"
			checked={extras.state.sensitive}
			onchange={toggle}
			disabled={context.state.submitting}
		/>
		<span class="contentus-compose-toggle__label">
			<EyeOffIcon size={16} aria-hidden="true" />
			Mark as sensitive
		</span>
	</label>

	{#if extras.state.sensitive}
		<p class="contentus-compose-hint">
			Sent as <code>sensitive</code>. Attached media is hidden behind a tap until a reader
			chooses to reveal it.
		</p>
	{/if}
</div>

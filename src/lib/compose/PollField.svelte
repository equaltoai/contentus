<!--
Poll attachment, on the vendored `PollComposer` pattern in `create` mode.

The pattern is built to CREATE a poll and reset — its submit reads "Create
poll", and it clears its options once the handler resolves. lesser does not
have a standalone poll object: a poll is a field on `CreateNoteInput`, attached
when the note is posted. So "create" here means "attach to this draft", and the
attached poll is shown back as a summary with a remove action, because a
pattern that has reset its own form can no longer show what it produced.

Recorded as an upstream observation rather than worked around: a compose-time
poll builder wants an `onChange`-shaped handler and a controlled `value`, not a
create-and-reset submit. Forking the pattern to get one would be
reimplementing a component upstream already owns.
-->

<script lang="ts">
	import XIcon from '$lib/greater/icons/icons/x.svelte';
	import PollComposer from '$lib/patterns/PollComposer.svelte';
	import { getComposeContext } from '$lib/components/compose/context';

	import { getComposeExtras } from './extras.svelte';

	const context = getComposeContext();
	const extras = getComposeExtras();

	let open = $state(false);

	const poll = $derived(extras.state.poll);

	/** lesser's `expiresIn` is seconds; this is only for the summary line. */
	function describeDuration(seconds: number): string {
		if (seconds % 86400 === 0) {
			const days = seconds / 86400;
			return `${days} day${days === 1 ? '' : 's'}`;
		}
		if (seconds % 3600 === 0) {
			const hours = seconds / 3600;
			return `${hours} hour${hours === 1 ? '' : 's'}`;
		}
		const minutes = Math.max(1, Math.round(seconds / 60));
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}

	async function attach(draft: {
		options: string[];
		expiresIn: number;
		multiple: boolean;
		hideTotals: boolean;
	}) {
		extras.update({
			poll: {
				options: draft.options,
				expiresIn: draft.expiresIn,
				multiple: draft.multiple,
				hideTotals: draft.hideTotals,
			},
		});
		open = false;
	}

	function detach() {
		extras.update({ poll: null });
	}
</script>

<div class="contentus-compose-poll">
	{#if poll}
		<div class="contentus-compose-poll__summary">
			<div>
				<p class="contentus-compose-poll__title">
					Poll · {poll.options.length} options · closes in {describeDuration(poll.expiresIn)}
				</p>
				<ul class="contentus-compose-poll__options">
					{#each poll.options as option, index (index)}
						<li>{option}</li>
					{/each}
				</ul>
				<p class="contentus-compose-hint">
					{poll.multiple ? 'Multiple choice' : 'Single choice'}{poll.hideTotals
						? ' · results hidden until it closes'
						: ''}
				</p>
			</div>
			<button
				type="button"
				class="contentus-compose-poll__remove"
				onclick={detach}
				disabled={context.state.submitting}
				aria-label="Remove poll"
			>
				<XIcon size={18} aria-hidden="true" />
			</button>
		</div>
	{:else if open}
		<PollComposer
			mode="create"
			config={{ maxOptions: 4, minOptions: 2, maxOptionLength: 50 }}
			handlers={{ onSubmit: attach }}
		/>
		<button
			type="button"
			class="contentus-compose-poll__toggle"
			onclick={() => (open = false)}
			disabled={context.state.submitting}
		>
			Cancel poll
		</button>
	{:else}
		<button
			type="button"
			class="contentus-compose-poll__toggle"
			onclick={() => (open = true)}
			disabled={context.state.submitting}
		>
			Add a poll
		</button>
	{/if}
</div>

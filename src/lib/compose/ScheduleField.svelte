<!--
Schedule a post for later, via lesser's `scheduleStatus`.

`<input type="datetime-local">` takes and returns a LOCAL wall-clock string with
no zone (`2026-08-01T09:30`), and lesser's `scheduledAt` is a `Time!` — an
instant. The conversion happens here, once, through the browser's own `Date`,
so the instant sent is the moment the poster picked in the timezone they are
standing in. Nothing about it is guessed and nothing is stored as a naive
string.

The control is hidden in edit mode. `updateStatus` has no scheduling and
`scheduleStatus` creates a new scheduled status rather than moving an existing
post — offering a schedule while editing would promise something neither
operation does.
-->

<script lang="ts">
	import ClockIcon from '$lib/greater/icons/icons/clock.svelte';
	import { getComposeContext } from '$lib/components/compose/context';

	import { getComposeExtras } from './extras.svelte';

	const context = getComposeContext();
	const extras = getComposeExtras();

	let enabled = $state(false);
	let localValue = $state('');
	let error = $state<string | null>(null);

	function toggle(event: Event) {
		enabled = (event.target as HTMLInputElement).checked;
		if (!enabled) {
			localValue = '';
			error = null;
			extras.update({ scheduledAt: null });
		}
	}

	function onChange(event: Event) {
		localValue = (event.target as HTMLInputElement).value;
		error = null;

		if (!localValue) {
			extras.update({ scheduledAt: null });
			return;
		}

		const instant = new Date(localValue);
		if (Number.isNaN(instant.getTime())) {
			error = 'That is not a time this browser understands.';
			extras.update({ scheduledAt: null });
			return;
		}

		if (instant.getTime() <= Date.now()) {
			// Refused here rather than by the instance, because a post scheduled
			// for the past is a mistake the poster can still fix at this point.
			error = 'Pick a time in the future.';
			extras.update({ scheduledAt: null });
			return;
		}

		extras.update({ scheduledAt: instant.toISOString() });
	}
</script>

<div class="contentus-compose-field">
	<label class="contentus-compose-toggle">
		<input
			type="checkbox"
			checked={enabled}
			onchange={toggle}
			disabled={context.state.submitting}
		/>
		<span class="contentus-compose-toggle__label">
			<ClockIcon size={16} aria-hidden="true" />
			Schedule for later
		</span>
	</label>

	{#if enabled}
		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">Post at</span>
			<input
				type="datetime-local"
				class="contentus-compose-input"
				value={localValue}
				onchange={onChange}
				disabled={context.state.submitting}
			/>
		</label>

		{#if error}
			<p class="contentus-compose-media__error" role="alert">{error}</p>
		{:else if extras.state.scheduledAt}
			<p class="contentus-compose-hint">
				Sent to <code>scheduleStatus</code>. Quoting is unavailable on a scheduled post —
				lesser's <code>ScheduleStatusInput</code> has no <code>quoteId</code>.
			</p>
		{/if}
	{/if}
</div>

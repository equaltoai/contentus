<!--
Content-warning control for the composer (product design §5, face 3: "the
visibility selector and CW are first-class, not hidden behind menus").

CONTENTUS-OWNED because greater-components has no compose-side CW control at
greater-v0.11.9. The vendored `patterns/ContentWarningHandler` is a READING
component — it collapses already-warned content behind a disclosure — and the
compose compound carries `contentWarning`/`contentWarningEnabled` in its context
with no control bound to them. This file is that binding, not a fork: all state
lives in the vendored compose context and is read back by `Compose.Root` on
submit.

Candidate to offer upstream alongside the mobile chrome, once proven on an
instance (framework feedback lane).

`sensitive` is deliberately NOT set from this control. lesser reads
`input.sensitive` on its own and never derives it from a spoiler being present
(`graph/mutation_resolvers_notes.go` → `buildCreateNoteCommand`), so coupling
them here would be contentus inventing a semantic the contract does not have.
The composer surfaces both, side by side, and says what each one does.
-->

<script lang="ts">
	import AlertTriangleIcon from '$lib/greater/icons/icons/alert-triangle.svelte';
	import { getComposeContext } from '$lib/components/compose/context';

	interface Props {
		/** Matches lesser's spoiler-text ceiling; see `validateUploadSpoilerText`. */
		maxLength?: number;
	}

	let { maxLength = 200 }: Props = $props();

	const context = getComposeContext();

	const enabled = $derived(context.state.contentWarningEnabled);

	function toggle(event: Event) {
		const on = (event.target as HTMLInputElement).checked;
		context.updateState({
			contentWarningEnabled: on,
			// Clearing the text on toggle-off is what keeps the control honest: a
			// warning left in state but not sent is a warning the poster believes
			// they wrote. `Compose.Root` only forwards it when enabled, so an
			// uncleared value would be invisible until the toggle came back on.
			...(on ? {} : { contentWarning: '' }),
		});
	}

	function onInput(event: Event) {
		const value = (event.target as HTMLInputElement).value.slice(0, maxLength);
		context.updateState({ contentWarning: value });
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
			<AlertTriangleIcon size={16} aria-hidden="true" />
			Content warning
		</span>
	</label>

	{#if enabled}
		<label class="contentus-compose-field__row">
			<span class="contentus-compose-field__label">
				Warning text
				<span class="contentus-compose-field__count">
					{context.state.contentWarning.length}/{maxLength}
				</span>
			</span>
			<input
				type="text"
				class="contentus-compose-input"
				value={context.state.contentWarning}
				maxlength={maxLength}
				oninput={onInput}
				disabled={context.state.submitting}
				placeholder="What should readers know before opening this?"
			/>
		</label>
		<p class="contentus-compose-hint">
			Sent as <code>spoilerText</code>. Clients that honour it collapse the post behind this
			line until a reader chooses to open it.
		</p>
	{/if}
</div>

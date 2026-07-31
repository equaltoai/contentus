<!--
The instance's custom emoji, on the vendored `CustomEmojiPicker` pattern.

Two ways in, and they do different jobs. Typing `:` opens the autocomplete menu
in the editor and completes in place at the caret — that is the fast path, and
it is the one `EditorWithAutocomplete` already handles. This picker is the
browse path: categories, search, and a grid, for finding an emoji you cannot
name yet.

A selection is APPENDED to the post rather than inserted at the caret. The
vendored `Compose.Editor` exposes no textarea reference to a sibling, and
reaching into the DOM for one would be this component deciding it knows how
another component is built. Appending is the honest behaviour available, and
the caret path already exists for anyone who wants placement.

The catalogue comes from lesser's `customEmojis`, fetched once per page and
filtered locally — the query takes no arguments, so there is nothing to
re-request per keystroke.
-->

<script lang="ts">
	import SmileIcon from '$lib/greater/icons/icons/smile.svelte';
	import CustomEmojiPicker from '$lib/patterns/CustomEmojiPicker.svelte';
	import { getComposeContext } from '$lib/components/compose/context';
	import { loadCustomEmojis, type InstanceEmoji } from '$lib/cms/discovery';

	const context = getComposeContext();

	let open = $state(false);
	let emojis = $state<InstanceEmoji[]>([]);
	let loaded = $state(false);

	async function toggle() {
		open = !open;
		if (open && !loaded) {
			emojis = await loadCustomEmojis();
			loaded = true;
		}
	}

	function insert(shortcode: string) {
		const current = context.state.content;
		const separator = current.length === 0 || current.endsWith(' ') || current.endsWith('\n')
			? ''
			: ' ';
		context.updateState({ content: `${current}${separator}:${shortcode}: ` });
	}
</script>

<div class="contentus-compose-emoji">
	<button
		type="button"
		class="contentus-compose-emoji__toggle"
		onclick={toggle}
		disabled={context.state.submitting}
		aria-expanded={open}
	>
		<SmileIcon size={18} aria-hidden="true" />
		{open ? 'Hide emoji' : 'Custom emoji'}
	</button>

	{#if open}
		{#if loaded && emojis.length === 0}
			<p class="contentus-compose-hint">This instance publishes no custom emoji.</p>
		{:else}
			<CustomEmojiPicker
				{emojis}
				config={{ mode: 'inline', showSearch: true, showCategories: true }}
				handlers={{
					onSelect: (emoji) => insert(emoji.shortcode),
				}}
			/>
		{/if}
	{/if}
</div>

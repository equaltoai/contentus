<!--
A section that collapses on a phone and stays open on a desk (face 6, M6.4;
product design §5: "MCP detail sections collapse into accordions").

NATIVE `<details>`, NOT A BUILT ONE. lesser performs no SPA fallback under
`/l/*`, so the first paint of a phone deep link is the server's. A disclosure
built from a button and a class toggle does nothing until hydration; a
`<details>` opens and closes with no script at all, is a real disclosure widget
to a screen reader without a single ARIA attribute, and is what the browser's
find-in-page can already expand.

WHICH WAY THE ENHANCEMENT RUNS, and it is the direction that matters. The server
renders every section OPEN. That is the honest cold state: a reader with no
script gets the whole panel — every MCP address, every scope, every guidance
line — rather than a stack of headings they cannot open reliably. On mount, and
only on a viewport at or below the 960px breakpoint, the sections marked
collapsible close. So script makes a phone tidier; its absence never hides
anything.

Doing it the other way — rendering closed and opening with script — would mean a
no-script phone reader could see the headings and not the contract. That is the
version of this component that would have been easier to write and wrong.
-->

<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/**
		 * Whether this section collapses on a phone. False for anything a reader
		 * on a phone came here for — the MCP endpoint itself does not hide.
		 */
		collapsible?: boolean;
		children: Snippet;
	}

	let { title, collapsible = true, children }: Props = $props();

	// Open on the server and for every no-script reader. Never starts closed.
	let open = $state(true);

	onMount(() => {
		if (!collapsible || typeof matchMedia !== 'function') return;

		const phone = matchMedia('(max-width: 960px)');
		open = !phone.matches;

		// Rotating a phone across the breakpoint should land on that viewport's
		// designed state rather than whatever the previous one happened to leave.
		const onChange = (event: MediaQueryListEvent) => {
			open = !event.matches;
		};
		phone.addEventListener('change', onChange);
		return () => phone.removeEventListener('change', onChange);
	});
</script>

<details class="contentus-accordion" bind:open>
	<summary class="contentus-accordion__summary">
		<span class="contentus-accordion__title">{title}</span>
		<span class="contentus-accordion__marker" aria-hidden="true"></span>
	</summary>
	<div class="contentus-accordion__body">
		{@render children()}
	</div>
</details>

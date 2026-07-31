<!--
Sheet chrome — a bottom-anchored full-screen surface on mobile, a centered
dialog on desktop (product design §4).

CONTENTUS-OWNED, and composed rather than invented: focus containment and
dismissal come from the vendored headless behaviours (`createFocusTrap`,
`createDismissable`), and the body scroll lock reuses the exact protocol the
vendored `Modal` uses — the `data-gr-scroll-lock-count` counter on `<body>` —
so a Sheet and a Modal open at once release the lock correctly instead of one
clobbering the other's. Nothing here reimplements a greater primitive.

SWAP-TO-VENDORED: greater-components has no sheet component at greater-v0.11.9
(product design §7, planned upstream). When greater M3a lands one, this file
becomes a binding over it and the `.contentus-sheet*` rules in
`src/lib/brand/bridge.css` are deleted with it.

Why not the vendored `Modal` for this: `Modal` renders a `<dialog>` with a
`<main>` landmark inside its body, and the app shell already owns the page's
`<main>`. Nesting a second one is a landmark defect on every sheet. `Modal`
remains the right component for short confirm dialogs, which is where contentus
uses it; a full-screen composition surface is a different shape.

Browser-only by construction. The behaviours bind to `document`, and a sheet is
an overlay on an already-rendered page — there is no first-paint state for the
server to produce. Routes that must exist on a cold request are routes, not
sheets.
-->

<script lang="ts">
	import type { Snippet } from 'svelte';

	import XIcon from '$lib/greater/icons/icons/x.svelte';
	import { createDismissable } from '$lib/greater/headless/behaviors/dismissable';
	import { createFocusTrap } from '$lib/greater/headless/behaviors/focus-trap';

	interface Props {
		/** Whether the sheet is showing. Bindable so a parent can close it. */
		open?: boolean;
		/** Accessible name for the dialog. Rendered as the sheet's heading. */
		title: string;
		/** Element id prefix; must be stable between server and client. */
		id: string;
		/** Close on Escape and on a click outside the panel. */
		dismissable?: boolean;
		children?: Snippet;
		/** Sticky action bar pinned to the bottom edge, above the safe area. */
		actions?: Snippet;
		onClose?: () => void;
	}

	let {
		open = $bindable(false),
		title,
		id,
		dismissable = true,
		children,
		actions,
		onClose,
	}: Props = $props();

	const titleId = $derived(`${id}-title`);

	let panel = $state<HTMLElement | null>(null);

	function close() {
		open = false;
		onClose?.();
	}

	const focusTrap = createFocusTrap({
		// Focus the panel's first control rather than the close button: on the
		// composer the first control is the editor, which is what a thumb-driven
		// sheet should hand the caret to.
		autoFocus: true,
		returnFocus: true,
	});

	const dismisser = createDismissable({
		closeOnClickOutside: true,
		closeOnEscape: true,
		onDismiss: () => close(),
	});

	// Behaviours follow the panel element, not the `open` flag alone: the element
	// only exists once the branch below has rendered, so binding on `open` would
	// activate against null on the first tick.
	$effect(() => {
		const element = panel;
		if (!open || !element) return;

		focusTrap.activate(element);
		if (dismissable) dismisser.activate(element);

		return () => {
			if (dismissable) dismisser.deactivate();
			focusTrap.deactivate();
		};
	});

	// Body scroll lock, sharing greater's counter so nested overlays compose.
	$effect(() => {
		if (!open || typeof document === 'undefined') return;

		const attribute = 'data-gr-scroll-lock-count';
		const next = Number(document.body.getAttribute(attribute) || '0') + 1;
		document.body.setAttribute(attribute, String(next));
		document.body.classList.add('gr-scroll-locked');

		return () => {
			const remaining = Math.max(0, Number(document.body.getAttribute(attribute) || '0') - 1);
			if (remaining === 0) {
				document.body.removeAttribute(attribute);
				document.body.classList.remove('gr-scroll-locked');
				return;
			}
			document.body.setAttribute(attribute, String(remaining));
		};
	});
</script>

{#if open}
	<!-- The scrim is decorative: dismissal is the dismissable behaviour's job
	     (Escape and outside-click), so the scrim carries no handler of its own
	     and needs no keyboard equivalent. -->
	<div class="contentus-sheet-scrim" aria-hidden="true"></div>

	<!-- A `div` rather than a `section`: `role="dialog"` is an interactive role,
	     and putting it on a landmark element conflicts with that landmark's own
	     semantics. The dialog IS the region here. -->
	<div
		bind:this={panel}
		class="contentus-sheet"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
	>
		<header class="contentus-sheet__header">
			<h2 class="contentus-sheet__title" id={titleId}>{title}</h2>
			<button
				type="button"
				class="contentus-sheet__close"
				onclick={close}
				aria-label="Close {title}"
			>
				<XIcon size={20} aria-hidden="true" />
			</button>
		</header>

		<div class="contentus-sheet__body">
			{@render children?.()}
		</div>

		{#if actions}
			<footer class="contentus-sheet__actions">
				{@render actions()}
			</footer>
		{/if}
	</div>
{/if}

<!--
Delete a posted status, behind a confirmation.

Uses the vendored `Modal` rather than the contentus sheet: this is a short
confirm with two buttons, which is exactly the shape `Modal` is for, and it
brings `<dialog>`'s top layer, native focus containment, and the shared body
scroll-lock counter with it. The contentus `Sheet` exists for full-screen
composition surfaces, which this is not.

Deletion is irreversible and it federates — a Delete activity goes out to every
instance that saw the post. The confirmation says that rather than asking "are
you sure", because "are you sure" is a question a reader answers reflexively
and "this cannot be undone, and other servers are told" is one they read.
-->

<script lang="ts">
	import Trash2Icon from '$lib/greater/icons/icons/trash-2.svelte';
	import Modal from '$lib/greater/primitives/components/Modal.svelte';
	import { deleteObject, type ComposeFailure } from '$lib/cms/compose';

	interface Props {
		statusId: string;
		/** Called once lesser has confirmed the delete. */
		onDeleted?: () => void;
	}

	let { statusId, onDeleted }: Props = $props();

	let open = $state(false);
	let deleting = $state(false);
	let failure = $state<ComposeFailure | null>(null);

	async function confirm() {
		deleting = true;
		failure = null;

		const result = await deleteObject(statusId);
		deleting = false;

		if (!result.ok) {
			failure = result.failure;
			// The dialog stays open: the reader asked for something that did not
			// happen, and closing would read as if it had.
			return;
		}

		open = false;
		onDeleted?.();
	}
</script>

<button
	type="button"
	class="contentus-compose-delete"
	onclick={() => (open = true)}
	disabled={deleting}
>
	<Trash2Icon size={16} aria-hidden="true" />
	Delete post
</button>

{#if failure && !open}
	<p class="contentus-compose-media__error" role="alert">{failure.message}</p>
{/if}

<Modal bind:open title="Delete this post?" size="sm">
	<p>
		This cannot be undone. lesser sends a delete out to every instance that received the post,
		though whether each one honours it is theirs to decide.
	</p>

	{#if failure}
		<p class="contentus-compose-media__error" role="alert">{failure.message}</p>
	{/if}

	{#snippet footer()}
		<button type="button" class="contentus-compose-poll__toggle" onclick={() => (open = false)}>
			Keep it
		</button>
		<button type="button" class="contentus-compose-delete" onclick={confirm} disabled={deleting}>
			{deleting ? 'Deleting…' : 'Delete permanently'}
		</button>
	{/snippet}
</Modal>

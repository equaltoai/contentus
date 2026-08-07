<!--
Media attachments, on the vendored `MediaComposer` pattern.

`MediaComposer` rather than the compose compound's own `MediaUpload`, and the
reason is the alt text. `MediaUpload` uploads on selection and then renders
description and spoiler editors whose changes have no handler at all — they
update its internal state and stop there. An accessibility control that never
reaches the server is worse than no control, so this face uses the pattern that
reports every edit: `MediaComposer` calls `onUpdateAltText` and
`onUpdateFocalPoint`, which map straight onto lesser's `updateMedia`.

WHO OWNS THE LIST. `MediaComposer` appends whatever `onUpload` returns to its
own copy of `attachments` and drops removed ones itself. So this component does
not also maintain that array — doing both would double every attachment. It
keeps the id list the post needs, updated from the same callbacks, and lets the
pattern own its presentation.

The consequence, recorded rather than papered over: `MediaComposer` learns about
an attachment only once `onUpload` has resolved, so it cannot paint a progress
bar during the upload it is waiting on. The real per-file progress from
`uploadMedia`'s XHR is surfaced in the line above instead. An upstream
observation — the handler would need to yield attachments before completion for
the pattern's own progress bar to ever run.

WHO DECIDES WHAT THE INSTANCE ACCEPTS. Not this component. The pattern's
defaults — six MIME types and a 10 MiB ceiling, enforced with `console.warn`
and a silent drop — are an invented policy that happens to resemble one
instance's configuration, and `cms/media.ts` is explicit that lesser's real
limits are unadvertised and must not be guessed. So the size ceiling is set
where the check can never trip it, the type list is widened to lesser's own
`MediaCategory` vocabulary, and anything the vendored validator still discards
is named to the poster rather than swallowed.

HOW THAT LAST PART IS DONE CHANGED AT greater-v0.13.0, and the change is a
deletion. contentus used to RECOVER discarded files by diffing the poster's
selection against what `onUpload` received, with capture-phase listeners on this
wrapper to capture the selection, plus a PREDICTION for the case the diff could
not reach — the validator discarding everything and returning before `onUpload`
ran. All of that was inference about a component's internals. The pattern now
reports its own rejections through `onReject`, so the listeners, the diff and the
prediction are gone and this component reads what the component says. The
reasoning, the residual limit, and the upstream `greater` issue it belongs to
are in `$lib/compose/media-policy`.
-->

<script lang="ts">
	import MediaComposer from '$lib/patterns/MediaComposer.svelte';
	import type { MediaComposerAttachment } from '$lib/patterns/MediaComposer.svelte';
	import { uploadMedia, updateMedia, type MediaCategory } from '$lib/cms/media';
	import type { ComposeFailure } from '$lib/cms/compose';

	import { getComposeExtras } from './extras.svelte';
	import {
		NO_CLIENT_SIZE_CEILING,
		PICKER_MEDIA_TYPES,
		rejectionMessage,
		type MediaRejectionReason,
	} from './media-policy';

	interface Props {
		/** lesser accepts four attachments per status, matching Mastodon. */
		maxAttachments?: number;
	}

	let { maxAttachments = 4 }: Props = $props();

	const extras = getComposeExtras();

	let failure = $state<ComposeFailure | null>(null);
	let inFlight = $state<{ name: string; percent: number } | null>(null);
	let rejected = $state<string | null>(null);
	/**
	 * Whether the rejections arriving now belong to the batch already on screen.
	 *
	 * `onReject` fires once per distinct reason within one selection, and those
	 * calls have to accumulate; the next selection has to replace them. Closed by
	 * `onUpload` — which runs after the whole batch's rejections — and by the
	 * pattern having nothing left to forward.
	 */
	let batchOpen = false;

	/**
	 * The vendored gate refused files, and said which and why.
	 *
	 * Called once per distinct reason, so the messages accumulate rather than
	 * overwrite: a selection that trips both the type gate and the attachment cap
	 * produces two calls, and a poster who is told only about one of them will fix
	 * that one and watch the rest vanish again.
	 *
	 * Cleared at the start of each upload, not here — `onReject` runs before
	 * `onUpload` in the same selection, so clearing here would erase the message
	 * the previous call just wrote.
	 */
	function onReject(files: File[], reason: MediaRejectionReason) {
		const message = rejectionMessage(files, reason);
		if (!message) return;
		// A new selection starts a new report: the pattern validates the whole
		// selection before reporting any of it, so the first call of a batch is
		// where the previous batch's messages stop being true.
		rejected = batchOpen ? `${rejected} ${message}` : message;
		batchOpen = true;
	}

	/**
	 * lesser's `MediaCategory` onto the vendored attachment `type`.
	 *
	 * The two vocabularies agree on everything the pattern renders; `DOCUMENT`
	 * and anything unrecognised become `unknown`, which is the pattern's own
	 * word for "show a file chip rather than a preview".
	 */
	function toAttachmentType(category: MediaCategory | string): MediaComposerAttachment['type'] {
		switch (String(category).toUpperCase()) {
			case 'IMAGE':
				return 'image';
			case 'VIDEO':
				return 'video';
			case 'GIFV':
				return 'gifv';
			case 'AUDIO':
				return 'audio';
			default:
				return 'unknown';
		}
	}

	async function onUpload(files: File[]): Promise<MediaComposerAttachment[]> {
		failure = null;
		// Every rejection for this selection has already been reported; anything
		// arriving after this belongs to the next one.
		batchOpen = false;

		const room = Math.max(0, maxAttachments - extras.state.attachmentIds.length);
		const accepted = files.slice(0, room);
		if (accepted.length < files.length) {
			failure = {
				reason: 'rejected',
				message: `This instance accepts ${maxAttachments} attachments per post.`,
			};
		}

		const uploaded: MediaComposerAttachment[] = [];

		// Sequential, not parallel. Four concurrent multipart uploads on a phone
		// connection compete for one uplink and every one of them crawls; one at a
		// time finishes the first attachment sooner, which is the one the poster
		// is waiting to see.
		for (const file of accepted) {
			inFlight = { name: file.name, percent: 0 };

			const result = await uploadMedia(file, { filename: file.name }, (percent) => {
				inFlight = { name: file.name, percent };
			});

			if (!result.ok) {
				failure = result.failure;
				continue;
			}

			uploaded.push({
				id: result.value.id,
				type: toAttachmentType(result.value.mediaCategory),
				url: result.value.url,
				...(result.value.previewUrl ? { previewUrl: result.value.previewUrl } : {}),
				...(result.value.description ? { description: result.value.description } : {}),
				uploadProgress: 100,
				uploaded: true,
			});
		}

		inFlight = null;

		extras.update({
			attachmentIds: [...extras.state.attachmentIds, ...uploaded.map((item) => item.id)],
		});

		return uploaded;
	}

	function onRemove(id: string) {
		extras.update({
			attachmentIds: extras.state.attachmentIds.filter((existing) => existing !== id),
		});
	}

	function onReorder(next: MediaComposerAttachment[]) {
		// Order is contract-relevant: lesser stores `attachmentIds` as given, and
		// that is the order every client renders the gallery in.
		extras.update({ attachmentIds: next.map((attachment) => attachment.id) });
	}

	async function onUpdateAltText(id: string, altText: string) {
		const result = await updateMedia(id, { description: altText });
		if (!result.ok) failure = result.failure;
	}

	async function onUpdateFocalPoint(id: string, x: number, y: number) {
		const result = await updateMedia(id, { focus: { x, y } });
		if (!result.ok) failure = result.failure;
	}
</script>

<div class="contentus-compose-media">
	{#if failure}
		<p class="contentus-compose-media__error" role="alert">{failure.message}</p>
	{/if}

	{#if rejected}
		<p class="contentus-compose-media__error" role="alert">{rejected}</p>
	{/if}

	{#if inFlight}
		<p class="contentus-compose-media__progress" role="status">
			Uploading {inFlight.name} — {inFlight.percent}%
		</p>
	{/if}

	<MediaComposer
		attachments={[]}
		config={{
			maxAttachments,
			enableFocalPoint: true,
			layout: 'grid',
			requireAltText: false,
			// Neither value is contentus deciding what the instance takes. The
			// list is what the vendored validator requires in order to offer
			// lesser's own media categories at all, and the ceiling is set where
			// the check cannot trip — leaving both decisions to lesser, which is
			// the only party that knows them. See `./media-policy`.
			allowedTypes: [...PICKER_MEDIA_TYPES],
			maxFileSize: NO_CLIENT_SIZE_CEILING,
		}}
		handlers={{ onUpload, onReject, onRemove, onReorder, onUpdateAltText, onUpdateFocalPoint }}
	/>
</div>

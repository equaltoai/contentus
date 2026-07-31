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
-->

<script lang="ts">
	import MediaComposer from '$lib/patterns/MediaComposer.svelte';
	import type { MediaComposerAttachment } from '$lib/patterns/MediaComposer.svelte';
	import { uploadMedia, updateMedia, type MediaCategory } from '$lib/cms/media';
	import type { ComposeFailure } from '$lib/cms/compose';

	import { getComposeExtras } from './extras.svelte';

	interface Props {
		/** lesser accepts four attachments per status, matching Mastodon. */
		maxAttachments?: number;
	}

	let { maxAttachments = 4 }: Props = $props();

	const extras = getComposeExtras();

	let failure = $state<ComposeFailure | null>(null);
	let inFlight = $state<{ name: string; percent: number } | null>(null);

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
		}}
		handlers={{ onUpload, onRemove, onReorder, onUpdateAltText, onUpdateFocalPoint }}
	/>
</div>

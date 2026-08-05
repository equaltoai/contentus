/**
 * What the file picker offers, and what to say when it drops something.
 *
 * WHO DECIDES WHAT AN INSTANCE ACCEPTS. lesser does, and it does not
 * advertise the answer: `MaxUploadSize` (10 MiB by default,
 * `graph/mutation_resolvers_media.go`) and the accepted media types are
 * server-side facts with no GraphQL field exposing them, the same shape of gap
 * as the status length limit. `cms/media.ts` has always said the client must
 * not guess, and the upload path does not — an oversized or unwanted file is
 * refused by the instance and the message is shown as-is.
 *
 * The composer was guessing anyway, one layer up. The vendored
 * `patterns/MediaComposer` validates before it ever calls `onUpload`, and its
 * defaults are a fixed six-MIME list and a 10 MiB ceiling — an invented policy
 * that happens to resemble one instance's configuration — enforced with
 * `console.warn` and a silent `return false`. So a poster attaching a 12 MiB
 * video to an instance configured for 50 saw the file vanish with no error,
 * and contentus never learned it happened.
 *
 * WHAT IS FIXED HERE AND WHAT IS NOT:
 *
 *   - The size ceiling is removed. `MediaField` passes a maximum the check can
 *     never trip, so size is lesser's decision again and lesser's rejection is
 *     what the poster reads.
 *   - The type list is widened to what lesser's own `MediaCategory` vocabulary
 *     spans, so the picker stops being narrower than the instance for the
 *     categories the contract names.
 *   - Nothing is dropped silently. `filesDroppedBeforeUpload` recovers what
 *     the vendored validator discarded — the files the picker took and
 *     `onUpload` never saw — so the UI can name them, and
 *     `wholeSelectionDroppedMessage` covers the case that recovery cannot
 *     reach: when the validator discards EVERYTHING it returns before
 *     `onUpload` runs, so there is no delta to compute and the selection
 *     vanishes one branch earlier.
 *
 * WHAT CANNOT BE FIXED FROM HERE, and is an upstream `greater` issue rather
 * than a shim: `MediaComposer` uses ONE array for two jobs — the `accept`
 * attribute on its file input and a hard `allowedTypes.includes(file.type)`
 * gate — and offers no way to defer validation to the server. Widening the
 * picker to `image/*` would empty the gate of every real MIME type and reject
 * everything; narrowing the gate narrows the picker. A concrete list is the
 * only shape that works against that component, so the list below is written
 * as what it is: a vendored-component requirement, not an instance policy, and
 * anything outside it is named to the poster rather than swallowed. The fix is
 * an `onReject` callback (or a `validate: false` config) upstream. SUNSET:
 * remove this module's list when the vendored pattern can defer validation to
 * the server.
 *
 * THE `onReject` HALF OF THAT SUNSET HAS LANDED (greater-v0.13.0,
 * `MediaComposerRejectionReason`), and this module shrank accordingly. Two
 * functions are gone rather than kept alongside the callback:
 *
 *   - `filesDroppedBeforeUpload`, which recovered discarded files by diffing
 *     the poster's selection against what `onUpload` received;
 *   - `wholeSelectionDroppedMessage`, which PREDICTED the case that diff could
 *     not reach — the validator discarding everything and returning before
 *     `onUpload` ran — from the selection and contentus's own config.
 *
 * Both were inferences about a component's internals, and the capture-phase
 * listeners `MediaField` needed to feed them are gone too. Keeping a prediction
 * beside an authoritative report is how the two drift apart: the component now
 * says which files it rejected and under which limit, and that is the only
 * source this module reads. The tests that pinned the gap were the sunset
 * condition, and they fired.
 */

/**
 * MIME types the picker offers, spanning lesser's `MediaCategory` vocabulary.
 *
 * Not a policy and not exhaustive — see above. Every type here is still
 * subject to whatever the instance actually accepts, and a file lesser refuses
 * is refused with lesser's own message.
 */
export const PICKER_MEDIA_TYPES: readonly string[] = [
	// IMAGE
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/heic',
	'image/heif',
	'image/tiff',
	'image/bmp',
	// VIDEO / GIFV
	'video/mp4',
	'video/webm',
	'video/quicktime',
	'video/ogg',
	'video/x-matroska',
	// AUDIO
	'audio/mpeg',
	'audio/mp4',
	'audio/aac',
	'audio/ogg',
	'audio/wav',
	'audio/webm',
	'audio/flac',
	// DOCUMENT
	'application/pdf',
];

/**
 * A size ceiling the vendored validator can never trip.
 *
 * `MediaComposer` compares `file.size > maxFileSize` with no way to disable
 * the check, so the honest value is one no file can exceed: the instance's
 * ceiling is the only real one, and it is enforced where it is known.
 */
export const NO_CLIENT_SIZE_CEILING = Number.MAX_SAFE_INTEGER;

/** The parts of a `File` this module reads. */
export interface PickedFile {
	name: string;
	type: string;
}

/**
 * Why the vendored gate rejected files, structurally matching the pattern's
 * `MediaComposerRejectionReason`.
 *
 * Declared structurally rather than imported so this module stays a pure,
 * probe-loadable module with no dependency on a `.svelte` file. The shape is
 * the vendored one and a drift between them is a compile error at the call
 * site, which is where it should surface.
 */
export type MediaRejectionReason =
	| { kind: 'unsupported-type'; allowedTypes: readonly string[] }
	| { kind: 'file-too-large'; maxFileSize: number }
	| { kind: 'max-attachments-reached'; maxAttachments: number };

/**
 * What to tell the poster about files the composer refused.
 *
 * The wording's job is to place the blame correctly. None of these rejections
 * are lesser's: they are the client-side gate refusing before the instance was
 * ever asked, and a poster who reads "rejected" without that distinction will
 * reasonably conclude their instance will not take the file. So each message
 * says which side refused.
 *
 * `file-too-large` is included for completeness and should be unreachable:
 * `MediaField` passes `NO_CLIENT_SIZE_CEILING`, so the size limb of the gate
 * cannot trip and size stays lesser's decision. If it ever does appear, the
 * message says plainly that the composer refused, because that would be a
 * contentus configuration bug rather than an instance limit.
 */
export function rejectionMessage(
	files: readonly PickedFile[],
	reason: MediaRejectionReason
): string | null {
	if (files.length === 0) return null;

	const named = files.map((file) => file.name || 'an unnamed file').join(', ');
	const subject = files.length === 1 ? 'file was' : 'files were';
	const lead = `${files.length} ${subject} not sent: ${named}.`;

	switch (reason.kind) {
		case 'unsupported-type':
			return (
				`${lead} The file picker rejected them before this instance was asked, so this is ` +
				'the composer refusing rather than the instance. Converting to a common image, ' +
				'video, or audio format usually works.'
			);
		case 'file-too-large':
			return (
				`${lead} The composer applied a size limit of its own before asking this ` +
				"instance. That limit is not this instance's and should not have been reached."
			);
		case 'max-attachments-reached':
			return (
				`${lead} This post already holds the ${reason.maxAttachments} attachments this ` +
				'instance accepts. Remove one to attach another.'
			);
	}
}

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
 *     `onUpload` never saw — so the UI can name them.
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
 * remove this module's list and its recovery when the vendored pattern can
 * defer.
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
 * The files the picker accepted from the poster but never handed to `onUpload`.
 *
 * Compared by identity, not by name: the vendored pattern filters the very
 * `File` objects it was given, so anything missing from `forwarded` is
 * something its validator discarded. Two files with the same name are two
 * files.
 */
export function filesDroppedBeforeUpload<T>(selected: readonly T[], forwarded: readonly T[]): T[] {
	return selected.filter((file) => !forwarded.includes(file));
}

/**
 * What to tell the poster about files that never reached the instance.
 *
 * Names them, says the instance never saw them, and says why — because the
 * alternative on offer was a `console.warn` nobody reads and a thumbnail that
 * never appeared. Returns null when there is nothing to say.
 */
export function droppedFilesMessage(dropped: readonly PickedFile[]): string | null {
	if (dropped.length === 0) return null;

	const named = dropped.map((file) => file.name || 'an unnamed file').join(', ');
	const subject = dropped.length === 1 ? 'file was' : 'files were';

	return (
		`${dropped.length} ${subject} not sent: ${named}. ` +
		'The file picker rejected them before this instance was asked, so this is the ' +
		'composer refusing rather than the instance. Converting to a common image, video, ' +
		'or audio format usually works.'
	);
}

/**
 * The status length lesser actually enforces.
 *
 * `MastodonBusinessLogic.ValidateStatusContent` rejects when
 * `len(content) > MaxStatusLength`, and `MaxStatusLength` is 500
 * (`lesser/pkg/common/business_mastodon.go`). Go's `len` over a string is the
 * UTF-8 byte count, so this is a byte budget, not a character one.
 *
 * The value is mirrored rather than read: lesser's GraphQL surface exposes no
 * instance-configuration field advertising it. That is an upstream observation
 * for the lesser steward, not something contentus can fix — and a mirrored
 * constant with a comment saying where it came from is at least a mirror
 * somebody can audit.
 */
export const STATUS_BYTE_LIMIT = 500;

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/**
 * UTF-8 byte length of what would be sent, counting the spoiler text the way
 * the composer's own counter does.
 *
 * lesser validates `content` alone, so including the warning here is a
 * deliberately conservative reading: it matches the vendored counter's
 * behaviour, so the two measures describe the same string and their
 * disagreement is purely about encoding rather than about scope.
 */
export function statusByteLength(content: string, contentWarning = ''): number {
	const text = `${content}${contentWarning}`;
	if (encoder) return encoder.encode(text).length;

	// TextEncoder is present in every runtime contentus targets; this branch
	// exists so a counter can never throw and take the composer with it. Counts
	// UTF-8 code-unit widths directly, including surrogate pairs as one 4-byte
	// code point rather than two 3-byte ones.
	let bytes = 0;
	for (const codePoint of text) {
		const value = codePoint.codePointAt(0) ?? 0;
		if (value < 0x80) bytes += 1;
		else if (value < 0x800) bytes += 2;
		else if (value < 0x10000) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

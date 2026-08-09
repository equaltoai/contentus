/**
 * The status length budget: what lesser enforces, and where the number comes
 * from.
 *
 * WHAT LESSER ENFORCES IS BYTES. `MastodonBusinessLogic.ValidateStatusContent`
 * rejects when `len(content) > MaxStatusLength`
 * (`lesser/pkg/common/business_mastodon.go:115`), and Go's `len` over a string
 * is the UTF-8 byte count — so this is a byte budget, not a character one, and
 * `statusByteLength` below is the measure that agrees with the server.
 *
 * WHERE THE NUMBER COMES FROM changed at lesser v1.6.4. The instance now
 * states it: `InstanceInfo.maxStatusCharacters` on the public `instance` field,
 * read through `$lib/instance/info`. When the instance's answer is known it IS
 * the budget (`statusByteLimit` below); when it is not — a pre-v1.6.4 instance,
 * or a read that failed — the fallback is lesser's DOCUMENTED default of 500
 * (`pkg/common/validation_mastodon.go`, `MaxStatusLength = 500`). That is what
 * `DEFAULT_STATUS_BYTE_LIMIT` is: a documented default standing in for an
 * unstated value, not a mirror of a live one.
 *
 * THE FIELD'S NAME IS AN UPSTREAM OBSERVATION, RECORDED NOT LITIGATED. The
 * served field is called `maxStatusCharacters` and lesser's refusal message
 * says "characters", while the enforcement (`len(content)`) counts BYTES. The
 * number is one budget either way, so this module keeps byte semantics and the
 * naming mismatch is routed to the lesser steward rather than argued with in
 * UI copy.
 */

import type { InstanceInfo } from '../instance/info.ts';

export const DEFAULT_STATUS_BYTE_LIMIT = 500;

/**
 * The budget to apply: the instance's own answer when it gave one, lesser's
 * documented default when it did not.
 *
 * Both halves are honest. A served value is the instance stating its own
 * limit; the default is what lesser documents an unconfigured instance
 * enforces, and the copy that renders it says so (`ComposeBudget.svelte`)
 * rather than presenting it as something this instance stated.
 */
export function statusByteLimit(info: InstanceInfo | null): number {
	return info?.maxStatusCharacters ?? DEFAULT_STATUS_BYTE_LIMIT;
}

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

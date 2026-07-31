/**
 * The one translation between greater's compose vocabulary and lesser's.
 *
 * greater's `PostVisibility` is Mastodon's — `public | unlisted | private |
 * direct` — where lesser's `Visibility` enum spells the followers-only case
 * `FOLLOWERS`. That single rename is the whole difference, and it belongs at
 * the adapter boundary rather than in either vocabulary.
 *
 * Deliberately free of imports. Visibility is the field that decides who can
 * see a post, so it is the field whose mapping most deserves a direct test —
 * and a module with no dependencies is one `node --test` can load as-is,
 * without a bundler or an alias resolver standing between the assertion and
 * the code that ships.
 */

/** lesser's `Visibility` enum, verbatim. */
export type LesserVisibility = 'PUBLIC' | 'UNLISTED' | 'FOLLOWERS' | 'DIRECT';

/** The vendored compose compound's visibility vocabulary. */
export type ComposeVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export const LESSER_VISIBILITIES: readonly LesserVisibility[] = [
	'PUBLIC',
	'UNLISTED',
	'FOLLOWERS',
	'DIRECT',
];

const TO_LESSER: Record<ComposeVisibility, LesserVisibility> = {
	public: 'PUBLIC',
	unlisted: 'UNLISTED',
	private: 'FOLLOWERS',
	direct: 'DIRECT',
};

const FROM_LESSER: Record<LesserVisibility, ComposeVisibility> = {
	PUBLIC: 'public',
	UNLISTED: 'unlisted',
	FOLLOWERS: 'private',
	DIRECT: 'direct',
};

/**
 * Falls back to the NARROWEST reading, not the widest.
 *
 * An unrecognised value means the two vocabularies have drifted, and the safe
 * answer to "who should see this" when the answer is unclear is "fewer people".
 * Defaulting to PUBLIC would turn a mapping bug into a disclosure.
 */
export function toLesserVisibility(visibility: string): LesserVisibility {
	return TO_LESSER[visibility as ComposeVisibility] ?? 'DIRECT';
}

/** Widening in the other direction is safe: this only drives a form control. */
export function fromLesserVisibility(visibility: string | null | undefined): ComposeVisibility {
	const key = String(visibility ?? '').toUpperCase() as LesserVisibility;
	return FROM_LESSER[key] ?? 'public';
}

/** Reader-facing description of each visibility, for the selector. */
export const VISIBILITY_DESCRIPTIONS: Record<LesserVisibility, { label: string; hint: string }> = {
	PUBLIC: { label: 'Public', hint: 'Anyone can see this, and it appears in public timelines.' },
	UNLISTED: {
		label: 'Unlisted',
		hint: 'Anyone with the link can see this; public timelines will not show it.',
	},
	FOLLOWERS: { label: 'Followers', hint: 'Only your followers can see this.' },
	DIRECT: { label: 'Direct', hint: 'Only the people you mention can see this.' },
};

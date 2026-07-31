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

/**
 * lesser's visibilities ordered by REACH, widest first.
 *
 * The order is the contract's own: PUBLIC appears in public timelines,
 * UNLISTED is reachable by anyone holding the link, FOLLOWERS is the author's
 * followers, and DIRECT is the mentioned actors and nobody else. Every
 * comparison below reads reach from this one list, so "wider" has a single
 * definition in the client rather than one per call site.
 */
const REACH_ORDER: readonly LesserVisibility[] = ['PUBLIC', 'UNLISTED', 'FOLLOWERS', 'DIRECT'];

/**
 * A lesser visibility read back from the server, or DIRECT when it is not one.
 *
 * Distinct from `toLesserVisibility`, which TRANSLATES the compose
 * vocabulary. This one only normalises a value that is already meant to be
 * lesser's — casing, whitespace, an enum member this client predates. The
 * narrow fallback is the same rule and the same reason: an unrecognised reach
 * means the client does not know who would see the post, and the safe answer
 * to that is "fewer people".
 */
export function normalizeVisibility(visibility: string | null | undefined): LesserVisibility {
	const key = String(visibility ?? '').toUpperCase();
	return (REACH_ORDER as readonly string[]).includes(key) ? (key as LesserVisibility) : 'DIRECT';
}

/**
 * The visibility a reply or quote STARTS at, given the post it answers.
 *
 * Composing an answer to a DIRECT status at PUBLIC is a disclosure of the
 * conversation, and composing one to a FOLLOWERS status at PUBLIC is a
 * disclosure of its author's audience choice. Neither is something a default
 * should do silently, so the seed is the parent's own reach: equal to it,
 * never wider. A reply to a public post still seeds public.
 *
 * Deliberately NOT `fromLesserVisibility`. That function widens on an
 * unrecognised value because it only ever drove a form control's initial
 * selection; this one decides the reach a post would actually be sent at, so
 * its fallback is the narrowest reading instead.
 */
export function seedVisibilityFrom(sourceVisibility: string | null | undefined): ComposeVisibility {
	return FROM_LESSER[normalizeVisibility(sourceVisibility)];
}

/**
 * Whether `candidate` would reach more people than `limit`.
 *
 * Both arguments are lesser visibilities — map the compose vocabulary through
 * `toLesserVisibility` first. Used to SAY SO when a poster widens a reply
 * past the reach of the post it answers; the choice stays theirs, but it is
 * not allowed to be silent.
 */
export function reachesWiderThan(
	candidate: string | null | undefined,
	limit: string | null | undefined
): boolean {
	return (
		REACH_ORDER.indexOf(normalizeVisibility(candidate)) <
		REACH_ORDER.indexOf(normalizeVisibility(limit))
	);
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

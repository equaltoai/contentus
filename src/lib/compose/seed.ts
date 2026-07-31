/**
 * What the composer STARTS at, for each of the four intents.
 *
 * Every field here is a value the poster can then change. That is what makes
 * the module worth having on its own: a seed is not a suggestion, it is the
 * value that gets sent when nobody touches the control, and for visibility
 * that means it decides who can see a post whenever the poster accepts the
 * default — which is most of the time.
 *
 * Dependency-free on purpose, for the same reason `cms/visibility.ts` is: a
 * probe can load it with `node --test` and assert the shipped rule directly,
 * with no bundler and no alias resolver standing between the assertion and
 * the code. The route calls this once, before the composer subtree exists, so
 * there is no window in which a seed can overwrite something the poster typed.
 */

import type { ComposeMode } from '../../facetheory/types';

import { seedVisibilityFrom, type ComposeVisibility } from '../cms/visibility';

/**
 * The parts of a source status the seeds read.
 *
 * Structural rather than the full `SourceStatus`, so this module needs no
 * import from the CMS client — `SourceStatus` satisfies it as-is.
 */
export interface SeedSource {
	visibility: string;
	content: string;
}

export interface ComposeSeed {
	/** The vendored compose vocabulary, because it seeds a vendored control. */
	visibility: ComposeVisibility;
	content: string;
}

/**
 * Seed the composer from the intent and the status it points at.
 *
 * VISIBILITY inherits the parent's reach for a reply or a quote, and is never
 * wider than it. Answering a DIRECT status at PUBLIC discloses the
 * conversation; answering a FOLLOWERS status at PUBLIC discloses its author's
 * audience choice. A default is not allowed to do either silently, so a reply
 * to DIRECT seeds DIRECT, a reply to FOLLOWERS seeds FOLLOWERS, and a reply to
 * a public post seeds public. A new post has no parent to inherit from and
 * seeds public, which is the instance's ordinary posture for something written
 * from nothing.
 *
 * The `source == null` case seeds the NARROWEST reach rather than the widest
 * (`seedVisibilityFrom`'s own fallback). The route holds the composer until
 * the source resolves and refuses to compose against a target it could not
 * load, so this branch should be unreachable for a reply or a quote — it is
 * here so that a future caller which forgets to hold gets the safe answer
 * rather than a public one.
 *
 * CONTENT is seeded only for an edit, from what lesser's own sanitizer stored
 * on write. A reply starts empty: lesser has no rule that an answer inherits
 * anything from the post it answers, so neither does this.
 */
export function composeSeed(mode: ComposeMode, source: SeedSource | null): ComposeSeed {
	return {
		visibility: mode === 'new' ? 'public' : seedVisibilityFrom(source?.visibility),
		content: mode === 'edit' ? (source?.content ?? '') : '',
	};
}

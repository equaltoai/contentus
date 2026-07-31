/**
 * Whether to offer the verdict controls, and what to say when they are not
 * offered.
 *
 * Pure and separate from the panel so the rule can be asserted directly. It is
 * a rule about WHAT LESSER PUBLISHED, not a reimplementation of lesser's
 * authorization: the decision reads one field and defers everything else.
 *
 * WHAT DECIDES: `DraftReview.grant`.
 *
 * `grant` is the VIEWER'S OWN invitation. lesser's resolver builds it from the
 * grant `DraftReviewForCaller` returned for this caller, so its presence is
 * lesser saying "you hold an active invitation on this draft".
 * `submitDraftReview` requires exactly that, so the controls appear when it is
 * there and an explanation appears when it is not.
 *
 * WHY BEING THE AUTHOR IS NOT A REASON TO SUPPRESS THEM — the finding this
 * module was extracted to fix. The panel used to apply a local `!isAuthor` gate
 * on top of the grant, on the reading that an owner may never review their own
 * draft. That is not lesser's rule. `SubmitDraftReview`
 * (`pkg/services/cms/draft_review.go`) refuses an owner ONLY when the owner is
 * not the instance principal:
 *
 *     if caller == owner {
 *         principal, err := s.instancePrincipal(ctx)
 *         if err != nil || principal != owner {
 *             return nil, errors.New("draft owner cannot review their own draft")
 *         }
 *     }
 *     if _, err := s.ActiveDraftReviewGrant(ctx, owner, draftID, caller); err != nil { … }
 *
 * and `DraftReviewForCaller` returns the owner's own grant for exactly this
 * case ("Owners ordinarily have no grant, except the explicit principal-owner
 * approval flow for generated drafts"). That path is how a principal approves a
 * principal-owned generated draft — the very flow the publication gate demands
 * for anything an agent wrote. Suppressing it client-side removed the only
 * control that could satisfy the gate.
 *
 * Contentus cannot see who the instance principal is, and does not try: it
 * offers the action whenever lesser projected an active grant and lets lesser
 * authorize. The worst a stale grant can produce is a control that comes back
 * with lesser's refusal — never one lesser wrongly honours.
 */

import type { DraftReviewData } from '../blog-types';

/**
 * The panel's three states.
 *
 * `granted` — lesser projected an active invitation for this viewer. Offer.
 * `no-grant-author` — no invitation, and this viewer authored the draft. The
 *   explanation names the self-grant path rather than saying "you cannot".
 * `no-grant` — no invitation, and this viewer did not author the draft.
 */
export type VerdictOfferState = 'granted' | 'no-grant-author' | 'no-grant';

export interface VerdictOffer {
	/** Whether to render `Review.VerdictActions`. */
	offer: boolean;
	state: VerdictOfferState;
}

/**
 * Decide whether the verdict controls are offered.
 *
 * `isAuthor` never suppresses the offer. It only chooses which explanation to
 * show when lesser projected no grant at all.
 */
export function describeVerdictOffer(
	review: Pick<DraftReviewData, 'grant'>,
	isAuthor: boolean
): VerdictOffer {
	if (review.grant) return { offer: true, state: 'granted' };
	return { offer: false, state: isAuthor ? 'no-grant-author' : 'no-grant' };
}

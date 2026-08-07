<!--
The verdict controls, and the reason they are or are not offered.

WHAT DECIDES. `DraftReview.grant` is the VIEWER'S OWN invitation — lesser's
resolver builds it from the grant `DraftReviewForCaller` returned for this
caller — so its presence is lesser telling contentus "you hold an active
invitation on this draft". `submitDraftReview` requires exactly that, so the
controls appear when it is there and an explanation appears when it is not.

This is reading a field lesser publishes, not reimplementing an authorization
rule. lesser re-checks the mutation regardless, and the worst a stale grant can
produce is a control that comes back with lesser's refusal — never one lesser
wrongly honours.

THE OWNER IS NOT A SEPARATE GATE, and this is the correction. An earlier
version of this panel suppressed the controls for the draft's author even when
lesser had projected an active grant, on the reading that an owner may never
review their own draft. lesser's rule is narrower: `SubmitDraftReview` refuses
an owner only when that owner is NOT the instance principal, and
`DraftReviewForCaller` returns the owner's own grant precisely for the
principal-owner approval flow. That flow is how a principal approves a
principal-owned generated draft — the approval the publication gate requires for
anything an agent wrote — so suppressing it removed the only control that could
satisfy the gate. Contentus cannot see who the principal is, does not guess, and
lets lesser authorize. The rule and its evidence live in
`$lib/review/verdict-offer`.

The submission itself goes straight through to lesser's mutation with no
transformation — the adapter binding pattern `createSubmitDraftReviewHandler`
documents, over contentus's own single-fetch transport rather than over an
Apollo client it does not otherwise need.
-->

<script lang="ts">
	import VerdictActions from '$lib/components/Review/VerdictActions.svelte';
	import { REVIEW_STATE_QUALIFIER, resolveReviewState } from '$lib/components/Review/state.js';
	import { createSubmitVerdictHandler } from '$lib/cms/review';
	import { describeVerdictOffer } from '$lib/review/verdict-offer';
	import type { DraftReviewData } from '$lib/blog-types';

	interface Props {
		review: DraftReviewData;
		/** Whether the viewer authored this draft, per lesser's own answer. */
		isAuthor: boolean;
		/** Called with the DraftReview lesser returned after recording a verdict. */
		onRecorded?: (review: DraftReviewData) => void;
	}

	let { review, isAuthor, onRecorded }: Props = $props();

	const offer = $derived(describeVerdictOffer(review, isAuthor));

	// Built once per draft rather than per render: `VerdictActions` holds the
	// handler across its dialog's lifetime, and swapping it mid-submission would
	// change what a confirmed verdict calls.
	const onSubmit = $derived(createSubmitVerdictHandler(onRecorded));

	const state = $derived(resolveReviewState(review));
</script>

<section class="contentus-review-verdict" aria-label="Record a verdict">
	<h2 class="contentus-h2">Your verdict</h2>

	<p class="contentus-review-note">
		{state.label}{state.source === 'none' ? '' : ` — ${REVIEW_STATE_QUALIFIER}`}
	</p>

	{#if offer.offer}
		<VerdictActions draftId={review.draftId} {onSubmit} />
		<p class="contentus-review-note">
			Recording a verdict does not publish anything. Publication is a separate action, and this
			instance decides whether it is permitted.
		</p>
	{:else if offer.state === 'no-grant-author'}
		<p class="contentus-review-note">
			You authored this draft and hold no active invitation on it, so this instance will not record
			a verdict from you. An author reviews their own draft only as this instance's principal, and
			only on an invitation they hold — otherwise, invite a reviewer through this instance or over
			MCP.
		</p>
	{:else}
		<p class="contentus-review-note">
			You do not hold an active invitation on this draft, so this instance will not record a
			verdict from you. Invitations are revocable, so one you held before may have been withdrawn.
		</p>
	{/if}
</section>

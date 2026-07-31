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

THE OWNER CASE IS ITS OWN SENTENCE, because it is the one people hit. lesser
refuses `submitDraftReview` when the caller is the draft's owner, unless that
caller is the instance principal. An author looking at their own agent's draft
is therefore not a reviewer of it, and saying "invite someone" is more useful
than a disabled button.

The submission itself goes straight through to lesser's mutation with no
transformation — the adapter binding pattern `createSubmitDraftReviewHandler`
documents, over contentus's own single-fetch transport rather than over an
Apollo client it does not otherwise need.
-->

<script lang="ts">
	import VerdictActions from '$lib/components/Review/VerdictActions.svelte';
	import { REVIEW_STATE_QUALIFIER, resolveReviewState } from '$lib/components/Review/state.js';
	import { createSubmitVerdictHandler } from '$lib/cms/review';
	import type { DraftReviewData } from '$lib/blog-types';

	interface Props {
		review: DraftReviewData;
		/** Whether the viewer authored this draft, per lesser's own answer. */
		isAuthor: boolean;
		/** Called with the DraftReview lesser returned after recording a verdict. */
		onRecorded?: (review: DraftReviewData) => void;
	}

	let { review, isAuthor, onRecorded }: Props = $props();

	const canReview = $derived(Boolean(review.grant) && !isAuthor);

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

	{#if canReview}
		<VerdictActions draftId={review.draftId} {onSubmit} />
		<p class="contentus-review-note">
			Recording a verdict does not publish anything. Publication is a separate action, and this
			instance decides whether it is permitted.
		</p>
	{:else if isAuthor}
		<p class="contentus-review-note">
			You authored this draft, so you cannot record a verdict on it. Invite a reviewer to have one
			recorded — through this instance or over MCP.
		</p>
	{:else}
		<p class="contentus-review-note">
			You do not hold an active invitation on this draft, so this instance will not record a
			verdict from you. Invitations are revocable, so one you held before may have been withdrawn.
		</p>
	{/if}
</section>

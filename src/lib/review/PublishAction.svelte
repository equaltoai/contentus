<!--
Publish or schedule a reviewed draft, behind a confirmation that states what
publishing does.

THE GATE IS LESSER'S, AND SINCE v1.6.4 LESSER SAYS WHAT IT EVALUATED. The rule
itself is unchanged — unanimous approval from every reviewer holding an active
grant, plus the instance principal's approval for any draft that records a
generator, cumulatively — and neither this component nor anything it calls
reconstructs that arithmetic. What v1.6.4 added is `DraftReview.publishEligibility`:
lesser's OWN evaluation of its gate, with `eligible` and its own
`blockingReasons`. Reading that projection is not the client computing the
gate; it is the client rendering the server's answer. When it says
`eligible: false`, the publish action is disabled and lesser's blocking
reasons are shown verbatim — they are lesser's words about its own rule, not
client-computed gate logic.

That is also why the older rule — the button is never disabled on gate
grounds — no longer applies. It predated the projection: back then the only
signal available was the mutation's refusal, so a disabled control could only
ever rest on a client-side guess. Now that lesser serves the evaluation, a
disabled control backed by lesser's own reasons teaches the same thing the
refusal did, earlier.

AND THE REFUSAL STILL HAS THE FINAL WORD. An eligibility read can be stale
between load and click — a verdict recorded in another tab changes the answer.
So the mutation's refusal path below is untouched: lesser re-evaluates the
gate at publish time, and its answer is what appears.

WHAT THE CONFIRMATION SAYS. Not "are you sure" — that is a question people
answer reflexively. It says what changes: the draft becomes an Article at a
public address, that address is permanent, and the attribution recorded against
it goes out with it. For a draft that records a generator it says so explicitly,
because "an agent wrote this and it is about to carry your instance's name" is
the single most consequential fact on this screen.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Modal from '$lib/greater/primitives/components/Modal.svelte';
	import {
		publishDraft,
		scheduleDraft,
		type PublishedArticle,
		type ReviewFailure,
	} from '$lib/cms/review';
	import type { DraftReviewData } from '$lib/blog-types';
	import { reviewActorName } from '$lib/components/Review/state.js';
	import { getCachedInstanceInfo } from '$lib/instance/info';

	import { initialSchedulingOffer } from './scheduling-offer';

	interface Props {
		review: DraftReviewData;
		/** Called with lesser's Article once a publish has actually happened. */
		onPublished?: (article: PublishedArticle) => void;
		/** Called once lesser has accepted a schedule. */
		onScheduled?: (scheduledAt: string) => void;
	}

	let { review, onPublished, onScheduled }: Props = $props();

	type Intent = 'publish' | 'schedule';

	let intent = $state<Intent | null>(null);
	let open = $state(false);
	let working = $state(false);
	let failure = $state<ReviewFailure | null>(null);
	let scheduledAt = $state('');

	/**
	 * Whether this instance has scheduling switched on — null until the
	 * instance's own answer (or its absence) has arrived.
	 *
	 * lesser v1.6.4 serves the capability (`InstanceInfo.cmsFeatures.scheduling`),
	 * so the control starts from lesser's statement rather than from a guess: a
	 * served `false` means the control is never offered and no schedule attempt
	 * is made — the same answer the feature-gate refusal used to deliver after
	 * the fact. A served `true`, or an instance that did not answer, keeps the
	 * pre-v1.6.4 behaviour: offer, and flip off if an attempt comes back
	 * `cms-disabled`, because a served `true` can still be stale by click time
	 * and the typed FEATURE_DISABLED refusal remains the final word.
	 *
	 * The control is HELD while the read is in flight rather than offered and
	 * then withdrawn, and the hold cannot stick: `getCachedInstanceInfo`
	 * resolves null on any failure, which `initialSchedulingOffer` reads as
	 * "offer" — the pre-v1.6.4 default.
	 */
	let schedulingAvailable = $state<boolean | null>(null);

	onMount(() => {
		void getCachedInstanceInfo().then((info) => {
			schedulingAvailable = initialSchedulingOffer(info);
		});
	});

	const generatorName = $derived(reviewActorName(review.generatedBy));
	const hasGenerator = $derived(Boolean(review.generatedBy));

	/**
	 * lesser's own gate evaluation, when the projection carried it.
	 *
	 * `eligible === false` disables the publish action and puts lesser's
	 * `blockingReasons` on screen verbatim. An ABSENT projection (a pre-v1.6.4
	 * instance, or a partial selection) changes nothing: the action is offered
	 * and the mutation's refusal carries the explanation, as it always has.
	 * `eligible === true` is likewise not a promise — lesser re-evaluates at
	 * publish time, and its refusal still has the final word.
	 */
	const publishBlocked = $derived(review.publishEligibility?.eligible === false);
	const blockingReasons = $derived(
		publishBlocked ? (review.publishEligibility?.blockingReasons ?? []) : []
	);

	function openDialog(next: Intent) {
		intent = next;
		failure = null;
		open = true;
	}

	function cancel() {
		if (working) return;
		open = false;
	}

	async function confirm() {
		if (!intent || working) return;

		working = true;
		failure = null;

		try {
			if (intent === 'schedule') {
				if (!scheduledAt) {
					failure = { reason: 'rejected', message: 'Choose a date and time to schedule for.' };
					return;
				}

				// `datetime-local` has no zone, so it is read as the reviewer's own
				// and converted to the instant lesser's `Time!` expects. Sending the
				// wall-clock string would publish at the server's midnight rather
				// than the reviewer's.
				const instant = new Date(scheduledAt);
				if (Number.isNaN(instant.getTime())) {
					failure = { reason: 'rejected', message: 'That is not a time this instance can read.' };
					return;
				}

				const result = await scheduleDraft(review.draftId, instant.toISOString());
				if (!result.ok) {
					failure = result.failure;
					if (result.failure.reason === 'cms-disabled') schedulingAvailable = false;
					return;
				}

				open = false;
				onScheduled?.(result.value.scheduledAt ?? instant.toISOString());
				return;
			}

			const result = await publishDraft(review.draftId);
			if (!result.ok) {
				// The dialog STAYS OPEN on a refusal, and that is deliberate for the
				// gated case above all: closing it would read as "done", which is the
				// opposite of what happened.
				failure = result.failure;
				return;
			}

			open = false;
			onPublished?.(result.value);
		} finally {
			working = false;
		}
	}
</script>

<div class="contentus-review-publish">
	<button
		type="button"
		class="contentus-review-publish__primary"
		onclick={() => openDialog('publish')}
		disabled={working || publishBlocked}
	>
		Publish
	</button>

	{#if schedulingAvailable}
		<button
			type="button"
			class="contentus-review-publish__secondary"
			onclick={() => openDialog('schedule')}
			disabled={working}
		>
			Schedule
		</button>
	{/if}
</div>

{#if publishBlocked}
	<!-- lesser's own words about its own gate, verbatim. Paraphrasing them would
	     put contentus's voice between the author and the only party that knows
	     WHICH approval is missing. -->
	<p class="contentus-review-note">This instance says this draft cannot publish yet:</p>
	<ul class="contentus-review-errors">
		{#each blockingReasons as reason, index (index)}
			<li>{reason}</li>
		{/each}
	</ul>
	{#if blockingReasons.length === 0}
		<p class="contentus-meta">The instance reported the gate as unsatisfied without naming why.</p>
	{/if}
{/if}

{#if hasGenerator}
	<p class="contentus-review-note">
		This draft records a generator{generatorName ? ` (${generatorName})` : ''}. This instance
		additionally requires the instance principal's approval before it can publish, on top of
		approval from every reviewer holding an active invitation.
	</p>
{/if}

{#if failure && !open}
	<p class="contentus-review-error" role="alert">{failure.message}</p>
{/if}

<Modal
	bind:open
	title={intent === 'schedule' ? 'Schedule this draft?' : 'Publish this draft?'}
	size="md"
	closeOnEscape={!working}
	closeOnBackdrop={!working}
>
	{#if intent === 'schedule'}
		<p>
			The instance will publish this draft at the time you choose. Publication is still gated:
			this schedules the attempt, it does not pre-approve it.
		</p>
		<label class="contentus-review-field">
			<span>Publish at</span>
			<input type="datetime-local" bind:value={scheduledAt} disabled={working} />
		</label>
	{:else}
		<p>
			Publishing turns this draft into an article at a public address on this instance, and
			federates it. The address is permanent — a published slug does not change.
		</p>
	{/if}

	{#if hasGenerator}
		<p>
			<strong>Attribution travels with it.</strong>
			{generatorName
				? `This draft records ${generatorName} as its generator.`
				: 'This draft records a generator.'} That attribution is published with the article and
			goes out to the instances that receive it.
		</p>
	{/if}

	<p>
		This instance decides whether the publish is permitted. If the approvals it requires are not
		in place, it will refuse and say which are missing.
	</p>

	{#if failure}
		<p
			class="contentus-review-error"
			role="alert"
			data-gated={failure.reason === 'gated' ? 'true' : undefined}
		>
			{#if failure.reason === 'gated'}
				<strong>Not published — the review gate is not satisfied.</strong>
			{/if}
			{failure.message}
		</p>
	{/if}

	{#snippet footer()}
		<button type="button" class="contentus-review-publish__secondary" onclick={cancel}>
			Cancel
		</button>
		<button
			type="button"
			class="contentus-review-publish__primary"
			onclick={confirm}
			disabled={working}
		>
			{working
				? intent === 'schedule'
					? 'Scheduling…'
					: 'Publishing…'
				: intent === 'schedule'
					? 'Schedule'
					: 'Publish now'}
		</button>
	{/snippet}
</Modal>

<!--
Publish or schedule a reviewed draft, behind a confirmation that states what
publishing does.

THE GATE IS NOT EVALUATED HERE. lesser decides — unanimous approval from every
reviewer holding an active grant, plus the instance principal's approval for any
draft that records a generator, cumulatively. Neither this component nor
anything it calls reconstructs that: the inputs (the active-grant set, the
principal's identity) are not in lesser's projection, so a client-side "ready to
publish" badge would be a guess dressed as a fact. The button is offered, the
mutation is called, and lesser's answer is what appears.

That is also why the button is never disabled on gate grounds. A disabled
control with no explanation teaches an author that publishing is broken; a
control that runs and comes back with "draft requires approval from every active
reviewer" teaches them what the gate is. The refusal is the feature.

WHAT THE CONFIRMATION SAYS. Not "are you sure" — that is a question people
answer reflexively. It says what changes: the draft becomes an Article at a
public address, that address is permanent, and the attribution recorded against
it goes out with it. For a draft that records a generator it says so explicitly,
because "an agent wrote this and it is about to carry your instance's name" is
the single most consequential fact on this screen.
-->

<script lang="ts">
	import Modal from '$lib/greater/primitives/components/Modal.svelte';
	import {
		publishDraft,
		scheduleDraft,
		type PublishedArticle,
		type ReviewFailure,
	} from '$lib/cms/review';
	import type { DraftReviewData } from '$lib/blog-types';
	import { reviewActorName } from '$lib/components/Review/state.js';

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
	 * Whether this instance has scheduling switched on.
	 *
	 * Starts `true` because lesser's public schema exposes no capability field to
	 * ask (the flags live on the admin-scoped config), so the honest options are
	 * "offer it and find out" or "never offer it". Once an attempt comes back
	 * with the feature-gate error the control stops being offered for the rest of
	 * the session — a refusal is an answer, and repeating a question lesser has
	 * already declined is not useful. Recorded as an upstream ask in
	 * docs/consumption/review-contract.md.
	 */
	let schedulingAvailable = $state(true);

	const generatorName = $derived(reviewActorName(review.generatedBy));
	const hasGenerator = $derived(Boolean(review.generatedBy));

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
		disabled={working}
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

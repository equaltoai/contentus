<!--
Face 2 — the review queue (product design §5) · journal surface.

WHAT THE ORDER MEANS. Drafts shared WITH the reviewer come first, then the
reviewer's own agent-generated drafts. That is the human-updates-to-agent-content
workflow written as a sort rather than as a filter the reviewer has to go and
find: an agent writes, a human reviews, and the things waiting on this person
are above the things this person set in motion.

AUTH AND SSR. The server pass is anonymous by construction — the session lives
in `sessionStorage` — and these props travel on to a public hydration endpoint,
so the queue is never fetched server-side. The SSR document says the one true
thing: reviewing requires an account on this instance. The queue itself arrives
once the client has read the session.

NO VERDICTS HERE, deliberately. `Review.VerdictActions` is workspace-only. The
queue shows enough to choose what to open; approving from a list means approving
without having read the server-rendered preview, and a review gate whose
approvals can be given without reading is a gate in name only.

WHAT IS VENDORED. `Review.QueueCard` comes from the greater-v0.13.0 `review`
registry entry untouched, and it owns the card: title, state badge, the
"latest activity, not publication state" qualifier, the agent badge, and the
timestamps. This route owns the queue AROUND it — grouping, order, empty
states, and the honesty about what was not loaded.

EVERY ENTRY GETS THE CARD. Before lesser v1.6.4 the own half was built from
the `myDrafts` listing, which carries no `reviewStatus` and no verdict history,
and an entry whose `draftReview(id)` enrichment had not arrived could not
honestly render the badge — those entries got contentus's own chrome saying
the review state was unknown. `myDraftReviews` (v1.6.4) returns the same full
`DraftReview` projection as `sharedDraftReviews`, so the thin shape can no
longer arrive and the alternate chrome is gone.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import QueueCard from '$lib/components/Review/QueueCard.svelte';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import {
		emptyHalfCopy,
		loadReviewQueue,
		type ReviewQueue,
		type ReviewQueueEntry,
	} from '$lib/cms/review';
	import { isAuthenticated, startLogin } from '$lib/auth/session';

	import { reviewDraftHref } from '../../facetheory/routing';
	import type { AppPageDescriptor } from '../../facetheory/types';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();

	/**
	 * Three states, not two. `unknown` is the server's honest answer and the
	 * client's first frame: nothing has read `sessionStorage` yet, so claiming
	 * either way would be a guess that flickers.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let queue = $state<ReviewQueue | null>(null);
	let loading = $state(false);
	let signInError = $state<string | null>(null);

	onMount(async () => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated') return;

		loading = true;
		try {
			queue = await loadReviewQueue();
		} finally {
			loading = false;
		}
	});

	async function onSignIn() {
		signInError = null;
		try {
			// No explicit `returnTo`: `startLogin` defaults to the current path,
			// which is this queue.
			await startLogin();
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	const shared = $derived(
		(queue?.entries ?? []).filter((entry) => entry.source === 'shared-with-me')
	);
	const own = $derived((queue?.entries ?? []).filter((entry) => entry.source === 'my-agent-draft'));

	/**
	 * A session that expired between loading the page and loading the queue.
	 *
	 * Surfaced as its own state rather than as one more failure line: the answer
	 * is "sign in again", not "the instance had a problem".
	 */
	const expired = $derived(
		(queue?.failures ?? []).some((failure) => failure.reason === 'unauthenticated')
	);

	/** Failures worth showing beside a partially loaded queue. */
	const failures = $derived(
		(queue?.failures ?? []).filter((failure) => failure.reason !== 'unauthenticated')
	);
</script>

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{page.title}</h1>
	<p class="contentus-lede">{page.summary}</p>
</header>

{#if session !== 'authenticated'}
	<!-- The server renders this branch, where `session` is `unknown`. It cannot
	     know who is asking, and "reviewing requires an account" is true either
	     way. The sign-in button appears once the client has actually looked. -->
	<Panel class="contentus-review-panel" padding="md" aria-label="Review queue">
		<section class="contentus-notice">
			<h2 class="contentus-notice__title">Sign in to review</h2>
			<p class="contentus-notice__body">
				Review queues are per-account: this instance shows you the drafts shared with you and the
				drafts you own. Signing in returns you here.
			</p>
			{#if session === 'anonymous'}
				<button class="contentus-session__button" type="button" onclick={onSignIn}>Sign in</button>
			{/if}
			{#if signInError}
				<p class="contentus-meta" role="alert">{signInError}</p>
			{/if}
		</section>
	</Panel>
{:else if loading}
	<p class="contentus-review-hint" role="status">Loading your review queue…</p>
{:else if expired}
	<Notice
		title="Your session has expired"
		message="Sign in again to load the drafts shared with you."
	/>
	<button class="contentus-session__button" type="button" onclick={onSignIn}>Sign in</button>
{:else}
	{#each failures as failure (failure.reason + failure.message)}
		<Notice
			title={failure.reason === 'cms-disabled'
				? 'Long-form publishing is off'
				: 'Part of the queue could not be loaded'}
			message={failure.message}
		/>
	{/each}

	<section class="contentus-review-group" aria-labelledby="contentus-review-shared">
		<h2 class="contentus-h2" id="contentus-review-shared">Shared with you</h2>
		{#if shared.length === 0}
			<!-- Which sentence this is depends on whether the half was ANSWERED, not
			     merely on whether it is empty. A half whose query failed has said
			     nothing about its contents, and "no drafts are shared with you" is a
			     claim about them. `emptyHalfCopy` holds the three cases apart. -->
			<p class="contentus-review-empty">
				{emptyHalfCopy(queue?.shared ?? { status: 'unavailable' }, 'shared-with-me')}
			</p>
		{:else}
			<ul class="contentus-review-list">
				{#each shared as entry (entry.review.draftId)}
					<li>{@render card(entry)}</li>
				{/each}
			</ul>
			{#if queue?.shared.status === 'loaded' && queue.shared.more}
				<p class="contentus-meta">
					More drafts are shared with you than are listed here. Paging through the rest lands with
					the workspace.
				</p>
			{:else if queue?.shared.status === 'unavailable'}
				<p class="contentus-meta">
					Drafts shared with you could not be loaded, so this list may be missing some.
				</p>
			{/if}
		{/if}
	</section>

	<section class="contentus-review-group" aria-labelledby="contentus-review-own">
		<h2 class="contentus-h2" id="contentus-review-own">Your agent-generated drafts</h2>
		{#if own.length === 0}
			<p class="contentus-review-empty">
				{emptyHalfCopy(queue?.own ?? { status: 'unavailable' }, 'my-agent-draft')}
			</p>
		{:else}
			<ul class="contentus-review-list">
				{#each own as entry (entry.review.draftId)}
					<li>{@render card(entry)}</li>
				{/each}
			</ul>
			{#if queue?.own.status === 'loaded' && queue.own.more}
				<p class="contentus-meta">
					Only the first drafts on this instance were scanned for agent attribution; there are
					more.
				</p>
			{:else if queue?.own.status === 'unavailable'}
				<p class="contentus-meta">
					Your own drafts could not be loaded, so this list may be missing some.
				</p>
			{/if}
		{/if}
	</section>
{/if}

{#snippet card(entry: ReviewQueueEntry)}
	<!-- One path, on purpose: both halves are full `DraftReview` projections
	     (see the header), so the vendored card's state badge is lesser's own
	     answer for every entry. -->
	<QueueCard review={entry.review} href={reviewDraftHref(entry.review.draftId)} headingLevel={3} />
{/snippet}

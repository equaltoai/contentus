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

AND THE ONE PLACE THE CARD IS NOT USED. `resolveReviewState` turns a projection
with no `reviewStatus` and no verdicts into the definite label "No review
activity recorded". That is true of a `DraftReview`, which carries both fields
and would have shown them. It is NOT true of the `myDrafts` listing, which
carries neither — a draft a reviewer has already ruled on looks identical there
to one nobody has touched. The queue therefore loads `draftReview(id)` for the
viewer's own drafts, which lesser authorizes for the owner, and renders the
vendored card whenever that answer arrived. When it did not, the entry gets
contentus's own chrome, which says the review state is not known instead of
saying there is none. Routed upstream as an ask on the vendored chrome; see
`docs/consumption/review-contract.md`.
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
	{#if entry.projection === 'review'}
		<QueueCard review={entry.review} href={reviewDraftHref(entry.review.draftId)} headingLevel={3} />
	{:else}
		<!-- The listing projection only. The vendored card's state badge would read
		     the missing `reviewStatus` and empty verdict history as a decided
		     absence, so this entry says the true thing instead: the review state
		     did not arrive. It is still listed and still opens — the listing proved
		     the draft exists, and the workspace loads the projection that failed
		     here. -->
		<article class="gr-blog-review-card">
			<div class="gr-blog-review-card__header">
				<h3 class="gr-blog-review-card__title">
					<a class="gr-blog-review-card__link" href={reviewDraftHref(entry.review.draftId)}>
						{entry.review.title?.trim() || 'Untitled draft'}
					</a>
				</h3>
				<div class="gr-blog-review-card__state-group">
					<p class="gr-blog-review-card__state gr-blog-review-card__state--pending">
						<span class="gr-blog-review-card__state-label">Review state unknown</span>
					</p>
				</div>
			</div>
			<p class="contentus-review-note">
				This instance did not return the review activity for this draft, so nothing here says
				whether it has been reviewed. Open it to load its review state.
			</p>
		</article>
	{/if}
{/snippet}

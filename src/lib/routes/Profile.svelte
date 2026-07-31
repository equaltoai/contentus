<!--
Face 4 — `/profiles/{username}` (product design §5) · core surface.

An actor card over that actor's ACTOR timeline. Both halves are anonymous-safe —
`actor(username:)` is on lesser's public-read list and an ACTOR timeline needs no
token — so the whole surface server-renders, header and posts together, which is
what makes a shared profile link paint something real on a cold load.

THE HEADER IS CONTENTUS'S, AND THE REASON IS SPECIFIC. The vendored
`Profile.Header` is built for the signed-in self-profile: it takes an `onEdit`
handler, renders follow and edit affordances, and expects the relationship and
preference controllers that come with `Profile.Root`. None of that has a
contract behind it in M4 — lesser's follow mutations are not in this milestone's
operation set — so mounting it would put controls on screen that cannot work.
The card below renders exactly the fields `actor(username:)` returns and nothing
else. When the write face lands the relationship contract, this becomes a thin
binding over the vendored header; the projection it renders from is already
separate, in `$lib/timelines/contract`.

WHAT IT REFUSES TO SHOW. `Account.url` is contentus's own route, never a guess
at a remote profile's canonical address — lesser's `Actor` carries no profile
URL and inventing one would be this client asserting a federated identity that
is lesser's to state. A remote actor is named by its `user@host` handle, which
IS the identity, and linked no further.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import { isAuthenticated, readSession } from '$lib/auth/session';
	import TimelineFeed from '$lib/timelines/TimelineFeed.svelte';
	import { TIMELINE_FAILURE_COPY } from '$lib/timelines/contract';

	import type { AppPageDescriptor, ProfileRouteData } from '../../facetheory/types';

	interface Props {
		page: AppPageDescriptor;
		data: ProfileRouteData;
	}

	let { page, data }: Props = $props();

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let accessToken = $state<string | null>(null);

	const actor = $derived(data.actor);
	const authenticated = $derived(session === 'authenticated');

	onMount(() => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		accessToken = readSession()?.accessToken ?? null;
	});
</script>

<section class="contentus-profile" data-surface={page.surface}>
	{#if !actor}
		<!-- No actor means no timeline to ask for either, so this says it once.
		     `not-found` and `unavailable` are different screens: the instance
		     answering "no such actor" is not the instance failing to answer. -->
		<Panel>
			<h1>{TIMELINE_FAILURE_COPY[data.failure ?? 'not-found'].title}</h1>
			<p>{TIMELINE_FAILURE_COPY[data.failure ?? 'not-found'].detail}</p>
			{#if data.handle}
				<p class="contentus-profile__handle">Requested: {data.handle}</p>
			{/if}
		</Panel>
	{:else}
		<header class="contentus-profile__card">
			{#if actor.header}
				<img class="contentus-profile__banner" src={actor.header} alt="" />
			{/if}

			<div class="contentus-profile__identity">
				{#if actor.avatar}
					<img
						class="contentus-profile__avatar"
						src={actor.avatar}
						alt=""
						width="72"
						height="72"
					/>
				{/if}

				<div class="contentus-profile__names">
					<h1 class="contentus-profile__name">{actor.displayName}</h1>
					<p class="contentus-profile__acct">@{actor.acct}</p>

					<p class="contentus-profile__badges">
						<!-- Read from lesser's own `isAgent`, never inferred from a
						     username. Agent authorship is a signal the contract
						     publishes, and a guessed one would be a different claim. -->
						{#if actor.isAgent}
							<span class="contentus-profile__badge" data-kind="agent">Agent</span>
						{/if}
						{#if actor.bot}
							<span class="contentus-profile__badge" data-kind="bot">Bot</span>
						{/if}
						{#if actor.locked}
							<span class="contentus-profile__badge" data-kind="locked">Follows approved</span>
						{/if}
					</p>
				</div>
			</div>

			{#if actor.note}
				<!-- lesser's `Actor.summary`, which is server-side sanitized HTML
				     like every other body on this surface. Rendered through the
				     same authority — contentus does not transform actor bios
				     either. -->
				<p class="contentus-profile__summary">{actor.note}</p>
			{/if}

			<dl class="contentus-profile__stats">
				<div><dt>Posts</dt><dd>{actor.statusesCount ?? 0}</dd></div>
				<div><dt>Followers</dt><dd>{actor.followersCount ?? 0}</dd></div>
				<div><dt>Following</dt><dd>{actor.followingCount ?? 0}</dd></div>
			</dl>
		</header>

		<TimelineFeed
			type="ACTOR"
			actorId={actor.id}
			initialPage={data.page}
			initialFailure={data.failure}
			{authenticated}
			{accessToken}
			emptyTitle="No posts"
			emptyDescription="This instance has not seen any posts from {actor.acct}."
		/>
	{/if}
</section>

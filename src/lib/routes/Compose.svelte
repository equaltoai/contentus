<!--
Face 3 — Post to Timeline (product design §5) · core surface.

Composed from the vendored `shared/compose` compound. `ComposeBox` is deprecated
upstream and is not used anywhere here.

FOUR INTENTS, ONE SURFACE. `/compose`, `?inReplyTo=`, `?quote=`, and `?edit=`
are the same composer with a target attached, so they are the same route. Each
deep-links and server-renders like anything else, which matters because lesser
performs no SPA fallback under `/l/*`.

WHAT IS VENDORED AND WHAT IS OURS. `Root`, `EditorWithAutocomplete`,
`CharacterCount`, `VisibilitySelect`, and `Submit` come from
`src/lib/components/compose/` untouched, and `MediaComposer`, `PollComposer`,
`CustomEmojiPicker`, and `Modal` are vendored patterns and primitives. The
controls beside them — content warning, `sensitive`, schedule, agent
attribution, the byte budget — are contentus-owned because greater's compose
state models the Mastodon-shaped subset and lesser's contract is wider. Neither
the compound nor its state is forked; the extras store in
`$lib/compose/extras.svelte` runs alongside it and both are read together at
submit.

AUTH AND SSR. The server pass is anonymous by construction — the session lives
in `sessionStorage`, which the server cannot see — so the SSR document says the
one thing that is true for every reader: posting requires an account on this
instance, and here is where to sign in. The write intents — editor, media,
poll, schedule, submit, edit, delete — are not in that document at all. They
mount once the client has read the session and found one.

This inverts an earlier shape that rendered the whole form to everyone and
stated the requirement beside it, on the theory that nothing a signed-out
visitor typed would be lost. That traded a real property for a cosmetic one: a
composer that cannot post is a control that lies, and shipping every write
affordance inside a cacheable anonymous document is a surface to defend for a
convenience nobody asked for. Sign-in carries the intent — `startLogin`'s own
default `returnTo` is the current path AND query string — so a deep-linked
reply comes back a reply.

THE REVIEW GATE IS NOT HERE. This face posts notes to the timeline, which is a
direct authenticated write. Article drafts are face 2, they go through lesser's
reviewer/publisher workflow, and nothing on this page touches them.
-->

<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import ComposeCharacterCount from '$lib/components/compose/CharacterCount.svelte';
	import ComposeEditorWithAutocomplete from '$lib/components/compose/EditorWithAutocomplete.svelte';
	import ComposeRoot from '$lib/components/compose/Root.svelte';
	import ComposeSubmit from '$lib/components/compose/Submit.svelte';
	import ComposeVisibilitySelect from '$lib/components/compose/VisibilitySelect.svelte';
	import type { ComposeHandlers } from '$lib/components/compose/context';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import XIcon from '$lib/greater/icons/icons/x.svelte';
	import AgentAttributionField from '$lib/compose/AgentAttributionField.svelte';
	import ComposeBudget from '$lib/compose/ComposeBudget.svelte';
	import ContentWarningField from '$lib/compose/ContentWarningField.svelte';
	import DeleteAction from '$lib/compose/DeleteAction.svelte';
	import EmojiField from '$lib/compose/EmojiField.svelte';
	import MediaField from '$lib/compose/MediaField.svelte';
	import PollField from '$lib/compose/PollField.svelte';
	import ReachNotice from '$lib/compose/ReachNotice.svelte';
	import ScheduleField from '$lib/compose/ScheduleField.svelte';
	import SensitiveField from '$lib/compose/SensitiveField.svelte';
	import SourceContext from '$lib/compose/SourceContext.svelte';
	import { DEFAULT_STATUS_BYTE_LIMIT, statusByteLimit } from '$lib/compose/budget';
	import { createComposeExtras } from '$lib/compose/extras.svelte';
	import { composeSeed, type ComposeSeed } from '$lib/compose/seed';
	import { buildComposeSubmission } from '$lib/compose/submission';
	import { getCachedInstanceInfo } from '$lib/instance/info';
	import {
		createNote,
		loadComposeViewer,
		loadSourceStatus,
		scheduleStatus,
		updateStatus,
		type ComposeFailure,
		type ComposeViewer,
		type SourceStatus,
	} from '$lib/cms/compose';
	import { composeSearchHandler } from '$lib/cms/discovery';
	import { accessTokenOrNull, isAuthenticated, startLogin } from '$lib/auth/session';

	import type { AppPageDescriptor, ComposeData } from '../../facetheory/types';
	import { href as appHref } from '../../facetheory/routing';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
		data: ComposeData;
	}

	let { page, data }: Props = $props();

	// Route props are settled for the life of a page load: FaceTheory hydrates
	// once, and every compose intent is a full navigation because lesser has no
	// SPA fallback under `/l/*`. `$derived` for the two the template reads, so
	// the intent is stated in one place.
	const mode = $derived(data.intent.mode);
	const targetId = $derived(data.intent.statusId);

	let source = $state<SourceStatus | null>(untrack(() => data.source));
	let viewer = $state<ComposeViewer | null>(null);

	/**
	 * The intent's target, planted in the extras store before the first render so
	 * a reply is a reply from the moment it exists — not after an effect fires.
	 *
	 * `quoteId` is only set for a quote intent. A reply carries `inReplyToId`,
	 * an edit carries neither and drives `updateStatus` instead.
	 *
	 * `untrack` because this is a SEEDING read, and saying so is the point: the
	 * store is initialised from the intent once, and everything after that is the
	 * poster editing it. Without it the compiler reasonably asks whether a
	 * changing prop should flow through, and the answer here is no — a different
	 * intent is a different page load.
	 */
	const extras = createComposeExtras(
		untrack(() => ({
			...(mode === 'reply' && targetId ? { inReplyToId: targetId } : {}),
			...(mode === 'quote' && targetId ? { quoteId: targetId } : {}),
			...(mode === 'edit' && targetId ? { editingStatusId: targetId } : {}),
		}))
	);

	/**
	 * Three states, not two. `unknown` is the server's honest answer and the
	 * client's first frame: nothing has read `sessionStorage` yet, so claiming
	 * either way would be a guess that flickers.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let failure = $state<ComposeFailure | null>(null);
	let posted = $state<{ id: string; url: string | null } | null>(null);
	let scheduled = $state<{ id: string; scheduledAt: string } | null>(null);
	let deleted = $state(false);
	let signInError = $state<string | null>(null);

	/**
	 * The composer's starting values, or null while they are still unknown.
	 *
	 * THE COMPOSER DOES NOT EXIST UNTIL THIS IS SET, and that is the whole
	 * point. Visibility is seeded from the reach of the post being answered
	 * (`$lib/compose/seed`), so a composer mounted before its source resolved
	 * would have to start at some default and be corrected afterwards — and the
	 * default it started at is exactly what gets sent by a poster who types and
	 * presses Post inside that window. Holding removes the window instead of
	 * racing it, and it means no seed can ever overwrite something already
	 * typed: the subtree that would hold the typing is not there yet.
	 *
	 * `content` carries `Object.content` for an edit, which is what lesser's own
	 * sanitizer stored on write (`htmlsafe.SanitizeHTMLByContract`);
	 * `updateStatus` sanitizes again on the way back, so an edit is a round trip
	 * through the server's sanitizer with the client neither rendering nor
	 * transforming anything.
	 */
	let seed = $state<ComposeSeed | null>(null);

	/**
	 * The byte budget the composer enforces, with its provenance — or null
	 * while the instance's answer is still in flight.
	 *
	 * The vendored `Compose.Root` fixes its counter cap at construction, so the
	 * budget is settled BEFORE the composer exists (the template holds the
	 * subtree until this is set, exactly as it does for the seed): the
	 * instance's served `maxStatusCharacters` when it answers, lesser's
	 * documented default when it does not. `getCachedInstanceInfo` resolves
	 * null on any failure rather than throwing, so the hold cannot stick — an
	 * unanswered read simply means the default applies.
	 */
	let byteBudget = $state<{ limit: number; served: boolean } | null>(null);

	/** A target intent whose status could not be loaded. Not composable. */
	let sourceUnavailable = $state(false);

	onMount(async () => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';

		if (session !== 'authenticated') return;

		// Settle the byte budget BEFORE any seed is applied: the vendored
		// counter's cap is fixed when `Compose.Root` is constructed, and the
		// composer mounts the moment `seed` is set — so a budget learned after
		// seeding would be a budget the composer never had. The instance's
		// served `maxStatusCharacters` wins when it answers (lesser v1.6.4);
		// the read resolves null on any failure rather than throwing, and
		// `statusByteLimit` then stands lesser's documented default in.
		const instanceInfo = await getCachedInstanceInfo();
		byteBudget = { limit: statusByteLimit(instanceInfo), served: instanceInfo !== null };

		// Seed straight away when nothing has to be fetched first: a new post has
		// no parent to inherit reach from, and a target the anonymous server pass
		// already resolved is already here. Waiting on the viewer query in either
		// case would hold the editor for a round trip that only decides whether
		// the agent-attribution panel appears.
		if (!targetId || source) applySeed(composeSeed(mode, source));

		// The server pass is anonymous, so anything narrower than a public status
		// arrives null. Re-ask with the session token.
		const [loadedViewer, loadedSource] = await Promise.all([
			loadComposeViewer(),
			targetId && !source
				? loadSourceStatus(targetId, { endpoint: null, accessToken: accessTokenOrNull() })
				: Promise.resolve(source),
		]);

		viewer = loadedViewer;
		if (loadedSource) source = loadedSource;

		if (!targetId || seed) return;

		// A reply, quote, or edit whose target did not resolve. There is no reach
		// to inherit and no body to edit, so there is nothing honest to compose
		// against: refuse rather than fall back to a default that would be wider
		// than the post being answered.
		if (!source) {
			sourceUnavailable = true;
			return;
		}

		applySeed(composeSeed(mode, source));
	});

	/**
	 * Plant a settled seed, then let the composer exist.
	 *
	 * `sensitive` lives in the extras store rather than the vendored context,
	 * so it is planted here while the content, warning, and visibility travel
	 * as `initialState` on the subtree this call is about to create. Assigning
	 * `seed` last is what makes the order safe: nothing is on screen to
	 * overwrite until every starting value is in place.
	 */
	function applySeed(settled: ComposeSeed) {
		extras.update({ sensitive: settled.sensitive });
		seed = settled;
	}

	async function onSignIn() {
		signInError = null;
		try {
			// No explicit `returnTo`: `startLogin` defaults to the current path AND
			// query string, which is the whole intent. Naming `/compose` here would
			// send a reader who deep-linked into a reply back to a blank new post.
			await startLogin();
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	/** An absolute lesser Object id is a link; anything else is just an id. */
	function linkableUrl(id: string): string | null {
		try {
			const url = new URL(id);
			return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
		} catch {
			return null;
		}
	}

	const submitLabel = $derived(
		mode === 'edit' ? 'Save changes' : extras.state.scheduledAt ? 'Schedule' : 'Post'
	);

	/**
	 * Report a write that did not happen, and stop the submit.
	 *
	 * Thrown rather than returned so `Compose.Root` keeps the draft: it resets
	 * its state only on a RESOLVED submit, and a post the instance did not
	 * accept must not clear the text the poster still needs.
	 */
	function refuse(reported: ComposeFailure): never {
		failure = reported;
		if (reported.reason === 'unauthenticated') session = 'anonymous';
		throw new Error(reported.message);
	}

	const handlers: ComposeHandlers = {
		onSubmit: async (formData) => {
			failure = null;
			posted = null;
			scheduled = null;

			// What gets sent is decided in one pure place (`$lib/compose/submission`)
			// and awaited here. The route's job on this path is the awaiting, the
			// failure display, and what to show afterwards — not the contract.
			//
			// `byteBudget` is settled before the composer can exist (the template
			// holds the subtree until it is), so this handler cannot fire without
			// it; the `??` keeps the type honest, it does not pick a second rule.
			const submission = buildComposeSubmission({
				mode,
				form: formData,
				extras: extras.state,
				byteLimit: byteBudget?.limit ?? DEFAULT_STATUS_BYTE_LIMIT,
			});

			if (submission.kind === 'rejected') {
				refuse({ reason: 'rejected', message: submission.message });
			}

			if (submission.kind === 'update') {
				const result = await updateStatus(submission.id, submission.input);
				if (!result.ok) refuse(result.failure);

				posted = { id: result.value.id, url: linkableUrl(result.value.id) };
				return;
			}

			if (submission.kind === 'schedule') {
				const result = await scheduleStatus(submission.input);
				if (!result.ok) refuse(result.failure);

				scheduled = result.value;
				extras.reset();
				return;
			}

			const result = await createNote(submission.input);

			if (!result.ok) {
				refuse(result.failure);
			}

			posted = { id: result.value.id, url: linkableUrl(result.value.id) };
			extras.reset();
		},
	};
</script>

<header class="contentus-page-header contentus-compose-header">
	<div>
		<p class="contentus-eyebrow">{page.eyebrow}</p>
		<h1 class="contentus-h1">
			{mode === 'edit'
				? 'Edit post'
				: mode === 'reply'
					? 'Reply'
					: mode === 'quote'
						? 'Quote'
						: page.title}
		</h1>
		<p class="contentus-lede">{page.summary}</p>
	</div>

	<!-- The mobile sheet covers the tab bar, so it owns the way out. Hidden
	     above 960px, where the sidebar nav is still on screen. A link rather
	     than a history-back button: the composer is a real route, and a reader
	     who deep-linked into it has no history to go back to. -->
	<a class="contentus-compose-close" href={appHref('/')}>
		<XIcon size={20} aria-hidden="true" />
		<span class="contentus-visually-hidden">Close the composer</span>
	</a>
</header>

{#if deleted}
	<Notice
		title="Deleted"
		message="The post is gone from this instance, and a delete has gone out to the instances that
			received it."
	/>
{/if}

{#if posted}
	<Notice
		title={mode === 'edit' ? 'Saved' : 'Posted'}
		message={mode === 'edit'
			? 'Your changes are live, and an update has gone out to the fediverse.'
			: 'Your post is live on this instance and on its way to the fediverse.'}
		detail={posted.url ? null : posted.id}
	/>
	{#if posted.url}
		<p class="contentus-meta"><a href={posted.url}>View the post</a></p>
	{/if}
{/if}

{#if scheduled}
	<Notice
		title="Scheduled"
		message="This post is queued and will publish at the time you chose."
		detail={scheduled.scheduledAt}
	/>
{/if}

{#if failure && failure.reason === 'unauthenticated'}
	<Notice title="Not signed in" message={failure.message} />
{/if}

<div class="contentus-compose">
	{#if targetId && mode !== 'new'}
		<SourceContext {mode} statusId={targetId} {source} />
	{/if}

	<!-- The desktop presentation product design §5 names: a greater `Panel`.
	     Below 960px the same markup is flattened to a full-bleed sheet by CSS —
	     one document, two presentations, no viewport measurement.

	     The Panel itself is chrome, so it renders for everyone: the sheet has
	     the same shape on the first paint whether it will hold a composer or a
	     sign-in prompt. What it HOLDS is what the session decides. -->
	<Panel class="contentus-compose-panel" padding="md" aria-label="Composer">
	{#if session !== 'authenticated'}
		<!-- The server renders this branch, where `session` is `unknown`. It
		     cannot know who is asking — the token lives in `sessionStorage` — and
		     "posting requires an account" is true either way, so that is what the
		     SSR document says. The sign-in button appears once the client has
		     actually looked, rather than the server asserting a session state it
		     cannot see. -->
		<section class="contentus-notice">
			<h2 class="contentus-notice__title">Sign in to post</h2>
			<p class="contentus-notice__body">
				Posting requires an account on this instance. Signing in returns you here, to this
				same {mode === 'new' ? 'composer' : mode}.
			</p>
			{#if session === 'anonymous'}
				<button class="contentus-session__button" type="button" onclick={onSignIn}>
					Sign in
				</button>
			{/if}
			{#if signInError}
				<p class="contentus-meta" role="alert">{signInError}</p>
			{/if}
		</section>
	{:else if sourceUnavailable}
		<!-- Not a transient state and not a spinner. The instance did not return
		     the post this intent points at — deleted, or narrower than this
		     session can see — and there is no honest composer to offer for it:
		     the reach to inherit and the body to edit both live on that status. -->
		<section class="contentus-notice">
			<h2 class="contentus-notice__title">That post could not be loaded</h2>
			<p class="contentus-notice__body">
				This instance did not return the post you are {mode === 'edit' ? 'editing' : mode}-ing.
				It may have been deleted, or your account may not be able to see it. Reload to try
				again, or open the original.
			</p>
		</section>
	{:else if !seed || !byteBudget}
		<p class="contentus-compose-hint" role="status">Preparing the composer…</p>
	{:else}
		<ComposeRoot
			config={{
				// The instance's own served limit when it answered, lesser's
				// documented default when it did not — settled before this subtree
				// exists, so the vendored counter never runs against a cap below
				// the one the instance actually enforces.
				characterLimit: byteBudget.limit,
				placeholder: mode === 'reply' ? 'Write your reply…' : 'What do you want to say?',
				allowMedia: true,
				allowPolls: mode !== 'edit',
				// BOTH, and they must agree. `Root` reads `initialState.visibility`
				// for the first render and `config.defaultVisibility` for the reset
				// it performs after a resolved submit — so seeding only the first
				// would send the second reply of a thread at the wrong reach.
				defaultVisibility: seed.visibility,
				class: 'contentus-compose__form',
			}}
			initialState={{
				content: seed.content,
				visibility: seed.visibility,
				contentWarning: seed.contentWarning,
				contentWarningEnabled: seed.contentWarningEnabled,
			}}
			{handlers}
		>
			<!-- `@` and `#` complete against lesser's `search`, `:` against the
			     instance's `customEmojis`. The completion writes into the post text,
			     which is the only path lesser reads: its resolver never looks at
			     CreateNoteInput.mentions or .tags. -->
			<ComposeEditorWithAutocomplete rows={6} searchHandler={composeSearchHandler} />

			<!-- Media sits directly under the editor so its thumbnails stay above the
			     action bar — and so, on a phone, above the keyboard-safe area rather
			     than behind the keyboard (product design §5). -->
			<MediaField />

			<!-- Visibility and the content warning are first-class controls on the
			     surface, not entries in an overflow menu (product design §5).
			     Visibility is hidden while editing: `UpdateStatusInput` has no
			     visibility field, so the control would change nothing. -->
			<div class="contentus-compose-controls">
				{#if mode !== 'edit'}
					<ComposeVisibilitySelect />
				{/if}
				<ContentWarningField />
				<SensitiveField />
				{#if mode !== 'edit'}
					<ScheduleField />
				{/if}
			</div>

			<!-- Silent for every seeded default, because the seed is never wider
			     than the post being answered. It speaks when the poster widens it
			     themselves — their call, but not an invisible one. -->
			{#if mode !== 'edit' && source}
				<ReachNotice sourceVisibility={source.visibility} />
			{/if}

			{#if mode !== 'edit'}
				<PollField />
			{/if}
			<EmojiField />

			<AgentAttributionField {viewer} />

			<ComposeBudget byteLimit={byteBudget.limit} served={byteBudget.served} />

			<footer class="contentus-compose-actions">
				<ComposeCharacterCount />
				<div class="contentus-compose-actions__buttons">
					{#if mode === 'edit' && targetId}
						<DeleteAction
							statusId={targetId}
							onDeleted={() => {
								deleted = true;
								posted = null;
							}}
						/>
					{/if}
					<ComposeSubmit text={submitLabel} loadingText="Sending…" />
				</div>
			</footer>
		</ComposeRoot>
	{/if}
	</Panel>
</div>

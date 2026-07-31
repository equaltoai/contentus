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

AUTH AND SSR. The form renders for everyone, including on the anonymous server
pass. The session lives in `sessionStorage` where the server cannot see it, and
a cold deep link has to produce a complete page — so the composer renders and
the sign-in requirement is stated beside it, rather than the page flashing from
"sign in" to a form a beat later. Nothing a signed-out visitor types is lost.

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
	import ScheduleField from '$lib/compose/ScheduleField.svelte';
	import SensitiveField from '$lib/compose/SensitiveField.svelte';
	import SourceContext from '$lib/compose/SourceContext.svelte';
	import { STATUS_BYTE_LIMIT, statusByteLength } from '$lib/compose/budget';
	import { createComposeExtras } from '$lib/compose/extras.svelte';
	import {
		createNote,
		loadComposeViewer,
		loadSourceStatus,
		scheduleStatus,
		toLesserVisibility,
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
	 * The edit body, seeded once from the source status.
	 *
	 * `Object.content` is what lesser's own sanitizer stored on write
	 * (`htmlsafe.SanitizeHTMLByContract`), and `updateStatus` sanitizes again on
	 * the way back — so an edit is a round trip through the server's sanitizer,
	 * with the client neither rendering nor transforming anything. There is no
	 * separate raw source for a note to withhold: the stored content IS the
	 * sanitized content, and editing it is editing text.
	 */
	let editSeed = $state(untrack(() => (mode === 'edit' ? (data.source?.content ?? '') : '')));
	let editSeeded = $state(untrack(() => mode !== 'edit' || Boolean(data.source)));

	onMount(async () => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';

		if (session !== 'authenticated') return;

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
		if (mode === 'edit' && !editSeeded && loadedSource) {
			editSeed = loadedSource.content;
			editSeeded = true;
		}
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin({ returnTo: `${appHref('/compose')}` });
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

	const handlers: ComposeHandlers = {
		onSubmit: async (formData) => {
			failure = null;
			posted = null;
			scheduled = null;

			// The byte guard, applied where it is decisive. lesser measures UTF-8
			// bytes and the vendored counter measures UTF-16 units, so a post can
			// pass the on-screen counter and still be rejected. Refusing here —
			// rather than driving the vendored `overLimit` flag, which `Root`
			// recomputes on every keystroke — means the composer's refusal and the
			// instance's always agree.
			const bytes = statusByteLength(formData.content, formData.contentWarning ?? '');
			if (bytes > STATUS_BYTE_LIMIT) {
				const message = `This post is ${bytes} bytes and the instance accepts ${STATUS_BYTE_LIMIT}.`;
				failure = { reason: 'rejected', message };
				throw new Error(message);
			}

			const spoiler = formData.contentWarning ? { spoilerText: formData.contentWarning } : {};

			if (mode === 'edit' && extras.state.editingStatusId) {
				// No visibility and no poll: `UpdateStatusInput` carries neither,
				// which is lesser saying a posted status keeps its reach and a poll
				// with votes is not rewritten underneath them.
				const result = await updateStatus(extras.state.editingStatusId, {
					content: formData.content,
					sensitive: extras.state.sensitive,
					...spoiler,
					...(extras.state.attachmentIds.length
						? { attachmentIds: extras.state.attachmentIds }
						: {}),
				});

				if (!result.ok) {
					failure = result.failure;
					if (result.failure.reason === 'unauthenticated') session = 'anonymous';
					throw new Error(result.failure.message);
				}

				posted = { id: result.value.id, url: linkableUrl(result.value.id) };
				return;
			}

			if (extras.state.scheduledAt) {
				// `ScheduleStatusInput` spells the body `text` and attachments
				// `mediaIds`, and has no `quoteId` — so the schedule control and the
				// quote intent are mutually exclusive, stated rather than dropped.
				const result = await scheduleStatus({
					text: formData.content,
					scheduledAt: extras.state.scheduledAt,
					visibility: toLesserVisibility(formData.visibility),
					sensitive: extras.state.sensitive,
					...spoiler,
					...(extras.state.inReplyToId ? { inReplyToId: extras.state.inReplyToId } : {}),
					...(extras.state.attachmentIds.length
						? { mediaIds: extras.state.attachmentIds }
						: {}),
					...(extras.state.poll ? { poll: extras.state.poll } : {}),
				});

				if (!result.ok) {
					failure = result.failure;
					if (result.failure.reason === 'unauthenticated') session = 'anonymous';
					throw new Error(result.failure.message);
				}

				scheduled = result.value;
				extras.reset();
				return;
			}

			const result = await createNote({
				content: formData.content,
				visibility: toLesserVisibility(formData.visibility),
				sensitive: extras.state.sensitive,
				...spoiler,
				...(extras.state.attachmentIds.length
					? { attachmentIds: extras.state.attachmentIds }
					: {}),
				...(extras.state.poll ? { poll: extras.state.poll } : {}),
				...(extras.state.inReplyToId ? { inReplyToId: extras.state.inReplyToId } : {}),
				...(extras.state.quoteId ? { quoteId: extras.state.quoteId } : {}),
				...(extras.state.agentAttribution
					? { agentAttribution: extras.state.agentAttribution }
					: {}),
			});

			if (!result.ok) {
				failure = result.failure;
				if (result.failure.reason === 'unauthenticated') session = 'anonymous';
				// Thrown so `Compose.Root` keeps the draft: it resets its state only
				// on a resolved submit, and a post that was not accepted must not
				// clear the text the poster still needs.
				throw new Error(result.failure.message);
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

{#if session !== 'authenticated'}
	<!-- Rendered on the server too, where `session` is `unknown`. The server
	     cannot know who is asking — the token lives in `sessionStorage` — but
	     "posting requires an account" is true regardless, so the SSR document
	     says it. The sign-in button appears once the client has actually looked,
	     rather than the server asserting a session state it cannot see. -->
	<section class="contentus-notice">
		<h2 class="contentus-notice__title">Sign in to post</h2>
		<p class="contentus-notice__body">
			Posting requires an account on this instance. You can write here first — signing in
			returns you to this page.
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
{/if}

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
	     one document, two presentations, no viewport measurement. -->
	<Panel class="contentus-compose-panel" padding="md" aria-label="Composer">
	{#key editSeed}
		<ComposeRoot
			config={{
				characterLimit: STATUS_BYTE_LIMIT,
				placeholder: mode === 'reply' ? 'Write your reply…' : 'What do you want to say?',
				allowMedia: true,
				allowPolls: mode !== 'edit',
				defaultVisibility: 'public',
				class: 'contentus-compose__form',
			}}
			initialState={{ content: editSeed }}
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

			{#if mode !== 'edit'}
				<PollField />
			{/if}
			<EmojiField />

			<AgentAttributionField {viewer} />

			<ComposeBudget />

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
	{/key}
	</Panel>
</div>

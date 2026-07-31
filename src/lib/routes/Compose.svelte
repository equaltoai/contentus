<!--
Face 3 — Post to Timeline (product design §5) · core surface.

Composed from the vendored `shared/compose` compound. `ComposeBox` is deprecated
upstream and is not used anywhere here.

WHAT IS VENDORED AND WHAT IS OURS. `Root`, `Editor`, `CharacterCount`,
`VisibilitySelect`, and `Submit` come from `src/lib/components/compose/`
untouched. The controls beside them — content warning, `sensitive`, the byte
budget — are contentus-owned because greater's compose state models the
Mastodon-shaped subset and lesser's contract is wider. Neither the compound nor
its state is forked; the extras store in `$lib/compose/extras.svelte` runs
alongside it and both are read together at submit.

AUTH AND SSR. The form renders for everyone, including on the anonymous server
pass. lesser has no SPA fallback under `/l/*`, so a cold deep link to /compose
has to produce a complete page, and the session lives in `sessionStorage` where
the server cannot see it. Rendering the composer and stating the sign-in
requirement beside it beats a page that flashes from "sign in" to a form a beat
later — and nothing a signed-out visitor types is lost when they do sign in.

THE REVIEW GATE IS NOT HERE. This face posts notes to the timeline, which is a
direct authenticated write. Article drafts are face 2, they go through lesser's
reviewer/publisher workflow, and nothing on this page touches them.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import ComposeCharacterCount from '$lib/components/compose/CharacterCount.svelte';
	import ComposeEditorWithAutocomplete from '$lib/components/compose/EditorWithAutocomplete.svelte';
	import ComposeRoot from '$lib/components/compose/Root.svelte';
	import ComposeSubmit from '$lib/components/compose/Submit.svelte';
	import ComposeVisibilitySelect from '$lib/components/compose/VisibilitySelect.svelte';
	import type { ComposeHandlers } from '$lib/components/compose/context';
	import ComposeBudget from '$lib/compose/ComposeBudget.svelte';
	import ContentWarningField from '$lib/compose/ContentWarningField.svelte';
	import EmojiField from '$lib/compose/EmojiField.svelte';
	import MediaField from '$lib/compose/MediaField.svelte';
	import PollField from '$lib/compose/PollField.svelte';
	import SensitiveField from '$lib/compose/SensitiveField.svelte';
	import { STATUS_BYTE_LIMIT, statusByteLength } from '$lib/compose/budget';
	import { createComposeExtras } from '$lib/compose/extras.svelte';
	import { createNote, toLesserVisibility, type ComposeFailure } from '$lib/cms/compose';
	import { composeSearchHandler } from '$lib/cms/discovery';
	import { isAuthenticated, startLogin } from '$lib/auth/session';

	import type { AppPageDescriptor } from '../../facetheory/types';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
	}

	let { page }: Props = $props();

	const extras = createComposeExtras();

	/**
	 * Three states, not two. `unknown` is the server's honest answer and the
	 * client's first frame: nothing has read `sessionStorage` yet, so claiming
	 * either way would be a guess that flickers.
	 */
	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let failure = $state<ComposeFailure | null>(null);
	let posted = $state<{ id: string; url: string | null } | null>(null);
	let signInError = $state<string | null>(null);

	onMount(() => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin({ returnTo: `${page.path}` });
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

	const handlers: ComposeHandlers = {
		onSubmit: async (data) => {
			failure = null;
			posted = null;

			// The byte guard, applied where it is decisive. lesser measures UTF-8
			// bytes and the vendored counter measures UTF-16 units, so a post can
			// pass the on-screen counter and still be rejected. Refusing here —
			// rather than trying to drive the vendored `overLimit` flag, which
			// `Root` recomputes on every keystroke — means the composer's refusal
			// and the instance's refusal always agree.
			const bytes = statusByteLength(data.content, data.contentWarning ?? '');
			if (bytes > STATUS_BYTE_LIMIT) {
				const message = `This post is ${bytes} bytes and the instance accepts ${STATUS_BYTE_LIMIT}.`;
				failure = { reason: 'rejected', message };
				throw new Error(message);
			}

			const result = await createNote({
				content: data.content,
				visibility: toLesserVisibility(data.visibility),
				sensitive: extras.state.sensitive,
				...(data.contentWarning ? { spoilerText: data.contentWarning } : {}),
				...(extras.state.attachmentIds.length
					? { attachmentIds: extras.state.attachmentIds }
					: {}),
				...(extras.state.poll ? { poll: extras.state.poll } : {}),
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

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{page.title}</h1>
	<p class="contentus-lede">{page.summary}</p>
</header>

{#if session === 'anonymous'}
	<section class="contentus-notice">
		<h2 class="contentus-notice__title">Sign in to post</h2>
		<p class="contentus-notice__body">
			Posting requires an account on this instance. You can write here first — signing in
			returns you to this page.
		</p>
		<button class="contentus-session__button" type="button" onclick={onSignIn}>
			Sign in
		</button>
		{#if signInError}
			<p class="contentus-meta" role="alert">{signInError}</p>
		{/if}
	</section>
{/if}

{#if posted}
	<Notice
		title="Posted"
		message="Your post is live on this instance and on its way to the fediverse."
		detail={posted.url ? null : posted.id}
	/>
	{#if posted.url}
		<p class="contentus-meta"><a href={posted.url}>View the post</a></p>
	{/if}
{/if}

{#if failure && failure.reason === 'unauthenticated'}
	<Notice title="Not signed in" message={failure.message} />
{/if}

<div class="contentus-compose">
	<ComposeRoot
		config={{
			characterLimit: STATUS_BYTE_LIMIT,
			placeholder: 'What do you want to say?',
			allowMedia: true,
			allowPolls: true,
			defaultVisibility: 'public',
			class: 'contentus-compose__form',
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
		     surface, not entries in an overflow menu (product design §5). -->
		<div class="contentus-compose-controls">
			<ComposeVisibilitySelect />
			<ContentWarningField />
			<SensitiveField />
		</div>

		<PollField />
		<EmojiField />

		<ComposeBudget />

		<footer class="contentus-compose-actions">
			<ComposeCharacterCount />
			<ComposeSubmit text="Post" loadingText="Posting…" />
		</footer>
	</ComposeRoot>
</div>

<!--
Face 2 — the review workspace (product design §5) · journal surface.

TWO PANES, ONE SOURCE OF TRUTH. The rail carries the draft's metadata and its
attribution; the panel carries the body. The body is `draftPreview.renderedHtml`
and only ever that — lesser's `cms.RenderDraftPreview` output, handed to the
vendored blog face's `Article.Content`, which sanitizes it again on the way to
the DOM. Contentus renders no Markdown, holds no renderer, and never displays
raw draft source. A preview lesser could not produce is an explained failure
carrying lesser's own deterministic errors, never a fallback to the source.

WHY THE RAIL HAS NO EDITOR, stated because the design contemplated one and the
contract does not currently permit it. Two independent blocks:

  1. lesser scopes writing to the author. `draft(id)` and `updateDraft(id, …)`
     both resolve through `GetDraft(ctx, username, id)`, which is owner-only,
     while `draftPreview` and `draftReview` resolve through
     `DraftReviewForCaller`, which also admits an active grantee. So a reviewer
     who is not the author has, by contract, no read of the source and no write
     path at all. Their channel for changes is `submitDraftReview` with notes —
     which is what lesser's review contract is for.
  2. The vendored `Editor.Root` cannot be consumed here regardless. It imports
     `MarkdownRenderer` from the greater content module at the top level, and
     that pulls `remark-parse`, `remark-gfm`, and `remark-rehype` into the
     graph — the client-side Markdown renderer contentus refuses to ship and
     does not install. The import is static, so the `mode !== 'split'` config
     that leaves the preview pane unrendered does not keep it out of the
     bundle. Routed upstream; see `docs/consumption/review-contract.md`.

The honest shape today is therefore a read-and-decide workspace. Neither block
is worked around here.

ATTRIBUTION IS ALWAYS ON SCREEN. `Review.AttributionStrip` sits in the rail
above the fold, not behind a disclosure, because seeing exactly what an agent
did is the reason this face exists. `describeApprovalRequirement` names which
approval rules are in force; it never claims progress against them, because the
active-grant set and the principal's identity are not in lesser's projection and
counting the verdict history instead would be wrong.
-->

<script lang="ts">
	import { onMount } from 'svelte';

	import {
		Content as ArticleContent,
		Root as ArticleRoot,
		normalizeArticleData,
	} from '$lib/greater/faces/blog/components/Article/index.js';
	import AttributionStrip from '$lib/components/Review/AttributionStrip.svelte';
	import { describeApprovalRequirement } from '$lib/components/Review/state.js';
	import Panel from '$lib/greater/shell/components/Panel.svelte';
	import {
		loadDraftPreview,
		loadDraftReview,
		toPreviewFaceArticle,
		type DraftPreview,
		type ReviewFailure,
	} from '$lib/cms/review';
	import type { DraftReviewData } from '$lib/blog-types';
	import { isAuthenticated, startLogin } from '$lib/auth/session';

	import type { AppPageDescriptor, ReviewRouteData } from '../../facetheory/types';
	import { reviewQueueHref } from '../../facetheory/routing';
	import Notice from './Notice.svelte';

	interface Props {
		page: AppPageDescriptor;
		data: ReviewRouteData;
	}

	let { page, data }: Props = $props();

	const draftId = $derived(data.draftId ?? '');

	let session = $state<'unknown' | 'anonymous' | 'authenticated'>('unknown');
	let review = $state<DraftReviewData | null>(null);
	let preview = $state<DraftPreview | null>(null);
	let reviewFailure = $state<ReviewFailure | null>(null);
	let previewFailure = $state<ReviewFailure | null>(null);
	let loading = $state(false);
	let signInError = $state<string | null>(null);

	onMount(async () => {
		session = isAuthenticated() ? 'authenticated' : 'anonymous';
		if (session !== 'authenticated' || !draftId) return;

		loading = true;
		try {
			// Metadata and body are asked for together and reported separately. A
			// draft whose preview fails to render still has attribution worth
			// showing, and a reviewer who can see the attribution but not the body
			// should be told which of the two is missing.
			const [reviewResult, previewResult] = await Promise.all([
				loadDraftReview(draftId),
				loadDraftPreview(draftId),
			]);

			if (reviewResult.ok) review = reviewResult.value;
			else reviewFailure = reviewResult.failure;

			if (previewResult.ok) preview = previewResult.value;
			else previewFailure = previewResult.failure;
		} finally {
			loading = false;
		}
	});

	async function onSignIn() {
		signInError = null;
		try {
			await startLogin();
		} catch (error) {
			signInError = error instanceof Error ? error.message : 'Sign-in could not start.';
		}
	}

	/**
	 * Which approval rules lesser will apply, for display only.
	 *
	 * `activeReviewerCount` is deliberately not supplied: the projection carries
	 * the viewer's own grant, never the active set, so any count here would be
	 * invented. Without it the strip names the rule and stays silent about
	 * progress — which is the true thing to say.
	 */
	const approvalRequirement = $derived(review ? describeApprovalRequirement(review) : undefined);

	/**
	 * The preview body, shaped for the vendored `Article.Content`.
	 *
	 * `contentFormat` is hard-coded `'html'` because that is what this value IS:
	 * lesser's renderer output. It is not a format flag contentus chooses — a
	 * preview that did not render carries no content at all (`preview.html` is
	 * null), so there is no branch here that could hand the face something
	 * unrendered and label it HTML.
	 */
	const previewArticle = $derived(
		preview ? (toPreviewFaceArticle(preview, review) ?? null) : null
	);

	const isMarkdownSource = $derived(review?.contentFormat === 'MARKDOWN');
</script>

<header class="contentus-page-header">
	<p class="contentus-eyebrow">{page.eyebrow}</p>
	<h1 class="contentus-h1">{review?.title?.trim() || page.title}</h1>
	<p class="contentus-meta">
		<a href={reviewQueueHref()}>← Back to the review queue</a>
	</p>
</header>

{#if !draftId}
	<Notice
		title="No draft was requested"
		message="This address does not name a draft. Open one from the review queue."
	/>
{:else if session !== 'authenticated'}
	<!-- The server renders this branch. It cannot know who is asking, and a
	     draft is never public, so this is the whole document a cold deep link
	     produces for an anonymous reader. -->
	<Panel class="contentus-review-panel" padding="md" aria-label="Review workspace">
		<section class="contentus-notice">
			<h2 class="contentus-notice__title">Sign in to review this draft</h2>
			<p class="contentus-notice__body">
				Drafts are visible to their author and to the reviewers invited to them. Signing in
				returns you here.
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
	<p class="contentus-review-hint" role="status">Loading the draft…</p>
{:else if reviewFailure && !review}
	<Notice
		title={reviewFailure.reason === 'not-found' || reviewFailure.reason === 'forbidden'
			? 'This draft is not available to you'
			: reviewFailure.reason === 'unauthenticated'
				? 'Your session has expired'
				: 'The draft could not be loaded'}
		message={reviewFailure.message}
		detail={reviewFailure.reason === 'not-found'
			? 'A draft is visible to its author and to reviewers holding an active invitation. An invitation that has been revoked no longer grants access.'
			: null}
	/>
{:else if review}
	<div class="contentus-review-workspace">
		<!-- The rail. Metadata and attribution, in that order, both above the
		     preview on a narrow viewport because knowing WHO wrote this changes
		     how the prose reads. -->
		<aside class="contentus-review-rail" aria-label="Draft metadata and attribution">
			<Panel class="contentus-review-panel" padding="md" aria-label="Attribution">
				<AttributionStrip {review} {approvalRequirement} />
			</Panel>

			<Panel class="contentus-review-panel" padding="md" aria-label="Draft details">
				<dl class="contentus-review-meta">
					<dt>Status</dt>
					<dd>{review.status ?? 'Unknown'}</dd>

					<dt>Source format</dt>
					<dd>{review.contentFormat ?? 'Unknown'}</dd>

					{#if review.scheduledAt}
						<dt>Scheduled</dt>
						<dd>{review.scheduledAt}</dd>
					{/if}

					{#if preview}
						<dt>Rendered size</dt>
						<dd>{preview.renderedBytes} bytes from {preview.sourceBytes} bytes of source</dd>
					{/if}
				</dl>

				<p class="contentus-review-note">
					{#if isMarkdownSource}
						This draft is written in Markdown. The preview beside it is the instance's own
						rendered output — contentus does not render Markdown, and does not show the source.
					{:else}
						The preview beside this is the instance's rendered output, not the stored source.
					{/if}
				</p>

				<p class="contentus-review-note">
					Changes are requested through a verdict, not edited here: this instance scopes draft
					edits to the draft's author.
				</p>
			</Panel>
		</aside>

		<!-- The panel. lesser's rendered output, or an explanation. -->
		<section class="contentus-review-preview" aria-label="Rendered preview">
			<Panel class="contentus-review-panel" padding="md" aria-label="Draft preview">
				{#if previewArticle}
					<!--
						`Article.Content` reads its article from the compound's context,
						so it needs `Article.Root` around it. Only Content is rendered:
						the header, footer, share bar, and reading progress belong to a
						PUBLISHED article, and putting them on a draft would dress an
						unpublished thing as a published one.
					-->
					<article class="contentus-reader">
						<ArticleRoot article={normalizeArticleData(previewArticle)}>
							<ArticleContent />
						</ArticleRoot>
					</article>
				{:else if previewFailure}
					<Notice
						title={previewFailure.reason === 'not-found' ||
						previewFailure.reason === 'forbidden'
							? 'The preview is not available to you'
							: 'The preview could not be loaded'}
						message={previewFailure.message}
					/>
				{:else if preview && !preview.success}
					<!-- lesser rendered and failed, and said why. Its errors are
					     deterministic, so they are shown verbatim rather than
					     summarised: "unclosed code fence at line 40" is actionable
					     and "the preview failed" is not. There is no fallback to
					     source here, and there will not be one. -->
					<Notice
						title="The instance could not render this draft"
						message="Nothing is shown in place of the rendered output — contentus displays what
							lesser's renderer produces, or it displays nothing."
					/>
					<ul class="contentus-review-errors">
						{#each preview.errors as error, index (index)}
							<li>{error}</li>
						{/each}
					</ul>
					{#if preview.errors.length === 0}
						<p class="contentus-meta">The instance reported a failure without naming a cause.</p>
					{/if}
				{:else}
					<Notice
						title="This draft has no rendered body"
						message="The instance rendered this draft successfully and produced no content."
					/>
				{/if}
			</Panel>
		</section>
	</div>
{/if}

<!--
The review preview body: lesser's rendered draft output, displayed exactly as
lesser produced it.

RENDERER AUTHORITY, STATED FOR THIS SINK. lesser rendered and sanitized this
HTML (`cms.RenderDraftPreviewWithMedia` behind `draftPreview(id:,
includeAccessUrls: true)`, `graph/query_resolvers_cms.go`); contentus displays
it and produces nothing. There is no client-side Markdown here, no fallback to
source, and — deliberately — no second sanitization pass. The vendored blog
face's `Article.Content` applies an allowlist shaped for UNTRUSTED FEDIVERSE
content, and that pass strips the lesser-authored `<figure>`/`<img>` this
preview exists to show — the operator failure behind #112 was exactly a bound
image invisible in the review DOM. lesser's own renderer/sanitizer is the
single authority for this HTML; re-filtering trusted server output is not
defence, it is a second opinion that disagrees with the authority.

SO THIS IS THE ONE OWNED HTML SINK IN THE REPOSITORY, and it is pinned as
such: `scripts/audit-renderer-authority.mjs` names this file as the sole
exception to its owned-sink ban and content-binds the exception — exactly one
sink, bound to `preview.html` verbatim, type-only imports, no transform. The
probe `tests/renderer-authority-audit.test.mjs` plants violations of that
binding and fails. Anything richer than "display lesser's bytes" belongs
upstream, not here.

WHAT REACHES THE SINK. `preview.html` is the `DraftPreview` projection field:
lesser's `renderedHtml` when lesser reported success, and null otherwise —
`toDraftPreview` drops the bytes of any render that failed. The guard below
re-checks both, because a display gate is worth stating twice.

SSR. Nothing here renders server-side: the preview arrives from an
authenticated `onMount` fetch after the session read, so the anonymous document
and the public hydration payload stay body-free (`tests/ssr-review.test.mjs`
pins that half). The short-lived media access URLs lesser mints into this HTML
therefore never appear in an unauthenticated response.
-->

<script lang="ts">
	import type { DraftPreview } from '$lib/cms/review';

	interface Props {
		preview: DraftPreview;
	}

	let { preview }: Props = $props();
</script>

{#if preview.success && preview.html}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html preview.html}
{/if}

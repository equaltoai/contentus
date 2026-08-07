<!--
The status a reply, quote, or edit is anchored to.

WHAT THIS DELIBERATELY DOES NOT SHOW: the source status's body.

`Object.content` is what lesser's own sanitizer stored on write
(`htmlsafe.SanitizeHTMLByContract`), so it is server-sanitized markup, not
plain text. Putting it on screen would take an `{@html}` sink in a
contentus-owned template — which `scripts/audit-renderer-authority.mjs` blocks
outright, and rightly: rendering authority is lesser's, and the one component
permitted to render sanitized server output is the vendored blog face's
`Article.Content`, which is an article surface, not a compose one. Reaching for
a client-side tag strip to make a "safe preview" would be the same violation
wearing a hat — it is contentus transforming content.

So the strip states what it can state without touching the body: who wrote it,
when, how far it reaches, whether it carries a warning, how much media it has,
and whether an agent made it. That is enough to confirm you are answering the
right post, and the id links out for anyone who wants to read it.

A greater-components status-context component that renders sanitized bodies
through the kit's own sanitizer boundary would close this properly. Recorded as
a candidate for the upstream brief alongside the mobile chrome.
-->

<script lang="ts">
	import type { SourceStatus } from '$lib/cms/compose';
	import { VISIBILITY_DESCRIPTIONS } from '$lib/cms/visibility';
	import type { ComposeMode } from '../../facetheory/types';

	interface Props {
		mode: ComposeMode;
		statusId: string;
		source: SourceStatus | null;
	}

	let { mode, statusId, source }: Props = $props();

	const heading = $derived(
		mode === 'reply' ? 'Replying to' : mode === 'quote' ? 'Quoting' : 'Editing'
	);

	const handle = $derived(
		source
			? source.authorDomain
				? `@${source.authorUsername}@${source.authorDomain}`
				: `@${source.authorUsername}`
			: null
	);

	function linkableUrl(id: string): string | null {
		try {
			const url = new URL(id);
			return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
		} catch {
			return null;
		}
	}

	const sourceUrl = $derived(linkableUrl(statusId));
</script>

<section class="contentus-compose-source" aria-label="{heading} a post">
	<p class="contentus-compose-source__eyebrow">{heading}</p>

	{#if source}
		<p class="contentus-compose-source__author">
			{#if source.authorDisplayName}
				<strong>{source.authorDisplayName}</strong>
			{/if}
			<span class="contentus-compose-source__handle">{handle}</span>
		</p>

		<p class="contentus-compose-hint">
			{VISIBILITY_DESCRIPTIONS[source.visibility]?.label ?? source.visibility}
			{#if source.createdAt}· {source.createdAt}{/if}
			{#if source.attachmentIds.length}
				· {source.attachmentIds.length} attachment{source.attachmentIds.length === 1 ? '' : 's'}
			{/if}
		</p>

		{#if source.spoilerText}
			<p class="contentus-compose-source__warning">
				Content warning: {source.spoilerText}
			</p>
		{/if}

		{#if source.agentAttributionLabel}
			<p class="contentus-compose-source__attribution">
				Written by an agent · {source.agentAttributionLabel}
			</p>
		{/if}
	{:else}
		<!-- Not an error. The server pass is anonymous, so anything narrower than
		     public resolves only once the client has the session token. -->
		<p class="contentus-compose-hint">
			Loading the post’s details. Your reply is still addressed to it.
		</p>
	{/if}

	{#if sourceUrl}
		<p class="contentus-compose-hint">
			<a href={sourceUrl} rel="noreferrer">Open the original</a>
		</p>
	{/if}
</section>

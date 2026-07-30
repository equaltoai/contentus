<!--
A designed state for "there is nothing to render, and here is why".

Product design §5 is explicit that a feature-gated instance must render a
graceful state rather than an error. The same treatment covers the other
reasons a surface can legitimately have no content, so a reader always gets a
sentence they can act on instead of a blank page or a stack trace.
-->

<script lang="ts">
	interface Props {
		title: string;
		message: string;
		/** Optional detail line, e.g. an upstream tracking note. */
		detail?: string | null;
	}

	let { title, message, detail = null }: Props = $props();
</script>

<section class="contentus-notice">
	<h2 class="contentus-notice__title">{title}</h2>
	<p class="contentus-notice__body">{message}</p>
	{#if detail}
		<p class="contentus-notice__body"><small>{detail}</small></p>
	{/if}
</section>

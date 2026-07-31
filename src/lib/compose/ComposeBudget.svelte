<!--
The gap between what the vendored character counter measures and what lesser
actually accepts.

lesser validates a status with `len(content) > MaxStatusLength` in Go
(`pkg/common/business_mastodon.go`), which is a UTF-8 BYTE length, and the limit
is 500. The vendored `Compose.Root` counts `content.length` in JavaScript, which
is UTF-16 code units. The two agree exactly on ASCII and diverge everywhere
else: a CJK character is 3 bytes and 1 unit, an emoji is 4 bytes and 2 units. So
a post the counter shows as comfortably under can be rejected by the instance,
and the poster has no way to see why.

This component closes that gap without fighting the vendored state machine. It
renders nothing while the two measures agree — which is most posts — and speaks
up only when the byte budget is spent and the character counter still says
there is room. The compose face applies the same check as a hard refusal at
submit, so the warning here and the refusal there cannot disagree.

lesser advertises no character limit on its GraphQL surface — there is no
instance-configuration field carrying `maxTootChars` — so 500 is mirrored from
the server's own constant rather than read from it. A client hardcoding a
server's limit is exactly the drift a contract is supposed to prevent; recorded
as an upstream observation for the lesser steward.
-->

<script lang="ts">
	import { getComposeContext } from '$lib/components/compose/context';

	import { STATUS_BYTE_LIMIT, statusByteLength } from './budget';

	const context = getComposeContext();

	const bytes = $derived(
		statusByteLength(
			context.state.content,
			context.state.contentWarningEnabled ? context.state.contentWarning : ''
		)
	);

	const overBudget = $derived(bytes > STATUS_BYTE_LIMIT);
	const counterAgrees = $derived(context.state.overLimit);
</script>

{#if overBudget && !counterAgrees}
	<p class="contentus-compose-budget" role="status">
		This post is {bytes} bytes and the instance accepts {STATUS_BYTE_LIMIT}. Characters outside
		the basic Latin range cost more than one byte each, so the counter above reads lower than
		what the server measures.
	</p>
{/if}

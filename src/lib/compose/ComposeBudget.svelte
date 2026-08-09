<!--
The gap between what the vendored character counter measures and what lesser
actually accepts.

lesser validates a status with `len(content) > MaxStatusLength` in Go
(`pkg/common/business_mastodon.go`), which is a UTF-8 BYTE length. The vendored
`Compose.Root` counts `content.length` in JavaScript, which is UTF-16 code
units. The two agree exactly on ASCII and diverge everywhere else: a CJK
character is 3 bytes and 1 unit, an emoji is 4 bytes and 2 units. So a post the
counter shows as comfortably under can be rejected by the instance, and the
poster has no way to see why.

This component closes that gap without fighting the vendored state machine. It
renders nothing while the two measures agree — which is most posts — and speaks
up only when the byte budget is spent and the character counter still says
there is room. The compose face applies the same check as a hard refusal at
submit, so the warning here and the refusal there cannot disagree.

WHERE THE LIMIT COMES FROM, since lesser v1.6.4: the instance serves it as
`InstanceInfo.maxStatusCharacters`, and the route hands that answer down as
`byteLimit` with `served` recording its provenance. The copy keeps the two
cases apart: a served limit is "the instance accepts N", and the documented
default standing in for an instance that did not answer is said to be lesser's
default — never presented as a value this instance stated. (The field is named
"Characters" while lesser enforces bytes; that mismatch is an upstream
observation recorded in `./budget.ts`, not something this copy argues with.)
-->

<script lang="ts">
	import { getComposeContext } from '$lib/components/compose/context';

	import { statusByteLength } from './budget';

	interface Props {
		/** The byte budget in effect, resolved by the route (`statusByteLimit`). */
		byteLimit: number;
		/**
		 * True when `byteLimit` is this instance's own served value; false when
		 * lesser's documented default is standing in for an unstated one. The
		 * copy says which, because only the first is something the instance
		 * actually claimed.
		 */
		served: boolean;
	}

	let { byteLimit, served }: Props = $props();

	const context = getComposeContext();

	const bytes = $derived(
		statusByteLength(
			context.state.content,
			context.state.contentWarningEnabled ? context.state.contentWarning : ''
		)
	);

	const overBudget = $derived(bytes > byteLimit);
	const counterAgrees = $derived(context.state.overLimit);
</script>

{#if overBudget && !counterAgrees}
	<p class="contentus-compose-budget" role="status">
		This post is {bytes} bytes and
		{#if served}
			the instance accepts {byteLimit}.
		{:else}
			this instance has not stated its limit, so lesser's documented default of {byteLimit}
			applies.
		{/if}
		Characters outside the basic Latin range cost more than one byte each, so the counter above
		reads lower than what the server measures.
	</p>
{/if}

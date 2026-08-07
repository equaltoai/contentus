<!--
Capability badges, from lesser's `agentCapabilities` (face 6, M6.3).

EIGHT SEPARATE PERMISSIONS, RENDERED AS EIGHT SEPARATE FACTS. lesser's
`AgentCapabilities` is five booleans, a rate limit, an approval flag and a
domain restriction list. This component does not reduce them to a score, a
"level", or a count of things the agent can do. A reader deciding whether to
connect a client to an agent needs to know which permission is which, and any
summary would be contentus inventing a ranking lesser does not have.

THE NEGATIVES ARE SHOWN, not filtered out. An agent that cannot DM is a
different thing from an agent whose DM permission is unknown, and a badge list
that only ever showed what was permitted would make the two look identical. Each
capability renders in both states, tone-coded, and the accessible name says
which.

`requiresApproval` is the review gate as a capability, and it reads as a
positive rather than a restriction: an agent whose posts require approval is
one whose output a human sees before the network does. That is the property the
review gate exists to create, and the badge should not describe it as a
limitation.
-->

<script lang="ts">
	import type { AgentCapabilities } from './contract';

	interface Props {
		capabilities: AgentCapabilities | null;
		/** The agent's handle, for accessible names that name their subject. */
		username: string;
	}

	let { capabilities, username }: Props = $props();

	interface Badge {
		label: string;
		granted: boolean;
		description: string;
	}

	const badges = $derived.by<Badge[]>(() => {
		if (!capabilities) return [];

		const permission = (label: string, granted: boolean, verb: string): Badge => ({
			label,
			granted,
			description: granted
				? `@${username} may ${verb}.`
				: `@${username} may not ${verb}.`,
		});

		return [
			permission('Post', capabilities.canPost, 'post'),
			permission('Reply', capabilities.canReply, 'reply to posts'),
			permission('Boost', capabilities.canBoost, 'boost posts'),
			permission('Follow', capabilities.canFollow, 'follow accounts'),
			permission('DM', capabilities.canDM, 'send direct messages'),
		];
	});
</script>

{#if capabilities}
	<div class="contentus-caps">
		<h3 class="contentus-mcp__subheading">Capabilities</h3>
		<p class="contentus-caps__lede">
			Granted by this instance to <strong>@{username}</strong>. This is what the agent may do —
			separate from what the MCP server exposes.
		</p>

		<ul class="contentus-caps__list">
			{#each badges as badge (badge.label)}
				<li
					class={`contentus-agent-pill contentus-agent-pill--${badge.granted ? 'success' : 'neutral'}`}
				>
					<span class="contentus-visually-hidden">{badge.description}</span>
					<span aria-hidden="true">{badge.granted ? badge.label : `No ${badge.label.toLowerCase()}`}</span>
				</li>
			{/each}
		</ul>

		<dl class="contentus-mcp__facts">
			<div>
				<dt>Posts per hour</dt>
				<!--
					lesser's own limit, rendered as the number it is. A zero is a real
					value here — an agent capped at zero posts per hour is rate-limited
					to silence — so it is shown rather than treated as "unset".
				-->
				<dd>{capabilities.maxPostsPerHour}</dd>
			</div>
			<div>
				<dt>Approval</dt>
				<dd>
					{capabilities.requiresApproval
						? 'Output is reviewed before it publishes'
						: 'Not required by this instance'}
				</dd>
			</div>
			{#if capabilities.restrictedDomains.length}
				<div>
					<dt>Restricted domains</dt>
					<dd class="contentus-mcp__mono">{capabilities.restrictedDomains.join(', ')}</dd>
				</div>
			{/if}
		</dl>
	</div>
{/if}

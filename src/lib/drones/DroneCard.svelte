<script lang="ts">
	import { agentHref } from '../../facetheory/routing';
	import type { OwnedDrone } from './contract';
	import { identitySurfaceHref } from './identity';

	interface Props {
		drone: OwnedDrone;
	}

	let { drone }: Props = $props();
</script>

<article class="contentus-drone-card">
	<header class="contentus-drone-card__header">
		<div>
			<h3 class="contentus-drone-card__title">
				<a href={agentHref(drone.agent.username)}>{drone.agent.displayName}</a>
			</h3>
			<p class="contentus-drone-card__handle">@{drone.agent.username}</p>
		</div>
		<span class="contentus-drone-pill">{drone.agent.agentType}</span>
	</header>

	{#if drone.agent.bio}
		<p class="contentus-drone-card__bio">{drone.agent.bio}</p>
	{/if}

	<dl class="contentus-drone-card__facts">
		<div>
			<dt>Delegated scopes</dt>
			<dd>{drone.agent.owner?.delegatedScopes.join(' ') || 'None reported'}</dd>
		</div>
		<div>
			<dt>Workflow</dt>
			<dd>
				{#if drone.workflow}
					{drone.workflow.currentPhase} · {drone.workflow.currentState}
				{:else if drone.workflowUnavailable}
					Status unavailable
				{:else}
					Not started
				{/if}
			</dd>
		</div>
		{#if drone.workflow?.identityLabel}
			<div>
				<dt>Identity</dt>
				<dd>{drone.workflow.identityLabel}</dd>
			</div>
		{/if}
	</dl>

	<div class="contentus-drone-card__actions">
		<a class="contentus-drone-action" href={agentHref(drone.agent.username)}>View agent details</a>
		<a class="contentus-drone-action" href={identitySurfaceHref(drone.agent.username)}>
			Open identity &amp; promotion
		</a>
	</div>
</article>

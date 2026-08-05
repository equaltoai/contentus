<!--
The roster's filter controls (face 6, M6.1).

A PLAIN GET FORM, and that is the design rather than a shortcut. lesser performs
no SPA fallback under `/l/*`, so the first paint of a deep link is the server's;
a filter built from JavaScript listeners would leave a no-script reader — and
the server's own paint — with controls that do nothing. A form whose method is
GET and whose action is this route submits to a real address, which is the same
address the links elsewhere in the roster build. Filtering therefore works
before hydration and produces a URL a reader can share.

`after` is deliberately not a field: submitting the form starts a new query, and
carrying the old cursor would ask lesser to resume a list that no longer exists.
Its absence from the form is what drops it.
-->

<script lang="ts">
	
	import { agentsHref } from '../../facetheory/routing';
	import { AGENT_TYPE_OPTIONS, hasActiveFilters, type AgentRosterFilterState } from './filters';

	interface Props {
		filters: AgentRosterFilterState;
	}

	let { filters }: Props = $props();

	const verifiedValue = $derived(
		filters.verified === true ? 'true' : filters.verified === false ? 'false' : ''
	);
</script>

<form class="contentus-agents__filters" method="get" action={agentsHref()} role="search">
	<div class="contentus-agents__filter">
		<label class="contentus-agents__filter-label" for="contentus-agents-q">Search</label>
		<input
			class="contentus-agents__filter-input"
			id="contentus-agents-q"
			type="search"
			name="q"
			value={filters.query ?? ''}
			placeholder="Handle, name or bio"
		/>
	</div>

	<div class="contentus-agents__filter">
		<label class="contentus-agents__filter-label" for="contentus-agents-type">Type</label>
		<select class="contentus-agents__filter-input" id="contentus-agents-type" name="type">
			{#each AGENT_TYPE_OPTIONS as option (option.label)}
				<option value={option.value ?? ''} selected={filters.type === option.value}>
					{option.label}
				</option>
			{/each}
		</select>
	</div>

	<div class="contentus-agents__filter">
		<label class="contentus-agents__filter-label" for="contentus-agents-verified">
			Verification
		</label>
		<select class="contentus-agents__filter-input" id="contentus-agents-verified" name="verified">
			<!--
				"Any" is the empty value, not `false`. lesser treats a null `verified`
				as no opinion and `false` as "unverified only" — collapsing them would
				silently hide every verified agent behind the default.
			-->
			<option value="" selected={verifiedValue === ''}>Any</option>
			<option value="true" selected={verifiedValue === 'true'}>Verified only</option>
			<option value="false" selected={verifiedValue === 'false'}>Unverified only</option>
		</select>
	</div>

	<div class="contentus-agents__filter-actions">
		<button class="contentus-agents__filter-submit" type="submit">Apply</button>
		{#if hasActiveFilters(filters)}
			<a class="contentus-agents__filter-clear" href={agentsHref()}>Clear</a>
		{/if}
	</div>
</form>

<!--
Notifications.Filter - Filter notifications by type

Allows users to filter notifications by type (all, mentions, follows, etc.).

@component
@example
```svelte
<script>
  import { Notifications } from 'src/lib/components/notifications';
</script>

<Notifications.Root {notifications}>
  <Notifications.Filter />
  {#each notifications as notification}
    <Notifications.Item {notification} />
  {/each}
</Notifications.Root>
```
-->

<script lang="ts">
	import { getNotificationsContext } from './context.svelte.js';
	import type { NotificationFilter } from './context.svelte.js';

	interface Props {
		/**
		 * Additional CSS class
		 */
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	const context = getNotificationsContext();

	const filters: Array<{ value: NotificationFilter; label: string; icon: string }> = [
		{ value: 'all', label: 'All', icon: '🔔' },
		{ value: 'mentions', label: 'Mentions', icon: '@' },
		{ value: 'follows', label: 'Follows', icon: '👤' },
		{ value: 'boosts', label: 'Boosts', icon: '🔁' },
		{ value: 'favorites', label: 'Favorites', icon: '⭐' },
		{ value: 'polls', label: 'Polls', icon: '📊' },
	];

	function handleFilterClick(filter: NotificationFilter) {
		context.updateState({ activeFilter: filter });
		context.handlers.onFilterChange?.(filter);
	}
</script>

<nav class={`notification-filter ${className}`} aria-label="Filter notifications">
	<div class="notification-filter__tabs">
		{#each filters as filter (filter.value)}
			<button
				class="notification-filter__tab"
				class:notification-filter__tab--active={context.state.activeFilter === filter.value}
				onclick={() => handleFilterClick(filter.value)}
				aria-current={context.state.activeFilter === filter.value ? 'page' : undefined}
			>
				<span class="notification-filter__icon" aria-hidden="true">{filter.icon}</span>
				<span class="notification-filter__label">{filter.label}</span>
			</button>
		{/each}
	</div>
</nav>

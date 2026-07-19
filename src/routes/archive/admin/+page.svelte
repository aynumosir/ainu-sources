<script lang="ts">
	import AdminUsersTable from '$lib/components/archive/AdminUsersTable.svelte';
	import UnderConstruction from '$lib/components/archive/UnderConstruction.svelte';

	type Tab = 'users' | 'orphans' | 'budgets';

	let { data } = $props();
	let tab = $state<Tab>('users');

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'users', label: 'Users' },
		{ id: 'orphans', label: 'Orphans & quarantine' },
		{ id: 'budgets', label: 'Budgets & events' }
	];
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-[27px] font-semibold">{data.title}</h1>
		<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Archive administration.</p>
	</div>

	<div class="border-b border-[var(--archive-border)]">
		<nav class="-mb-px flex flex-wrap gap-1 text-[13px]" aria-label="Admin sections">
			{#each tabs as item}
				<button
					type="button"
					onclick={() => (tab = item.id)}
					class={`border-b-2 px-3 py-2 font-medium ${
						tab === item.id
							? 'border-[var(--archive-accent)] text-[var(--archive-text)]'
							: 'border-transparent text-[var(--archive-subtle)] hover:text-[var(--archive-text)]'
					}`}
				>
					{item.label}
				</button>
			{/each}
		</nav>
	</div>

	{#if tab === 'users'}
		<AdminUsersTable users={data.users ?? []} />
	{:else if tab === 'orphans'}
		<UnderConstruction title="Orphans & quarantine" />
	{:else}
		<UnderConstruction title="Budgets & events" />
	{/if}
</div>

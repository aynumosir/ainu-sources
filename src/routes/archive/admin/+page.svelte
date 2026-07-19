<script lang="ts">
	import AdminUsersTable from '$lib/components/archive/AdminUsersTable.svelte';
	import UnderConstruction from '$lib/components/archive/UnderConstruction.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	type Tab = 'users' | 'orphans' | 'budgets';

	let { data } = $props();
	let tab = $state<Tab>('users');

	const tabs: { id: Tab; label: (typeof archiveLabels)[keyof typeof archiveLabels] }[] = [
		{ id: 'users', label: archiveLabels.users },
		{ id: 'orphans', label: archiveLabels.orphansQuarantine },
		{ id: 'budgets', label: archiveLabels.budgetsEvents }
	];
</script>

<div class="space-y-4">
	<div class="archive-rule-dotted pb-3">
		<BilingualLabel
			tag="h1"
			stacked
			ja={archiveLabels.admin.ja}
			en={archiveLabels.admin.en}
			class="text-[27px] font-semibold"
		/>
		<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Archive administration.</p>
	</div>

	<div class="border-b border-[var(--archive-border)]">
		<nav class="-mb-px flex flex-wrap gap-1 text-[13px]" aria-label="Admin sections">
			{#each tabs as item}
				<button
					type="button"
					aria-label={bilingualAriaLabel(item.label)}
					onclick={() => (tab = item.id)}
					class={`border-b-2 px-3 py-2 font-medium ${
						tab === item.id
							? 'border-[var(--archive-accent)] text-[var(--archive-text)]'
							: 'border-transparent text-[var(--archive-subtle)] hover:text-[var(--archive-text)]'
					}`}
				>
					<BilingualLabel ja={item.label.ja} en={item.label.en} />
				</button>
			{/each}
		</nav>
	</div>

	{#if tab === 'users'}
		<AdminUsersTable users={data.users ?? []} />
	{:else if tab === 'orphans'}
		<UnderConstruction label={archiveLabels.orphansQuarantine} />
	{:else}
		<UnderConstruction label={archiveLabels.budgetsEvents} />
	{/if}
</div>

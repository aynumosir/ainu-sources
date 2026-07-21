<script lang="ts">
	import { archiveFetch } from '$lib/archive/session.svelte';
	import { formatBytes, formatDateTime } from '$lib/archive/format';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	type Pending = {
		revisionId: string;
		title: string;
		fileRole: string | null;
		filename: string | null;
		bytes: number | null;
		submittedAt: string | null;
		uploader: string;
		canWithdraw: boolean;
	};

	let { items }: { items: Pending[] } = $props();
	let error = $state<string | null>(null);
	let withdrawing = $state<string | null>(null);

	async function withdraw(revisionId: string): Promise<void> {
		if (!confirm('Withdraw this pending submission?')) return;
		withdrawing = revisionId;
		error = null;
		try {
			const csrf = await archiveFetch('/api/archive/csrf');
			if (!csrf.ok) throw new Error('Could not issue CSRF token.');
			const { token } = (await csrf.json()) as { token: string };
			const response = await archiveFetch(`/api/archive/revisions/${revisionId}/withdraw`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-archive-csrf': token
				},
				body: '{}'
			});
			if (!response.ok) throw new Error(`Withdraw failed (${response.status}).`);
			location.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Withdraw failed.';
		} finally {
			withdrawing = null;
		}
	}
</script>

<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
	<BilingualLabel
		tag="h2"
		ja={archiveLabels.pendingSubmissions.ja}
		en={archiveLabels.pendingSubmissions.en}
		class="text-[17px] font-semibold"
	/>
	{#if error}<p class="mt-2 text-[13px] text-[var(--archive-danger)]">{error}</p>{/if}
	{#if items.length}
		<ul class="mt-3 space-y-3">
			{#each items as item (item.revisionId)}
				<li class="flex flex-col gap-2 border-t border-[var(--archive-border)] pt-3 first:border-0 first:pt-0 md:flex-row md:items-center md:justify-between">
					<div>
						<p class="text-[15px] font-medium">{item.filename ?? item.title}</p>
						<p class="text-[13px] text-[var(--archive-subtle)]">
							{item.fileRole ?? 'file'} · {formatBytes(item.bytes)}
							{#if item.submittedAt} · <time class="tnum" datetime={item.submittedAt}>{formatDateTime(item.submittedAt)}</time>{/if}
						</p>
					</div>
					{#if item.canWithdraw}
						<button
							type="button"
							disabled={withdrawing === item.revisionId}
							onclick={() => withdraw(item.revisionId)}
							class="self-start border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] hover:border-[var(--archive-gilt)] disabled:opacity-60"
						>
							{withdrawing === item.revisionId ? 'Withdrawing' : 'Withdraw'}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-[13px] text-[var(--archive-subtle)]">No pending submissions.</p>
	{/if}
</section>

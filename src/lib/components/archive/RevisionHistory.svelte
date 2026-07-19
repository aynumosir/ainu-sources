<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	type Revision = {
		revisionId: string | null;
		revisionNo: number | null;
		reviewStatus: string | null;
		submittedAt: string | null;
		sha256: string | null;
	};

	let { revisions }: { revisions: Revision[] } = $props();
</script>

<details class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
	<summary class="cursor-pointer text-[15px] font-semibold">
		<BilingualLabel ja={archiveLabels.revisionHistory.ja} en={archiveLabels.revisionHistory.en} />
	</summary>
	{#if revisions.length}
		<ol class="mt-3 space-y-2">
			{#each revisions as revision, index (revision.revisionId ?? index)}
				<li class="flex flex-wrap items-center gap-2 text-[13px] text-[var(--archive-subtle)]">
					<span class="tnum text-[var(--archive-text)]">rev {revision.revisionNo ?? '—'}</span>
					<span>{revision.reviewStatus ?? 'unknown'}</span>
					{#if revision.submittedAt}<time datetime={revision.submittedAt}>{new Date(revision.submittedAt).toLocaleString('en-US')}</time>{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="mt-3 text-[13px] text-[var(--archive-subtle)]">No prior revisions are visible.</p>
	{/if}
</details>

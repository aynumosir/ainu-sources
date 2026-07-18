<script lang="ts">
	import SourceHeader from '$lib/components/archive/SourceHeader.svelte';
	import FileRow from '$lib/components/archive/FileRow.svelte';
	import RevisionHistory from '$lib/components/archive/RevisionHistory.svelte';
	import PendingSubmissions from '$lib/components/archive/PendingSubmissions.svelte';

	let { data } = $props();

	const source = $derived(data.detail?.source);
	const primaryFile = $derived(data.files.find((file) => file.revisionId) ?? null);
</script>

{#if source}
	<div class="space-y-5">
		<SourceHeader {source} {primaryFile} />

		<section>
			<h2 class="mb-3 text-[21px] font-semibold">Files</h2>
			{#if data.files.length}
				<div class="space-y-3">
					{#each data.files as file (file.fileId + ':' + (file.revisionId ?? 'none'))}
						<FileRow {file} sourceSlug={source.slug} />
					{/each}
				</div>
			{:else}
				<p class="rounded-lg border border-dashed border-[var(--archive-border)] bg-[var(--archive-surface)] p-6 text-[15px] text-[var(--archive-subtle)]">
					No archive files are available for this source.
				</p>
			{/if}
		</section>

		<section class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
			<h2 class="text-[17px] font-semibold">OCR coverage</h2>
			<p class="mt-2 text-[13px] text-[var(--archive-subtle)]">
				OCR coverage data is not available from the phase 1 API.
			</p>
		</section>

		<PendingSubmissions items={data.pending} />
		<RevisionHistory revisions={data.revisions} />
	</div>
{/if}

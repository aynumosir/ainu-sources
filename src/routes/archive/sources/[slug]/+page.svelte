<script lang="ts">
	import SourceHeader from '$lib/components/archive/SourceHeader.svelte';
	import FileRow from '$lib/components/archive/FileRow.svelte';
	import RevisionHistory from '$lib/components/archive/RevisionHistory.svelte';
	import PendingSubmissions from '$lib/components/archive/PendingSubmissions.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	let { data } = $props();

	const source = $derived(data.detail?.source);
	const primaryFile = $derived(data.files.find((file) => file.revisionId) ?? null);
</script>

{#if source}
	<div class="space-y-5">
		<SourceHeader {source} {primaryFile} />

		<section>
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.files.ja}
				en={archiveLabels.files.en}
				class="mb-3 text-[21px] font-semibold [--archive-label-en-size:17px]"
			/>
			{#if data.files.length}
				<div class="space-y-3">
					{#each data.files as file (file.fileId + ':' + (file.revisionId ?? 'none'))}
						<FileRow {file} sourceSlug={source.slug} />
					{/each}
				</div>
			{:else}
				<div class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-6 text-[15px] text-[var(--archive-subtle)]">
					<BilingualLabel
						stacked
						ja={archiveLabels.noArchiveFiles.ja}
						en={archiveLabels.noArchiveFiles.en}
						class="[--archive-label-en-size:13px]"
					/>
				</div>
			{/if}
		</section>

		<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.ocrCoverage.ja}
				en={archiveLabels.ocrCoverage.en}
				class="text-[17px] font-semibold [--archive-label-en-size:15px]"
			/>
			<p class="mt-2 text-[13px] text-[var(--archive-subtle)]">
				OCR coverage data is not available from the phase 1 API.
			</p>
		</section>

		<PendingSubmissions items={data.pending} />
		<RevisionHistory revisions={data.revisions} />
	</div>
{/if}

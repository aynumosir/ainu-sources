<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	let { slug, reference }: { slug: string; reference: string } = $props();

	// Export formats: label + endpoint extension. Each is downloadable and copyable.
	const FORMATS = [
		{ label: 'BibTeX', ext: 'cite.bib' },
		{ label: 'Hayagriva', ext: 'cite.yml' },
		{ label: 'RIS', ext: 'cite.ris' },
		{ label: 'CSL-JSON', ext: 'cite.json' }
	];

	let copied = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy(text: string, tag: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		copied = tag;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = null), 1500);
	}

	async function copyFormat(ext: string, label: string) {
		try {
			const res = await fetch(`/sources/${slug}/${ext}`);
			await copy(await res.text(), label);
		} catch {
			/* ignore */
		}
	}
</script>

<div>
	<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
		{m.source_cite()}
	</h2>

	<!-- Formatted reference + copy -->
	<div class="mt-2 rounded-md bg-stone-50 p-2 text-xs leading-relaxed text-stone-600 ring-1 ring-inset ring-stone-200">
		<p>{reference}</p>
		<button
			type="button"
			onclick={() => copy(reference, 'ref')}
			class="mt-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-stone-500 ring-1 ring-stone-300 hover:bg-stone-100"
		>
			{copied === 'ref' ? m.cite_copied() : m.cite_copy()}
		</button>
	</div>

	<!-- Export formats: copy + download -->
	<ul class="mt-2 space-y-1">
		{#each FORMATS as f (f.ext)}
			<li class="flex items-center gap-2 text-xs">
				<button
					type="button"
					onclick={() => copyFormat(f.ext, f.label)}
					class="min-w-[5.5rem] rounded px-1.5 py-0.5 text-left font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
				>
					{copied === f.label ? m.cite_copied() : f.label}
				</button>
				<a href="/sources/{slug}/{f.ext}" class="link text-[11px] text-stone-400" download>
					{m.cite_download()}
				</a>
			</li>
		{/each}
	</ul>
</div>

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import SourceForm from '$lib/components/SourceForm.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>{m.edit_source_title()} · {data.title}</title></svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.edit_source_title()}</h1>
	<p class="mt-1 text-stone-500">{data.title}</p>
	<div class="mt-6">
		<SourceForm
			mode="edit"
			initial={data.initial}
			cancelHref={`/sources/${data.slug}`}
			error={form?.error}
		/>
	</div>
</div>

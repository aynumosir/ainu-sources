<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import SourceForm from '$lib/components/SourceForm.svelte';

	let { form } = $props();
</script>

<svelte:head><title>{m.new_source_title()} · {m.site_short()}</title></svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.new_source_title()}</h1>
	<div class="mt-6">
		<SourceForm
			mode="create"
			initial={{ category: 'primary', type: 'old-document' }}
			cancelHref="/sources"
			error={form?.error}
		/>
	</div>
</div>

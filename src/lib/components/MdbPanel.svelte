<script lang="ts">
	import { mdbLinks } from '$lib/mdb';
	import { getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	let { catalogue }: { catalogue: string } = $props();
	const links = $derived(mdbLinks(catalogue, getLocale()));
</script>

{#if links.length}
	<section class="mt-6 rounded-xl border border-brand-200 bg-paper-card p-5" aria-label={m.mdb_lexemes_title()}>
		<h2 class="font-serif text-xl font-bold text-ink">{m.mdb_lexemes_title()}</h2>
		<p class="mt-2 text-sm text-stone-600">{m.mdb_lexemes_intro()}</p>
		<ul class="mt-3 space-y-2">
			{#each links as link (link.id)}
				<li>
					<a class="font-medium text-brand-700 underline" href={link.url}>{m.mdb_lexemes_browse({ count: link.lexemes.toLocaleString(getLocale() === 'ja' ? 'ja' : 'en') })} ↗</a>
					{#if links.length > 1}<span class="ml-2 text-sm text-stone-600">{link.title}</span>{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	const year = 2026;
	const cols = [
		{
			heading: () => m.nav_sources(),
			links: [
				{ href: '/sources', label: () => m.nav_sources() },
				{ href: '/timeline', label: () => m.nav_timeline() },
				{ href: '/map', label: () => m.nav_map() }
			]
		},
		{
			heading: () => m.nav_people(),
			links: [
				{ href: '/people', label: () => m.nav_people() },
				{ href: '/places', label: () => m.nav_places() },
				{ href: '/institutions', label: () => m.nav_institutions() }
			]
		},
		{
			heading: () => m.nav_about(),
			links: [{ href: '/about', label: () => m.nav_about() }]
		}
	];
</script>

<footer class="mt-16 border-t border-stone-200 bg-paper-card">
	<div class="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 md:grid-cols-4">
		<div class="sm:col-span-2 md:col-span-1">
			<div class="font-serif text-base font-bold text-ink">{m.site_short()}</div>
			<p class="mt-2 max-w-xs text-sm text-stone-500">{m.footer_tagline()}</p>
		</div>
		{#each cols as col (col.heading())}
			<nav>
				<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
					{col.heading()}
				</h2>
				<ul class="mt-2 space-y-1.5">
					{#each col.links as l (l.href)}
						<li>
							<a href={localizeHref(l.href)} class="text-sm text-stone-600 hover:text-brand-700"
								>{l.label()}</a
							>
						</li>
					{/each}
				</ul>
			</nav>
		{/each}
	</div>
	<div
		class="mx-auto flex max-w-6xl flex-col gap-1 border-t border-stone-200 px-4 py-5 text-xs text-stone-500 sm:flex-row sm:items-center sm:justify-between"
	>
		<p>© {year} {m.site_title()} · {m.footer_part_of()}</p>
		<p>{m.footer_data_credit()}</p>
	</div>
</footer>

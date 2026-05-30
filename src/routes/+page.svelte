<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import SourceCard from '$lib/components/SourceCard.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import { tl, REGION_LABELS, TYPE_LABELS } from '$lib/constants';

	let { data } = $props();
	const { stats, recent, timeline } = $derived(data);

	const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

	const categoryCount = (key: string) =>
		stats.byCategory.find((b) => b.key === key)?.count ?? 0;

	// stat cards
	const statCards = $derived([
		{ label: m.home_stat_sources(), value: num(stats.total) },
		{ label: m.home_stat_primary(), value: num(categoryCount('primary')) },
		{ label: m.home_stat_corpus(), value: num(categoryCount('corpus')) },
		{ label: m.home_stat_secondary(), value: num(categoryCount('secondary')) },
		{ label: m.home_stat_tools(), value: num(categoryCount('tool')) },
		{ label: m.home_stat_people(), value: num(stats.personCount) },
		{ label: m.home_stat_places(), value: num(stats.placeCount) },
		{ label: m.home_stat_institutions(), value: num(stats.institutionCount) },
		{
			label: m.home_stat_span(),
			value:
				stats.yearMin != null && stats.yearMax != null
					? `${stats.yearMin}–${stats.yearMax}`
					: '—'
		}
	]);

	const regionRows = $derived(stats.byRegion.filter((b) => b.key));
	const regionMax = $derived(Math.max(1, ...regionRows.map((b) => b.count)));

	const typeRows = $derived(stats.byType.filter((b) => b.key));
	const typeMax = $derived(Math.max(1, ...typeRows.map((b) => b.count)));
</script>

<svelte:head><title>{m.site_title()} · {m.site_short()}</title></svelte:head>

<!-- Hero -->
<section class="bg-paper">
	<div class="mx-auto max-w-6xl px-4 py-16 sm:py-20">
		<h1 class="max-w-3xl font-serif text-4xl font-bold leading-tight text-ink sm:text-5xl">
			{m.home_hero_title()}
		</h1>
		<p class="mt-5 max-w-2xl text-lg leading-relaxed text-stone-600">{m.home_hero_lead()}</p>
		<div class="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
			<a
				href={localizeHref('/sources')}
				class="inline-flex items-center justify-center rounded-md bg-brand-700 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-800"
				>{m.home_browse_cta()}</a
			>
			<SearchBox />
		</div>
	</div>
</section>

<div class="mx-auto max-w-6xl space-y-16 px-4 py-16">
	<!-- Stats strip -->
	<section>
		<h2 class="font-serif text-2xl font-bold text-ink">{m.home_stats_heading()}</h2>
		<div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
			{#each statCards as card (card.label)}
				<div class="card rounded-xl border border-stone-200 bg-paper-card p-5">
					<div class="tnum font-serif text-2xl font-bold text-brand-700">{card.value}</div>
					<div class="mt-1 text-sm text-stone-500">{card.label}</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- Mini timeline -->
	<section>
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.home_by_period()}</h2>
			<a href={localizeHref('/timeline')} class="link text-sm">{m.home_explore_timeline()} →</a>
		</div>
		<div class="mt-6">
			<Timeline points={timeline} height={200} variant="mini" showLegend={true} />
		</div>
	</section>

	<!-- By region & by type -->
	<section class="grid gap-10 md:grid-cols-2">
		<div>
			<h2 class="font-serif text-2xl font-bold text-ink">{m.home_by_region()}</h2>
			<div class="mt-6 space-y-2">
				{#each regionRows as row (row.key)}
					<a
						href={localizeHref('/sources?regions=' + row.key)}
						class="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-stone-100"
					>
						<span class="w-28 shrink-0 truncate text-sm text-ink"
							>{tl(REGION_LABELS, row.key)}</span
						>
						<span class="relative h-2.5 flex-1 overflow-hidden rounded-full bg-stone-100">
							<span
								class="absolute inset-y-0 left-0 rounded-full bg-brand-400 transition group-hover:bg-brand-600"
								style="width:{(row.count / regionMax) * 100}%"
							></span>
						</span>
						<span class="tnum w-10 shrink-0 text-right text-sm text-stone-500">{num(row.count)}</span>
					</a>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="font-serif text-2xl font-bold text-ink">{m.home_by_type()}</h2>
			<div class="mt-6 space-y-2">
				{#each typeRows as row (row.key)}
					<a
						href={localizeHref('/sources?types=' + row.key)}
						class="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-stone-100"
					>
						<span class="w-40 shrink-0 truncate text-sm text-ink"
							>{tl(TYPE_LABELS, row.key)}</span
						>
						<span class="relative h-2.5 flex-1 overflow-hidden rounded-full bg-stone-100">
							<span
								class="absolute inset-y-0 left-0 rounded-full bg-brand-400 transition group-hover:bg-brand-600"
								style="width:{(row.count / typeMax) * 100}%"
							></span>
						</span>
						<span class="tnum w-10 shrink-0 text-right text-sm text-stone-500">{num(row.count)}</span>
					</a>
				{/each}
			</div>
		</div>
	</section>

	<!-- Recently updated -->
	<section>
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.home_recent()}</h2>
			<a href={localizeHref('/sources')} class="link text-sm">{m.common_view_all()} →</a>
		</div>
		{#if recent.length}
			<div class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{#each recent as s (s.id)}
					<SourceCard source={s} />
				{/each}
			</div>
		{:else}
			<div
				class="mt-6 rounded-xl border border-dashed border-stone-300 p-12 text-center text-stone-500"
			>
				{m.common_no_results()}
			</div>
		{/if}
	</section>
</div>

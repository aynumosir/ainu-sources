<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { archiveFilterHref, type ArchiveFilters } from '$lib/archive/filters';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import type { ArchiveStats } from '$lib/server/archive/stats';

	let { filters, stats = null }: { filters: ArchiveFilters; stats?: ArchiveStats | null } = $props();

	// The form only knows its own fields; without this, submitting it or
	// clicking Clear would drop the view mode back to the cards default.
	const view = $derived(page.url.searchParams.get('view'));
	const clearHref = $derived.by(() => {
		const href = archiveFilterHref('/archive', { ocr: 'any', sort: 'significance' });
		if (!view) return href;
		const [path, query] = href.split('?');
		const params = new URLSearchParams(query);
		params.set('view', view);
		return `${path}?${params}`;
	});

	// Real decades present in the collection, oldest first, each with its
	// work count — built from the same era buckets /stats already reports,
	// so a researcher only ever picks a decade that actually has something
	// in it. The decade filter itself is a [decade, decade+10) range, which
	// "pre-1900" (an open-ended bucket covering several sparse decades) does
	// not fit; it is also, in this collection, a single work, so it is left
	// off the list rather than forcing an unrelated filter shape to carry it.
	const decadeOptions = $derived.by(() => {
		const values = stats?.distribution.era.values ?? [];
		return values
			.map((v) => {
				const decade = Number.parseInt(v.value, 10);
				return Number.isNaN(decade) ? null : { decade, label: v.value, count: v.count };
			})
			.filter((v): v is { decade: number; label: string; count: number } => v !== null)
			.sort((a, b) => a.decade - b.decade);
	});

	const CATEGORY_OPTION_LABELS: Record<string, string> = {
		primary: 'Primary / 一次資料',
		secondary: 'Secondary / 二次資料',
		corpus: 'Corpus / コーパス',
		tool: 'Tool / ツール'
	};
	const categoryOptions = $derived(stats?.distribution.category.values ?? []);
	const dialectOptions = $derived(stats?.distribution.dialect.values ?? []);
	const tagOptions = $derived(stats?.tags ?? []);

	const LANG_OPTIONS = [
		{ value: 'ain', label: 'Ainu / アイヌ語' },
		{ value: 'jpn', label: 'Japanese / 日本語' },
		{ value: 'eng', label: 'English / 英語' },
		{ value: 'rus', label: 'Russian / ロシア語' }
	] as const;

	// Every dropdown narrows results the moment it's changed — a researcher
	// expects a dropdown to act immediately, the way a sort does on any
	// modern catalogue. Only free-text search waits for Apply/Enter, since
	// reloading on every keystroke would be its own kind of broken.
	function navigateWith(name: string, value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		params.delete('cursor');
		if (value && value !== 'any' && !(name === 'sort' && value === 'significance')) params.set(name, value);
		else params.delete(name);
		const qs = params.toString();
		// Replace, not push: each filter change stands in for the last one, so
		// leaving the page after a run of instant filter changes is one Back
		// press, not one per dropdown touched.
		goto(qs ? `${page.url.pathname}?${qs}` : page.url.pathname, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}
</script>

<form action="/archive" method="get" class="border-b border-[var(--archive-border)] pb-4">
	{#if view}<input type="hidden" name="view" value={view} />{/if}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)] lg:col-span-2">
			<BilingualLabel ja="キーワード" en="Keyword" />
			<input name="q" value={filters.text ?? ''} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="分類" en="Category" />
			<select
				name="category"
				value={filters.category ?? ''}
				onchange={(e) => navigateWith('category', e.currentTarget.value)}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]"
			>
				<option value="">All / すべて</option>
				{#each categoryOptions as opt (opt.value)}
					<option value={opt.value}>{CATEGORY_OPTION_LABELS[opt.value] ?? opt.value} ({opt.count})</option>
				{/each}
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="タグ" en="Tag" />
			<select
				name="tag"
				value={filters.tag ?? ''}
				onchange={(e) => navigateWith('tag', e.currentTarget.value)}
				disabled={tagOptions.length === 0}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)] disabled:opacity-50"
			>
				<option value="">All / すべて</option>
				{#each tagOptions as opt (opt.slug)}
					<option value={opt.slug}>{opt.name}{opt.nameEn && opt.nameEn !== opt.name ? ` / ${opt.nameEn}` : ''} ({opt.works})</option>
				{/each}
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="方言" en="Dialect" />
			<select
				name="dialect"
				value={filters.dialect ?? ''}
				onchange={(e) => navigateWith('dialect', e.currentTarget.value)}
				disabled={dialectOptions.length === 0}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)] disabled:opacity-50"
			>
				<option value="">All / すべて</option>
				{#each dialectOptions as opt (opt.value)}
					<option value={opt.value}>{opt.value} ({opt.count})</option>
				{/each}
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="本文言語" en="Text language" />
			<select
				name="lang"
				value={filters.lang ?? ''}
				onchange={(e) => navigateWith('lang', e.currentTarget.value)}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]"
			>
				<option value="">All / すべて</option>
				{#each LANG_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="年代" en="Decade" />
			<select
				name="decade"
				value={filters.decade ?? ''}
				onchange={(e) => navigateWith('decade', e.currentTarget.value)}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]"
			>
				<option value="">All decades / すべて</option>
				{#each decadeOptions as opt (opt.decade)}
					<option value={opt.decade}>{opt.label} ({opt.count})</option>
				{/each}
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="並び順" en="Sort" />
			<select
				name="sort"
				value={filters.sort}
				onchange={(e) => navigateWith('sort', e.currentTarget.value)}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]"
			>
				<option value="significance">Significance / 重要度順</option>
				<option value="updated">Recently updated / 更新順</option>
				<option value="title">Title / タイトル順</option>
				<option value="year-desc">Newest / 新しい順</option>
				<option value="year-asc">Oldest / 古い順</option>
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			<BilingualLabel ja="本文の有無" en="Has text" />
			<select
				name="ocr"
				value={filters.ocr}
				onchange={(e) => navigateWith('ocr', e.currentTarget.value)}
				class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]"
			>
				<option value="any">Any / すべて</option>
				<option value="with">With text / あり</option>
				<option value="without">Without text / なし</option>
			</select>
		</label>
		<div class="flex items-center gap-2 sm:col-span-2 lg:col-span-3 lg:justify-end">
			<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.apply)} class="h-10 border border-[var(--archive-gilt-text)] bg-[var(--archive-gilt-text)] px-4 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt)] hover:border-[var(--archive-gilt)]">
				<BilingualLabel ja={archiveLabels.apply.ja} en={archiveLabels.apply.en} compact />
			</button>
			<a href={clearHref} aria-label={bilingualAriaLabel(archiveLabels.clear)} class="flex h-10 items-center border border-[var(--archive-border)] px-3 text-[13px] font-semibold text-[var(--archive-subtle)] hover:border-[var(--archive-gilt)] hover:text-[var(--archive-gilt-text)]">
				<BilingualLabel ja={archiveLabels.clear.ja} en={archiveLabels.clear.en} compact />
			</a>
		</div>
	</div>
</form>

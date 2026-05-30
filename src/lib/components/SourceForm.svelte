<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import {
		tl,
		CATEGORY_LABELS,
		CATEGORY_ORDER,
		TYPE_LABELS,
		TYPE_ORDER,
		REGION_LABELS,
		REGION_ORDER,
		LINK_TYPE_LABELS,
		YEAR_CERTAINTY_LABELS
	} from '$lib/constants';

	interface LinkRow {
		type: string;
		label: string;
		url: string;
	}
	export interface InitialSource {
		slug?: string;
		title?: string;
		titleEn?: string;
		titleAin?: string;
		category?: string;
		type?: string;
		author?: string;
		yearText?: string;
		yearStart?: number | null;
		yearEnd?: number | null;
		yearCertainty?: string;
		dialect?: string;
		region?: string;
		languages?: string;
		scripts?: string;
		holdingInstitution?: string;
		callNumber?: string;
		entryCount?: number | null;
		entryCountLabel?: string;
		license?: string;
		summary?: string;
		notes?: string;
		reliability?: string;
		links?: LinkRow[];
		tags?: string;
	}

	let {
		mode,
		initial = {},
		cancelHref,
		error = null
	}: { mode: 'create' | 'edit'; initial?: InitialSource; cancelHref: string; error?: string | null } =
		$props();

	let links = $state<LinkRow[]>(untrack(() => (initial.links?.length ? [...initial.links] : [])));
	const linksJson = $derived(JSON.stringify(links));

	function addLink() {
		links = [...links, { type: 'website', label: '', url: '' }];
	}
	function removeLink(i: number) {
		links = links.filter((_, idx) => idx !== i);
	}

	const LINK_TYPES = Object.keys(LINK_TYPE_LABELS);
	const inputCls =
		'mt-1 w-full rounded-md border-stone-300 bg-white text-sm shadow-sm focus:border-brand-600 focus:ring-brand-600';
	const labelCls = 'block text-sm font-medium text-stone-600';
</script>

<form method="POST" use:enhance class="space-y-8">
	<input type="hidden" name="linksJson" value={linksJson} />

	{#if error}
		<p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
	{/if}

	<!-- Titles -->
	<fieldset class="grid gap-4 sm:grid-cols-2">
		<label class="sm:col-span-2">
			<span class={labelCls}>{m.form_title()} <span class="text-red-500">*</span></span>
			<input name="title" required value={initial.title ?? ''} class={inputCls} />
		</label>
		<label>
			<span class={labelCls}>{m.form_title_en()}</span>
			<input name="titleEn" value={initial.titleEn ?? ''} class={inputCls} />
		</label>
		<label>
			<span class={labelCls}>{m.form_title_ain()}</span>
			<input name="titleAin" value={initial.titleAin ?? ''} lang="ain-Latn" class={inputCls} />
		</label>
	</fieldset>

	<!-- Classification -->
	<fieldset class="grid gap-4 sm:grid-cols-3">
		<label>
			<span class={labelCls}>{m.form_category()} <span class="text-red-500">*</span></span>
			<select name="category" class={inputCls} value={initial.category ?? 'primary'}>
				{#each CATEGORY_ORDER as c (c)}<option value={c}>{tl(CATEGORY_LABELS, c)}</option>{/each}
			</select>
		</label>
		<label>
			<span class={labelCls}>{m.form_type()} <span class="text-red-500">*</span></span>
			<select name="type" class={inputCls} value={initial.type ?? 'dictionary'}>
				{#each TYPE_ORDER as t (t)}<option value={t}>{tl(TYPE_LABELS, t)}</option>{/each}
			</select>
		</label>
		<label>
			<span class={labelCls}>{m.form_region()}</span>
			<select name="region" class={inputCls} value={initial.region ?? ''}>
				<option value="">{m.common_none()}</option>
				{#each REGION_ORDER as r (r)}<option value={r}>{tl(REGION_LABELS, r)}</option>{/each}
			</select>
		</label>
	</fieldset>

	<!-- Responsibility + date -->
	<fieldset class="grid gap-4 sm:grid-cols-2">
		<label class="sm:col-span-2">
			<span class={labelCls}>{m.form_author()}</span>
			<input name="author" value={initial.author ?? ''} class={inputCls} />
		</label>
		<label>
			<span class={labelCls}>{m.form_year_text()}</span>
			<input name="yearText" value={initial.yearText ?? ''} class={inputCls} placeholder="1875 / 1867–1872" />
		</label>
		<div class="grid grid-cols-3 gap-2">
			<label>
				<span class={labelCls}>{m.form_year_start()}</span>
				<input name="yearStart" type="number" value={initial.yearStart ?? ''} class={inputCls} />
			</label>
			<label>
				<span class={labelCls}>{m.form_year_end()}</span>
				<input name="yearEnd" type="number" value={initial.yearEnd ?? ''} class={inputCls} />
			</label>
			<label>
				<span class={labelCls}>{m.form_year_certainty()}</span>
				<select name="yearCertainty" class={inputCls} value={initial.yearCertainty ?? 'exact'}>
					{#each Object.keys(YEAR_CERTAINTY_LABELS) as k (k)}<option value={k}>{tl(YEAR_CERTAINTY_LABELS, k)}</option>{/each}
				</select>
			</label>
		</div>
	</fieldset>

	<!-- Linguistic + holdings -->
	<fieldset class="grid gap-4 sm:grid-cols-2">
		<label>
			<span class={labelCls}>{m.form_dialect()}</span>
			<input name="dialect" value={initial.dialect ?? ''} class={inputCls} />
		</label>
		<div class="grid grid-cols-2 gap-2">
			<label>
				<span class={labelCls}>{m.form_languages()}</span>
				<input name="languages" value={initial.languages ?? ''} class={inputCls} placeholder="ain, jpn" />
			</label>
			<label>
				<span class={labelCls}>{m.form_scripts()}</span>
				<input name="scripts" value={initial.scripts ?? ''} class={inputCls} placeholder="latn, kana" />
			</label>
		</div>
		<label>
			<span class={labelCls}>{m.form_holding()}</span>
			<input name="holdingInstitution" value={initial.holdingInstitution ?? ''} class={inputCls} />
		</label>
		<label>
			<span class={labelCls}>{m.form_call_number()}</span>
			<input name="callNumber" value={initial.callNumber ?? ''} class={inputCls} />
		</label>
		<div class="grid grid-cols-2 gap-2">
			<label>
				<span class={labelCls}>{m.form_entry_count()}</span>
				<input name="entryCount" type="number" value={initial.entryCount ?? ''} class={inputCls} />
			</label>
			<label>
				<span class={labelCls}>{m.form_entry_count_label()}</span>
				<input name="entryCountLabel" value={initial.entryCountLabel ?? ''} class={inputCls} placeholder="entries" />
			</label>
		</div>
		<label>
			<span class={labelCls}>{m.form_license()}</span>
			<input name="license" value={initial.license ?? ''} class={inputCls} />
		</label>
	</fieldset>

	<!-- Prose -->
	<fieldset class="space-y-4">
		<label class="block">
			<span class={labelCls}>{m.form_summary()}</span>
			<textarea name="summary" rows="2" class={inputCls}>{initial.summary ?? ''}</textarea>
		</label>
		<label class="block">
			<span class={labelCls}>{m.form_notes()}</span>
			<textarea name="notes" rows="4" class={inputCls}>{initial.notes ?? ''}</textarea>
		</label>
		<div class="grid gap-4 sm:grid-cols-2">
			<label>
				<span class={labelCls}>{m.form_reliability()}</span>
				<input name="reliability" value={initial.reliability ?? ''} class={inputCls} />
			</label>
			<label>
				<span class={labelCls}>{m.form_tags()}</span>
				<input name="tags" value={initial.tags ?? ''} class={inputCls} placeholder="placenames, grammar" />
			</label>
		</div>
	</fieldset>

	<!-- Links -->
	<fieldset class="space-y-2">
		<div class="flex items-center justify-between">
			<span class={labelCls}>{m.form_links()}</span>
			<button type="button" onclick={addLink} class="text-sm font-medium text-brand-700 hover:underline"
				>+ {m.form_add_link()}</button
			>
		</div>
		{#each links as link, i (i)}
			<div class="flex flex-wrap items-center gap-2 rounded-md bg-stone-50 p-2 ring-1 ring-stone-200">
				<select bind:value={link.type} class="rounded-md border-stone-300 text-sm">
					{#each LINK_TYPES as t (t)}<option value={t}>{tl(LINK_TYPE_LABELS, t)}</option>{/each}
				</select>
				<input bind:value={link.label} placeholder={m.form_link_label()} class="w-32 rounded-md border-stone-300 text-sm" />
				<input bind:value={link.url} placeholder={m.form_link_url()} class="min-w-0 flex-1 rounded-md border-stone-300 text-sm" />
				<button type="button" onclick={() => removeLink(i)} class="text-sm text-red-600 hover:underline"
					>{m.form_remove()}</button
				>
			</div>
		{/each}
	</fieldset>

	<!-- Revision summary + actions -->
	<fieldset class="border-t border-stone-200 pt-4">
		<label class="block">
			<span class={labelCls}>{m.form_revision_summary()}</span>
			<input name="revisionSummary" class={inputCls} />
		</label>
		<div class="mt-4 flex items-center gap-3">
			<button type="submit" class="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
				>{mode === 'create' ? m.form_save_create() : m.form_save_update()}</button
			>
			<a href={localizeHref(cancelHref)} class="text-sm text-stone-500 hover:underline">{m.common_cancel()}</a>
		</div>
	</fieldset>
</form>

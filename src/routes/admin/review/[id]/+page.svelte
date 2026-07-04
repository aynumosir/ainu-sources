<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizeHref, getLocale } from '$lib/paraglide/runtime';
	import Seo from '$lib/components/Seo.svelte';
	import { kindBadge, statusBadge, verdictBadge, fmtVal, opClass } from '$lib/review-ui';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let submitting = $state(false);

	const cr = $derived(data.detail.changeRequest);
	const diff = $derived(data.detail.diff);
	const obs = $derived(data.detail.observation);
	const reviews = $derived(data.detail.reviews);

	const k = $derived(kindBadge(cr.kind));
	const s = $derived(statusBadge(cr.status));
	const pct = (c: number | null | undefined) => (c == null ? '—' : `${Math.round(c * 100)}%`);

	function when(ms: number | null | undefined): string {
		if (ms == null) return '—';
		return new Date(ms).toLocaleString(getLocale(), {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Current provenance keyed by field, so each scalar row can show how the value
	// it would overwrite is currently sourced (is the proposal better-sourced?).
	const provByField = $derived(
		new Map(data.detail.currentProvenance.map((p) => [p.fieldName, p]))
	);

	const COLLECTION_NAMES = [
		'links',
		'tags',
		'persons',
		'places',
		'institutions',
		'relations'
	] as const;
	type CollName = (typeof COLLECTION_NAMES)[number];

	/** A single collection element → a short human label (mirrors /history). */
	function fmtMember(name: CollName, item: unknown): string {
		if (name === 'tags') return String(item);
		const o = (item ?? {}) as Record<string, unknown>;
		if (name === 'links') return `${o.type}: ${o.label ?? o.url}`;
		if (name === 'relations')
			return `${o.direction === 'in' ? '←' : '→'} ${o.type} ${o.toSlugOrId}`;
		const role = o.role ? ` (${o.role})` : '';
		const call = o.callNumber ? ` · ${o.callNumber}` : '';
		return `${o.slug}${role}${call}`;
	}

	interface CollView {
		name: string;
		added: string[];
		removed: string[];
		updated: string[];
	}
	const collections = $derived.by<CollView[]>(() => {
		if (!diff) return [];
		const out: CollView[] = [];
		for (const name of COLLECTION_NAMES) {
			const c = diff[name];
			if (!c) continue;
			if (!c.added.length && !c.removed.length && !c.updated.length) continue;
			out.push({
				name,
				added: c.added.map((x: unknown) => fmtMember(name, x)),
				removed: c.removed.map((x: unknown) => fmtMember(name, x)),
				updated: c.updated.map(
					(u: { before: unknown; after: unknown }) =>
						`${fmtMember(name, u.before)} → ${fmtMember(name, u.after)}`
				)
			});
		}
		return out;
	});

	const pretty = (v: unknown) => JSON.stringify(v ?? null, null, 2);

	// A CR only takes verdicts while it is still in the working set; once decided
	// (applied / rejected / superseded / withdrawn) the actions are read-only.
	const actionable = $derived(['open', 'needs_evidence', 'approved'].includes(cr.status));
</script>

<Seo title={`Review · ${cr.title || cr.kind}`} noindex />

<div class="mx-auto max-w-4xl px-4 py-8">
	<a href={localizeHref('/admin/review')} class="text-sm text-stone-500 hover:text-brand-700"
		>← Review queue</a
	>

	<!-- Action result banner -->
	{#if form?.ok}
		<div
			class="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
		>
			{form.message}
		</div>
	{:else if form?.error}
		<div class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
			{form.error}
		</div>
	{/if}

	<!-- Header -->
	<div class="mt-2 flex flex-wrap items-center gap-1.5">
		<span class={k.cls}>{k.label}</span>
		<span class={s.cls}>{s.label}</span>
		{#if diff?.isNewSource}
			<span class="inline-flex items-center rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800"
				>New source</span
			>
		{/if}
	</div>
	<h1 class="mt-2 font-serif text-2xl font-bold text-ink">{cr.title || '(untitled proposal)'}</h1>
	{#if cr.summary}<p class="mt-1 whitespace-pre-wrap text-sm text-stone-600">{cr.summary}</p>{/if}

	<dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-stone-500 sm:grid-cols-3">
		<div><dt class="inline text-stone-400">origin</dt> <dd class="inline">{cr.origin}</dd></div>
		<div>
			<dt class="inline text-stone-400">derivation</dt>
			<dd class="inline font-mono">{cr.derivation}</dd>
		</div>
		<div>
			<dt class="inline text-stone-400">confidence</dt>
			<dd class="inline tnum">{pct(cr.confidence)}</dd>
		</div>
		<div>
			<dt class="inline text-stone-400">evidence</dt>
			<dd class="inline tnum">{cr.evidence}</dd>
		</div>
		<div>
			<dt class="inline text-stone-400">routing</dt>
			<dd class="inline font-mono">{cr.routingReason}</dd>
		</div>
		<div>
			<dt class="inline text-stone-400">created</dt>
			<dd class="inline tnum">{when(cr.createdAt)}</dd>
		</div>
		{#if obs?.matchDecision}
			<div>
				<dt class="inline text-stone-400">match</dt>
				<dd class="inline font-mono">{obs.matchDecision}</dd>
			</div>
		{/if}
		{#if cr.proposedByActor}
			<div>
				<dt class="inline text-stone-400">proposed by</dt>
				<dd class="inline">{cr.proposedByActor}</dd>
			</div>
		{/if}
		{#if cr.sourceId}
			<div class="col-span-2 sm:col-span-3">
				<dt class="inline text-stone-400">target source</dt>
				<dd class="inline font-mono text-[11px]">{cr.sourceId}</dd>
			</div>
		{/if}
	</dl>

	<!-- Before → after: scalar fields -->
	<section class="mt-8">
		<h2 class="font-serif text-lg font-bold text-ink">Proposed changes</h2>
		{#if diff && diff.scalars.length}
			<div class="mt-3 overflow-hidden rounded-lg border border-stone-200">
				<table class="w-full border-collapse text-sm">
					<thead>
						<tr class="bg-stone-100/70 text-left text-xs text-stone-500">
							<th class="px-2 py-1.5 font-medium">Field</th>
							<th class="px-2 py-1.5 font-medium">Before</th>
							<th class="px-2 py-1.5 font-medium">After</th>
							<th class="px-2 py-1.5 font-medium">Current provenance</th>
							<th class="px-2 py-1.5 font-medium">Reason</th>
						</tr>
					</thead>
					<tbody>
						{#each diff.scalars as f (f.field)}
							{@const p = provByField.get(f.field)}
							<tr class="border-t border-stone-100 align-top">
								<td class="px-2 py-1.5 font-mono text-xs text-stone-600">{f.field}</td>
								<td class="px-2 py-1.5">
									{#if f.before === null || f.before === '' || (Array.isArray(f.before) && !f.before.length)}
										<span class="text-xs text-stone-400">∅</span>
									{:else}
										<span class="text-rose-700 line-through decoration-rose-300"
											>{fmtVal(f.before)}</span
										>
									{/if}
								</td>
								<td class="px-2 py-1.5">
									<span class={opClass(f.op)}>{fmtVal(f.after)}</span>
								</td>
								<td class="px-2 py-1.5 text-xs text-stone-500">
									{#if p}
										<span class="font-mono">{p.derivation ?? '—'}</span>
										{#if p.rankBand != null}<span class="text-stone-400"> · b{p.rankBand}</span>{/if}
										{#if p.confidence != null}<span class="tnum text-stone-400"> · {pct(p.confidence)}</span
											>{/if}
									{:else}
										<span class="text-stone-400">—</span>
									{/if}
								</td>
								<td class="px-2 py-1.5 text-xs text-stone-500">{f.reason ?? f.decision ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if collections.length}
			<div class="mt-3 space-y-3">
				{#each collections as c (c.name)}
					<div class="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
						<span class="font-mono text-xs text-stone-500">{c.name}</span>
						<ul class="mt-1 space-y-0.5 text-sm">
							{#each c.added as item, i (i)}
								<li class="text-emerald-700"><span class="font-mono">+</span> {item}</li>
							{/each}
							{#each c.removed as item, i (i)}
								<li class="text-rose-700"><span class="font-mono">−</span> {item}</li>
							{/each}
							{#each c.updated as item, i (i)}
								<li class="text-amber-700"><span class="font-mono">~</span> {item}</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		{/if}

		{#if diff && !diff.scalars.length && !collections.length}
			<p class="mt-3 text-sm text-stone-400">No content fields changed (metadata only).</p>
		{/if}
	</section>

	<!-- Conflicts / held / rejected — always shown, never hidden (no-loss) -->
	{#if diff && (diff.conflicts.length || diff.heldClaims.length || diff.rejectedClaims.length || diff.warnings.length)}
		<section class="mt-8">
			<h2 class="font-serif text-lg font-bold text-ink">Held for review</h2>
			<p class="mt-1 text-sm text-stone-500">
				What the engine refused to apply automatically — surfaced, never silently dropped.
			</p>
			<div class="mt-3 space-y-3">
				{#if diff.conflicts.length}
					<div class="rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm">
						<div class="text-xs font-semibold text-rose-800">Conflicts</div>
						<ul class="mt-1 space-y-0.5">
							{#each diff.conflicts as c, i (i)}
								<li class="text-rose-700">
									<span class="font-mono text-xs">{c.kind}</span>
									{#if c.fieldName}<span class="font-mono text-xs text-rose-500"> · {c.fieldName}</span
										>{/if}
									— {c.detail}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if diff.heldClaims.length}
					<div class="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
						<div class="text-xs font-semibold text-amber-800">Held below current value</div>
						<ul class="mt-1 space-y-0.5">
							{#each diff.heldClaims as c, i (i)}
								<li class="text-amber-700">
									<span class="font-mono text-xs">{c.fieldName}</span>
									{#if c.reason}<span class="text-amber-600"> — {c.reason}</span>{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if diff.rejectedClaims.length}
					<div class="rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-sm">
						<div class="text-xs font-semibold text-stone-700">Rejected claims</div>
						<ul class="mt-1 space-y-0.5">
							{#each diff.rejectedClaims as c, i (i)}
								<li class="text-stone-600">
									<span class="font-mono text-xs">{c.fieldName}</span>
									{#if c.reason}<span class="text-stone-500"> — {c.reason}</span>{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if diff.warnings.length}
					<ul class="space-y-0.5 text-xs text-stone-500">
						{#each diff.warnings as w, i (i)}<li>⚠ {w}</li>{/each}
					</ul>
				{/if}
			</div>
		</section>
	{/if}

	<!-- Prior reviews — append-only -->
	{#if reviews.length}
		<section class="mt-8">
			<h2 class="font-serif text-lg font-bold text-ink">Reviews</h2>
			<ol class="mt-3 space-y-2">
				{#each reviews as r (r.id)}
					{@const v = verdictBadge(r.verdict)}
					<li class="rounded-lg border border-stone-200 bg-paper-card p-3 text-sm">
						<div class="flex flex-wrap items-center gap-1.5">
							<span class={v.cls}>{v.label}</span>
							<span class="text-xs text-stone-500">{r.reviewerKind}</span>
							{#if r.reviewerActor}<span class="text-xs text-stone-400">· {r.reviewerActor}</span>{/if}
							{#if r.confidence != null}<span class="tnum text-xs text-stone-400"
									>· {pct(r.confidence)}</span
								>{/if}
							<span class="ml-auto tnum text-xs text-stone-400">{when(r.createdAt)}</span>
						</div>
						{#if r.reason}<p class="mt-1 text-stone-600">{r.reason}</p>{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	<!-- Evidence / raw payload + current provenance — collapsible -->
	<section class="mt-8 space-y-2">
		{#if obs}
			<details class="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
				<summary class="cursor-pointer text-sm font-medium text-ink">
					Observation payload &amp; evidence
					<span class="ml-1 font-mono text-xs text-stone-400">{obs.contentHash.slice(0, 12)}…</span>
				</summary>
				<div class="mt-2 text-xs text-stone-500">Normalized payload</div>
				<pre class="mt-1 max-h-80 overflow-auto rounded bg-stone-100/70 p-2 text-xs text-stone-700">{pretty(
						obs.payload
					)}</pre>
				{#if obs.rawPayload}
					<div class="mt-2 text-xs text-stone-500">Raw evidence</div>
					<pre class="mt-1 max-h-80 overflow-auto rounded bg-stone-100/70 p-2 text-xs text-stone-700">{pretty(
							obs.rawPayload
						)}</pre>
				{/if}
			</details>
		{/if}

		{#if data.detail.currentProvenance.length}
			<details class="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
				<summary class="cursor-pointer text-sm font-medium text-ink">
					Current field provenance
					<span class="ml-1 text-xs text-stone-400"
						>({data.detail.currentProvenance.length} fields)</span
					>
				</summary>
				<div class="mt-2 overflow-hidden rounded border border-stone-200">
					<table class="w-full border-collapse text-xs">
						<tbody>
							{#each data.detail.currentProvenance as p (p.fieldName)}
								<tr class="border-b border-stone-100 align-top last:border-0">
									<td class="bg-stone-100/60 px-2 py-1 font-mono text-stone-600">{p.fieldName}</td>
									<td class="px-2 py-1 text-stone-700">{fmtVal(p.currentValue)}</td>
									<td class="px-2 py-1 text-stone-500">
										<span class="font-mono">{p.derivation ?? '—'}</span>
										{#if p.rankBand != null}<span class="text-stone-400"> · b{p.rankBand}</span>{/if}
										{#if p.confidence != null}<span class="tnum text-stone-400"> · {pct(p.confidence)}</span
											>{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>
		{/if}
	</section>

	<!-- Decision -->
	<section class="mt-8 rounded-xl border border-stone-200 bg-paper-card p-4">
		<h2 class="font-serif text-lg font-bold text-ink">Decision</h2>
		{#if actionable}
			<p class="mt-1 text-sm text-stone-500">
				Approving marks this proposal for publishing by the batch apply (claims still rank by their
				own provenance — a verdict gates application, it never changes a claim's band).
			</p>
			<form
				method="POST"
				class="mt-3"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				<textarea
					name="reason"
					rows="2"
					placeholder="Reason (optional) — recorded on the append-only review log."
					class="w-full rounded-lg border border-stone-300 bg-paper px-3 py-2 text-sm text-ink placeholder:text-stone-400 focus:border-brand-400 focus:outline-none"
				></textarea>
				<div class="mt-3 flex flex-wrap gap-2">
					<button
						formaction="?/approve"
						disabled={submitting}
						class="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-50"
						>Approve</button
					>
					<button
						formaction="?/requestEvidence"
						disabled={submitting}
						class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
						>Request evidence</button
					>
					<button
						formaction="?/reject"
						disabled={submitting}
						class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-800 transition hover:bg-rose-100 disabled:opacity-50"
						>Reject</button
					>
				</div>
			</form>
		{:else}
			<p class="mt-1 text-sm text-stone-500">
				This change request is <span class="font-medium text-ink">{cr.status}</span> and no longer
				accepts verdicts.
				{#if cr.decidedByActor}<span class="text-stone-400"
						>Decided by {cr.decidedByActor}{#if cr.decidedAt}
							· {when(cr.decidedAt)}{/if}.</span
					>{/if}
			</p>
		{/if}
	</section>
</div>

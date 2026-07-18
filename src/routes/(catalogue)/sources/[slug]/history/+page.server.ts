import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSourceBySlug, getSourceHistory } from '$lib/server/queries';
import type { SourceDiff, ScalarFieldDiff } from '$lib/server/merge/diff';

/** Render-ready scalar change. */
interface ScalarChange {
	field: string;
	before: string | null;
	after: string | null;
	op: 'add' | 'update' | 'clear';
}
/** Render-ready collection change. */
interface CollectionChange {
	name: string;
	added: string[];
	removed: string[];
	updated: string[];
}
interface DiffView {
	id: string;
	kind: string;
	isNewSource: boolean;
	hasConflicts: boolean;
	createdAt: number;
	scalars: ScalarChange[];
	collections: CollectionChange[];
	summaryLines: string[];
}

const COLLECTION_NAMES = ['links', 'tags', 'persons', 'places', 'institutions', 'relations'] as const;
type CollName = (typeof COLLECTION_NAMES)[number];

function fmtVal(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	if (Array.isArray(v)) return v.join(', ');
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

/** A single collection element → a short human label. */
function fmtMember(name: CollName, item: unknown): string {
	if (name === 'tags') return String(item);
	const o = item as Record<string, unknown>;
	if (name === 'links') return `${o.type}: ${o.label ?? o.url}`;
	if (name === 'relations') return `${o.direction === 'in' ? '←' : '→'} ${o.type} ${o.toSlugOrId}`;
	// persons / places / institutions
	const role = o.role ? ` (${o.role})` : '';
	const call = o.callNumber ? ` · ${o.callNumber}` : '';
	return `${o.slug}${role}${call}`;
}

function shapeDiff(row: {
	id: string;
	diffKind: string;
	isNewSource: boolean;
	hasConflicts: boolean;
	createdAt: Date | number;
	diff: SourceDiff;
}): DiffView {
	const diff = row.diff;
	const scalars: ScalarChange[] = (diff.scalars ?? []).map((s: ScalarFieldDiff) => ({
		field: s.field,
		before: fmtVal(s.before),
		after: fmtVal(s.after),
		op: s.op
	}));
	const collections: CollectionChange[] = [];
	for (const name of COLLECTION_NAMES) {
		const c = diff[name];
		if (!c) continue;
		if (!c.added.length && !c.removed.length && !c.updated.length) continue;
		collections.push({
			name,
			added: c.added.map((x: unknown) => fmtMember(name, x)),
			removed: c.removed.map((x: unknown) => fmtMember(name, x)),
			updated: c.updated.map(
				(u: { before: unknown; after: unknown }) =>
					`${fmtMember(name, u.before)} → ${fmtMember(name, u.after)}`
			)
		});
	}
	const when = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt);
	return {
		id: row.id,
		kind: row.diffKind,
		isNewSource: row.isNewSource,
		hasConflicts: row.hasConflicts,
		createdAt: when,
		scalars,
		collections,
		summaryLines: diff.summaryLines ?? []
	};
}

export const load: PageServerLoad = async ({ params }) => {
	const source = await getSourceBySlug(params.slug);
	if (!source) error(404, 'Source not found');
	const { revisions, diffs } = await getSourceHistory(source.id);

	const diffViews = diffs.map(shapeDiff);

	// Associate each diff with the nearest revision by time (a website edit writes
	// both within the same instant) so an edit reads as ONE timeline node carrying
	// its field changes. Unmatched diffs fall back to standalone entries; older
	// revisions (recorded before diffs existed) render plain. ±4s window, each diff
	// used once.
	const WINDOW = 4000;
	const revs = revisions.map((r) => ({
		id: r.id,
		action: r.action,
		userName: r.userName,
		summary: r.summary,
		createdAt: (r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt)) as number,
		diff: null as DiffView | null
	}));
	const usedDiff = new Set<string>();
	for (const rev of revs) {
		let best: DiffView | null = null;
		let bestDelta = WINDOW + 1;
		for (const d of diffViews) {
			if (usedDiff.has(d.id)) continue;
			const delta = Math.abs(d.createdAt - rev.createdAt);
			if (delta <= WINDOW && delta < bestDelta) {
				best = d;
				bestDelta = delta;
			}
		}
		if (best) {
			rev.diff = best;
			usedDiff.add(best.id);
		}
	}

	type Event =
		| { kind: 'revision'; id: string; createdAt: number; action: string; userName: string | null; summary: string | null; diff: DiffView | null }
		| { kind: 'diff'; id: string; createdAt: number; diff: DiffView };

	const events: Event[] = [
		...revs.map(
			(r): Event => ({
				kind: 'revision',
				id: r.id,
				createdAt: r.createdAt,
				action: r.action,
				userName: r.userName,
				summary: r.summary,
				diff: r.diff
			})
		),
		...diffViews
			.filter((d) => !usedDiff.has(d.id))
			.map((d): Event => ({ kind: 'diff', id: d.id, createdAt: d.createdAt, diff: d }))
	].sort((a, b) => b.createdAt - a.createdAt);

	return {
		source: { slug: source.slug, title: source.title },
		events
	};
};

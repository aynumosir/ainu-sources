/**
 * Presentation helpers shared by the `/admin/review` queue and detail pages.
 * Client-safe (no server imports): just label + Tailwind-class maps so the two
 * pages render kinds / statuses / verdicts identically. Colours stay within the
 * default emerald / amber / rose / sky / violet palette the history page already
 * uses on the parchment ground — no new design language.
 */

const BADGE = 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium';

export interface Badge {
	label: string;
	cls: string;
}

/** ChangeKind → a labelled badge. */
export function kindBadge(kind: string): Badge {
	switch (kind) {
		case 'new_source':
			return { label: 'New source', cls: `${BADGE} bg-emerald-100 text-emerald-800` };
		case 'enrichment':
			return { label: 'Enrichment', cls: `${BADGE} bg-sky-100 text-sky-800` };
		case 'identity_conflict':
			return { label: 'Identity conflict', cls: `${BADGE} bg-rose-100 text-rose-800` };
		case 'lifecycle':
			return { label: 'Lifecycle', cls: `${BADGE} bg-violet-100 text-violet-800` };
		case 'field_update':
			return { label: 'Field update', cls: `${BADGE} bg-amber-100 text-amber-800` };
		case 'drift':
			return { label: 'Drift', cls: `${BADGE} bg-stone-200 text-stone-700` };
		default:
			return { label: kind, cls: `${BADGE} bg-stone-200 text-stone-700` };
	}
}

/** CR workflow status → a labelled badge. */
export function statusBadge(status: string): Badge {
	switch (status) {
		case 'open':
			return { label: 'Open', cls: `${BADGE} bg-brand-100 text-brand-800` };
		case 'needs_evidence':
			return { label: 'Needs evidence', cls: `${BADGE} bg-amber-100 text-amber-800` };
		case 'approved':
			return { label: 'Approved', cls: `${BADGE} bg-emerald-100 text-emerald-800` };
		case 'applying':
			return { label: 'Applying…', cls: `${BADGE} bg-sky-100 text-sky-800` };
		case 'applied':
			return { label: 'Applied', cls: `${BADGE} bg-emerald-100 text-emerald-800` };
		case 'rejected':
			return { label: 'Rejected', cls: `${BADGE} bg-rose-100 text-rose-800` };
		case 'superseded':
			return { label: 'Superseded', cls: `${BADGE} bg-stone-200 text-stone-700` };
		case 'withdrawn':
			return { label: 'Withdrawn', cls: `${BADGE} bg-stone-200 text-stone-700` };
		default:
			return { label: status, cls: `${BADGE} bg-stone-200 text-stone-700` };
	}
}

/** Reviewer verdict → a labelled badge (append-only review log). */
export function verdictBadge(verdict: string): Badge {
	switch (verdict) {
		case 'apply':
			return { label: 'Apply', cls: `${BADGE} bg-emerald-100 text-emerald-800` };
		case 'reject':
			return { label: 'Reject', cls: `${BADGE} bg-rose-100 text-rose-800` };
		case 'needs_evidence':
			return { label: 'Needs evidence', cls: `${BADGE} bg-amber-100 text-amber-800` };
		default:
			return { label: verdict, cls: `${BADGE} bg-stone-200 text-stone-700` };
	}
}

/** Render any scalar / collection value as a compact human string. `∅` for empty. */
export function fmtVal(v: unknown): string {
	if (v === null || v === undefined || v === '') return '∅';
	if (Array.isArray(v)) return v.length ? v.join(', ') : '∅';
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

const opColor: Record<string, string> = {
	add: 'text-emerald-700',
	update: 'text-amber-700',
	clear: 'text-rose-700'
};
/** Colour for a scalar diff op (add / update / clear). */
export const opClass = (op: string): string => opColor[op] ?? 'text-stone-700';

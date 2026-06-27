/**
 * Normalization at the ingest boundary — identifiers, text, arrays, enums.
 *
 * Identifier normalization is deliberately kept IDENTICAL to the Phase-3
 * bootstrap (scripts/bootstrap-ledger.ts `normId`) for the kinds the bootstrap
 * emitted (doi lowercased + resolver-stripped, openalex_work uppercased,
 * everything else lowercased) so the engine can find-or-create against the
 * identifiers the bootstrap already wrote. Additional kinds (isbn/issn/
 * url_persistent) get their own canonical form + validity check.
 */
import { policyFor } from './field-policies';
import { STRONG_ID_KINDS } from './constants';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export interface NormalizedIdentifier {
	kind: string;
	valueRaw: string;
	valueNorm: string;
	strength: 'strong' | 'medium' | 'weak';
	valid: boolean;
	/** normalized canonical value this id redirects to (same kind), if any */
	redirectsToNorm?: string;
}

const DEFAULT_STRENGTH: Record<string, 'strong' | 'medium' | 'weak'> = {
	doi: 'strong',
	openalex_work: 'strong',
	isbn: 'strong',
	issn: 'strong',
	cinii: 'strong',
	ndl: 'strong',
	jstage: 'strong',
	repo_path: 'medium',
	url_persistent: 'medium',
	synthetic_stable: 'medium'
};

function defaultStrength(kind: string): 'strong' | 'medium' | 'weak' {
	return DEFAULT_STRENGTH[kind] ?? (STRONG_ID_KINDS.has(kind) ? 'strong' : 'weak');
}

/** Canonicalize a URL: lowercase scheme+host, drop default port, drop fragment,
 *  strip a trailing slash. Returns null if it does not parse as http(s). */
export function canonicalizeUrl(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	u.protocol = u.protocol.toLowerCase();
	let out = u.toString();
	if (out.endsWith('/') && u.pathname === '/') out = out.slice(0, -1);
	else if (out.endsWith('/')) out = out.slice(0, -1);
	return out;
}

function isbnChecksum(d: string): boolean {
	if (d.length === 10) {
		let sum = 0;
		for (let i = 0; i < 10; i++) {
			const c = d[i];
			const v = i === 9 && (c === 'X' || c === 'x') ? 10 : Number(c);
			if (Number.isNaN(v)) return false;
			sum += v * (10 - i);
		}
		return sum % 11 === 0;
	}
	if (d.length === 13) {
		let sum = 0;
		for (let i = 0; i < 13; i++) {
			const v = Number(d[i]);
			if (Number.isNaN(v)) return false;
			sum += v * (i % 2 === 0 ? 1 : 3);
		}
		return sum % 10 === 0;
	}
	return false;
}

function issnChecksum(d: string): boolean {
	if (d.length !== 8) return false;
	let sum = 0;
	for (let i = 0; i < 8; i++) {
		const c = d[i];
		const v = i === 7 && (c === 'X' || c === 'x') ? 10 : Number(c);
		if (Number.isNaN(v)) return false;
		sum += v * (8 - i);
	}
	return sum % 11 === 0;
}

/**
 * Normalize one identifier. Returns `{ valid:false }` (with a best-effort norm)
 * when the value is malformed for its kind — the audit gate rejects the whole
 * observation rather than silently dropping a bad strong id.
 */
export function normalizeIdentifier(input: {
	kind: string;
	value: string;
	strength?: 'strong' | 'medium' | 'weak';
	redirectsTo?: string;
}): NormalizedIdentifier {
	const kind = input.kind.trim();
	const raw = (input.value ?? '').trim();
	const strength = input.strength ?? defaultStrength(kind);
	const base = { kind, valueRaw: raw, strength };

	const normOne = (k: string, v: string): { norm: string; valid: boolean } => {
		const t = v.trim();
		switch (k) {
			case 'doi': {
				const s = t
					.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
					.replace(/^doi:\s*/i, '')
					.toLowerCase();
				return { norm: s, valid: /^10\.\d{4,9}\/\S+$/.test(s) };
			}
			case 'openalex_work': {
				const s = t.replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase();
				return { norm: s, valid: /^W\d+$/.test(s) };
			}
			case 'isbn': {
				const s = t.replace(/[\s-]/g, '').toUpperCase();
				return { norm: s, valid: isbnChecksum(s) };
			}
			case 'issn': {
				const s = t.replace(/[\s-]/g, '').toUpperCase();
				const valid = issnChecksum(s);
				return { norm: valid ? `${s.slice(0, 4)}-${s.slice(4)}` : s, valid };
			}
			case 'url_persistent': {
				const c = canonicalizeUrl(t);
				return { norm: c ?? t.toLowerCase(), valid: c !== null };
			}
			case 'synthetic_stable':
				return { norm: t, valid: t.length > 0 };
			default:
				// cinii | ndl | jstage | repo_path | unknown — match bootstrap (lowercase)
				return { norm: t.toLowerCase(), valid: t.length > 0 };
		}
	};

	const { norm, valid } = normOne(kind, raw);
	const out: NormalizedIdentifier = { ...base, valueNorm: norm, valid };
	if (input.redirectsTo) {
		const r = normOne(kind, input.redirectsTo);
		if (r.valid) out.redirectsToNorm = r.norm;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Text / arrays / enums
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
	'&#39;': "'",
	'&nbsp;': ' '
};

export function decodeEntities(s: string): string {
	let out = s;
	for (const [k, v] of Object.entries(NAMED_ENTITIES)) out = out.split(k).join(v);
	out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
	out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
	return out;
}

/** Trim, decode entities, NFC-normalize, collapse internal whitespace.
 *  Returns null for empty/whitespace-only input. Newlines are preserved as
 *  single `\n` for prose fields are handled by the caller; here all whitespace
 *  collapses to single spaces (titles/authors/scalars). */
export function normalizeText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	let t = decodeEntities(String(value)).normalize('NFC');
	t = t.replace(/\s+/g, ' ').trim();
	return t === '' ? null : t;
}

/** Prose normalization: like normalizeText but keeps paragraph structure
 *  (collapses runs of spaces/tabs, trims, but preserves single newlines). */
export function normalizeProse(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	let t = decodeEntities(String(value)).normalize('NFC');
	t = t.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
	return t === '' ? null : t;
}

export function normalizeInt(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = typeof value === 'bigint' ? Number(value) : Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function normalizeBool(value: unknown): boolean | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'boolean') return value;
	return value === 1 || value === '1' || value === 'true';
}

/** Trim/dedupe/sort a string array; returns null when nothing survives. */
export function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const seen = new Set<string>();
	for (const x of value) {
		const t = normalizeText(x);
		if (t) seen.add(t);
	}
	const out = [...seen].sort();
	return out.length ? out : null;
}

/** Lowercased, punctuation-stripped form of a title/author for fuzzy identity
 *  matching (NOT stored — used only to bound the candidate search). */
export function coreText(value: unknown): string {
	const t = normalizeText(value);
	if (!t) return '';
	return t
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Normalize one field's value according to its policy value-type. */
export function normalizeFieldValue(field: string, value: unknown): unknown {
	const p = policyFor(field);
	const vt = p?.valueType ?? 'text';
	switch (vt) {
		case 'set':
			return normalizeStringArray(value);
		case 'int':
			return normalizeInt(value);
		case 'bool':
			return normalizeBool(value);
		case 'enum':
			return normalizeText(value);
		default:
			return field === 'notes' || field === 'summary'
				? normalizeProse(value)
				: normalizeText(value);
	}
}

/** Normalize an incoming field map. Drops keys that are not claimable fields
 *  (system/identity columns can never be asserted via a payload). Empty values
 *  are kept as `null` so the empty-overwrite audit can see them. */
export function normalizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!fields) return out;
	for (const [k, v] of Object.entries(fields)) {
		const p = policyFor(k);
		if (!p || !p.claimable) continue; // ignore unknown / system / identity cols
		out[k] = normalizeFieldValue(k, v);
	}
	return out;
}

/** True when a normalized field value is "empty" (absent / blank / empty set). */
export function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

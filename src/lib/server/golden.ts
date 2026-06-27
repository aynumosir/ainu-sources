/**
 * Golden projection — a PURE, DB-agnostic canonical view of one source.
 *
 * Purpose: the no-loss gate for the upcoming DB migration. We capture each
 * source's full durable projection NOW (deterministic bytes + a sha256), so
 * after the migration we can re-dump and assert byte-for-byte equality. If a
 * migration silently drops, reorders, or mangles any captured field, the hash
 * changes and the gate fails.
 *
 * This module never touches the database. `projectSource` takes ALREADY-FETCHED
 * rows (the caller does all I/O) and returns a plain object whose bytes are
 * stable regardless of:
 *   - object key order        → `canonicalStringify` re-sorts every object key
 *   - child-array row order   → links/tags/assoc/relations are sorted here
 *   - the fetch layer          → values are normalised so a drizzle row
 *                                (Date, parsed JSON, boolean) and a raw libSQL
 *                                row (epoch-ms integer, JSON string, 0/1) that
 *                                represent the SAME data project identically.
 *
 * ── Field coverage (what is captured) ──────────────────────────────────────
 *   sources : EVERY scalar column (see SOURCE_SCALAR_COLUMNS) — including the
 *             audit columns (id, createdAt, updatedAt, createdBy, updatedBy).
 *             For a no-loss gate every persisted column is part of the durable
 *             projection and must survive the migration byte-equal, so NONE of
 *             the `sources` scalar columns are excluded.
 *   links   : { type, label, url, sortOrder }      (per spec)
 *   tags    : tag name strings
 *   persons : { slug, role, sortOrder }
 *   places  : { slug, role, notes }
 *   instit. : { slug, role, callNumber, notes }
 *   relations: { type, toSlugOrId, direction }
 *
 * ── Deliberately EXCLUDED (volatile / system / redundant) ──────────────────
 *   • Surrogate join-row UUIDs — sourceLinks.id, sourcePersons.id, etc. These
 *     are random per-row identifiers, regenerated on any reseed, never
 *     user-facing, and carry no durable meaning. Including them would make the
 *     hash depend on RNG, defeating the gate.
 *   • The redundant child `sourceId` foreign key — it is always THIS source.
 *   • link.notes — the link projection is fixed by spec to {type,label,url,
 *     sortOrder}; link notes are not part of this baseline. (Association notes
 *     on places/institutions ARE captured — those join rows model curatorial
 *     metadata the detail page surfaces.)
 *   • Related entities' own scalar columns (a person's name/bio, a place's
 *     lat/lng, …). Persons/places/institutions/tags are SEPARATE top-level
 *     entities; this is the per-SOURCE projection, so it references them by
 *     their stable human-readable `slug` (or tag name) only. Their own
 *     no-loss coverage would be a sibling projection, out of scope here.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Column contract
// ---------------------------------------------------------------------------

/** Every scalar column of `sources`, in a fixed, explicit order. The canonical
 *  serialiser re-sorts keys anyway, but emitting a stable order keeps the
 *  in-memory projection readable and makes the captured set auditable here. */
export const SOURCE_SCALAR_COLUMNS = [
	'id',
	'slug',
	'title',
	'titleEn',
	'titleAin',
	'altTitles',
	'category',
	'type',
	'author',
	'yearText',
	'yearStart',
	'yearEnd',
	'yearCertainty',
	'dialect',
	'region',
	'languages',
	'scripts',
	'holdingInstitution',
	'callNumber',
	'entryCount',
	'entryCountLabel',
	'license',
	'summary',
	'notes',
	'reliability',
	'provenanceRepo',
	'provenancePath',
	'externalIds',
	'featured',
	'createdAt',
	'updatedAt',
	'createdBy',
	'updatedBy'
] as const;

/** Columns stored as JSON text in SQLite (drizzle parses them; raw libSQL does not). */
const JSON_COLUMNS = new Set(['altTitles', 'languages', 'scripts', 'externalIds']);
/** Columns stored as `timestamp_ms` integers (drizzle hydrates them to Date). */
const TIMESTAMP_COLUMNS = new Set(['createdAt', 'updatedAt']);
/** Columns stored as 0/1 integers and exposed as booleans. */
const BOOLEAN_COLUMNS = new Set(['featured']);

// ---------------------------------------------------------------------------
// Input contract (all rows are supplied by the caller — NO DB access here)
// ---------------------------------------------------------------------------

export type SourceRow = Record<string, unknown>;

export interface LinkRow {
	type?: unknown;
	label?: unknown;
	url?: unknown;
	sortOrder?: unknown;
	[k: string]: unknown;
}

/** A resolved entity association: the entity's stable `slug` plus join columns. */
export interface AssocRow {
	slug?: unknown;
	role?: unknown;
	sortOrder?: unknown;
	callNumber?: unknown;
	notes?: unknown;
	[k: string]: unknown;
}

export interface RelationRow {
	type?: unknown;
	/** The OTHER source's stable slug (falls back to its id if slug is absent). */
	toSlugOrId?: unknown;
	direction?: unknown;
	[k: string]: unknown;
}

export interface ProjectSourceInput {
	source: SourceRow;
	links?: LinkRow[];
	/** Either tag-name strings, or rows carrying a `name`. */
	tags?: Array<string | { name?: unknown }>;
	persons?: AssocRow[];
	places?: AssocRow[];
	institutions?: AssocRow[];
	relations?: RelationRow[];
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface SourceProjection {
	[column: string]: unknown;
	links: Array<{ type: string; label: string | null; url: string; sortOrder: number }>;
	tags: string[];
	persons: Array<{ slug: string; role: string | null; sortOrder: number | null }>;
	places: Array<{ slug: string; role: string | null; notes: string | null }>;
	institutions: Array<{
		slug: string;
		role: string | null;
		callNumber: string | null;
		notes: string | null;
	}>;
	relations: Array<{ type: string; toSlugOrId: string; direction: string }>;
}

// ---------------------------------------------------------------------------
// Value normalisation — make drizzle rows and raw libSQL rows project alike
// ---------------------------------------------------------------------------

function asStringOrNull(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	return String(v);
}

function asNumberOrNull(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'bigint' ? Number(v) : Number(v);
	return Number.isNaN(n) ? null : n;
}

/** Normalise a single `sources` scalar so equivalent representations collapse. */
function normaliseScalar(column: string, value: unknown): unknown {
	if (value === undefined) return null;

	if (TIMESTAMP_COLUMNS.has(column)) {
		if (value === null) return null;
		if (value instanceof Date) return value.getTime();
		if (typeof value === 'bigint') return Number(value);
		if (typeof value === 'number') return value;
		// raw string from a SQL text export, e.g. "1700000000000"
		const n = Number(value);
		return Number.isNaN(n) ? value : n;
	}

	if (BOOLEAN_COLUMNS.has(column)) {
		if (value === null) return false;
		if (typeof value === 'boolean') return value;
		// 0/1 from raw libSQL, "0"/"1" from a SQL export
		return value === 1 || value === '1' || value === true;
	}

	if (JSON_COLUMNS.has(column)) {
		if (value === null) return null;
		if (typeof value === 'string') {
			const t = value.trim();
			if (t === '') return null;
			try {
				return JSON.parse(t);
			} catch {
				return value; // leave malformed JSON verbatim rather than crash the dump
			}
		}
		return value; // already a parsed array/object (drizzle)
	}

	return value; // plain text / integer column — keep as-is
}

// ---------------------------------------------------------------------------
// Deterministic comparators
// ---------------------------------------------------------------------------

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// projectSource — the canonical per-source object
// ---------------------------------------------------------------------------

export function projectSource(input: ProjectSourceInput): SourceProjection {
	const src = input.source ?? {};

	// --- scalar columns, in the fixed column order ---
	const out: Record<string, unknown> = {};
	for (const col of SOURCE_SCALAR_COLUMNS) {
		out[col] = normaliseScalar(col, src[col]);
	}

	// --- links: {type,label,url,sortOrder} sorted by (type, url) ---
	const links = (input.links ?? []).map((l) => ({
		type: String(l.type ?? 'website'),
		label: asStringOrNull(l.label),
		url: String(l.url ?? ''),
		sortOrder: asNumberOrNull(l.sortOrder) ?? 0
	}));
	links.sort((a, b) => cmp(a.type, b.type) || cmp(a.url, b.url) || a.sortOrder - b.sortOrder);

	// --- tags: names, sorted ---
	const tags = (input.tags ?? [])
		.map((t) => (typeof t === 'string' ? t : String((t as { name?: unknown }).name ?? '')))
		.filter((n) => n !== '');
	tags.sort(cmp);

	// --- person associations: {slug,role,sortOrder} sorted by (slug,role,sortOrder) ---
	const persons = (input.persons ?? []).map((p) => ({
		slug: String(p.slug ?? ''),
		role: asStringOrNull(p.role),
		sortOrder: asNumberOrNull(p.sortOrder)
	}));
	persons.sort(
		(a, b) =>
			cmp(a.slug, b.slug) ||
			cmp(a.role ?? '', b.role ?? '') ||
			(a.sortOrder ?? 0) - (b.sortOrder ?? 0)
	);

	// --- place associations: {slug,role,notes} sorted by (slug,role,notes) ---
	const places = (input.places ?? []).map((p) => ({
		slug: String(p.slug ?? ''),
		role: asStringOrNull(p.role),
		notes: asStringOrNull(p.notes)
	}));
	places.sort(
		(a, b) => cmp(a.slug, b.slug) || cmp(a.role ?? '', b.role ?? '') || cmp(a.notes ?? '', b.notes ?? '')
	);

	// --- institution associations: {slug,role,callNumber,notes} ---
	const institutions = (input.institutions ?? []).map((i) => ({
		slug: String(i.slug ?? ''),
		role: asStringOrNull(i.role),
		callNumber: asStringOrNull(i.callNumber),
		notes: asStringOrNull(i.notes)
	}));
	institutions.sort(
		(a, b) =>
			cmp(a.slug, b.slug) ||
			cmp(a.role ?? '', b.role ?? '') ||
			cmp(a.callNumber ?? '', b.callNumber ?? '') ||
			cmp(a.notes ?? '', b.notes ?? '')
	);

	// --- relations: {type,toSlugOrId,direction} sorted by (direction,type,toSlugOrId) ---
	// `direction` ('out' = this source -> other; 'in' = other -> this source) is
	// kept so an inbound and an outbound relation never collapse — losing it
	// would be a real no-loss failure, so we extend the {type,toSlugOrId} spec.
	const relations = (input.relations ?? []).map((r) => ({
		type: String(r.type ?? 'related'),
		toSlugOrId: String(r.toSlugOrId ?? ''),
		direction: String(r.direction ?? 'out')
	}));
	relations.sort(
		(a, b) =>
			cmp(a.direction, b.direction) || cmp(a.type, b.type) || cmp(a.toSlugOrId, b.toSlugOrId)
	);

	out.links = links;
	out.tags = tags;
	out.persons = persons;
	out.places = places;
	out.institutions = institutions;
	out.relations = relations;

	return out as SourceProjection;
}

// ---------------------------------------------------------------------------
// Canonical serialisation + hashing
// ---------------------------------------------------------------------------

/** Recursively rebuild a value with every OBJECT key sorted. Array order is
 *  preserved (it is meaningful and already deterministically sorted upstream). */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === 'object') {
		if (value instanceof Date) return value.getTime();
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort(cmp)) {
			const v = obj[key];
			if (v === undefined) continue; // mirror JSON.stringify's drop of undefined
			sorted[key] = sortDeep(v);
		}
		return sorted;
	}
	if (typeof value === 'bigint') return Number(value);
	return value;
}

/** JSON with every object key recursively sorted → byte-stable regardless of
 *  the key insertion order of the input. Compact (no whitespace). */
export function canonicalStringify(obj: unknown): string {
	return JSON.stringify(sortDeep(obj));
}

/** sha256 hex of the canonical serialisation of `obj`. */
export function hashProjection(obj: unknown): string {
	return createHash('sha256').update(canonicalStringify(obj), 'utf8').digest('hex');
}

export interface ManifestEntry {
	id?: string;
	slug?: string;
	hash: string;
}

/** A single catalogue-wide fingerprint: sha256 over the per-source hashes,
 *  SORTED so it is invariant to the order sources are dumped in. */
export function rootHash(manifestEntries: ReadonlyArray<ManifestEntry | string>): string {
	const hashes = manifestEntries
		.map((e) => (typeof e === 'string' ? e : e.hash))
		.slice()
		.sort(cmp);
	return createHash('sha256').update(hashes.join('\n'), 'utf8').digest('hex');
}

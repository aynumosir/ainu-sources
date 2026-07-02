/**
 * DB-backed, IDEMPOTENT entity resolvers + join upserts for the harvest importers.
 *
 * The merge engine (mergeSourceObservation) owns the `sources` row, its scalar/set
 * field claims, identifiers and links. It does NOT touch the entity graph — persons,
 * places, institutions and tags are the CALLER's responsibility (exactly as
 * merge-write.ts reconciles tags for the website path). This module is that caller
 * half for harvest: it resolves each entity find-by-slug-or-create (deterministic
 * slug from the SAME derive.ts logic seed.ts used, so a known author/place/tag lands
 * on the EXISTING row and is never duplicated), then upserts the join row only when
 * it is absent.
 *
 * Idempotency (the golden-projection gate):
 *   • entities keyed on their UNIQUE `slug` column (persons/places/institutions/tags)
 *     → find-or-create never mints a second row for the same slug.
 *   • join rows: the durability UNIQUE(source,entity,role) indexes are DEFERRED
 *     (see schema.ts), so we can't rely on onConflictDoNothing. Instead an explicit
 *     existence check `SELECT 1 … WHERE sourceId=? AND entityId=? AND role=?` gates
 *     the insert — a second run adds ZERO join rows, preserving the existing
 *     sortOrder / role / notes / callNumber that the golden projection captures.
 *
 * Nothing here mutates a projected column of an EXISTING row: on a find we return the
 * id untouched; on a create we stamp only durability columns (origin / status /
 * firstSeenAt / lastSeenAt) plus the entity's own display fields — none of which,
 * for an already-present entity, is ever revisited. Join rows carry observationId /
 * confidence provenance stamps that are outside the golden projection.
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from '../../../src/lib/server/db/schema';
import {
	canonicalSlugFor,
	parsePersonName,
	PERSON_ENRICH,
	PERSON_CANON,
	stripParens,
	slugify,
	djb2,
	hasCJK,
	splitNakaguro,
	INSTITUTION_RE,
	placesFor,
	type GazEntry,
	type InstEntry
} from './derive';

export type Db = LibSQLDatabase<typeof schema>;

/** The shape of a TAG_DEFS entry (a topical/genre keyword rule). */
export type TagDef = { slug: string; name: string; nameEn: string; category: string; match: RegExp };

const uuid = () => crypto.randomUUID();

/** Provenance stamp carried onto every entity + join row a run writes. */
export interface EntityStamp {
	/** normalized harvest origin, e.g. 'ainu-dictionaries' */
	origin: string;
	/** the merge observation this association was asserted by (nullable) */
	observationId?: string | null;
	/** confidence of the asserting observation (join rows only) */
	confidence?: number | null;
	/** one shared timestamp per source so firstSeen/lastSeen are stable within a record */
	now?: Date;
}

const stampNow = (s: EntityStamp) => s.now ?? new Date();

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

/**
 * Resolve a free-form author string to a person id, find-by-slug-or-create.
 *
 * The slug is computed by the SAME logic seed.ts's in-memory `getPerson` used —
 * `canonicalSlugFor` (alias/canon fold) first, else a readable slug from the
 * parsed display / enrichment romaji, else a djb2 hash — so a known scholar
 * (中川裕 / "Nakagawa, Hiroshi" / "Hiroshi Nakagawa") resolves to the one
 * canonical row that already exists. Cross-form romaji-key merging that does NOT
 * go through a canon alias (seed's in-memory personByKey) is a documented
 * follow-up (Risk A); for the dictionaries feed authors are canon- or slug-simple.
 */
export async function getPerson(db: Db, name: string, stamp: EntityStamp): Promise<string> {
	const parsed = parsePersonName(name);
	const display = parsed.name;
	const canon = canonicalSlugFor(name.trim()) ?? canonicalSlugFor(display);
	const enrich =
		(canon ? PERSON_ENRICH[canon] : undefined) ??
		PERSON_ENRICH[name.trim()] ??
		PERSON_ENRICH[stripParens(display)] ??
		PERSON_ENRICH[stripParens(display).replace(/\s+/g, '')] ??
		PERSON_ENRICH[stripParens(name.trim()).replace(/\s+/g, '')];
	const c = canon ? PERSON_CANON[canon] : undefined;
	const pName = c ? c.name : display;
	const pNameEn: string | null =
		enrich?.nameEn ?? (c ? (c.nameEn ?? (hasCJK(c.name) ? null : c.name)) : parsed.nameEn);
	const researchmap: string | null = enrich?.researchmap ?? null;
	const wikidata: string | null = enrich?.wikidata ?? null;

	const baseSlug = canon
		? canon
		: slugify(stripParens(display)) || (pNameEn ? slugify(pNameEn) : '') || `p-${djb2(display)}`;

	const now = stampNow(stamp);
	return resolveBySlug(db, schema.persons, baseSlug, {
		id: uuid(),
		slug: baseSlug,
		name: pName,
		nameEn: pNameEn,
		nameKana: null,
		nameAin: null,
		researchmap,
		wikidata,
		status: 'active',
		origin: stamp.origin,
		firstSeenAt: now,
		lastSeenAt: now
	});
}

// ---------------------------------------------------------------------------
// Places / institutions / tags
// ---------------------------------------------------------------------------

export async function getPlace(db: Db, p: GazEntry, stamp: EntityStamp): Promise<string> {
	const now = stampNow(stamp);
	return resolveBySlug(db, schema.places, p.slug, {
		id: uuid(),
		slug: p.slug,
		name: p.name,
		nameEn: p.nameEn,
		kind: p.kind,
		region: p.region,
		lat: p.lat,
		lng: p.lng,
		status: 'active',
		origin: stamp.origin,
		firstSeenAt: now,
		lastSeenAt: now
	});
}

export async function getInstitution(db: Db, inst: InstEntry, stamp: EntityStamp): Promise<string> {
	const now = stampNow(stamp);
	return resolveBySlug(db, schema.institutions, inst.slug, {
		id: uuid(),
		slug: inst.slug,
		name: inst.name,
		nameEn: inst.nameEn,
		country: inst.country,
		city: inst.city,
		lat: inst.lat,
		lng: inst.lng,
		url: inst.url,
		status: 'active',
		origin: stamp.origin,
		firstSeenAt: now,
		lastSeenAt: now
	});
}

export async function getTag(db: Db, def: TagDef, stamp: EntityStamp): Promise<string> {
	return resolveBySlug(db, schema.tags, def.slug, {
		id: uuid(),
		slug: def.slug,
		name: def.name,
		nameEn: def.nameEn,
		category: def.category,
		status: 'active',
		origin: stamp.origin
	});
}

// ---------------------------------------------------------------------------
// Join upserts (existence-checked; deferred UNIQUE indexes)
// ---------------------------------------------------------------------------

/**
 * Attach persons parsed from a free-form author string. Mirrors seed.ts's
 * `addPersons` splitting (co-author separators, 中黒 for Han co-authors only) and
 * placeholder/anonymous filtering, then upserts one source_persons row per author
 * with the author-index `sortOrder` (captured by the golden projection).
 */
export async function addPersons(
	db: Db,
	sourceId: string,
	author: string | null | undefined,
	stamp: EntityStamp,
	role = 'author'
): Promise<void> {
	if (!author) return;
	const cleaned = author.trim();
	if (!cleaned || /^(unknown|anon\.?|anonymous|不明|作者不詳|なし|n\/a)$/i.test(cleaned)) return;
	if (/\b(various|compilation)\b/i.test(cleaned)) return;
	const parts = cleaned
		.split(/\s*[&;|｜/／]\s*|、|，|\s+and\s+/)
		.flatMap(splitNakaguro)
		.map((s) => s.trim())
		.filter(Boolean);
	let i = 0;
	for (const name of parts) {
		if (INSTITUTION_RE.test(name)) continue;
		const personId = await getPerson(db, name, stamp);
		await upsertJoin(
			db,
			schema.sourcePersons,
			{ sourceId: schema.sourcePersons.sourceId, entity: schema.sourcePersons.personId, role: schema.sourcePersons.role },
			{ sourceId, personId, role },
			{
				id: uuid(),
				sourceId,
				personId,
				role,
				sortOrder: i,
				status: 'active',
				origin: stamp.origin,
				observationId: stamp.observationId ?? null,
				confidence: stamp.confidence ?? null,
				firstSeenAt: stampNow(stamp),
				lastSeenAt: stampNow(stamp)
			}
		);
		i += 1;
	}
}

/** Attach dialect-derived places (role='dialect' by default). */
export async function addPlaces(
	db: Db,
	sourceId: string,
	dialect: string | null | undefined,
	stamp: EntityStamp,
	role = 'dialect'
): Promise<void> {
	if (!dialect) return;
	for (const p of placesFor(dialect)) {
		const placeId = await getPlace(db, p, stamp);
		await upsertJoin(
			db,
			schema.sourcePlaces,
			{ sourceId: schema.sourcePlaces.sourceId, entity: schema.sourcePlaces.placeId, role: schema.sourcePlaces.role },
			{ sourceId, placeId, role },
			{
				id: uuid(),
				sourceId,
				placeId,
				role,
				status: 'active',
				origin: stamp.origin,
				observationId: stamp.observationId ?? null,
				confidence: stamp.confidence ?? null,
				firstSeenAt: stampNow(stamp),
				lastSeenAt: stampNow(stamp)
			}
		);
	}
}

/** Attach an institution association (role/callNumber/notes preserved). */
export async function addInstitution(
	db: Db,
	sourceId: string,
	inst: InstEntry,
	stamp: EntityStamp,
	opts: { role?: string; callNumber?: string | null; notes?: string | null } = {}
): Promise<void> {
	const role = opts.role ?? 'holding';
	const institutionId = await getInstitution(db, inst, stamp);
	await upsertJoin(
		db,
		schema.sourceInstitutions,
		{ sourceId: schema.sourceInstitutions.sourceId, entity: schema.sourceInstitutions.institutionId, role: schema.sourceInstitutions.role },
		{ sourceId, institutionId, role },
		{
			id: uuid(),
			sourceId,
			institutionId,
			role,
			callNumber: opts.callNumber ?? null,
			notes: opts.notes ?? null,
			status: 'active',
			origin: stamp.origin,
			observationId: stamp.observationId ?? null,
			confidence: stamp.confidence ?? null,
			firstSeenAt: stampNow(stamp),
			lastSeenAt: stampNow(stamp)
		}
	);
}

/**
 * Keyword-sweep the given texts against TAG_DEFS and attach every match. Tags have
 * no role, so the existence check is on (sourceId, tagId). `defs` defaults to the
 * shared TAG_DEFS; pass a subset for venue-restricted tagging.
 */
export async function attachTags(
	db: Db,
	sourceId: string,
	texts: (string | null | undefined)[],
	stamp: EntityStamp,
	defs: readonly TagDef[]
): Promise<void> {
	const hay = texts.filter(Boolean).join(' ');
	for (const def of defs) {
		if (!def.match.test(hay)) continue;
		const tagId = await getTag(db, def, stamp);
		await upsertJoinNoRole(
			db,
			schema.sourceTags,
			{ sourceId: schema.sourceTags.sourceId, entity: schema.sourceTags.tagId },
			{ sourceId, tagId },
			{
				id: uuid(),
				sourceId,
				tagId,
				status: 'active',
				origin: stamp.origin,
				observationId: stamp.observationId ?? null,
				confidence: stamp.confidence ?? null,
				firstSeenAt: stampNow(stamp),
				lastSeenAt: stampNow(stamp)
			}
		);
	}
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Find a row by its UNIQUE slug; insert `values` (with that slug) if absent. */
async function resolveBySlug(
	db: Db,
	table: any,
	slug: string,
	values: Record<string, unknown>
): Promise<string> {
	const [existing] = await db.select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
	if (existing) return existing.id as string;
	await db.insert(table).values(values as any).onConflictDoNothing();
	// A concurrent insert (or an onConflictDoNothing that hit the slug UNIQUE) means
	// the row now exists — re-read to return the winning id deterministically.
	const [row] = await db.select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
	return (row?.id ?? (values.id as string)) as string;
}

/** Insert a (source, entity, role) join only when no such row already exists. */
async function upsertJoin(
	db: Db,
	table: any,
	cols: { sourceId: any; entity: any; role: any },
	key: Record<string, string>,
	values: Record<string, unknown>
): Promise<void> {
	const entityCol = Object.keys(key).find((k) => k !== 'sourceId' && k !== 'role')!;
	const [hit] = await db
		.select({ one: sql`1` })
		.from(table)
		.where(and(eq(cols.sourceId, key.sourceId), eq(cols.entity, key[entityCol]), eq(cols.role, key.role)))
		.limit(1);
	if (hit) return;
	await db.insert(table).values(values as any);
}

/** Insert a (source, entity) join (no role column, e.g. tags) only when absent. */
async function upsertJoinNoRole(
	db: Db,
	table: any,
	cols: { sourceId: any; entity: any },
	key: Record<string, string>,
	values: Record<string, unknown>
): Promise<void> {
	const entityCol = Object.keys(key).find((k) => k !== 'sourceId')!;
	const [hit] = await db
		.select({ one: sql`1` })
		.from(table)
		.where(and(eq(cols.sourceId, key.sourceId), eq(cols.entity, key[entityCol])))
		.limit(1);
	if (hit) return;
	await db.insert(table).values(values as any);
}

/** Open a libSQL handle for a standalone importer (mirrors seed.ts/golden-dump.ts). */
export function openDb(url: string, authToken?: string): Db {
	const client = createClient({ url, authToken: authToken || undefined });
	return drizzle(client, { schema });
}

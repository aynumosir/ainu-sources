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
 *   • places/institutions/tags keyed on their UNIQUE `slug` column → find-or-create
 *     never mints a second row for the same slug.
 *   • persons additionally fold cross-form / cross-run name variants onto the
 *     bootstrapped identity via a DB-seeded fold-key index (see getPerson, Risk A),
 *     so a re-import resolves each spelling to the SAME person seed created rather
 *     than a slug-computed duplicate.
 *   • join rows: the durability UNIQUE(source,entity,role) indexes are DEFERRED
 *     (see schema.ts), so we can't rely on onConflictDoNothing. Instead an explicit
 *     existence check `SELECT 1 … WHERE sourceId=? AND entityId=? AND role=?` gates
 *     the insert — a second run adds ZERO join rows, preserving the existing
 *     sortOrder / role / notes / callNumber that the golden projection captures.
 *
 * Nothing here mutates a PROJECTED column of an EXISTING row: on a find we return the
 * id untouched; on a create we stamp only durability columns (origin / status /
 * firstSeenAt / lastSeenAt) plus the entity's own display fields. The one write to an
 * existing row is getPerson's monotonic gap-fill of person name/nameEn/researchmap/
 * wikidata — all OUTSIDE the golden projection (which keys persons on slug) and
 * idempotent (second identical run is a noop). Join rows carry observationId /
 * confidence provenance stamps that are outside the golden projection.
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from '../../../src/lib/server/db/schema';
import {
	canonicalSlugFor,
	derivePerson,
	personFoldKeys,
	PERSON_CANON_SLUGS,
	hasCJK,
	splitNakaguro,
	INSTITUTION_RE,
	placesFor,
	authorParts,
	isGarbageName,
	simplePersonKey,
	venueTagSlugs,
	type PersonDerivation,
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
// Persons — cross-form / cross-run identity folding (Risk A)
// ---------------------------------------------------------------------------

/**
 * seed.ts collapsed the many spellings of one scholar/narrator (bare surname,
 * "Last, First", CJK, reversed romaji, macron variants, née names …) into ONE
 * person via an in-memory `personByKey` map keyed on FOLD KEYS — canon slug,
 * diacritic-folded order-insensitive romaji, despaced kanji, alnum Latin — and the
 * 809-person bootstrap DB was built from it. A re-import must reproduce that
 * folding, or a form that folds to an existing person under a DIFFERENT computed
 * slug mints a DUPLICATE person + join (Risk A: 4 duplicate speaker joins observed
 * in the corpus feed, far worse for the 5.7k-record academic feed).
 *
 * The fold-key INDEX below is seed's personByKey rebuilt FROM THE DB's existing
 * persons: every stored person is registered under all of its fold keys, so an
 * incoming name whose fold key matches resolves to the bootstrapped person instead
 * of creating a new one. It is lazily loaded once per Db handle and kept live —
 * a person created mid-run is registered so a later cross-form reference in the
 * SAME run folds onto it (exactly as seed's map accumulated).
 */
interface PersonIndex {
	byKey: Map<string, string>;
}
const personIndexByDb = new WeakMap<Db, Promise<PersonIndex>>();

/** Register a person id under fold keys, first-writer-wins (seed's map semantics). */
function registerPersonKeys(idx: PersonIndex, keys: string[], id: string): void {
	for (const k of keys) if (!idx.byKey.has(k)) idx.byKey.set(k, id);
}

/** The fold keys a DB person row is findable under (canon recovered from its slug). */
function personKeysForRow(row: { slug: string; name: string; nameEn: string | null }): string[] {
	const canon = PERSON_CANON_SLUGS.has(row.slug) ? row.slug : (canonicalSlugFor(row.name) ?? null);
	return personFoldKeys({ canon, name: row.name, nameEn: row.nameEn });
}

/** Build seed's personByKey, SEEDED FROM THE DB, so resolution matches the bootstrap. */
async function loadPersonIndex(db: Db): Promise<PersonIndex> {
	const rows = await db
		.select({ id: schema.persons.id, slug: schema.persons.slug, name: schema.persons.name, nameEn: schema.persons.nameEn })
		.from(schema.persons)
		.orderBy(schema.persons.slug); // deterministic order → stable first-writer-wins
	const idx: PersonIndex = { byKey: new Map() };
	for (const p of rows) registerPersonKeys(idx, personKeysForRow(p), p.id);
	return idx;
}

function personIndex(db: Db): Promise<PersonIndex> {
	let p = personIndexByDb.get(db);
	if (!p) {
		p = loadPersonIndex(db);
		personIndexByDb.set(db, p);
	}
	return p;
}

/**
 * Like seed's merge-on-hit: fill richer, NON-projected display fields on an already
 * resolved person — a romaji-only display upgraded to kanji, and researchmap /
 * wikidata backfilled when absent. name/nameEn/researchmap/wikidata are OUTSIDE the
 * golden projection (which keys persons on slug), and the upgrade is monotonic
 * (gap-fill + romaji→kanji only) so the SECOND identical run is a pure noop. The
 * slug and id are NEVER touched.
 */
async function maybeUpgradePerson(db: Db, id: string, d: PersonDerivation): Promise<void> {
	const [row] = await db
		.select({
			name: schema.persons.name,
			nameEn: schema.persons.nameEn,
			researchmap: schema.persons.researchmap,
			wikidata: schema.persons.wikidata
		})
		.from(schema.persons)
		.where(eq(schema.persons.id, id))
		.limit(1);
	if (!row) return;
	const patch: Record<string, unknown> = {};
	if (d.name && hasCJK(d.name) && !hasCJK(row.name)) patch.name = d.name;
	if (d.nameEn && !row.nameEn) patch.nameEn = d.nameEn;
	else if (d.curatedNameEn && d.nameEn && row.nameEn !== d.nameEn) patch.nameEn = d.nameEn;
	if (d.researchmap && !row.researchmap) patch.researchmap = d.researchmap;
	if (d.wikidata && !row.wikidata) patch.wikidata = d.wikidata;
	if (Object.keys(patch).length === 0) return;
	await db.update(schema.persons).set(patch).where(eq(schema.persons.id, id));
}

/**
 * Resolve a free-form author string to a person id, folding cross-form / cross-run
 * name variants onto the SAME person the bootstrap created (Risk A). Computes the
 * incoming form's fold keys and probes the DB-seeded index in priority order —
 * canon slug, folded romaji, despaced kanji, alnum Latin — before creating; on a
 * hit it returns the existing id (and gap-fills richer display fields), on a miss
 * it creates by slug and registers the new person's keys for the rest of the run.
 * Deterministic + idempotent: a 2nd identical run mints zero persons and zero joins.
 */
export async function getPerson(db: Db, name: string, stamp: EntityStamp): Promise<string> {
	const d = derivePerson(name);
	const keys = personFoldKeys(d);
	const idx = await personIndex(db);
	for (const k of keys) {
		const hit = idx.byKey.get(k);
		if (hit) {
			await maybeUpgradePerson(db, hit, d);
			return hit;
		}
	}

	const now = stampNow(stamp);
	const id = await resolveBySlug(db, schema.persons, d.slug, {
		id: uuid(),
		slug: d.slug,
		name: d.name,
		nameEn: d.nameEn,
		nameKana: null,
		nameAin: null,
		researchmap: d.researchmap,
		wikidata: d.wikidata,
		status: 'active',
		origin: stamp.origin,
		firstSeenAt: now,
		lastSeenAt: now
	});
	// resolveBySlug may have FOUND a same-slug row rather than inserting; either way
	// index this form's keys → the winning id so the rest of the run folds onto it.
	registerPersonKeys(idx, keys, id);
	return id;
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

/**
 * Attach academic authors ABOVE a prominence gate (seed.ts's `addPersonsGated`,
 * verbatim splitting/filtering). Each free-form author string is split into parts
 * via `authorParts`; a part is promoted to a person entity only when it is neither
 * an institution nor a garbage token AND is either in the prominent-author `allow`
 * set (≥ AUTHOR_MIN_WORKS, computed by the caller's global pre-pass) OR carries a
 * known canonical slug (so e.g. 安岡孝一's Qiita/HF handle still attaches). Person
 * identity folds onto the bootstrapped record via getPerson (Risk A); the join is
 * existence-checked so a re-run adds ZERO rows and preserves the golden sortOrder.
 */
export async function addPersonsGated(
	db: Db,
	sourceId: string,
	authors: string[],
	allow: Set<string>,
	stamp: EntityStamp,
	role = 'author'
): Promise<void> {
	let i = 0;
	for (const a of authors)
		for (const name of authorParts(a)) {
			if (
				INSTITUTION_RE.test(name) ||
				isGarbageName(name) ||
				(!allow.has(simplePersonKey(name)) && !canonicalSlugFor(name))
			)
				continue;
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

/**
 * Attach the venue-derived tag(s) for a source (seed.ts's `attachVenueTags`). The
 * matcher (`venueTagSlugs`) lives in derive.ts; here we map each produced slug to
 * its shared TAG_DEFS entry and existence-check the (source, tag) join. seed's
 * per-source dedup drops any overlap with the title-based sweep — the existence
 * check reproduces that (a tag the title sweep already attached is a noop).
 */
export async function attachVenueTags(
	db: Db,
	sourceId: string,
	venue: string | null | undefined,
	stamp: EntityStamp,
	defs: readonly TagDef[]
): Promise<void> {
	for (const slug of venueTagSlugs(venue)) {
		const def = defs.find((d) => d.slug === slug);
		if (!def) continue;
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

/**
 * Observation diffs — the "commit diff" of the Git-in-the-DB model (Phase 1).
 *
 * Every commit (a `source_observations` row) gets at most one stored diff per
 * kind (`applied` for an auto-applied merge; `proposal`/`planned` reserved for
 * the later PR phases). A diff is a PURE, DB-agnostic before→after view of one
 * source's canonical projection, computed with the SAME `golden.ts` projector +
 * hash the merge engine uses — so the diff and the content hash can never drift.
 *
 * This module has two halves:
 *   • `diffSourceProjection(...)`  — PURE: two `SourceProjection`s → `SourceDiff`.
 *     No DB access, so it behaves identically on a drizzle row and a raw libSQL
 *     row (the same property `golden.ts` already guarantees).
 *   • `loadSourceProjection(db,…)` — the one DB read helper: fetches a source's
 *     ACTIVE child rows and builds its canonical projection + hash, mirroring the
 *     engine's `projectAndStore` exactly (active links/tags/assoc, relations
 *     resolved to the other endpoint's slug).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { projectSource, hashProjection, type SourceProjection } from '../golden';
import type { ClaimOutcome, ConflictOutcome, Db } from './types';
import {
	sources,
	sourceLinks,
	sourceTags,
	tags,
	sourcePersons,
	persons,
	sourcePlaces,
	places,
	sourceInstitutions,
	institutions,
	sourceRelations
} from '../db/schema';

/** Projected collection element shapes — reuse golden's projection contract. */
export type LinkProj = SourceProjection['links'][number];
export type PersonAssocProj = SourceProjection['persons'][number];
export type PlaceAssocProj = SourceProjection['places'][number];
export type InstAssocProj = SourceProjection['institutions'][number];
export type RelationProj = SourceProjection['relations'][number];

export type CollectionName =
	| 'links'
	| 'tags'
	| 'persons'
	| 'places'
	| 'institutions'
	| 'relations';

export interface ScalarFieldDiff {
	field: string;
	before: unknown;
	after: unknown;
	op: 'add' | 'update' | 'clear';
	/** in the applied diff every shown scalar is 'applied'; the held/rejected ones
	 *  surface separately so a refused edit is visible, never silently dropped. */
	decision?: 'will_apply' | 'applied' | 'held_below' | 'conflict' | 'rejected' | 'noop';
	reason?: string;
}

export interface CollectionDiff<T> {
	added: T[];
	removed: T[];
	updated: Array<{ key: string; before: T; after: T }>;
}

export interface LifecycleDiff {
	eventType: string;
	fromStatus?: string | null;
	toStatus?: string | null;
	reason?: string | null;
}

export interface SourceDiff {
	version: 1;
	sourceId: string | null;
	slug: string | null;
	isNewSource: boolean;
	base: { contentHash: string | null };
	result: { contentHash: string };
	/** user-facing changed scalar columns */
	scalars: ScalarFieldDiff[];
	/** id / createdAt / updatedAt / createdBy / updatedBy — collapsed in the UI */
	systemScalars: ScalarFieldDiff[];
	links: CollectionDiff<LinkProj>;
	tags: CollectionDiff<string>;
	persons: CollectionDiff<PersonAssocProj>;
	places: CollectionDiff<PlaceAssocProj>;
	institutions: CollectionDiff<InstAssocProj>;
	relations: CollectionDiff<RelationProj>;
	lifecycle: LifecycleDiff[];
	changedScalarFields: string[];
	changedCollections: CollectionName[];
	/** e.g. 'yearStart: 1875 → 1872' */
	summaryLines: string[];
	warnings: string[];
	conflicts: ConflictOutcome[];
	/** engine REFUSED these — shown, never silently dropped (no-loss) */
	heldClaims: ClaimOutcome[];
	rejectedClaims: ClaimOutcome[];
}

// ---------------------------------------------------------------------------
// PURE diff
// ---------------------------------------------------------------------------

/** Scalar columns that are system/audit metadata, collapsed in the UI. */
const SYSTEM_SCALAR_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);

/** The collection keys of a `SourceProjection` (everything else is a scalar). */
const COLLECTION_KEYS: ReadonlySet<string> = new Set([
	'links',
	'tags',
	'persons',
	'places',
	'institutions',
	'relations'
]);

function isEmpty(v: unknown): boolean {
	return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Stable, order-independent equality for two projected scalar values. */
function scalarEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	// arrays / objects (altTitles, languages, scripts, externalIds) — canonical compare
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function scalarOp(before: unknown, after: unknown): 'add' | 'update' | 'clear' {
	if (isEmpty(before)) return 'add';
	if (isEmpty(after)) return 'clear';
	return 'update';
}

function fmtScalar(v: unknown): string {
	if (isEmpty(v)) return '∅';
	if (Array.isArray(v)) return v.join(', ');
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Build a CollectionDiff from two arrays keyed by a stable string key. */
function diffCollection<T>(before: T[], after: T[], keyOf: (item: T) => string): CollectionDiff<T> {
	const b = new Map(before.map((x) => [keyOf(x), x] as const));
	const a = new Map(after.map((x) => [keyOf(x), x] as const));
	const added: T[] = [];
	const removed: T[] = [];
	const updated: Array<{ key: string; before: T; after: T }> = [];
	for (const [k, av] of a) {
		const bv = b.get(k);
		if (bv === undefined) added.push(av);
		else if (JSON.stringify(bv) !== JSON.stringify(av)) updated.push({ key: k, before: bv, after: av });
	}
	for (const [k, bv] of b) {
		if (!a.has(k)) removed.push(bv);
	}
	return { added, removed, updated };
}

const linkKey = (l: LinkProj) => `${l.type}\n${l.url}`;
const personKey = (p: PersonAssocProj) => `${p.slug}\n${p.role ?? ''}`;
const placeKey = (p: PlaceAssocProj) => `${p.slug}\n${p.role ?? ''}`;
const instKey = (i: InstAssocProj) => `${i.slug}\n${i.role ?? ''}\n${i.callNumber ?? ''}`;
const relKey = (r: RelationProj) => `${r.direction}\n${r.type}\n${r.toSlugOrId}`;

function projScalars(p: SourceProjection | null): Record<string, unknown> {
	if (!p) return {};
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(p)) {
		if (!COLLECTION_KEYS.has(k)) out[k] = (p as Record<string, unknown>)[k];
	}
	return out;
}

export interface DiffSourceProjectionArgs {
	sourceId: string | null;
	slug: string | null;
	before: SourceProjection | null;
	after: SourceProjection;
	beforeHash: string | null;
	afterHash: string;
	conflicts?: ConflictOutcome[];
	heldClaims?: ClaimOutcome[];
	rejectedClaims?: ClaimOutcome[];
	warnings?: string[];
}

/**
 * PURE before→after diff of two canonical source projections. `before === null`
 * means a brand-new source (every non-empty scalar is an `add`, every collection
 * member is `added`). No DB access; deterministic; safe on any row representation.
 */
export function diffSourceProjection(args: DiffSourceProjectionArgs): SourceDiff {
	const { before, after } = args;
	const isNewSource = before === null;
	const beforeS = projScalars(before);
	const afterS = projScalars(after);

	const scalars: ScalarFieldDiff[] = [];
	const systemScalars: ScalarFieldDiff[] = [];
	const changedScalarFields: string[] = [];
	const summaryLines: string[] = [];

	for (const field of new Set([...Object.keys(afterS), ...Object.keys(beforeS)])) {
		const bv = beforeS[field];
		const av = afterS[field];
		if (scalarEqual(bv, av)) continue;
		const entry: ScalarFieldDiff = {
			field,
			before: bv ?? null,
			after: av ?? null,
			op: scalarOp(bv, av),
			decision: 'applied'
		};
		if (SYSTEM_SCALAR_FIELDS.has(field)) {
			systemScalars.push(entry);
		} else {
			scalars.push(entry);
			changedScalarFields.push(field);
			summaryLines.push(`${field}: ${fmtScalar(bv)} → ${fmtScalar(av)}`);
		}
	}
	scalars.sort((x, y) => cmp(x.field, y.field));
	systemScalars.sort((x, y) => cmp(x.field, y.field));
	changedScalarFields.sort();
	summaryLines.sort();

	const links = diffCollection(before?.links ?? [], after.links, linkKey);
	const tagsDiff = diffCollection(before?.tags ?? [], after.tags, (t) => t);
	const personsDiff = diffCollection(before?.persons ?? [], after.persons, personKey);
	const placesDiff = diffCollection(before?.places ?? [], after.places, placeKey);
	const institutionsDiff = diffCollection(before?.institutions ?? [], after.institutions, instKey);
	const relationsDiff = diffCollection(before?.relations ?? [], after.relations, relKey);

	const changedCollections: CollectionName[] = [];
	const collEntries: Array<[CollectionName, CollectionDiff<unknown>]> = [
		['links', links],
		['tags', tagsDiff],
		['persons', personsDiff],
		['places', placesDiff],
		['institutions', institutionsDiff],
		['relations', relationsDiff]
	];
	for (const [name, d] of collEntries) {
		if (d.added.length + d.removed.length + d.updated.length === 0) continue;
		changedCollections.push(name);
		const parts: string[] = [];
		if (d.added.length) parts.push(`+${d.added.length}`);
		if (d.removed.length) parts.push(`−${d.removed.length}`);
		if (d.updated.length) parts.push(`~${d.updated.length}`);
		summaryLines.push(`${name}: ${parts.join(' ')}`);
	}

	return {
		version: 1,
		sourceId: args.sourceId,
		slug: args.slug,
		isNewSource,
		base: { contentHash: args.beforeHash },
		result: { contentHash: args.afterHash },
		scalars,
		systemScalars,
		links,
		tags: tagsDiff,
		persons: personsDiff,
		places: placesDiff,
		institutions: institutionsDiff,
		relations: relationsDiff,
		lifecycle: [],
		changedScalarFields,
		changedCollections,
		summaryLines,
		warnings: args.warnings ?? [],
		conflicts: args.conflicts ?? [],
		heldClaims: args.heldClaims ?? [],
		rejectedClaims: args.rejectedClaims ?? []
	};
}

// ---------------------------------------------------------------------------
// The one DB read helper — active children → canonical projection + hash
// ---------------------------------------------------------------------------

/**
 * Read a source's ACTIVE child rows and build its canonical projection + content
 * hash, mirroring the engine's `projectAndStore` (active links/tags/assoc,
 * relations in accepted/active/candidate state, each resolved to the other
 * endpoint's slug). Used by the proposal/`/history` paths to obtain a genuine
 * "before" or to reconstruct a source's projection from durable rows.
 */
export async function loadSourceProjection(
	db: Db,
	sourceId: string
): Promise<{ projection: SourceProjection; contentHash: string } | null> {
	const [srcRows, links, tagRows, personRows, placeRows, instRows, relOut, relIn] = await db.batch([
		db.select().from(sources).where(eq(sources.id, sourceId)).limit(1),
		db
			.select()
			.from(sourceLinks)
			.where(and(eq(sourceLinks.sourceId, sourceId), eq(sourceLinks.status, 'active'))),
		db
			.select({ name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id))
			.where(and(eq(sourceTags.sourceId, sourceId), eq(sourceTags.status, 'active'))),
		db
			.select({ slug: persons.slug, role: sourcePersons.role, sortOrder: sourcePersons.sortOrder })
			.from(sourcePersons)
			.innerJoin(persons, eq(sourcePersons.personId, persons.id))
			.where(and(eq(sourcePersons.sourceId, sourceId), eq(sourcePersons.status, 'active'))),
		db
			.select({ slug: places.slug, role: sourcePlaces.role, notes: sourcePlaces.notes })
			.from(sourcePlaces)
			.innerJoin(places, eq(sourcePlaces.placeId, places.id))
			.where(and(eq(sourcePlaces.sourceId, sourceId), eq(sourcePlaces.status, 'active'))),
		db
			.select({
				slug: institutions.slug,
				role: sourceInstitutions.role,
				callNumber: sourceInstitutions.callNumber,
				notes: sourceInstitutions.notes
			})
			.from(sourceInstitutions)
			.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id))
			.where(and(eq(sourceInstitutions.sourceId, sourceId), eq(sourceInstitutions.status, 'active'))),
		db
			.select({ to: sourceRelations.toSourceId, type: sourceRelations.type, status: sourceRelations.status })
			.from(sourceRelations)
			.where(eq(sourceRelations.fromSourceId, sourceId)),
		db
			.select({ from: sourceRelations.fromSourceId, type: sourceRelations.type, status: sourceRelations.status })
			.from(sourceRelations)
			.where(eq(sourceRelations.toSourceId, sourceId))
	]);

	const src = srcRows[0];
	if (!src) return null;

	const ACTIVE_REL = new Set(['accepted', 'active', 'candidate']);
	const relOutActive = relOut.filter((r) => ACTIVE_REL.has(r.status ?? 'accepted'));
	const relInActive = relIn.filter((r) => ACTIVE_REL.has(r.status ?? 'accepted'));
	const endpointIds = [...relOutActive.map((r) => r.to), ...relInActive.map((r) => r.from)];
	const slugMap = new Map<string, string>();
	if (endpointIds.length) {
		const rows = await db
			.select({ id: sources.id, slug: sources.slug })
			.from(sources)
			.where(inArray(sources.id, endpointIds));
		for (const r of rows) slugMap.set(r.id, r.slug);
	}
	const relations = [
		...relOutActive.map((r) => ({ type: r.type, toSlugOrId: slugMap.get(r.to) ?? r.to, direction: 'out' as const })),
		...relInActive.map((r) => ({ type: r.type, toSlugOrId: slugMap.get(r.from) ?? r.from, direction: 'in' as const }))
	];

	const projection = projectSource({
		source: src as unknown as Record<string, unknown>,
		links,
		tags: tagRows.map((t) => t.name),
		persons: personRows,
		places: placeRows,
		institutions: instRows,
		relations
	});
	return { projection, contentHash: hashProjection(projection) };
}

import { db } from './db';
import {
	sources,
	sourceLinks,
	persons,
	sourcePersons,
	places,
	sourcePlaces,
	institutions,
	sourceInstitutions,
	sourceRelations,
	tags,
	sourceTags,
	sourceRevisions,
	sourceObservationDiffs,
	type Source,
	type Person,
	type Place,
	type Institution,
	type Tag
} from './db/schema';
import { and, or, eq, ne, like, inArray, gte, lte, desc, asc, sql, count, countDistinct } from 'drizzle-orm';
import type {
	SourceFilters,
	Facets,
	FacetBucket,
	SourceListResult,
	SourceDetail,
	DbStats,
	TimelinePoint,
	MapPlace,
	PersonRef,
	PlaceRef,
	InstitutionRef,
	RelatedSource
} from '$lib/types';
import { asArray, centuryOf } from '$lib/format';
import { activeSourcesOnly, publicRelationsOnly } from './visibility';
import {
	createSourceOnApp,
	updateSourceOnApp,
	mergeNotice,
	type WebsiteEditResult
} from './merge-write';

export { mergeNotice, type WebsiteEditResult };

type SQLCond = ReturnType<typeof eq>;

const SEEDED = ['ainu-dictionaries', 'ainu-grammar', 'ainu-corpora'];

// ---------------------------------------------------------------------------
// Filter → SQL conditions
// ---------------------------------------------------------------------------

/** Conditions shared by the list view and the facet counts. */
function baseConditions(f: SourceFilters): SQLCond[] {
	// Public read model: only active sources surface. Shared by listSources and
	// computeFacets, so merged/hidden/candidate/soft_deleted rows never appear in
	// the browse list OR inflate a facet bucket. No-op while everything is active.
	const c: SQLCond[] = [activeSourcesOnly()];
	if (f.q && f.q.trim()) {
		const q = `%${f.q.trim()}%`;
		c.push(
			or(
				like(sources.title, q),
				like(sources.titleEn, q),
				like(sources.titleAin, q),
				like(sources.author, q),
				like(sources.dialect, q),
				like(sources.summary, q)
			)!
		);
	}
	if (f.tag) {
		c.push(
			inArray(
				sources.id,
				db
					.select({ id: sourceTags.sourceId })
					.from(sourceTags)
					.innerJoin(tags, eq(sourceTags.tagId, tags.id))
					.where(eq(tags.slug, f.tag))
			)
		);
	}
	if (f.person) {
		c.push(
			inArray(
				sources.id,
				db
					.select({ id: sourcePersons.sourceId })
					.from(sourcePersons)
					.innerJoin(persons, eq(sourcePersons.personId, persons.id))
					.where(eq(persons.slug, f.person))
			)
		);
	}
	if (f.hasDigital) {
		c.push(inArray(sources.id, db.select({ id: sourceLinks.sourceId }).from(sourceLinks)));
	}
	return c;
}

function jsonAnyOf(column: typeof sources.languages | typeof sources.scripts, values: string[]) {
	return or(...values.map((v) => like(column, `%"${v}"%`)))!;
}

function centuryConds(centuries: number[]) {
	return or(
		...centuries.map((cn) =>
			and(gte(sources.yearStart, (cn - 1) * 100 + 1), lte(sources.yearStart, cn * 100))!
		)
	)!;
}

/** All conditions, including the multi-select facet dimensions. */
function fullConditions(f: SourceFilters): SQLCond[] {
	const c = baseConditions(f);
	if (f.category) c.push(eq(sources.category, f.category));
	if (f.types?.length) c.push(inArray(sources.type, f.types));
	if (f.genres?.length)
		c.push(
			inArray(
				sources.id,
				db
					.select({ id: sourceTags.sourceId })
					.from(sourceTags)
					.innerJoin(tags, eq(sourceTags.tagId, tags.id))
					// Constrain to genre-category tags so a slug shared with a non-genre
					// tag can't leak in — matches how genre facets are counted.
					.where(and(inArray(tags.slug, f.genres), eq(tags.category, 'genre')))
			)
		);
	if (f.regions?.length) c.push(inArray(sources.region, f.regions));
	if (f.languages?.length) c.push(jsonAnyOf(sources.languages, f.languages));
	if (f.scripts?.length) c.push(jsonAnyOf(sources.scripts, f.scripts));
	if (f.centuries?.length) c.push(centuryConds(f.centuries));
	return c;
}

function orderBy(sort: SourceFilters['sort']) {
	switch (sort) {
		case 'year-asc':
			return [asc(sources.yearStart), asc(sources.title)];
		case 'title':
			return [asc(sources.title)];
		case 'updated':
			return [desc(sources.updatedAt)];
		case 'entries-desc':
			return [desc(sources.entryCount)];
		case 'year-desc':
		default:
			return [desc(sources.yearStart), asc(sources.title)];
	}
}

// ---------------------------------------------------------------------------
// List + facets
// ---------------------------------------------------------------------------

export async function listSources(f: SourceFilters): Promise<SourceListResult> {
	const page = Math.max(1, f.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, f.pageSize ?? 24));
	const conds = fullConditions(f);
	const where = conds.length ? and(...conds) : undefined;

	const [items, totalRow] = await Promise.all([
		db
			.select()
			.from(sources)
			.where(where)
			.orderBy(...orderBy(f.sort))
			.limit(pageSize)
			.offset((page - 1) * pageSize),
		db.select({ n: count() }).from(sources).where(where)
	]);

	const total = totalRow[0]?.n ?? 0;
	return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function tally(values: string[]): FacetBucket[] {
	const m = new Map<string, number>();
	for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
	return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/**
 * Per-dimension predicates for the selected facet values. Standard faceted-search
 * semantics: a dimension's own buckets are counted with every OTHER selected
 * dimension applied, but NOT its own filter — so the visible options narrow as you
 * pick across dimensions, while you can still widen a selection within one dimension.
 */
type FacetRow = {
	id: string;
	category: string;
	type: string;
	region: string | null;
	languages: unknown;
	scripts: unknown;
	yearStart: number | null;
};

export async function computeFacets(f: SourceFilters): Promise<Facets> {
	const conds = baseConditions(f);
	const where = conds.length ? and(...conds) : undefined;
	const rows: FacetRow[] = await db
		.select({
			id: sources.id,
			category: sources.category,
			type: sources.type,
			region: sources.region,
			languages: sources.languages,
			scripts: sources.scripts,
			yearStart: sources.yearStart
		})
		.from(sources)
		.where(where);

	// Genre tags per source (genre is a tag-derived dimension, not a column).
	const genreRows = await db
		.select({ sid: sourceTags.sourceId, slug: tags.slug })
		.from(sourceTags)
		.innerJoin(tags, eq(tags.id, sourceTags.tagId))
		.where(eq(tags.category, 'genre'));
	const genreBySource = new Map<string, string[]>();
	for (const g of genreRows) {
		const arr = genreBySource.get(g.sid);
		if (arr) arr.push(g.slug);
		else genreBySource.set(g.sid, [g.slug]);
	}
	const genresOf = (r: FacetRow) => genreBySource.get(r.id) ?? [];

	// Predicate per dimension (true = row passes that dimension's selected filter).
	const matchCategory = (r: FacetRow) => !f.category || r.category === f.category;
	const matchType = (r: FacetRow) => !f.types?.length || f.types.includes(r.type);
	const matchGenre = (r: FacetRow) => !f.genres?.length || genresOf(r).some((g) => f.genres!.includes(g));
	const matchRegion = (r: FacetRow) => !f.regions?.length || f.regions.includes(r.region ?? '');
	const matchLanguages = (r: FacetRow) =>
		!f.languages?.length || asArray(r.languages).some((v) => f.languages!.includes(v));
	const matchScripts = (r: FacetRow) =>
		!f.scripts?.length || asArray(r.scripts).some((v) => f.scripts!.includes(v));
	const matchCenturies = (r: FacetRow) => {
		if (!f.centuries?.length) return true;
		const c = centuryOf(r.yearStart);
		return c != null && f.centuries.includes(c);
	};

	// For dimension X, keep rows passing all dimensions except X.
	const except = (skip: keyof SourceFilters) =>
		rows.filter(
			(r) =>
				(skip === 'category' || matchCategory(r)) &&
				(skip === 'types' || matchType(r)) &&
				(skip === 'genres' || matchGenre(r)) &&
				(skip === 'regions' || matchRegion(r)) &&
				(skip === 'languages' || matchLanguages(r)) &&
				(skip === 'scripts' || matchScripts(r)) &&
				(skip === 'centuries' || matchCenturies(r))
		);

	const centuryKeys = (rs: FacetRow[]) =>
		rs
			.map((r) => centuryOf(r.yearStart))
			.filter((c): c is number => c != null)
			.map(String);

	return {
		categories: tally(except('category').map((r) => r.category)),
		types: tally(except('types').map((r) => r.type)),
		genres: tally(except('genres').flatMap(genresOf)),
		regions: tally(except('regions').map((r) => r.region ?? '')),
		languages: tally(except('languages').flatMap((r) => asArray(r.languages))),
		scripts: tally(except('scripts').flatMap((r) => asArray(r.scripts))),
		centuries: tally(centuryKeys(except('centuries'))).sort((a, b) => Number(a.key) - Number(b.key))
	};
}

// ---------------------------------------------------------------------------
// Source detail
// ---------------------------------------------------------------------------

export async function getSourceBySlug(slug: string): Promise<Source | undefined> {
	// Public lookup: a non-active source (merged/hidden/candidate/soft_deleted) is
	// treated as not-found here. The detail route turns "not found" into a 302 to
	// the merge winner (see getMergeRedirectTarget) or a 404.
	const r = await db
		.select()
		.from(sources)
		.where(and(eq(sources.slug, slug), activeSourcesOnly()))
		.limit(1);
	return r[0];
}

/**
 * Decide the public response for a slug that did NOT resolve to an active source.
 * A merged loser (status='merged' + mergedIntoSourceId) redirects to its winner's
 * slug — but only when that winner is itself active; everything else (hidden,
 * soft_deleted, candidate, or genuinely missing) returns undefined → the caller
 * 404s. Reads `sources` WITHOUT the active filter on purpose: it must see the
 * non-active loser row to know where to send the visitor.
 */
export async function getMergeRedirectTarget(slug: string): Promise<string | undefined> {
	const [row] = await db
		.select({ status: sources.status, mergedIntoSourceId: sources.mergedIntoSourceId })
		.from(sources)
		.where(eq(sources.slug, slug))
		.limit(1);
	if (!row || row.status !== 'merged' || !row.mergedIntoSourceId) return undefined;
	const [winner] = await db
		.select({ slug: sources.slug })
		.from(sources)
		.where(and(eq(sources.id, row.mergedIntoSourceId), activeSourcesOnly()))
		.limit(1);
	return winner?.slug;
}

export async function getSourceDetail(slug: string): Promise<SourceDetail | undefined> {
	const source = await getSourceBySlug(slug);
	if (!source) return undefined;
	const id = source.id;

	const [links, personRows, placeRows, instRows, tagRows, relOut, relIn, revCount] =
		await Promise.all([
			db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, id)).orderBy(asc(sourceLinks.sortOrder)),
			db
				.select({ person: persons, role: sourcePersons.role, sortOrder: sourcePersons.sortOrder })
				.from(sourcePersons)
				.innerJoin(persons, eq(sourcePersons.personId, persons.id))
				.where(eq(sourcePersons.sourceId, id))
				.orderBy(asc(sourcePersons.sortOrder)),
			db
				.select({ place: places, role: sourcePlaces.role })
				.from(sourcePlaces)
				.innerJoin(places, eq(sourcePlaces.placeId, places.id))
				.where(eq(sourcePlaces.sourceId, id)),
			db
				.select({ institution: institutions, role: sourceInstitutions.role, callNumber: sourceInstitutions.callNumber })
				.from(sourceInstitutions)
				.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id))
				.where(eq(sourceInstitutions.sourceId, id)),
			db
				.select({ tag: tags })
				.from(sourceTags)
				.innerJoin(tags, eq(sourceTags.tagId, tags.id))
				.where(eq(sourceTags.sourceId, id)),
			db
				.select({ relation: sourceRelations, source: sources })
				.from(sourceRelations)
				.innerJoin(sources, eq(sourceRelations.toSourceId, sources.id))
				// Only accepted relations whose OTHER endpoint (the joined source) is
				// itself active — a candidate/rejected edge, or one pointing at a
				// hidden/merged source, is never shown on the detail page.
				.where(and(eq(sourceRelations.fromSourceId, id), publicRelationsOnly(), activeSourcesOnly())),
			db
				.select({ relation: sourceRelations, source: sources })
				.from(sourceRelations)
				.innerJoin(sources, eq(sourceRelations.fromSourceId, sources.id))
				.where(and(eq(sourceRelations.toSourceId, id), publicRelationsOnly(), activeSourcesOnly())),
			db.select({ n: count() }).from(sourceRevisions).where(eq(sourceRevisions.sourceId, id))
		]);

	const personsR: PersonRef[] = personRows.map((r) => ({ ...r.person, role: r.role }));
	const placesR: PlaceRef[] = placeRows.map((r) => ({ ...r.place, role: r.role }));
	const instR: InstitutionRef[] = instRows.map((r) => ({
		...r.institution,
		role: r.role,
		callNumber: r.callNumber
	}));
	const related: RelatedSource[] = [
		...relOut.map((r) => ({ relation: r.relation, source: r.source, direction: 'out' as const })),
		...relIn.map((r) => ({ relation: r.relation, source: r.source, direction: 'in' as const }))
	];

	return {
		source,
		links,
		persons: personsR,
		places: placesR,
		institutions: instR,
		tags: tagRows.map((r) => r.tag),
		related,
		revisionCount: revCount[0]?.n ?? 0
	};
}

// ---------------------------------------------------------------------------
// Stats / timeline / map
// ---------------------------------------------------------------------------

export async function getStats(): Promise<DbStats> {
	const rows = await db
		.select({
			category: sources.category,
			region: sources.region,
			type: sources.type,
			languages: sources.languages,
			yearStart: sources.yearStart
		})
		.from(sources)
		.where(activeSourcesOnly());
	const [pc, plc, ic, dig] = await Promise.all([
		db.select({ n: count() }).from(persons),
		db.select({ n: count() }).from(places),
		db.select({ n: count() }).from(institutions),
		// "with digital access" = active sources that have ≥1 link (join sources so
		// a link hanging off a hidden/merged source is not counted).
		db
			.select({ n: sql<number>`count(distinct ${sourceLinks.sourceId})` })
			.from(sourceLinks)
			.innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
			.where(activeSourcesOnly())
	]);
	const years = rows.map((r) => r.yearStart).filter((y): y is number => y != null);
	return {
		total: rows.length,
		byCategory: tally(rows.map((r) => r.category)),
		byRegion: tally(rows.map((r) => r.region ?? '')),
		byType: tally(rows.map((r) => r.type)),
		byLanguage: tally(rows.flatMap((r) => asArray(r.languages))),
		personCount: pc[0]?.n ?? 0,
		placeCount: plc[0]?.n ?? 0,
		institutionCount: ic[0]?.n ?? 0,
		yearMin: years.length ? Math.min(...years) : null,
		yearMax: years.length ? Math.max(...years) : null,
		withDigital: dig[0]?.n ?? 0
	};
}

export async function getTimeline(): Promise<TimelinePoint[]> {
	const rows = await db
		.select({
			slug: sources.slug,
			title: sources.title,
			titleEn: sources.titleEn,
			yearStart: sources.yearStart,
			yearEnd: sources.yearEnd,
			yearCertainty: sources.yearCertainty,
			category: sources.category,
			type: sources.type,
			region: sources.region
		})
		.from(sources)
		.where(activeSourcesOnly())
		.orderBy(asc(sources.yearStart));
	return rows.filter((r): r is TimelinePoint => r.yearStart != null);
}

export async function getMapPlaces(): Promise<MapPlace[]> {
	const rows = await db
		.select({
			id: places.id,
			slug: places.slug,
			name: places.name,
			nameEn: places.nameEn,
			region: places.region,
			kind: places.kind,
			lat: places.lat,
			lng: places.lng,
			// Count only active sources for the map badge: the inner-most join keeps a
			// place even with zero active sources (leftJoin), but counts only the
			// active ones. Identical to count(sourcePlaces.sourceId) when all active.
			sourceCount: sql<number>`count(${sources.id})`
		})
		.from(places)
		.leftJoin(sourcePlaces, eq(sourcePlaces.placeId, places.id))
		.leftJoin(sources, and(eq(sources.id, sourcePlaces.sourceId), activeSourcesOnly()))
		.groupBy(places.id);
	return rows.filter((r): r is MapPlace => r.lat != null && r.lng != null);
}

// ---------------------------------------------------------------------------
// Persons / places / institutions / tags directories
// ---------------------------------------------------------------------------

export interface PersonWithCount extends Person {
	sourceCount: number;
	roles: string[];
}

export interface PersonListOptions {
	q?: string;
	role?: string;
	sort?: 'count' | 'name' | 'name-desc';
}

export async function listPersons(opts: PersonListOptions = {}): Promise<PersonWithCount[]> {
	const conds: SQLCond[] = [];
	if (opts.q && opts.q.trim()) {
		const q = `%${opts.q.trim()}%`;
		conds.push(or(like(persons.name, q), like(persons.nameEn, q))!);
	}
	if (opts.role) {
		conds.push(
			inArray(
				persons.id,
				db
					.select({ id: sourcePersons.personId })
					.from(sourcePersons)
					.where(eq(sourcePersons.role, opts.role))
			)
		);
	}

	// Count + role labels reflect only ACTIVE works: the second leftJoin keeps the
	// person row even with zero active sources, but `sources.id` is non-null only
	// for an active link, so count/roles ignore hidden/merged/candidate works. All
	// no-ops when every source is active (sources.id then matches every link).
	const cnt = sql<number>`count(${sources.id})`;
	const order =
		opts.sort === 'name'
			? [asc(persons.name)]
			: opts.sort === 'name-desc'
				? [desc(persons.name)]
				: [desc(cnt), asc(persons.name)];

	const rows = await db
		.select({
			person: persons,
			n: cnt,
			roles: sql<string | null>`group_concat(distinct case when ${sources.id} is not null then ${sourcePersons.role} end)`
		})
		.from(persons)
		.leftJoin(sourcePersons, eq(sourcePersons.personId, persons.id))
		.leftJoin(sources, and(eq(sources.id, sourcePersons.sourceId), activeSourcesOnly()))
		.where(conds.length ? and(...conds) : undefined)
		.groupBy(persons.id)
		.orderBy(...order);

	return rows.map((r) => ({
		...r.person,
		sourceCount: r.n,
		roles: r.roles ? r.roles.split(',').filter(Boolean) : []
	}));
}

/** Distinct person roles present in the data, for the People filter dropdown. */
export async function listPersonRoles(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ role: sourcePersons.role })
		.from(sourcePersons)
		.orderBy(asc(sourcePersons.role));
	return rows.map((r) => r.role).filter(Boolean);
}

export interface PersonArea {
	slug: string;
	name: string;
	nameEn: string | null;
	category: string;
	count: number;
}
export async function getPersonBySlug(
	slug: string
): Promise<
	| { person: Person; sources: { source: Source; role: string }[]; areas: PersonArea[] }
	| undefined
> {
	const r = await db.select().from(persons).where(eq(persons.slug, slug)).limit(1);
	const person = r[0];
	if (!person) return undefined;
	const srcRows = await db
		.select({ source: sources, role: sourcePersons.role })
		.from(sourcePersons)
		.innerJoin(sources, eq(sourcePersons.sourceId, sources.id))
		.where(and(eq(sourcePersons.personId, person.id), activeSourcesOnly()))
		.orderBy(asc(sources.yearStart));
	// A merged person can carry the same (source, role) twice — dedupe so the page's
	// keyed {#each} doesn't get duplicate keys (which crashes hydration).
	const seenSR = new Set<string>();
	const srcs = srcRows.filter((r) => {
		const k = `${r.source.id}\t${r.role}`;
		if (seenSR.has(k)) return false;
		seenSR.add(k);
		return true;
	});
	// Research areas = the topical/genre tags of this person's works, by frequency.
	// Derived from real publications, so a grammarian surfaces 文法, a comparatist
	// 比較・系統, an oral-literature scholar 口承文芸.
	const areaRows = await db
		.select({
			slug: tags.slug,
			name: tags.name,
			nameEn: tags.nameEn,
			category: tags.category,
			// Count distinct works: a person can hold the same source twice (e.g. two
			// roles), and the join would otherwise multiply the tag's tally.
			n: countDistinct(sourcePersons.sourceId)
		})
		.from(sourcePersons)
		.innerJoin(sources, eq(sources.id, sourcePersons.sourceId))
		.innerJoin(sourceTags, eq(sourceTags.sourceId, sourcePersons.sourceId))
		.innerJoin(tags, eq(tags.id, sourceTags.tagId))
		.where(and(eq(sourcePersons.personId, person.id), activeSourcesOnly()))
		.groupBy(tags.id)
		.orderBy(desc(countDistinct(sourcePersons.sourceId)));
	const areas: PersonArea[] = areaRows.map((a) => ({
		slug: a.slug,
		name: a.name,
		nameEn: a.nameEn,
		category: a.category,
		count: a.n
	}));
	return { person, sources: srcs, areas };
}

export interface PlaceWithCount extends Place {
	sourceCount: number;
}
export async function listPlaces(): Promise<PlaceWithCount[]> {
	const rows = await db
		.select({ place: places, n: sql<number>`count(${sources.id})` })
		.from(places)
		.leftJoin(sourcePlaces, eq(sourcePlaces.placeId, places.id))
		.leftJoin(sources, and(eq(sources.id, sourcePlaces.sourceId), activeSourcesOnly()))
		.groupBy(places.id)
		.orderBy(desc(sql`count(${sources.id})`), asc(places.name));
	return rows.map((r) => ({ ...r.place, sourceCount: r.n }));
}

export async function getPlaceBySlug(
	slug: string
): Promise<{ place: Place; sources: { source: Source; role: string }[] } | undefined> {
	const r = await db.select().from(places).where(eq(places.slug, slug)).limit(1);
	const place = r[0];
	if (!place) return undefined;
	const srcs = await db
		.select({ source: sources, role: sourcePlaces.role })
		.from(sourcePlaces)
		.innerJoin(sources, eq(sourcePlaces.sourceId, sources.id))
		.where(and(eq(sourcePlaces.placeId, place.id), activeSourcesOnly()))
		.orderBy(asc(sources.yearStart));
	return { place, sources: srcs };
}

export interface InstitutionWithCount extends Institution {
	sourceCount: number;
}
export async function listInstitutions(): Promise<InstitutionWithCount[]> {
	const rows = await db
		.select({ inst: institutions, n: sql<number>`count(${sources.id})` })
		.from(institutions)
		.leftJoin(sourceInstitutions, eq(sourceInstitutions.institutionId, institutions.id))
		.leftJoin(sources, and(eq(sources.id, sourceInstitutions.sourceId), activeSourcesOnly()))
		.groupBy(institutions.id)
		.orderBy(desc(sql`count(${sources.id})`), asc(institutions.name));
	return rows.map((r) => ({ ...r.inst, sourceCount: r.n }));
}

export async function getInstitutionBySlug(
	slug: string
): Promise<{ institution: Institution; sources: { source: Source; role: string }[] } | undefined> {
	const r = await db.select().from(institutions).where(eq(institutions.slug, slug)).limit(1);
	const institution = r[0];
	if (!institution) return undefined;
	const srcs = await db
		.select({ source: sources, role: sourceInstitutions.role })
		.from(sourceInstitutions)
		.innerJoin(sources, eq(sourceInstitutions.sourceId, sources.id))
		.where(and(eq(sourceInstitutions.institutionId, institution.id), activeSourcesOnly()))
		.orderBy(asc(sources.yearStart));
	return { institution, sources: srcs };
}

export interface TagWithCount extends Tag {
	sourceCount: number;
}
export async function listTags(): Promise<TagWithCount[]> {
	const rows = await db
		.select({ tag: tags, n: sql<number>`count(${sources.id})` })
		.from(tags)
		.leftJoin(sourceTags, eq(sourceTags.tagId, tags.id))
		.leftJoin(sources, and(eq(sources.id, sourceTags.sourceId), activeSourcesOnly()))
		.groupBy(tags.id)
		.orderBy(desc(sql`count(${sources.id})`), asc(tags.name));
	return rows.map((r) => ({ ...r.tag, sourceCount: r.n }));
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapEntries {
	sources: { slug: string; updatedAt: Date }[];
	persons: { slug: string; updatedAt: Date }[];
	places: { slug: string }[];
	institutions: { slug: string }[];
}

/** Slugs (+ lastmod where available) for every public, indexable detail page. */
export async function getSitemapEntries(): Promise<SitemapEntries> {
	const [s, pe, pl, inst] = await Promise.all([
		db.select({ slug: sources.slug, updatedAt: sources.updatedAt }).from(sources).where(activeSourcesOnly()).orderBy(asc(sources.slug)),
		db.select({ slug: persons.slug, updatedAt: persons.updatedAt }).from(persons).orderBy(asc(persons.slug)),
		db.select({ slug: places.slug }).from(places).orderBy(asc(places.slug)),
		db.select({ slug: institutions.slug }).from(institutions).orderBy(asc(institutions.slug))
	]);
	return { sources: s, persons: pe, places: pl, institutions: inst };
}

// ---------------------------------------------------------------------------
// Quick search (for the live search box / API)
// ---------------------------------------------------------------------------

export async function quickSearch(q: string, limit = 8): Promise<Source[]> {
	if (!q.trim()) return [];
	const term = `%${q.trim()}%`;
	return db
		.select()
		.from(sources)
		.where(
			and(
				activeSourcesOnly(),
				or(
					like(sources.title, term),
					like(sources.titleEn, term),
					like(sources.author, term),
					like(sources.dialect, term)
				)
			)
		)
		.orderBy(asc(sources.yearStart))
		.limit(limit);
}

// ---------------------------------------------------------------------------
// Editing (wiki) — create / update with revision history
// ---------------------------------------------------------------------------

export interface SourceInput {
	/** Explicit slug — honored on CREATE only and validated by the entry points
	 *  (see `explicitSlugError`); an update never re-mints a slug (renames go
	 *  through scripts/apply-reslug.ts so the redirect is recorded). */
	slug?: string | null;
	title: string;
	titleEn?: string | null;
	titleAin?: string | null;
	category: string;
	type: string;
	author?: string | null;
	yearText?: string | null;
	yearStart?: number | null;
	yearEnd?: number | null;
	yearCertainty?: string | null;
	dialect?: string | null;
	region?: string | null;
	languages?: string[];
	scripts?: string[];
	holdingInstitution?: string | null;
	callNumber?: string | null;
	entryCount?: number | null;
	entryCountLabel?: string | null;
	license?: string | null;
	summary?: string | null;
	notes?: string | null;
	reliability?: string | null;
	links?: { type: string; label?: string | null; url: string }[];
	tagNames?: string[];
}

/**
 * The flat `sources` column mapping the PRE-cutover write path produced. The
 * merge path (see merge-write.ts) reproduces this for scalar/controlled fields
 * via an `editorial_decision` claim, so it stays exported as the canonical
 * equivalence reference the cutover test asserts against.
 */
export function scalarValues(input: SourceInput) {
	return {
		title: input.title,
		titleEn: input.titleEn || null,
		titleAin: input.titleAin || null,
		category: input.category,
		type: input.type,
		author: input.author || null,
		yearText: input.yearText || null,
		yearStart: input.yearStart ?? null,
		yearEnd: input.yearEnd ?? null,
		yearCertainty: input.yearCertainty || 'exact',
		dialect: input.dialect || null,
		region: input.region || null,
		languages: input.languages?.length ? input.languages : null,
		scripts: input.scripts?.length ? input.scripts : null,
		holdingInstitution: input.holdingInstitution || null,
		callNumber: input.callNumber || null,
		entryCount: input.entryCount ?? null,
		entryCountLabel: input.entryCountLabel || null,
		license: input.license || null,
		summary: input.summary || null,
		notes: input.notes || null,
		reliability: input.reliability || null
	};
}

export interface EditUser {
	id?: string;
	name?: string;
}

/**
 * Create a source through the merge engine (the "cutover"). The on-site write
 * path no longer mutates `sources`/links/tags directly — it submits an
 * `editorial_decision` observation so the edit is band-900 (wins over any
 * machine claim) and harvested data is preserved no-loss. Returns the new slug
 * for the post-save redirect PLUS the full `MergeResult` so the caller can
 * surface a held/conflict outcome instead of silently discarding it (N4).
 */
export async function createSource(
	input: SourceInput,
	user: EditUser,
	summary?: string
): Promise<WebsiteEditResult> {
	return createSourceOnApp(input, user, summary);
}

/** Update a source through the merge engine (see `createSource`). */
export async function updateSource(
	id: string,
	input: SourceInput,
	user: EditUser,
	summary?: string
): Promise<WebsiteEditResult> {
	return updateSourceOnApp(id, input, user, summary);
}

/**
 * Revisions for the /history page — a SINGLE bounded query. Projects ONLY the
 * five columns the timeline renders and explicitly EXCLUDES the per-revision
 * `snapshot` JSON blob (each snapshot embeds the full source + links + tags, so
 * `select()` here pulled megabytes for a frequently-edited source and made the
 * loader a heavyweight serialize — a contributor to /history slowness under the
 * cutover). Capped so the page can never fan out an unbounded result set.
 */
const HISTORY_LIMIT = 200;
export async function getRevisions(sourceId: string) {
	return db
		.select({
			id: sourceRevisions.id,
			action: sourceRevisions.action,
			userName: sourceRevisions.userName,
			summary: sourceRevisions.summary,
			createdAt: sourceRevisions.createdAt
		})
		.from(sourceRevisions)
		.where(eq(sourceRevisions.sourceId, sourceId))
		.orderBy(desc(sourceRevisions.createdAt))
		.limit(HISTORY_LIMIT);
}

/**
 * /history data — revisions (who/when/summary) + the per-observation applied
 * diffs (what changed), in ONE bounded round-trip (a `db.batch` of two capped
 * selects). No per-row `__data.json` fan-out — the pattern that hung /history
 * (see db/index.ts). The diff JSON is the full `SourceDiff`; the page renders its
 * scalar before→after table and collection +/−/~ deltas.
 */
export async function getSourceHistory(sourceId: string) {
	const [revisions, diffs] = await db.batch([
		db
			.select({
				id: sourceRevisions.id,
				action: sourceRevisions.action,
				userName: sourceRevisions.userName,
				summary: sourceRevisions.summary,
				createdAt: sourceRevisions.createdAt
			})
			.from(sourceRevisions)
			.where(eq(sourceRevisions.sourceId, sourceId))
			.orderBy(desc(sourceRevisions.createdAt))
			.limit(HISTORY_LIMIT),
		db
			.select({
				id: sourceObservationDiffs.id,
				diffKind: sourceObservationDiffs.diffKind,
				isNewSource: sourceObservationDiffs.isNewSource,
				hasConflicts: sourceObservationDiffs.hasConflicts,
				changedScalarFields: sourceObservationDiffs.changedScalarFields,
				changedCollections: sourceObservationDiffs.changedCollections,
				diff: sourceObservationDiffs.diff,
				createdAt: sourceObservationDiffs.createdAt
			})
			.from(sourceObservationDiffs)
			.where(eq(sourceObservationDiffs.sourceId, sourceId))
			.orderBy(desc(sourceObservationDiffs.createdAt))
			.limit(HISTORY_LIMIT)
	]);
	return { revisions, diffs };
}

// ---------------------------------------------------------------------------
// Content audit — data-quality review of the catalogue (public, read-only).
// ---------------------------------------------------------------------------

/** Compact source row shown in audit lists. */
export interface AuditSource {
	slug: string;
	title: string;
	titleEn: string | null;
	yearText: string | null;
	type: string;
}

export interface ContentAudit {
	total: number;
	/** Per-bucket total counts (full, not capped). */
	missingCounts: { year: number; region: number; language: number; summary: number };
	/** Capped sample lists for each missing-metadata bucket. */
	missing: { year: AuditSource[]; region: AuditSource[]; language: AuditSource[]; summary: AuditSource[] };
	/** Groups of records sharing a normalized title (likely duplicates). */
	duplicates: { key: string; items: AuditSource[] }[];
	duplicateGroups: number;
	/** Persons with linked works but no verified Wikidata QID, by work count. */
	weakPersons: { slug: string; name: string; nameEn: string | null; works: number }[];
	weakPersonTotal: number;
}

const AUDIT_CAP = 100; // max rows shown per bucket (the counts above are full)

/** Normalize a title for near-duplicate grouping: NFKC, lowercased, with spaces
 * and common punctuation stripped so trivially-different titles collapse. */
function dupKey(title: string): string {
	return title
		.normalize('NFKC')
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/["'’“”「」『』（）()[\]【】、。,.・:;!?\-–—_/]/g, '');
}

export async function getContentAudit(): Promise<ContentAudit> {
	const rows = await db
		.select({
			slug: sources.slug,
			title: sources.title,
			titleEn: sources.titleEn,
			yearText: sources.yearText,
			yearStart: sources.yearStart,
			type: sources.type,
			region: sources.region,
			languages: sources.languages,
			summary: sources.summary
		})
		.from(sources);

	const lite = (r: (typeof rows)[number]): AuditSource => ({
		slug: r.slug,
		title: r.title,
		titleEn: r.titleEn,
		yearText: r.yearText,
		type: r.type
	});
	const blank = (s: string | null) => !s || !s.trim();

	const year: AuditSource[] = [];
	const region: AuditSource[] = [];
	const language: AuditSource[] = [];
	const summary: AuditSource[] = [];
	const byKey = new Map<string, AuditSource[]>();

	for (const r of rows) {
		if (r.yearStart == null && blank(r.yearText)) year.push(lite(r));
		if (blank(r.region)) region.push(lite(r));
		if (!asArray(r.languages).length) language.push(lite(r));
		if (blank(r.summary)) summary.push(lite(r));
		const k = dupKey(r.title);
		if (k) {
			const g = byKey.get(k);
			if (g) g.push(lite(r));
			else byKey.set(k, [lite(r)]);
		}
	}

	const duplicates = [...byKey.entries()]
		.filter(([, items]) => items.length > 1)
		.map(([key, items]) => ({ key, items }))
		.sort((a, b) => b.items.length - a.items.length);

	// Persons with ≥1 linked work but no verified Wikidata identity (incl. the
	// nulled mis-disambiguations — they surface here as needing a real match).
	const weak = await db
		.select({
			slug: persons.slug,
			name: persons.name,
			nameEn: persons.nameEn,
			works: countDistinct(sourcePersons.sourceId)
		})
		.from(persons)
		.leftJoin(sourcePersons, eq(sourcePersons.personId, persons.id))
		.where(sql`(${persons.wikidata} is null or ${persons.wikidata} = '')`)
		.groupBy(persons.id)
		.having(sql`count(distinct ${sourcePersons.sourceId}) > 0`)
		.orderBy(desc(countDistinct(sourcePersons.sourceId)), asc(persons.name));

	return {
		total: rows.length,
		missingCounts: {
			year: year.length,
			region: region.length,
			language: language.length,
			summary: summary.length
		},
		missing: {
			year: year.slice(0, AUDIT_CAP),
			region: region.slice(0, AUDIT_CAP),
			language: language.slice(0, AUDIT_CAP),
			summary: summary.slice(0, AUDIT_CAP)
		},
		duplicates: duplicates.slice(0, AUDIT_CAP),
		duplicateGroups: duplicates.length,
		weakPersons: weak.slice(0, AUDIT_CAP),
		weakPersonTotal: weak.length
	};
}

export { SEEDED };

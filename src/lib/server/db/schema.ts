import { integer, sqliteTable, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * アイヌ語文献資料データベース — data model
 *
 * Central entity is `sources` (資料): any historical document, dictionary,
 * wordlist, grammar study or corpus text. Everything else hangs off it.
 */

const uuid = () => crypto.randomUUID();
const now = () => new Date();

// ---------------------------------------------------------------------------
// Sources (資料) — the central entity
// ---------------------------------------------------------------------------
export const sources = sqliteTable(
	'sources',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		/** human-readable stable identifier, e.g. "1875-dobrotvorsky-ainu-russian-dictionary" */
		slug: text('slug').notNull(),

		// --- titles ---
		title: text('title').notNull(), // original / Japanese title
		titleEn: text('title_en'),
		titleAin: text('title_ain'),
		altTitles: text('alt_titles', { mode: 'json' }).$type<string[]>(),

		// --- classification ---
		/** broad bucket: 'primary' (一次資料) | 'secondary' (研究文献) | 'corpus' (コーパス) */
		category: text('category').notNull().default('primary'),
		/** fine type: old-document, dictionary, wordlist, comparative-wordlist,
		 *  topical-dictionary, grammar-book, grammar-article, corpus-text, ... */
		type: text('type').notNull(),

		// --- responsibility ---
		author: text('author'), // free-form display string (normalised links live in sourcePersons)

		// --- chronology (年代) ---
		yearText: text('year_text'), // verbatim, may be "", "1867/1872", "2005–2007", "c.1700"
		yearStart: integer('year_start'), // numeric, for sorting / timeline
		yearEnd: integer('year_end'),
		/** 'exact' | 'range' | 'estimated' | 'unknown' */
		yearCertainty: text('year_certainty').default('exact'),

		// --- geography / dialect (地域・方言) ---
		dialect: text('dialect'), // raw dialect string from source data
		/** normalised: 'hokkaido' | 'sakhalin' | 'kuril' | 'proto' | '' */
		region: text('region'),

		// --- linguistic metadata ---
		languages: text('languages', { mode: 'json' }).$type<string[]>(), // ISO-ish: ain, jpn, rus, eng, lat...
		scripts: text('scripts', { mode: 'json' }).$type<string[]>(), // kana, latn, cyrl, kanji

		// --- holdings ---
		holdingInstitution: text('holding_institution'),
		callNumber: text('call_number'),

		// --- scale ---
		entryCount: integer('entry_count'),
		/** what entryCount counts: 'entries' | 'sentences' | 'pages' | 'lemmas' */
		entryCountLabel: text('entry_count_label'),

		// --- rights ---
		license: text('license'),

		// --- prose ---
		summary: text('summary'), // short description (markdown allowed)
		notes: text('notes'), // longer notes / 翻刻・解読メモ
		reliability: text('reliability'),

		// --- provenance (how it got into the DB) ---
		/** 'ainu-dictionaries' | 'ainu-grammar' | 'ainu-corpora' | 'manual' */
		provenanceRepo: text('provenance_repo').notNull().default('manual'),
		provenancePath: text('provenance_path'),

		// --- external identifiers ---
		externalIds: text('external_ids', { mode: 'json' }).$type<Record<string, string>>(),

		// --- flags ---
		featured: integer('featured', { mode: 'boolean' }).notNull().default(false),

		// --- audit ---
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		createdBy: text('created_by'),
		updatedBy: text('updated_by')
	},
	(t) => [
		uniqueIndex('sources_slug_idx').on(t.slug),
		index('sources_type_idx').on(t.type),
		index('sources_category_idx').on(t.category),
		index('sources_region_idx').on(t.region),
		index('sources_year_idx').on(t.yearStart)
	]
);

// ---------------------------------------------------------------------------
// Digital access / external links (デジタルアクセス情報)
// ---------------------------------------------------------------------------
export const sourceLinks = sqliteTable(
	'source_links',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		/** iiif | image | opac | cinii | ndl | doi | transcription | github | wikidata | pdf | website | api | other */
		type: text('type').notNull().default('website'),
		label: text('label'),
		url: text('url').notNull(),
		notes: text('notes'),
		sortOrder: integer('sort_order').notNull().default(0)
	},
	(t) => [index('source_links_source_idx').on(t.sourceId)]
);

// ---------------------------------------------------------------------------
// Persons (人物) — authors, recorders, speakers, researchers
// ---------------------------------------------------------------------------
export const persons = sqliteTable(
	'persons',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		slug: text('slug').notNull(),
		name: text('name').notNull(), // display name
		nameEn: text('name_en'),
		nameKana: text('name_kana'),
		nameAin: text('name_ain'),
		birthYear: integer('birth_year'),
		deathYear: integer('death_year'),
		wikidata: text('wikidata'), // Wikidata QID, e.g. "Q12345"
		wikipedia: text('wikipedia'), // verified Wikipedia article URL (only set when it exists)
		researchmap: text('researchmap'), // researchmap.jp permalink, e.g. "y.yoshikawa"
		bio: text('bio'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [uniqueIndex('persons_slug_idx').on(t.slug)]
);

export const sourcePersons = sqliteTable(
	'source_persons',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		personId: text('person_id')
			.notNull()
			.references(() => persons.id, { onDelete: 'cascade' }),
		/** author | editor | compiler | recorder | speaker | transcriber | translator | researcher */
		role: text('role').notNull().default('author'),
		sortOrder: integer('sort_order').notNull().default(0)
	},
	(t) => [
		index('source_persons_source_idx').on(t.sourceId),
		index('source_persons_person_idx').on(t.personId)
	]
);

// ---------------------------------------------------------------------------
// Places (地点) — composition place, record region, dialect area, subject
// ---------------------------------------------------------------------------
export const places = sqliteTable(
	'places',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		nameEn: text('name_en'),
		nameAin: text('name_ain'),
		/** region | settlement | island | river */
		kind: text('kind').notNull().default('region'),
		/** hokkaido | sakhalin | kuril | other */
		region: text('region'),
		lat: real('lat'),
		lng: real('lng'),
		geonames: text('geonames'),
		wikidata: text('wikidata'),
		notes: text('notes')
	},
	(t) => [uniqueIndex('places_slug_idx').on(t.slug)]
);

export const sourcePlaces = sqliteTable(
	'source_places',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		placeId: text('place_id')
			.notNull()
			.references(() => places.id, { onDelete: 'cascade' }),
		/** composition | record | dialect | subject | holding */
		role: text('role').notNull().default('dialect'),
		notes: text('notes')
	},
	(t) => [
		index('source_places_source_idx').on(t.sourceId),
		index('source_places_place_idx').on(t.placeId)
	]
);

// ---------------------------------------------------------------------------
// Institutions (機関) — libraries, museums, universities
// ---------------------------------------------------------------------------
export const institutions = sqliteTable(
	'institutions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		nameEn: text('name_en'),
		country: text('country'),
		city: text('city'),
		lat: real('lat'),
		lng: real('lng'),
		url: text('url'),
		wikidata: text('wikidata'),
		notes: text('notes')
	},
	(t) => [uniqueIndex('institutions_slug_idx').on(t.slug)]
);

export const sourceInstitutions = sqliteTable(
	'source_institutions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		institutionId: text('institution_id')
			.notNull()
			.references(() => institutions.id, { onDelete: 'cascade' }),
		/** holding | publisher | digitizer */
		role: text('role').notNull().default('holding'),
		callNumber: text('call_number'),
		notes: text('notes')
	},
	(t) => [
		index('source_institutions_source_idx').on(t.sourceId),
		index('source_institutions_institution_idx').on(t.institutionId)
	]
);

// ---------------------------------------------------------------------------
// Source-to-source relations (文献ネットワーク・伝本関係)
// ---------------------------------------------------------------------------
export const sourceRelations = sqliteTable(
	'source_relations',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		fromSourceId: text('from_source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		toSourceId: text('to_source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		/** cites | manuscript-of | edition-of | transcription-of | derived-from | related | same-work */
		type: text('type').notNull().default('related'),
		notes: text('notes')
	},
	(t) => [
		index('source_relations_from_idx').on(t.fromSourceId),
		index('source_relations_to_idx').on(t.toSourceId)
	]
);

// ---------------------------------------------------------------------------
// Tags (タグ) — free-form topical / genre / feature labels
// ---------------------------------------------------------------------------
export const tags = sqliteTable(
	'tags',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		nameEn: text('name_en'),
		/** topic | genre | feature | dialect */
		category: text('category').notNull().default('topic'),
		description: text('description')
	},
	(t) => [uniqueIndex('tags_slug_idx').on(t.slug)]
);

export const sourceTags = sqliteTable(
	'source_tags',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		tagId: text('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' })
	},
	(t) => [index('source_tags_source_idx').on(t.sourceId), index('source_tags_tag_idx').on(t.tagId)]
);

// ---------------------------------------------------------------------------
// Revisions (編集履歴) — JSON snapshot of a source on each edit
// ---------------------------------------------------------------------------
export const sourceRevisions = sqliteTable(
	'source_revisions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		userId: text('user_id'),
		userName: text('user_name'),
		summary: text('summary'),
		/** 'create' | 'update' | 'delete' */
		action: text('action').notNull().default('update'),
		snapshot: text('snapshot', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
	},
	(t) => [index('source_revisions_source_idx').on(t.sourceId)]
);

// --- inferred row types ---
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceLink = typeof sourceLinks.$inferSelect;
export type Person = typeof persons.$inferSelect;
export type Place = typeof places.$inferSelect;
export type Institution = typeof institutions.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type SourceRelation = typeof sourceRelations.$inferSelect;
export type SourceRevision = typeof sourceRevisions.$inferSelect;

export * from './auth.schema';

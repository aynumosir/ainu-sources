import {
	integer,
	sqliteTable,
	text,
	real,
	index,
	uniqueIndex,
	check,
	primaryKey,
	type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.schema';
import type { SourceDiff } from '../merge/diff';

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
		 *  topical-dictionary, grammar, book, article, corpus-text, ... */
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
		humanDownload: integer('human_download', { mode: 'boolean' }).notNull().default(false),
		localProcessing: integer('local_processing', { mode: 'boolean' }).notNull().default(false),
		hostedAiText: integer('hosted_ai_text', { mode: 'boolean' }).notNull().default(false),
		hostedAiImages: integer('hosted_ai_images', { mode: 'boolean' }).notNull().default(false),
		bulkExport: integer('bulk_export', { mode: 'boolean' }).notNull().default(false),

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
		updatedBy: text('updated_by'),

		// --- durability / lifecycle (Phase 2 additive) ---
		/** active | candidate | merged | deprecated | hidden | soft_deleted */
		status: text('status').notNull().default('active'),
		/** when status='merged', the winning source this row folds into (soft-merge) */
		mergedIntoSourceId: text('merged_into_source_id').references(
			(): AnySQLiteColumn => sources.id,
			{ onDelete: 'restrict' }
		),
		/** current | drifted | missing | conflict — upstream observation drift */
		driftStatus: text('drift_status').notNull().default('current'),
		/** hash of the canonical flat projection (engine-maintained) */
		contentHash: text('content_hash'),
		/** normalizer version that produced contentHash / projection */
		normalizerVersion: integer('normalizer_version'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
		contentChangedAt: integer('content_changed_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('sources_slug_idx').on(t.slug),
		index('sources_type_idx').on(t.type),
		index('sources_category_idx').on(t.category),
		index('sources_region_idx').on(t.region),
		index('sources_year_idx').on(t.yearStart),
		index('sources_status_idx').on(t.status),
		index('sources_merged_into_idx').on(t.mergedIntoSourceId),
		index('sources_content_hash_idx').on(t.contentHash)
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
		sortOrder: integer('sort_order').notNull().default(0),

		// --- durability / lifecycle (Phase 2 additive) ---
		/** active | candidate | removed | rejected | deprecated (removal = status, never delete) */
		status: text('status').notNull().default('active'),
		origin: text('origin'),
		derivation: text('derivation'),
		confidence: real('confidence'),
		evidence: integer('evidence'),
		contentHash: text('content_hash'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	// NOTE: UNIQUE(source_id, type, url) is DEFERRED to the bootstrap/dedup phase —
	// existing populated rows may contain duplicates that would break a unique index.
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
		orcid: text('orcid'), // ORCID iD, e.g. "0000-0002-1825-0097"
		bio: text('bio'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').notNull().default('active'),
		origin: text('origin'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('persons_slug_idx').on(t.slug),
		// partial unique: only enforced where orcid is set (column is new/empty → safe)
		uniqueIndex('persons_orcid_idx')
			.on(t.orcid)
			.where(sql`${t.orcid} is not null`)
	]
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
		sortOrder: integer('sort_order').notNull().default(0),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').default('active'),
		origin: text('origin'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		confidence: real('confidence'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	// NOTE: UNIQUE(source_id, person_id, role) DEFERRED to bootstrap/dedup phase.
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
		notes: text('notes'),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').notNull().default('active'),
		origin: text('origin'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
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
		notes: text('notes'),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').default('active'),
		origin: text('origin'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		confidence: real('confidence'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	// NOTE: UNIQUE(source_id, place_id, role) DEFERRED to bootstrap/dedup phase.
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
		ror: text('ror'), // ROR id, e.g. "https://ror.org/03vek6s52" / "03vek6s52"
		notes: text('notes'),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').notNull().default('active'),
		origin: text('origin'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('institutions_slug_idx').on(t.slug),
		// partial unique: only enforced where ror is set (column is new/empty → safe)
		uniqueIndex('institutions_ror_idx')
			.on(t.ror)
			.where(sql`${t.ror} is not null`)
	]
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
		notes: text('notes'),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').default('active'),
		origin: text('origin'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		confidence: real('confidence'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	// NOTE: UNIQUE(source_id, institution_id, role) DEFERRED to bootstrap/dedup phase.
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
		notes: text('notes'),

		// --- durability / lifecycle (Phase 2 additive) ---
		/** accepted | candidate | rejected | removed */
		status: text('status').notNull().default('accepted'),
		origin: text('origin'),
		derivation: text('derivation'),
		confidence: real('confidence'),
		evidence: integer('evidence'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		})
	},
	// NOTE: UNIQUE(from_source_id, to_source_id, type) DEFERRED to bootstrap/dedup phase.
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
		description: text('description'),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').notNull().default('active'),
		origin: text('origin'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
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
			.references(() => tags.id, { onDelete: 'cascade' }),

		// --- durability / lifecycle (Phase 2 additive) ---
		status: text('status').default('active'),
		origin: text('origin'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		confidence: real('confidence'),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	// NOTE: UNIQUE(source_id, tag_id) DEFERRED to bootstrap/dedup phase.
	(t) => [index('source_tags_source_idx').on(t.sourceId), index('source_tags_tag_idx').on(t.tagId)]
);

// ---------------------------------------------------------------------------
// Slug redirects (スラッグ転送) — the "old slugs never break" ledger
//
// When a source's slug is renamed (e.g. the planned database-wide re-slug), the
// previous slug is recorded here so every public slug lookup can fall through
// to a 301 redirect at the CURRENT slug. Append-only: `restrict` (never
// cascade) matches the no-hard-delete invariant — a redirect must outlive any
// attempt to hard-delete its source, exactly like `source_revisions`.
// ---------------------------------------------------------------------------
export const slugRedirects = sqliteTable(
	'slug_redirects',
	{
		/** the retired slug — globally unique, may never be re-minted */
		oldSlug: text('old_slug').primaryKey(),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'restrict' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [index('slug_redirects_source_idx').on(t.sourceId)]
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
			.references(() => sources.id, { onDelete: 'restrict' }),
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

// ===========================================================================
// Phase 2 — Durability ledger / identity / provenance (ADDITIVE)
//
// All foreign keys here are `restrict` or `set null` — NEVER cascade — so that
// the no-hard-delete invariant holds and canonical/ledger data is never lost by
// a parent deletion. These tables are append-only or current-winner projections
// maintained by the merge engine (Phase 4); they are created empty here.
// ===========================================================================

// ---------------------------------------------------------------------------
// Observation runs (収集ラン) — one row per harvest/import/website-write run
// ---------------------------------------------------------------------------
export const sourceObservationRuns = sqliteTable(
	'source_observation_runs',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		origin: text('origin').notNull(),
		/** full | incremental | targeted | manual | website */
		mode: text('mode').notNull(),
		/** running | completed | failed | partial */
		status: text('status').notNull().default('running'),
		collectorVersion: text('collector_version'),
		normalizerVersion: integer('normalizer_version').notNull(),
		summary: text('summary', { mode: 'json' }).$type<Record<string, unknown>>(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('source_observation_runs_origin_idx').on(t.origin)]
);

// ---------------------------------------------------------------------------
// Observed records (観測レコード) — current state of each upstream record
// ---------------------------------------------------------------------------
export const sourceObservedRecords = sqliteTable(
	'source_observed_records',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		origin: text('origin').notNull(),
		originRecordId: text('origin_record_id').notNull(),
		/** seen | missing | gone | error */
		status: text('status').notNull().default('seen'),
		lastContentHash: text('last_content_hash'),
		normalizerVersion: integer('normalizer_version').notNull(),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		contentChangedAt: integer('content_changed_at', { mode: 'timestamp_ms' }),
		missingSinceAt: integer('missing_since_at', { mode: 'timestamp_ms' }),
		missingCount: integer('missing_count').notNull().default(0)
	},
	(t) => [
		uniqueIndex('source_observed_records_origin_record_idx').on(t.origin, t.originRecordId)
	]
);

// ---------------------------------------------------------------------------
// Observations (観測) — append-only ledger of every incoming payload
// ---------------------------------------------------------------------------
export const sourceObservations = sqliteTable(
	'source_observations',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		origin: text('origin').notNull(),
		originRecordId: text('origin_record_id').notNull(),
		/** hash of the incoming canonical payload (idempotency key component) */
		contentHash: text('content_hash').notNull(),
		normalizerVersion: integer('normalizer_version').notNull(),
		runId: text('run_id').references(() => sourceObservationRuns.id, { onDelete: 'set null' }),
		derivation: text('derivation').notNull(),
		confidence: real('confidence').notNull(),
		evidence: integer('evidence').notNull().default(0),
		payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		rawPayload: text('raw_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
		/** submitted | applied | partial | noop | rejected | conflict | candidate */
		status: text('status').notNull().default('submitted'),
		matchDecision: text('match_decision'),
		/** audit-only actor descriptor (never used for precedence) */
		actor: text('actor'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		uniqueIndex('source_observations_idempotency_idx').on(
			t.origin,
			t.originRecordId,
			t.contentHash
		),
		index('source_observations_origin_record_idx').on(t.origin, t.originRecordId),
		// queue / history scans by lifecycle status, newest first
		index('source_observations_status_idx').on(t.status, t.createdAt)
	]
);

// ---------------------------------------------------------------------------
// Observation diffs (差分) — the per-observation "commit diff" (Phase 1)
//
// One stored diff per observation per kind: 'applied' for an auto-applied merge;
// 'proposal'/'planned' reserved for the later PR phases. The `diff` column holds
// the full canonical before→after `SourceDiff` (ALWAYS a JSON object, never a
// bare string). FKs are restrict/set null — the no-hard-delete invariant.
// ---------------------------------------------------------------------------
export const sourceObservationDiffs = sqliteTable(
	'source_observation_diffs',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		observationId: text('observation_id')
			.notNull()
			.references(() => sourceObservations.id, { onDelete: 'restrict' }),
		// nullable: a brand-new-source proposal has no canonical source row yet.
		sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),
		/** proposal | planned | applied */
		diffKind: text('diff_kind').notNull(),
		isNewSource: integer('is_new_source', { mode: 'boolean' }).notNull().default(false),
		baseContentHash: text('base_content_hash'),
		resultContentHash: text('result_content_hash'),
		changedScalarFields: text('changed_scalar_fields', { mode: 'json' }).$type<string[]>(),
		changedCollections: text('changed_collections', { mode: 'json' }).$type<string[]>(),
		hasConflicts: integer('has_conflicts', { mode: 'boolean' }).notNull().default(false),
		/** the FULL SourceDiff object — ALWAYS a JSON object, never a bare string. */
		diff: text('diff', { mode: 'json' }).$type<SourceDiff>().notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		uniqueIndex('source_obs_diffs_obs_kind_idx').on(t.observationId, t.diffKind),
		index('source_obs_diffs_source_idx').on(t.sourceId, t.createdAt)
	]
);

// ---------------------------------------------------------------------------
// Identifiers (識別子) — DOI/OpenAlex/ISBN/repo-path/... per source
// ---------------------------------------------------------------------------
export const sourceIdentifiers = sqliteTable(
	'source_identifiers',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		// nullable: unresolved candidate identifiers may not yet attach to a source
		sourceId: text('source_id').references(() => sources.id, { onDelete: 'restrict' }),
		/** doi | openalex_work | isbn | issn | cinii | ndl | jstage | repo_path | url_persistent | synthetic_stable */
		kind: text('kind').notNull(),
		valueRaw: text('value_raw').notNull(),
		valueNorm: text('value_norm').notNull(),
		/** strong | medium | weak */
		strength: text('strength').notNull().default('medium'),
		/** active | candidate | redirected | deprecated | conflict */
		status: text('status').notNull().default('active'),
		redirectsToIdentifierId: text('redirects_to_identifier_id').references(
			(): AnySQLiteColumn => sourceIdentifiers.id,
			{ onDelete: 'set null' }
		),
		canonicalValueNorm: text('canonical_value_norm'),
		origin: text('origin'),
		confidence: real('confidence'),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		uniqueIndex('source_identifiers_kind_value_idx').on(t.kind, t.valueNorm),
		index('source_identifiers_source_idx').on(t.sourceId)
	]
);

// ---------------------------------------------------------------------------
// Field claims (フィールド主張) — append-only per-field assertions
// ---------------------------------------------------------------------------
export const sourceFieldClaims = sqliteTable(
	'source_field_claims',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		observationId: text('observation_id')
			.notNull()
			.references(() => sourceObservations.id, { onDelete: 'restrict' }),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'restrict' }),
		fieldName: text('field_name').notNull(),
		value: text('value', { mode: 'json' }),
		valueHash: text('value_hash').notNull(),
		/** set | add | remove | append | explicit_delete */
		op: text('op').notNull().default('set'),
		rankBand: integer('rank_band').notNull(),
		rankScore: integer('rank_score').notNull(),
		origin: text('origin'),
		derivation: text('derivation'),
		confidence: real('confidence'),
		evidence: integer('evidence'),
		/** submitted | applied | superseded | rejected | conflict | held_below */
		status: text('status').notNull().default('submitted'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		uniqueIndex('source_field_claims_dedupe_idx').on(t.observationId, t.fieldName, t.valueHash),
		index('source_field_claims_source_field_idx').on(t.sourceId, t.fieldName)
	]
);

// ---------------------------------------------------------------------------
// Field provenance (フィールド由来) — current winning claim per (source,field)
// ---------------------------------------------------------------------------
export const sourceFieldProvenance = sqliteTable(
	'source_field_provenance',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'restrict' }),
		fieldName: text('field_name').notNull(),
		currentClaimId: text('current_claim_id').references(() => sourceFieldClaims.id, {
			onDelete: 'set null'
		}),
		valueHash: text('value_hash'),
		rankBand: integer('rank_band'),
		rankScore: integer('rank_score'),
		origin: text('origin'),
		derivation: text('derivation'),
		confidence: real('confidence'),
		evidence: integer('evidence'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	// UNIQUE(source_id, field_name) is the CAS target for the merge engine.
	(t) => [uniqueIndex('source_field_provenance_source_field_idx').on(t.sourceId, t.fieldName)]
);

// ---------------------------------------------------------------------------
// Lifecycle events (ライフサイクル) — append-only status/merge history
// ---------------------------------------------------------------------------
export const sourceLifecycleEvents = sqliteTable(
	'source_lifecycle_events',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id').references(() => sources.id, { onDelete: 'restrict' }),
		observationId: text('observation_id').references(() => sourceObservations.id, {
			onDelete: 'set null'
		}),
		/** create | status_change | soft_delete | restore | merge | unmerge | deprecate | hide | unhide */
		eventType: text('event_type').notNull(),
		entityType: text('entity_type'),
		entityId: text('entity_id'),
		details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
		fromStatus: text('from_status'),
		toStatus: text('to_status'),
		fromMergedInto: text('from_merged_into').references((): AnySQLiteColumn => sources.id, {
			onDelete: 'set null'
		}),
		toMergedInto: text('to_merged_into').references((): AnySQLiteColumn => sources.id, {
			onDelete: 'set null'
		}),
		reason: text('reason'),
		/** audit-only actor descriptor */
		actor: text('actor'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		index('source_lifecycle_events_source_idx').on(t.sourceId, t.createdAt),
		index('source_lifecycle_events_entity_idx').on(t.entityType, t.entityId, t.createdAt),
		check(
			'source_lifecycle_events_shape_check',
			sql`((${t.sourceId} is not null and ${t.entityType} is null and ${t.entityId} is null) or (${t.sourceId} is null and ${t.entityType} is not null and ${t.entityId} is not null))`
		)
	]
);

// ===========================================================================
// Phase 3 — Change requests (変更リクエスト) / reviews — the "PR" layer (ADDITIVE)
//
// A change request is the Git PR of the model: a `proposed` observation that the
// merge gate (decision.ts) routed to review instead of auto-applying. It carries
// MUTABLE workflow state (open → approved → applying → applied) so the
// append-only observation/diff ledger stays an immutable commit log. NO canonical
// data (sources / claims / provenance / links) is touched until the CR is APPLIED
// (Phase 4) — opening one writes only the 3 rows: the proposed observation, its
// 'proposal' diff, and the change_requests envelope.
//
// All FKs are `restrict` / `set null` — never cascade — matching the
// no-hard-delete invariant. `observation_id` is UNIQUE: one CR per observation.
// ===========================================================================

// ---------------------------------------------------------------------------
// Change requests (変更リクエスト) — the PR envelope; one per proposed observation
// ---------------------------------------------------------------------------
export const changeRequests = sqliteTable(
	'change_requests',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		observationId: text('observation_id')
			.notNull()
			.references(() => sourceObservations.id, { onDelete: 'restrict' }),
		// nullable: a brand-new-source proposal has no canonical source row yet.
		sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),
		// pre-reserved (NOT an FK) for new-source proposals; becomes real on apply.
		plannedSourceId: text('planned_source_id'),
		plannedSlug: text('planned_slug'),
		/** ChangeKind: field_update | new_source | enrichment | identity_conflict | lifecycle | drift */
		kind: text('kind').notNull(),
		/** open | needs_evidence | approved | applying | applied | rejected | superseded | withdrawn */
		status: text('status').notNull().default('open'),
		/** the gate.reason that routed this observation to review */
		routingReason: text('routing_reason').notNull(),
		title: text('title'),
		summary: text('summary'),
		// denormalized for cheap queue filtering (avoids a join on list):
		origin: text('origin').notNull(),
		originRecordId: text('origin_record_id').notNull(),
		derivation: text('derivation').notNull(),
		confidence: real('confidence').notNull(),
		evidence: integer('evidence').notNull().default(0),
		baseContentHash: text('base_content_hash'),
		resultContentHash: text('result_content_hash'),
		/** audit-only actor descriptor — NEVER used for precedence */
		proposedByActor: text('proposed_by_actor'),
		decidedByActor: text('decided_by_actor'),
		decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
		/** MergeResult.status recorded when the CR is applied (Phase 4) */
		appliedObservationStatus: text('applied_observation_status'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		// one change request per proposed observation
		uniqueIndex('change_requests_observation_idx').on(t.observationId),
		// the review queue: by workflow status, newest first
		index('change_requests_status_idx').on(t.status, t.createdAt),
		index('change_requests_source_idx').on(t.sourceId),
		index('change_requests_origin_record_idx').on(t.origin, t.originRecordId)
	]
);

// ---------------------------------------------------------------------------
// Change request reviews (レビュー) — append-only verdicts (LLM + human + system)
// ---------------------------------------------------------------------------
export const changeRequestReviews = sqliteTable(
	'change_request_reviews',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		changeRequestId: text('change_request_id')
			.notNull()
			.references(() => changeRequests.id, { onDelete: 'restrict' }),
		/** llm | human | system */
		reviewerKind: text('reviewer_kind').notNull(),
		/** model id / user id — audit-only, NEVER precedence */
		reviewerActor: text('reviewer_actor'),
		/** apply | reject | needs_evidence */
		verdict: text('verdict').notNull(),
		/** LLM self-report, advisory only */
		confidence: real('confidence'),
		reason: text('reason').notNull(),
		evidenceRefs: text('evidence_refs', { mode: 'json' }).$type<string[]>(),
		/** raw validated reviewer response — ALWAYS a JSON object, never a bare string */
		payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [index('cr_reviews_cr_idx').on(t.changeRequestId, t.createdAt)]
);

// ---------------------------------------------------------------------------
// Archive metadata (aynumosir)
// ---------------------------------------------------------------------------
export const userIdentities = sqliteTable(
	'user_identities',
	{
		kind: text('kind').notNull(),
		value: text('value').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		primaryKey({ columns: [t.kind, t.value] }),
		uniqueIndex('user_identities_user_kind_value_idx').on(t.userId, t.kind, t.value),
		check(
			'user_identities_kind_check',
			sql`${t.kind} in ('access_sub', 'github_login', 'service_token')`
		)
	]
);

export const archiveRepositories = sqliteTable(
	'archive_repositories',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		name: text('name').notNull(),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [uniqueIndex('archive_repositories_name_idx').on(t.name)]
);

export const archiveBlobs = sqliteTable(
	'archive_blobs',
	{
		sha256: text('sha256').primaryKey(),
		bytes: integer('bytes').notNull(),
		detectedMediaType: text('detected_media_type').notNull(),
		r2Etag: text('r2_etag'),
		r2Version: text('r2_version'),
		storageState: text('storage_state').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
		quarantineReviewDeadline: integer('quarantine_review_deadline', { mode: 'timestamp_ms' })
	},
	(t) => [
		check(
			'archive_blobs_sha256_check',
			sql`length(${t.sha256}) = 64 and ${t.sha256} not glob '*[^0-9a-f]*'`
		),
		check('archive_blobs_bytes_check', sql`${t.bytes} >= 0`),
		check(
			'archive_blobs_storage_state_check',
			sql`${t.storageState} in ('verified', 'quarantined', 'deleted')`
		),
		check(
			'archive_blobs_verified_state_check',
			sql`(${t.storageState} = 'verified' and ${t.verifiedAt} is not null) or ${t.storageState} in ('quarantined', 'deleted')`
		)
	]
);

export const sourceFiles = sqliteTable(
	'source_files',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceId: text('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'restrict' }),
		role: text('role').notNull(),
		label: text('label'),
		checkoutRepoId: text('checkout_repo_id').references(() => archiveRepositories.id),
		checkoutPath: text('checkout_path'),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' })
	},
	(t) => [
		uniqueIndex('source_files_checkout_idx').on(t.checkoutRepoId, t.checkoutPath),
		index('source_files_source').on(t.sourceId),
		check('source_files_role_check', sql`${t.role} in ('scan', 'epub', 'supplement', 'derivative')`),
		check(
			'source_files_checkout_pair_check',
			sql`(${t.checkoutRepoId} is null and ${t.checkoutPath} is null) or (${t.checkoutRepoId} is not null and ${t.checkoutPath} is not null)`
		)
	]
);

export const fileRevisions = sqliteTable(
	'file_revisions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceFileId: text('source_file_id')
			.notNull()
			.references(() => sourceFiles.id, { onDelete: 'restrict' }),
		revisionNo: integer('revision_no').notNull(),
		blobSha256: text('blob_sha256').references(() => archiveBlobs.sha256, {
			onDelete: 'restrict'
		}),
		originalFilename: text('original_filename').notNull(),
		declaredMediaType: text('declared_media_type').notNull(),
		artifactKind: text('artifact_kind').notNull(),
		pageCount: integer('page_count'),
		pageStart: integer('page_start'),
		pageEnd: integer('page_end'),
		reviewStatus: text('review_status').notNull(),
		accessState: text('access_state').notNull().default('available'),
		isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
		submittedBy: text('submitted_by')
			.notNull()
			.references(() => user.id),
		submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
		reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
		reviewNote: text('review_note')
	},
	(t) => [
		uniqueIndex('file_revisions_source_file_revision_idx').on(t.sourceFileId, t.revisionNo),
		uniqueIndex('source_file_one_current_revision')
			.on(t.sourceFileId)
			.where(sql`${t.isCurrent} = 1`),
		uniqueIndex('source_file_one_pending_revision')
			.on(t.sourceFileId)
			.where(sql`${t.reviewStatus} = 'pending'`),
		index('file_revisions_blob').on(t.blobSha256),
		check('file_revisions_revision_no_check', sql`${t.revisionNo} > 0`),
		check(
			'file_revisions_artifact_kind_check',
			sql`${t.artifactKind} in ('original', 'bbox', 'page_images', 'linearized')`
		),
		check('file_revisions_page_count_check', sql`${t.pageCount} is null or ${t.pageCount} > 0`),
		check('file_revisions_page_start_check', sql`${t.pageStart} is null or ${t.pageStart} > 0`),
		check('file_revisions_page_end_check', sql`${t.pageEnd} is null or ${t.pageEnd} > 0`),
		check(
			'file_revisions_review_status_check',
			sql`${t.reviewStatus} in ('pending', 'approved', 'rejected', 'withdrawn', 'expunged')`
		),
		check(
			'file_revisions_access_state_check',
			sql`${t.accessState} in ('available', 'embargoed', 'takedown')`
		),
		check(
			'file_revisions_page_range_check',
			sql`(${t.pageStart} is null and ${t.pageEnd} is null) or (${t.pageStart} is not null and ${t.pageEnd} is not null and ${t.pageEnd} >= ${t.pageStart})`
		),
		check(
			'file_revisions_review_pair_check',
			sql`(${t.reviewedBy} is null and ${t.reviewedAt} is null) or (${t.reviewedBy} is not null and ${t.reviewedAt} is not null)`
		),
		check(
			'file_revisions_current_review_status_check',
			sql`${t.isCurrent} = 0 or ${t.reviewStatus} = 'approved'`
		),
		check(
			'file_revisions_expunged_blob_check',
			sql`(${t.reviewStatus} = 'expunged' and ${t.blobSha256} is null and ${t.isCurrent} = 0) or (${t.reviewStatus} <> 'expunged' and ${t.blobSha256} is not null)`
		)
	]
);

export const revisionDerivations = sqliteTable(
	'revision_derivations',
	{
		derivedRevisionId: text('derived_revision_id')
			.notNull()
			.references(() => fileRevisions.id, { onDelete: 'restrict' }),
		parentRevisionId: text('parent_revision_id')
			.notNull()
			.references(() => fileRevisions.id, { onDelete: 'restrict' }),
		relation: text('relation').notNull(),
		parametersJson: text('parameters_json', { mode: 'json' }).$type<Record<string, unknown>>()
	},
	(t) => [
		primaryKey({ columns: [t.derivedRevisionId, t.parentRevisionId, t.relation] }),
		check(
			'revision_derivations_distinct_check',
			sql`${t.derivedRevisionId} <> ${t.parentRevisionId}`
		)
	]
);

export const revisionOcrCoverage = sqliteTable(
	'revision_ocr_coverage',
	{
		revisionId: text('revision_id')
			.notNull()
			.references(() => fileRevisions.id, { onDelete: 'cascade' }),
		variant: text('variant').notNull(),
		status: text('status').notNull(),
		tool: text('tool'),
		toolVersion: text('tool_version'),
		preferred: integer('preferred', { mode: 'boolean' }).notNull().default(false),
		measuredAt: integer('measured_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		primaryKey({ columns: [t.revisionId, t.variant] }),
		uniqueIndex('revision_one_preferred_ocr_variant')
			.on(t.revisionId)
			.where(sql`${t.preferred} = 1`),
		check('revision_ocr_coverage_status_check', sql`${t.status} in ('none', 'partial', 'complete')`)
	]
);

export const uploadSessions = sqliteTable(
	'upload_sessions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		sourceFileId: text('source_file_id')
			.notNull()
			.references(() => sourceFiles.id, { onDelete: 'restrict' }),
		expectedSha256: text('expected_sha256').notNull(),
		expectedBytes: integer('expected_bytes').notNull(),
		declaredMediaType: text('declared_media_type').notNull(),
		stagingKey: text('staging_key').notNull(),
		multipartId: text('multipart_id'),
		state: text('state').notNull(),
		submittedBy: text('submitted_by')
			.notNull()
			.references(() => user.id),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		errorCode: text('error_code')
	},
	(t) => [
		uniqueIndex('upload_sessions_staging_key_idx').on(t.stagingKey),
		uniqueIndex('upload_sessions_multipart_idx').on(t.multipartId),
		check('upload_sessions_expected_bytes_check', sql`${t.expectedBytes} > 0`),
		check(
			'upload_sessions_state_check',
			sql`${t.state} in ('initiated', 'uploading', 'uploaded', 'finalizing', 'verified', 'failed', 'aborted', 'expired')`
		)
	]
);

export const blobOrigins = sqliteTable(
	'blob_origins',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		blobSha256: text('blob_sha256')
			.notNull()
			.references(() => archiveBlobs.sha256, { onDelete: 'restrict' }),
		originKind: text('origin_kind').notNull(),
		lfsOid: text('lfs_oid'),
		gitBlobSha1: text('git_blob_sha1'),
		repository: text('repository'),
		historicalPath: text('historical_path'),
		pointerBytes: integer('pointer_bytes'),
		firstCommit: text('first_commit'),
		lastCommit: text('last_commit'),
		note: text('note')
	},
	(t) => [
		check('blob_origins_origin_kind_check', sql`${t.originKind} in ('lfs', 'git_blob', 'orphan')`),
		check(
			'blob_origins_kind_consistency_check',
			sql`(${t.originKind} = 'lfs' and ${t.lfsOid} is not null and ${t.gitBlobSha1} is null) or (${t.originKind} = 'git_blob' and ${t.gitBlobSha1} is not null and ${t.lfsOid} is null) or (${t.originKind} = 'orphan' and ${t.lfsOid} is null and ${t.gitBlobSha1} is null and ${t.note} is not null)`
		)
	]
);

export const capabilityTokens = sqliteTable(
	'capability_tokens',
	{
		jti: text('jti').primaryKey(),
		revisionId: text('revision_id')
			.notNull()
			.references(() => fileRevisions.id, { onDelete: 'restrict' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
		maxBytes: integer('max_bytes').notNull(),
		bytesServed: integer('bytes_served').notNull().default(0),
		redeemedAt: integer('redeemed_at', { mode: 'timestamp_ms' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		check('capability_tokens_max_bytes_check', sql`${t.maxBytes} > 0`),
		check('capability_tokens_bytes_served_check', sql`${t.bytesServed} >= 0`),
		check('capability_tokens_bytes_limit_check', sql`${t.bytesServed} <= ${t.maxBytes}`)
	]
);

export const archiveStreamDailyUsage = sqliteTable(
	'archive_stream_daily_usage',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		day: text('day').notNull(),
		bytesReserved: integer('bytes_reserved').notNull().default(0),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.day] }),
		check('archive_stream_daily_usage_bytes_check', sql`${t.bytesReserved} >= 0`)
	]
);

export const archiveStreamLeases = sqliteTable(
	'archive_stream_leases',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		revisionId: text('revision_id')
			.notNull()
			.references(() => fileRevisions.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
	},
	(t) => [
		index('archive_stream_leases_user_idx').on(t.userId, t.expiresAt),
		index('archive_stream_leases_expires_idx').on(t.expiresAt)
	]
);

// ---------------------------------------------------------------------------
// App user roles (権限) — app-owned authz (Better-Auth `user` table untouched)
// ---------------------------------------------------------------------------
export const appUserRoles = sqliteTable('app_user_roles', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'restrict' }),
	/** editor | moderator | admin — a missing row is treated as 'editor' */
	role: text('role').notNull().default('editor'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
});

// ---------------------------------------------------------------------------
// Migration watermarks (移行ウォーターマーク) — resumable bootstrap/import cursors
// ---------------------------------------------------------------------------
export const migrationWatermarks = sqliteTable('migration_watermarks', {
	jobName: text('job_name').primaryKey(),
	phase: text('phase'),
	cursor: text('cursor'),
	lastSourceId: text('last_source_id'),
	lastObservationId: text('last_observation_id'),
	status: text('status'),
	summary: text('summary', { mode: 'json' }).$type<Record<string, unknown>>(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now)
});

// --- inferred row types ---
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceLink = typeof sourceLinks.$inferSelect;
export type Person = typeof persons.$inferSelect;
export type Place = typeof places.$inferSelect;
export type Institution = typeof institutions.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type SourceRelation = typeof sourceRelations.$inferSelect;
export type SlugRedirect = typeof slugRedirects.$inferSelect;
export type SourceRevision = typeof sourceRevisions.$inferSelect;
export type SourceObservationRun = typeof sourceObservationRuns.$inferSelect;
export type SourceObservedRecord = typeof sourceObservedRecords.$inferSelect;
export type SourceObservation = typeof sourceObservations.$inferSelect;
export type SourceObservationDiff = typeof sourceObservationDiffs.$inferSelect;
export type SourceIdentifier = typeof sourceIdentifiers.$inferSelect;
export type SourceFieldClaim = typeof sourceFieldClaims.$inferSelect;
export type SourceFieldProvenance = typeof sourceFieldProvenance.$inferSelect;
export type SourceLifecycleEvent = typeof sourceLifecycleEvents.$inferSelect;
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type NewChangeRequest = typeof changeRequests.$inferInsert;
export type ChangeRequestReview = typeof changeRequestReviews.$inferSelect;
export type NewChangeRequestReview = typeof changeRequestReviews.$inferInsert;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type ArchiveRepository = typeof archiveRepositories.$inferSelect;
export type ArchiveBlob = typeof archiveBlobs.$inferSelect;
export type SourceFile = typeof sourceFiles.$inferSelect;
export type FileRevision = typeof fileRevisions.$inferSelect;
export type RevisionDerivation = typeof revisionDerivations.$inferSelect;
export type RevisionOcrCoverage = typeof revisionOcrCoverage.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type BlobOrigin = typeof blobOrigins.$inferSelect;
export type CapabilityToken = typeof capabilityTokens.$inferSelect;
export type ArchiveStreamDailyUsage = typeof archiveStreamDailyUsage.$inferSelect;
export type ArchiveStreamLease = typeof archiveStreamLeases.$inferSelect;
export type AppUserRole = typeof appUserRoles.$inferSelect;
export type MigrationWatermark = typeof migrationWatermarks.$inferSelect;

export * from './auth.schema';

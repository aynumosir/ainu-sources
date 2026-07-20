import { sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from '$lib/server/db/schema';
import { DEPLOYED_SEARCH_MODES } from './search-modes';

type Db = LibSQLDatabase<typeof schema>;

const CACHE_TTL_MS = 60_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const SIZE_BUCKETS = [
	{ key: 'zero', label: '0 B' },
	{ key: 'under-1-mib', label: '< 1 MiB' },
	{ key: '1-to-10-mib', label: '1–<10 MiB' },
	{ key: '10-to-100-mib', label: '10–<100 MiB' },
	{ key: '100-mib-to-1-gib', label: '100 MiB–<1 GiB' },
	{ key: '1-gib-and-over', label: '≥ 1 GiB' }
] as const;

type DistributionValue = { value: string; count: number };

export type ArchiveStatsDistribution = {
	unit: 'works' | 'current_revisions';
	total: number;
	recorded: number;
	unspecified: number;
	values: DistributionValue[];
};

export type ArchiveStats = {
	totals: {
		works: number;
		files: number;
		currentRevisions: number;
		storedObjects: number;
		totalBytes: number;
		deduplicatedBytes: number;
		byteCoverage: {
			recordedRevisions: number;
			unspecifiedRevisions: number;
		};
	};
	pages: {
		total: number;
		recordedRevisions: number;
		unspecifiedRevisions: number;
	};
	ocr: {
		worksWithText: number;
		worksWithoutRecordedText: number;
		worksWithPageAlignedText: number;
		worksWithWholeDocumentText: number;
		pagesWithText: number;
		chunks: number;
		variants: Array<{
			variant: string;
			works: number;
			engines: {
				recordedWorks: number;
				unspecifiedWorks: number;
				values: Array<{ engine: string; works: number }>;
			};
		}>;
	};
	derivatives: {
		currentRevisions: number;
		pageImages: { withRecordedDerivative: number; withoutRecordedDerivative: number };
		linearizedPdf: { withRecordedDerivative: number; withoutRecordedDerivative: number };
	};
	distribution: {
		category: ArchiveStatsDistribution;
		era: ArchiveStatsDistribution;
		dialect: ArchiveStatsDistribution;
		mediaType: ArchiveStatsDistribution;
		size: ArchiveStatsDistribution;
	};
	search: { enabledModes: string[] };
	freshness: {
		mostRecentIngestAt: string | null;
		mostRecentApprovedRevision: { id: string; approvedAt: string } | null;
	};
};

type SummaryRow = {
	works: number;
	files: number;
	currentRevisions: number;
	storedObjects: number;
	totalBytes: number;
	deduplicatedBytes: number;
	recordedByteRevisions: number;
	unspecifiedByteRevisions: number;
	pages: number;
	pageCountRecorded: number;
	pageCountUnspecified: number;
	pageImageDerivatives: number;
	linearizedDerivatives: number;
	mostRecentIngestAt: number | null;
	mostRecentApprovedRevisionId: string | null;
	mostRecentApprovedRevisionAt: number | null;
};

type OcrRow = {
	worksWithText: number;
	pagesWithText: number;
	worksWithPageAlignedText: number;
	chunks: number;
	variant: string | null;
	variantWorks: number | null;
	engineRecordedWorks: number | null;
	engineUnspecifiedWorks: number | null;
	engine: string | null;
	engineWorks: number | null;
};

type DistributionRow = {
	axis: 'category' | 'era' | 'dialect' | 'mediaType' | 'size';
	value: string | null;
	count: number;
};

const cache = new WeakMap<Db, { expiresAt: number; value: ArchiveStats }>();

function numberValue(value: number | null | undefined): number {
	return Number(value ?? 0);
}

function isoTimestamp(value: number | null): string | null {
	return value == null ? null : new Date(Number(value)).toISOString();
}

async function readSummary(db: Db): Promise<SummaryRow> {
	const [row] = await db.all<SummaryRow>(sql`
		with current_revisions as (
			select fr.*
			from file_revisions fr
			where fr.is_current = 1
		), stored_revision_bytes as (
			select fr.id, ab.bytes
			from file_revisions fr
			left join archive_blobs ab
				on ab.sha256 = fr.blob_sha256
				and ab.storage_state <> 'deleted'
			where fr.review_status <> 'expunged'
		), recorded_derivatives as (
			select rd.parent_revision_id, derived.artifact_kind
			from revision_derivations rd
			inner join file_revisions derived on derived.id = rd.derived_revision_id
			where derived.review_status = 'approved'
				and derived.access_state <> 'takedown'
		)
		select
			(select count(distinct source_id) from source_files) as works,
			(select count(*) from source_files) as files,
			(select count(*) from current_revisions) as currentRevisions,
			(select count(*) from archive_blobs where storage_state <> 'deleted') as storedObjects,
			(select coalesce(sum(bytes), 0) from stored_revision_bytes) as totalBytes,
			(select coalesce(sum(bytes), 0) from archive_blobs where storage_state <> 'deleted') as deduplicatedBytes,
			(select count(*) from stored_revision_bytes where bytes is not null) as recordedByteRevisions,
			(select count(*) from stored_revision_bytes where bytes is null) as unspecifiedByteRevisions,
			(select coalesce(sum(page_count), 0) from current_revisions) as pages,
			(select count(*) from current_revisions where page_count is not null) as pageCountRecorded,
			(select count(*) from current_revisions where page_count is null) as pageCountUnspecified,
			(select count(distinct current_revisions.id)
				from current_revisions
				inner join recorded_derivatives rd
					on rd.parent_revision_id = current_revisions.id
					and rd.artifact_kind = 'page_images') as pageImageDerivatives,
			(select count(distinct current_revisions.id)
				from current_revisions
				inner join recorded_derivatives rd
					on rd.parent_revision_id = current_revisions.id
					and rd.artifact_kind = 'linearized') as linearizedDerivatives,
			(select max(ingested_at) from ocr_ingest_state) as mostRecentIngestAt,
			(select id from file_revisions
				where review_status = 'approved' and reviewed_at is not null
				order by reviewed_at desc, id desc limit 1) as mostRecentApprovedRevisionId,
			(select reviewed_at from file_revisions
				where review_status = 'approved' and reviewed_at is not null
				order by reviewed_at desc, id desc limit 1) as mostRecentApprovedRevisionAt
	`);
	if (!row) throw new Error('archive statistics summary query returned no row');
	return row;
}

async function readOcr(db: Db): Promise<OcrRow[]> {
	return db.all<OcrRow>(sql`
		with archive_works as (
			select distinct source_id from source_files
		), active_text as (
			select
				c.revision_id,
				c.variant,
				c.page,
				c.chunk_id,
				sf.source_id,
				nullif(trim(coverage.tool), '') as engine
			from ocr_chunks c
			inner join ocr_ingest_state state
				on state.revision_id = c.revision_id
				and state.variant = c.variant
				and state.active_generation = c.ingest_generation
			inner join file_revisions fr on fr.id = c.revision_id and fr.is_current = 1
			inner join source_files sf on sf.id = fr.source_file_id
			left join revision_ocr_coverage coverage
				on coverage.revision_id = c.revision_id
				and coverage.variant = c.variant
			where length(trim(c.text)) > 0
		), totals as (
			select
				count(distinct source_id) as worksWithText,
				count(distinct case when cast(page as integer) > 0
					then revision_id || ':' || page end) as pagesWithText,
				count(distinct case when cast(page as integer) > 0
					then source_id end) as worksWithPageAlignedText,
				count(distinct chunk_id) as chunks
			from active_text
		), variant_totals as (
			select
				variant,
				count(distinct source_id) as variantWorks,
				count(distinct case when engine is not null then source_id end) as engineRecordedWorks,
				count(distinct case when engine is null then source_id end) as engineUnspecifiedWorks
			from active_text
			group by variant
		), engine_totals as (
			select variant, engine, count(distinct source_id) as engineWorks
			from active_text
			where engine is not null
			group by variant, engine
		)
		select
			totals.worksWithText,
			totals.pagesWithText,
			totals.worksWithPageAlignedText,
			totals.chunks,
			variant_totals.variant,
			variant_totals.variantWorks,
			variant_totals.engineRecordedWorks,
			variant_totals.engineUnspecifiedWorks,
			engine_totals.engine,
			engine_totals.engineWorks
		from totals
		left join variant_totals on 1 = 1
		left join engine_totals on engine_totals.variant = variant_totals.variant
		order by variant_totals.variant, engine_totals.engine
	`);
}

async function readDistribution(db: Db): Promise<DistributionRow[]> {
	return db.all<DistributionRow>(sql`
		with archive_works as (
			select distinct
				sf.source_id,
				nullif(trim(s.category), '') as category,
				s.year_start,
				nullif(trim(s.dialect), '') as dialect
			from source_files sf
			inner join sources s on s.id = sf.source_id
		), current_revisions as (
			select
				fr.id,
				nullif(trim(coalesce(ab.detected_media_type, fr.declared_media_type)), '') as media_type,
				ab.bytes
			from file_revisions fr
			left join archive_blobs ab
				on ab.sha256 = fr.blob_sha256
				and ab.storage_state <> 'deleted'
			where fr.is_current = 1
		), distribution as (
			select 'category' as axis, category as value, count(*) as count
			from archive_works group by category
			union all
			select 'era',
				case
					when year_start is null then null
					when year_start < 1900 then 'pre-1900'
					else printf('%ds', cast(year_start / 10 as integer) * 10)
				end,
				count(*)
			from archive_works
			group by 2
			union all
			select 'dialect', dialect, count(*)
			from archive_works group by dialect
			union all
			select 'mediaType', media_type, count(*)
			from current_revisions group by media_type
			union all
			select 'size',
				case
					when bytes is null then null
					when bytes = 0 then 'zero'
					when bytes < ${MIB} then 'under-1-mib'
					when bytes < ${10 * MIB} then '1-to-10-mib'
					when bytes < ${100 * MIB} then '10-to-100-mib'
					when bytes < ${GIB} then '100-mib-to-1-gib'
					else '1-gib-and-over'
				end,
				count(*)
			from current_revisions
			group by 2
		)
		select axis, value, count
		from distribution
		order by axis, value
	`);
}

function buildDistribution(
	rows: DistributionRow[],
	axis: DistributionRow['axis'],
	unit: ArchiveStatsDistribution['unit'],
	labels?: ReadonlyMap<string, string>
): ArchiveStatsDistribution {
	const axisRows = rows.filter((row) => row.axis === axis);
	const unspecified = axisRows.find((row) => row.value == null)?.count ?? 0;
	const values = axisRows
		.filter((row): row is DistributionRow & { value: string } => row.value != null)
		.map((row) => ({ value: labels?.get(row.value) ?? row.value, count: numberValue(row.count) }));
	const recorded = values.reduce((sum, row) => sum + row.count, 0);
	return { unit, total: recorded + numberValue(unspecified), recorded, unspecified: numberValue(unspecified), values };
}

function buildSizeDistribution(rows: DistributionRow[]): ArchiveStatsDistribution {
	const labels = new Map(SIZE_BUCKETS.map((bucket) => [bucket.key, bucket.label]));
	const distribution = buildDistribution(rows, 'size', 'current_revisions', labels);
	const counts = new Map(distribution.values.map((value) => [value.value, value.count]));
	distribution.values = SIZE_BUCKETS.map((bucket) => ({
		value: bucket.label,
		count: counts.get(bucket.label) ?? 0
	}));
	return distribution;
}

function buildEraDistribution(rows: DistributionRow[]): ArchiveStatsDistribution {
	const distribution = buildDistribution(rows, 'era', 'works');
	distribution.values.sort((left, right) => {
		if (left.value === 'pre-1900') return -1;
		if (right.value === 'pre-1900') return 1;
		return Number.parseInt(left.value, 10) - Number.parseInt(right.value, 10);
	});
	return distribution;
}

function buildOcr(rows: OcrRow[], works: number): ArchiveStats['ocr'] {
	const first = rows[0];
	const variants = new Map<string, ArchiveStats['ocr']['variants'][number]>();
	for (const row of rows) {
		if (row.variant == null) continue;
		let variant = variants.get(row.variant);
		if (!variant) {
			variant = {
				variant: row.variant,
				works: numberValue(row.variantWorks),
				engines: {
					recordedWorks: numberValue(row.engineRecordedWorks),
					unspecifiedWorks: numberValue(row.engineUnspecifiedWorks),
					values: []
				}
			};
			variants.set(row.variant, variant);
		}
		if (row.engine != null) variant.engines.values.push({ engine: row.engine, works: numberValue(row.engineWorks) });
	}
	const worksWithText = numberValue(first?.worksWithText);
	const worksWithPageAlignedText = numberValue(first?.worksWithPageAlignedText);
	return {
		worksWithText,
		worksWithoutRecordedText: Math.max(works - worksWithText, 0),
		worksWithPageAlignedText,
		worksWithWholeDocumentText: Math.max(worksWithText - worksWithPageAlignedText, 0),
		pagesWithText: numberValue(first?.pagesWithText),
		chunks: numberValue(first?.chunks),
		variants: [...variants.values()]
	};
}

async function queryArchiveStats(db: Db): Promise<ArchiveStats> {
	const summary = await readSummary(db);
	const ocrRows = await readOcr(db);
	const distributionRows = await readDistribution(db);
	const works = numberValue(summary.works);
	const currentRevisions = numberValue(summary.currentRevisions);
	const pageImageDerivatives = numberValue(summary.pageImageDerivatives);
	const linearizedDerivatives = numberValue(summary.linearizedDerivatives);

	return {
		totals: {
			works,
			files: numberValue(summary.files),
			currentRevisions,
			storedObjects: numberValue(summary.storedObjects),
			totalBytes: numberValue(summary.totalBytes),
			deduplicatedBytes: numberValue(summary.deduplicatedBytes),
			byteCoverage: {
				recordedRevisions: numberValue(summary.recordedByteRevisions),
				unspecifiedRevisions: numberValue(summary.unspecifiedByteRevisions)
			}
		},
		pages: {
			total: numberValue(summary.pages),
			recordedRevisions: numberValue(summary.pageCountRecorded),
			unspecifiedRevisions: numberValue(summary.pageCountUnspecified)
		},
		ocr: buildOcr(ocrRows, works),
		derivatives: {
			currentRevisions,
			pageImages: {
				withRecordedDerivative: pageImageDerivatives,
				withoutRecordedDerivative: Math.max(currentRevisions - pageImageDerivatives, 0)
			},
			linearizedPdf: {
				withRecordedDerivative: linearizedDerivatives,
				withoutRecordedDerivative: Math.max(currentRevisions - linearizedDerivatives, 0)
			}
		},
		distribution: {
			category: buildDistribution(distributionRows, 'category', 'works'),
			era: buildEraDistribution(distributionRows),
			dialect: buildDistribution(distributionRows, 'dialect', 'works'),
			mediaType: buildDistribution(distributionRows, 'mediaType', 'current_revisions'),
			size: buildSizeDistribution(distributionRows)
		},
		search: { enabledModes: [...DEPLOYED_SEARCH_MODES] },
		freshness: {
			mostRecentIngestAt: isoTimestamp(summary.mostRecentIngestAt),
			mostRecentApprovedRevision:
				summary.mostRecentApprovedRevisionId == null || summary.mostRecentApprovedRevisionAt == null
					? null
					: {
							id: summary.mostRecentApprovedRevisionId,
							approvedAt: isoTimestamp(summary.mostRecentApprovedRevisionAt)!
						}
		}
	};
}

export async function getArchiveStats(db: Db, now = Date.now()): Promise<ArchiveStats> {
	const cached = cache.get(db);
	if (cached && cached.expiresAt > now) return cached.value;
	const value = await queryArchiveStats(db);
	cache.set(db, { expiresAt: now + CACHE_TTL_MS, value });
	return value;
}

/**
 * What the reader needs to know about a work's text, loaded once.
 *
 * Both work routes need the same two things and previously carried their own
 * copy of the query. One of those copies went on reading a table a migration
 * had dropped, and every work page returned 500 until it was noticed; there is
 * one implementation now.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { revisionOcrCoverage, revisionPageFolios } from '$lib/server/db/schema';
import type { OcrCoverage } from '$lib/archive/ocr';

export async function loadTextCoverage(revisionId: string): Promise<OcrCoverage[]> {
	const [coverage, pageCounts] = await Promise.all([
		db
			.select({
				revisionId: revisionOcrCoverage.revisionId,
				variant: revisionOcrCoverage.variant,
				status: revisionOcrCoverage.status,
				sourceKind: revisionOcrCoverage.sourceKind,
				reliability: revisionOcrCoverage.reliability,
				reliabilityNote: revisionOcrCoverage.reliabilityNote,
				tool: revisionOcrCoverage.tool,
				toolVersion: revisionOcrCoverage.toolVersion,
				preferred: revisionOcrCoverage.preferred
			})
			.from(revisionOcrCoverage)
			.where(eq(revisionOcrCoverage.revisionId, revisionId)),
		db.all<{ variant: string; pageCount: number }>(sql`
			select c.variant as variant,
				cast(count(distinct cast(c.page as integer)) as integer) as pageCount
			from ocr_chunks c
			inner join ocr_ingest_state s
				on s.revision_id = c.revision_id
				and s.variant = c.variant
				and s.active_generation = c.ingest_generation
			where c.revision_id = ${revisionId}
			group by c.variant
		`)
	]);
	const countByVariant = new Map(pageCounts.map((row) => [row.variant, Number(row.pageCount)]));
	return coverage.map((row) => ({
		...row,
		status: row.status as OcrCoverage['status'],
		sourceKind: row.sourceKind as OcrCoverage['sourceKind'],
		reliability: row.reliability as OcrCoverage['reliability'],
		pageCount: countByVariant.get(row.variant) ?? 0
	}));
}

/** The number each page prints on itself, keyed by position in the scan. */
export async function loadPageFolios(revisionId: string): Promise<Record<number, string>> {
	const rows = await db
		.select({ page: revisionPageFolios.page, label: revisionPageFolios.label })
		.from(revisionPageFolios)
		.where(eq(revisionPageFolios.revisionId, revisionId));
	return Object.fromEntries(rows.map((row) => [row.page, row.label]));
}

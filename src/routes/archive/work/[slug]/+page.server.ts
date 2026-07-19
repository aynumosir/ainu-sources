import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { loadArchiveWork, loadArchiveWorkPersons } from '$lib/archive/work-data.server';
import { db } from '$lib/server/db';
import { revisionOcrCoverage } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { OcrCoverage } from '$lib/archive/ocr';

export const load: PageServerLoad = async ({ parent, params }) => {
	const layout = await parent();
	if (!layout.principal) return { accessDenied: true, work: null, persons: [] };
	if (!archiveRoleAtLeast(layout.principal.role, 'archive_reader')) error(403, 'archive reader role required');
	try {
		const [loadedWork, persons] = await Promise.all([
			loadArchiveWork(params.slug, layout.principal, null),
			loadArchiveWorkPersons(params.slug)
		]);
		const work = loadedWork && !loadedWork.unavailable
			? { ...loadedWork, ocr: await loadOcrCoverage(loadedWork.revision.id) }
			: loadedWork;
		return {
			accessDenied: false,
			work,
			persons
		};
	} catch (cause) {
		if (cause instanceof ArchiveHttpError) error(cause.status, cause.message);
		throw cause;
	}
};

async function loadOcrCoverage(revisionId: string): Promise<OcrCoverage[]> {
	const [coverage, pageCounts] = await Promise.all([
		db
			.select({
				revisionId: revisionOcrCoverage.revisionId,
				variant: revisionOcrCoverage.variant,
				status: revisionOcrCoverage.status,
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
		pageCount: countByVariant.get(row.variant) ?? 0
	}));
}

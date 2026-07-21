import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { listArchiveFiles } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { parseArchiveFilters } from '$lib/archive/filters';
import { revisionOcrCoverage } from '$lib/server/db/schema';
import { inArray } from 'drizzle-orm';
import type { OcrCoverage } from '$lib/archive/ocr';

export const load: PageServerLoad = async ({ request, url }) => {
	const filters = parseArchiveFilters(url.searchParams);
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, filters, items: [], nextCursor: null, params: '' };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const result = await listArchiveFiles(db, {
		text: filters.text,
		dialect: filters.dialect,
		decade: filters.decade,
		ocr: filters.ocr === 'any' ? undefined : filters.ocr,
		sort: filters.sort,
		cursor: url.searchParams.get('cursor'),
		limit: 50,
		principal
	});
	const revisionIds = [...new Set(result.items.map((item) => item.file.revisionId).filter((id): id is string => !!id))];
	const coverageRows = revisionIds.length
		? await db
				.select({
					revisionId: revisionOcrCoverage.revisionId,
					variant: revisionOcrCoverage.variant,
					status: revisionOcrCoverage.status,
					tool: revisionOcrCoverage.tool,
					toolVersion: revisionOcrCoverage.toolVersion,
					preferred: revisionOcrCoverage.preferred
				})
				.from(revisionOcrCoverage)
				.where(inArray(revisionOcrCoverage.revisionId, revisionIds))
		: [];
	const coverageByRevision = new Map<string, OcrCoverage[]>();
	for (const row of coverageRows) {
		const rows = coverageByRevision.get(row.revisionId) ?? [];
		rows.push({ ...row, status: row.status as OcrCoverage['status'], pageCount: 0 });
		coverageByRevision.set(row.revisionId, rows);
	}
	const items = result.items.map((item) => ({
		...item,
		coverage: item.file.revisionId ? (coverageByRevision.get(item.file.revisionId) ?? []) : []
	}));

	const params = new URLSearchParams(url.searchParams);
	params.delete('cursor');
	return {
		accessDenied: false,
		filters,
		items,
		nextCursor: result.nextCursor,
		params: params.toString()
	};
};

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { getRevision, getSourceFileById, listSourceFiles } from '$lib/server/archive/db';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { getSourceDetail } from '$lib/server/queries';

export const load: PageServerLoad = async ({ request, params, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, title: 'Reader', slug: params.slug, file: params.file };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	try {
		const sourceFile = await getSourceFileById(db, params.file, principal);
		if (sourceFile.sourceSlug !== params.slug) error(404, 'file not found for source');
		if (!sourceFile.currentRevisionId) error(404, 'file has no current revision');

		const revision = await getRevision(db, sourceFile.currentRevisionId, principal);
		const detail = await getSourceDetail(params.slug);
		const siblings = await listSourceFiles(db, params.slug, principal);
		const files = uniqueFiles(siblings).map((file) => ({
			fileId: file.fileId,
			role: file.role,
			label: file.label,
			checkoutPath: file.checkoutPath,
			revisionId: file.revisionId,
			revisionNo: file.revisionNo,
			bytes: file.bytes
		}));
		const pageCount = Math.max(1, revision.pageCount ?? 1);
		// TODO(D18): use the file's declared start page once the schema exposes it.
		const startPage = 1;
		const requestedPage = parsePage(url.searchParams.get('p'));
		const initialPage = clampPage(requestedPage ?? startPage, pageCount);

		return {
			accessDenied: false,
			title: revision.title,
			slug: params.slug,
			file: {
				fileId: sourceFile.fileId,
				role: revision.role,
				label: files.find((file) => file.fileId === sourceFile.fileId)?.label ?? null,
				checkoutPath: sourceFile.checkoutPath,
				currentRevisionId: sourceFile.currentRevisionId
			},
			source: {
				slug: revision.sourceSlug,
				title: detail?.source.title ?? revision.title,
				titleEn: detail?.source.titleEn ?? null,
				titleAin: detail?.source.titleAin ?? null,
				author: detail?.source.author ?? null,
				yearText: detail?.source.yearText ?? null,
				yearStart: detail?.source.yearStart ?? null,
				yearEnd: detail?.source.yearEnd ?? null,
				yearCertainty: detail?.source.yearCertainty ?? null,
				dialect: detail?.source.dialect ?? null,
				holdingInstitution: detail?.source.holdingInstitution ?? null,
				callNumber: detail?.source.callNumber ?? null,
				authors: (detail?.persons ?? [])
					.filter((person) => person.role === 'author')
					.map((person) => ({
						name: person.name,
						nameEn: person.nameEn
					})),
				publishers: (detail?.institutions ?? [])
					.filter((institution) => institution.role === 'publisher')
					.map((institution) => ({
						name: institution.name,
						nameEn: institution.nameEn
					}))
			},
			revision: {
				id: revision.id,
				revisionNo: revision.revisionNo,
				pageCount,
				reviewStatus: revision.reviewStatus,
				accessState: revision.accessState,
				bytes: revision.bytes,
				originalFilename: revision.originalFilename,
				detectedMediaType: revision.detectedMediaType
			},
			files,
			initialPage
		};
	} catch (e) {
		if (e instanceof ArchiveHttpError) error(e.status, e.message);
		throw e;
	}
};

function parsePage(value: string | null): number | null {
	if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
	const page = Number(value);
	return Number.isSafeInteger(page) ? page : null;
}

function clampPage(page: number, pageCount: number): number {
	return Math.min(Math.max(1, page), pageCount);
}

function uniqueFiles<T extends { fileId: string; revisionId: string | null; reviewStatus: string | null }>(rows: T[]): T[] {
	const byId = new Map<string, T>();
	for (const row of rows) {
		const current = byId.get(row.fileId);
		if (!current || (row.reviewStatus === 'approved' && current.reviewStatus !== 'approved')) byId.set(row.fileId, row);
	}
	return [...byId.values()];
}

import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSourceDetail, getMergeRedirectTarget } from '$lib/server/queries';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { sql } from 'drizzle-orm';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toReference } from '$lib/server/cite';

export const load: PageServerLoad = async ({ params, request }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		// A merged loser permanently redirects to its (active) winner; a RENAMED
		// slug 301s to the same source's current slug; hidden, soft_deleted,
		// candidate, or genuinely-missing slugs are 404 to the public.
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, `/sources/${target}`);
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}`);
		error(404, 'Source not found');
	}

	// A human-readable reference string for the Cite panel (copy-to-clipboard).
	const citation = toReference(buildCitation(detail, params.slug));

	// Archive access: if the visitor is logged in and has an archive role,
	// show a link to the restricted reader. Also surface what the archive holds
	// (page count, text availability) so the catalogue page tells the reader
	// whether the work is worth requesting access for.
	const principal = await resolveArchivePrincipal(request, db);
	const hasArchiveAccess = principal != null && archiveRoleAtLeast(principal.role, 'archive_reader');
	const archiveMeta = await db.all<{ pageCount: number; hasText: number }>(sql`
		select
			coalesce(max(fr.page_count), 0) as pageCount,
			case when exists (
				select 1 from ocr_ingest_state s where s.revision_id = fr.id
			) then 1 else 0 end as hasText
		from source_files sf
		join file_revisions fr on fr.source_file_id = sf.id and fr.is_current = 1
		where sf.source_id = ${detail.source.id}
		limit 1
	`);
	const archive = archiveMeta[0]
		? { pageCount: Number(archiveMeta[0].pageCount), hasText: archiveMeta[0].hasText === 1 }
		: null;

	return { detail, citation, hasArchiveAccess, archive };
};

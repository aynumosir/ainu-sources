import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { listFiles } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { getSourceBySlug } from '$lib/server/queries';
import { parseArchiveFilters } from '$lib/archive/filters';

export const load: PageServerLoad = async ({ request, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, filters: parseArchiveFilters(url.searchParams), items: [], nextCursor: null, params: '' };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const filters = parseArchiveFilters(url.searchParams);
	const result = await listFiles(db, url.searchParams.get('cursor'), null, 50);
	const sourceRows = await Promise.all(
		[...new Set(result.items.map((item) => item.sourceSlug))].map(async (slug) => [slug, await getSourceBySlug(slug)] as const)
	);
	const sourceBySlug = new Map(sourceRows.filter((row): row is readonly [string, NonNullable<(typeof row)[1]>] => !!row[1]));
	let items = result.items
		.map((file) => {
			const source = sourceBySlug.get(file.sourceSlug);
			return source ? { file, source, coverage: null } : null;
		})
		.filter((item): item is NonNullable<typeof item> => !!item);

	if (filters.text) {
		const needle = filters.text.toLocaleLowerCase();
		items = items.filter((item) =>
			[item.source.title, item.source.titleEn, item.source.author, item.source.summary]
				.filter(Boolean)
				.some((value) => value!.toLocaleLowerCase().includes(needle))
		);
	}
	if (filters.dialect) {
		const needle = filters.dialect.toLocaleLowerCase();
		items = items.filter((item) => item.source.dialect?.toLocaleLowerCase().includes(needle));
	}
	if (filters.decade) {
		items = items.filter((item) => {
			const year = item.source.yearStart;
			return year != null && year >= filters.decade! && year < filters.decade! + 10;
		});
	}
	if (filters.sort === 'title') items = items.sort((a, b) => a.source.title.localeCompare(b.source.title));
	if (filters.sort === 'year-desc') items = items.sort((a, b) => (b.source.yearStart ?? -Infinity) - (a.source.yearStart ?? -Infinity));
	if (filters.sort === 'year-asc') items = items.sort((a, b) => (a.source.yearStart ?? Infinity) - (b.source.yearStart ?? Infinity));

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

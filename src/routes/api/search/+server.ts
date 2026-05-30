import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { quickSearch } from '$lib/server/queries';

export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const rows = await quickSearch(q, 8);
	return json({
		results: rows.map((s) => ({
			slug: s.slug,
			title: s.title,
			titleEn: s.titleEn,
			year: s.yearStart,
			type: s.type
		}))
	});
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';
import { asArray } from '$lib/format';

function cslTypeFor(type: string): string {
	if (type === 'grammar-article') return 'article-journal';
	if (type === 'grammar-book') return 'book';
	if (type === 'corpus-text') return 'dataset';
	return 'manuscript';
}

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const { source, persons, links } = detail;

	const author = persons.length
		? persons.map((p) => ({ literal: p.name }))
		: source.author
			? [{ literal: source.author }]
			: [];

	const languages = asArray(source.languages);

	const cslItem: Record<string, unknown> = {
		id: params.slug,
		type: cslTypeFor(source.type),
		title: source.title,
		author,
		issued: source.yearStart != null ? { 'date-parts': [[source.yearStart]] } : undefined,
		language: languages[0],
		note: source.dialect ?? undefined,
		URL: links[0]?.url
	};

	return json([cslItem]);
};

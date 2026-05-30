import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';

/** Minimal BibTeX escaping: backslash first, then the active characters. */
function escapeBibtex(value: string): string {
	return value
		.replace(/\\/g, '\\textbackslash{}')
		.replace(/([&%$#_{}])/g, '\\$1')
		.replace(/~/g, '\\textasciitilde{}')
		.replace(/\^/g, '\\textasciicircum{}');
}

function entryTypeFor(type: string): string {
	if (type === 'grammar-article') return 'article';
	if (type === 'grammar-book') return 'book';
	return 'misc';
}

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const { source, persons, links } = detail;

	const entryType = entryTypeFor(source.type);
	const citeKey = params.slug.replace(/[^a-zA-Z0-9]/g, '');

	let title = source.title;
	if (source.titleEn && source.titleEn !== source.title) {
		title = `${title} (${source.titleEn})`;
	}

	const author = persons.map((p) => p.name).join(' and ') || source.author || '';
	const year = source.yearStart != null ? String(source.yearStart) : '';
	const note = source.dialect ?? '';
	const url = links[0]?.url ?? '';

	const fields: [string, string][] = [];
	if (title) fields.push(['title', escapeBibtex(title)]);
	if (author) fields.push(['author', escapeBibtex(author)]);
	if (year) fields.push(['year', escapeBibtex(year)]);
	if (note) fields.push(['note', escapeBibtex(note)]);
	if (url) fields.push([entryType === 'misc' ? 'howpublished' : 'url', escapeBibtex(url)]);

	const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
	const bibtex = `@${entryType}{${citeKey},\n${body}\n}\n`;

	return new Response(bibtex, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.bib"`
		}
	});
};

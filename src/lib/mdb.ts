import index from './mdb-index.json';
import type { MdbIndex } from './mdb-index';

const dictionaries = (index as MdbIndex).sources;

/** The exact dictionary identifier remains stable across catalogue renames. */
export function mdbLexemesHref(id: string, locale = 'en'): string {
	const url = new URL(`https://mdb.aynu.org${locale === 'ja' ? '/ja' : ''}/lexemes`);
	url.searchParams.set('source', id);
	return url.href;
}

export function mdbLinks(catalogue: string, locale = 'en') {
	return dictionaries.filter((source) => source.catalogue === catalogue).map((source) => ({
		...source, url: mdbLexemesHref(source.id, locale)
	}));
}

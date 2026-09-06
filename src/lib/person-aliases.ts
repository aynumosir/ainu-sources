import data from './data/person-aliases.json';

export interface PersonAlias {
	name: string;
	nameKana?: string;
	nameEn?: string;
	kind: string;
	language?: string;
	/** Redundant name forms retained for searching, without a visible alias line. */
	searchOnly?: boolean;
}
const entries: {slug: string; aliases: PersonAlias[]}[] = data;
export function personAliasLang(alias: PersonAlias): string {
	const codes: Record<string, string> = {jpn: 'ja', rus: 'ru', eng: 'en', ain: 'ain'};
	return codes[alias.language ?? 'jpn'] ?? alias.language!;
}

export function personAliases(slug: string) {
	return (entries.find(entry => entry.slug === slug)?.aliases ?? []).filter(alias => !alias.searchOnly);
}

const normalize = (value: string) => value.normalize('NFKC').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, '').toLowerCase();

export function personSlugsMatchingAlias(query: string): string[] {
	const q = normalize(query);
	if (!q) return [];
	return entries.filter(entry => entry.aliases.some(alias => [alias.name, alias.nameKana, alias.nameEn].some(value => value !== undefined && normalize(value).includes(q))))
		.map(entry => entry.slug);
}

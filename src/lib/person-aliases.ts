import entries from './data/person-aliases.json';

export function personAliases(slug: string) {
	return entries.find(entry => entry.slug === slug)?.aliases ?? [];
}

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export function personSlugsMatchingAlias(query: string): string[] {
	const q = normalize(query);
	if (!q) return [];
	return entries.filter(entry => entry.aliases.some(alias => normalize(alias.name).includes(q)))
		.map(entry => entry.slug);
}

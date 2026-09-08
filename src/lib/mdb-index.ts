import { catalogueSlugResolver } from './catalogue-slugs';

export interface DictionaryLexemes {
	id: string;
	catalogue: string;
	title: string;
	lexemes: number;
}
export interface MdbIndex {
	version: 1;
	sources: DictionaryLexemes[];
}

/** Validate the published coverage contract before replacing the local snapshot. */
export function projectMdbIndex(input: unknown, catalogue: unknown): MdbIndex {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected MDB index');
	const index = input as Record<string, unknown>;
	if (index.version !== 1) throw new Error('Unsupported MDB index version');
	if (!Array.isArray(index.sources) || !index.sources.length) throw new Error('Expected nonempty MDB sources');
	const resolve = catalogueSlugResolver(catalogue);
	const seen = new Set<string>();
	const sources = index.sources.map((value): DictionaryLexemes => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MDB source');
		const s = value as Record<string, unknown>;
		if (typeof s.id !== 'string' || !s.id.trim() || s.id !== s.id.trim() || /[\u0000-\u001f\u007f]/.test(s.id)) throw new Error('Invalid dictionary ID');
		if (seen.has(s.id)) throw new Error(`Duplicate dictionary ID: ${s.id}`);
		seen.add(s.id);
		if (typeof s.title !== 'string' || !s.title.trim()) throw new Error('Invalid dictionary title');
		if (typeof s.lexemes !== 'number' || !Number.isSafeInteger(s.lexemes) || s.lexemes <= 0) throw new Error('Invalid lexeme count');
		return { id: s.id, catalogue: resolve(s.catalogue), title: s.title, lexemes: s.lexemes };
	});
	return { version: 1, sources };
}

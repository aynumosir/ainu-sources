import type { SourceFilters, SortKey } from './types';

const SORTS = new Set<SortKey>(['year-asc', 'year-desc', 'title', 'updated', 'entries-desc']);

/**
 * Canonical mapping of URL search params → SourceFilters.
 * Input names match the controls in Facets.svelte / Pagination.svelte:
 *   q, sort, category, types[], regions[], languages[], scripts[], century[], digital, page, tag, person
 */
export function parseFilters(sp: URLSearchParams): SourceFilters {
	const sort = sp.get('sort');
	const page = Number(sp.get('page'));
	return {
		q: sp.get('q')?.trim() || undefined,
		category: sp.get('category') || undefined,
		types: sp.getAll('types').filter(Boolean),
		genres: sp.getAll('genres').filter(Boolean),
		regions: sp.getAll('regions').filter(Boolean),
		languages: sp.getAll('languages').filter(Boolean),
		scripts: sp.getAll('scripts').filter(Boolean),
		centuries: sp
			.getAll('century')
			.map(Number)
			.filter((n) => Number.isFinite(n)),
		tag: sp.get('tag') || undefined,
		person: sp.get('person') || undefined,
		hasDigital: sp.get('digital') === '1' || undefined,
		sort: sort && SORTS.has(sort as SortKey) ? (sort as SortKey) : 'year-asc',
		page: Number.isFinite(page) && page > 0 ? page : 1
	};
}

export const SORT_OPTIONS: SortKey[] = ['year-asc', 'year-desc', 'title', 'entries-desc', 'updated'];

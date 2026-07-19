export const ARCHIVE_SORTS = ['updated', 'title', 'year-desc', 'year-asc'] as const;

export type ArchiveSort = (typeof ARCHIVE_SORTS)[number];
export type ArchiveOcrFilter = 'any' | 'with' | 'without';

export type ArchiveFilters = {
	text?: string;
	dialect?: string;
	decade?: number;
	ocr: ArchiveOcrFilter;
	sort: ArchiveSort;
};

const SORT_SET = new Set<string>(ARCHIVE_SORTS);

export function parseArchiveFilters(params: URLSearchParams): ArchiveFilters {
	const text = params.get('q')?.trim() || undefined;
	const dialect = params.get('dialect')?.trim() || undefined;
	const decadeRaw = Number(params.get('decade'));
	const sort = params.get('sort');
	const ocr = params.get('ocr');
	return {
		text,
		dialect,
		decade: Number.isSafeInteger(decadeRaw) && decadeRaw > 0 ? decadeRaw : undefined,
		ocr: ocr === 'with' || ocr === 'without' ? ocr : params.get('searchable') === '1' ? 'with' : 'any',
		sort: sort && SORT_SET.has(sort) ? (sort as ArchiveSort) : 'updated'
	};
}

export function archiveFiltersToParams(filters: ArchiveFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.text?.trim()) params.set('q', filters.text.trim());
	if (filters.dialect?.trim()) params.set('dialect', filters.dialect.trim());
	if (filters.decade) params.set('decade', String(filters.decade));
	if (filters.ocr !== 'any') params.set('ocr', filters.ocr);
	if (filters.sort !== 'updated') params.set('sort', filters.sort);
	return params;
}

export function archiveFilterHref(path: string, filters: ArchiveFilters): string {
	const params = archiveFiltersToParams(filters);
	const qs = params.toString();
	return qs ? `${path}?${qs}` : path;
}

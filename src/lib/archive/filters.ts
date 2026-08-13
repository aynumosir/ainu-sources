export const ARCHIVE_SORTS = ['updated', 'title', 'year-desc', 'year-asc', 'significance'] as const;

export type ArchiveSort = (typeof ARCHIVE_SORTS)[number];
export type ArchiveOcrFilter = 'any' | 'with' | 'without';

/** Languages the composition measurement can classify, so the only values the lang facet can take. */
export const ARCHIVE_COMPOSITION_LANGS = ['ain', 'jpn', 'eng', 'rus'] as const;
export type ArchiveCompositionLang = (typeof ARCHIVE_COMPOSITION_LANGS)[number];

export type ArchiveFilters = {
	text?: string;
	dialect?: string;
	decade?: number;
	category?: string;
	tag?: string;
	lang?: ArchiveCompositionLang;
	ocr: ArchiveOcrFilter;
	sort: ArchiveSort;
};

const SORT_SET = new Set<string>(ARCHIVE_SORTS);
const LANG_SET = new Set<string>(ARCHIVE_COMPOSITION_LANGS);

export function parseArchiveFilters(params: URLSearchParams): ArchiveFilters {
	const text = params.get('q')?.trim() || undefined;
	const dialect = params.get('dialect')?.trim() || undefined;
	const category = params.get('category')?.trim() || undefined;
	const tag = params.get('tag')?.trim() || undefined;
	const langRaw = params.get('lang')?.trim();
	const decadeRaw = Number(params.get('decade'));
	const sort = params.get('sort');
	const ocr = params.get('ocr');
	return {
		text,
		dialect,
		category,
		tag,
		lang: langRaw && LANG_SET.has(langRaw) ? (langRaw as ArchiveCompositionLang) : undefined,
		decade: Number.isSafeInteger(decadeRaw) && decadeRaw > 0 ? decadeRaw : undefined,
		ocr: ocr === 'with' || ocr === 'without' ? ocr : params.get('searchable') === '1' ? 'with' : 'any',
		sort: sort && SORT_SET.has(sort) ? (sort as ArchiveSort) : 'significance'
	};
}

export function archiveFiltersToParams(filters: ArchiveFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.text?.trim()) params.set('q', filters.text.trim());
	if (filters.dialect?.trim()) params.set('dialect', filters.dialect.trim());
	if (filters.category?.trim()) params.set('category', filters.category.trim());
	if (filters.tag?.trim()) params.set('tag', filters.tag.trim());
	if (filters.lang) params.set('lang', filters.lang);
	if (filters.decade) params.set('decade', String(filters.decade));
	if (filters.ocr !== 'any') params.set('ocr', filters.ocr);
	if (filters.sort !== 'significance') params.set('sort', filters.sort);
	return params;
}

export function archiveFilterHref(path: string, filters: ArchiveFilters): string {
	const params = archiveFiltersToParams(filters);
	const qs = params.toString();
	return qs ? `${path}?${qs}` : path;
}

import reviews from '../../data/person-review.json';

export const REVIEW_COLUMNS = ['name', 'nameEn', 'nameKana', 'birthYear', 'deathYear', 'wikidata', 'wikipedia'] as const;
type Column = typeof REVIEW_COLUMNS[number];
export type ReviewPatch = Partial<Record<Column, string | number | null>>;
type Row = { id: string; slug: string; name: string } & ReviewPatch;
export type ReviewedPerson = { slugs: string[]; name: string; acceptedNames?: string[]; expected: ReviewPatch; corrected: ReviewPatch };
const normalize = (name: string) => name.normalize('NFKC').replace(/\s+/g, '');

/** Check the complete plan before any writes, including already-corrected rows. */
export function planPersonReviews(rows: Row[], entries: ReviewedPerson[] = reviews): Map<string, ReviewPatch> {
	const plans = new Map<string, ReviewPatch>();
	for (const entry of entries) {
		for (const row of rows.filter((r) => entry.slugs.includes(r.slug))) {
			const acceptedNames = [entry.name, entry.corrected.name, ...(entry.acceptedNames ?? [])].filter((n): n is string => typeof n === 'string');
			if (!acceptedNames.some((n) => normalize(n) === normalize(row.name)))
				throw new Error(`Person review identity changed: ${row.slug}`);
			for (const [key, value] of Object.entries(entry.corrected)) {
				if (!REVIEW_COLUMNS.includes(key as Column) || !(key in entry.expected))
					throw new Error(`Invalid reviewed field: ${row.slug}.${key}`);
				const col = key as Column;
				if (row[col] !== entry.expected[col] && row[col] !== value)
					throw new Error(`Person review needs rechecking: ${row.slug}.${col}`);
			}
			if (plans.has(row.id)) throw new Error(`Duplicate person review: ${row.slug}`);
			plans.set(row.id, entry.corrected);
		}
	}
	return plans;
}

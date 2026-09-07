import { expect, it } from 'vitest';
import { timelinePage, timelineYears } from './timeline';
import type { TimelinePoint } from './types';
const points: TimelinePoint[] = Array.from({ length: 196 }, (_, i) => ({ slug: `source-${i}`, title: `Source ${i}`, titleEn: null,
	yearStart: 2021, yearEnd: null, yearCertainty: null, category: 'primary', type: 'wordlist', region: null }));
points.push({ ...points[0], slug: 'oldest', yearStart: 1621 }, { ...points[0], slug: 'newest', yearStart: 2026 });
it('counts every source in a dense year', () => {
	expect(timelineYears(points)).toEqual([{ year: 2026, count: 1 }, { year: 2021, count: 196 }, { year: 1621, count: 1 }]);
});
it('makes every source reachable exactly once across all pages', () => {
	const first = timelinePage(points, null, null);
	const all = Array.from({ length: first.pageCount }, (_, i) => timelinePage(points, null, String(i + 1)).items).flat();
	expect(all).toHaveLength(points.length);
	expect(new Set(all.map((p) => p.slug)).size).toBe(points.length);
	expect(all[0].slug).toBe('newest');
	expect(all.at(-1)?.slug).toBe('oldest');
});
it('filters a selected year without dropping dense-year results', () => {
	const result = timelinePage(points, '2021', '4');
	expect(result.total).toBe(196); expect(result.items).toHaveLength(46);
	expect(result.items.every((p) => p.yearStart === 2021)).toBe(true);
});
it('handles invalid years and page bounds', () => {
	for (const value of ['bad', 'NaN', '2021.5', '-1']) expect(timelinePage(points, value, 'bad').selectedYear).toBeNull();
	expect(timelinePage(points, null, '999999').page).toBe(4);
	expect(timelinePage(points, null, '-1').page).toBe(1);
	expect(timelinePage([], null, null)).toMatchObject({ items: [], page: 1, pageCount: 1, total: 0 });
});

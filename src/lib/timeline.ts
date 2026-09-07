import type { TimelinePoint } from './types';

export function timelineYears(points: TimelinePoint[]) {
	const counts = new Map<number, number>();
	for (const point of points) counts.set(point.yearStart, (counts.get(point.yearStart) ?? 0) + 1);
	return [...counts].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}

/** Every dated record remains reachable, including dense years with hundreds of sources. */
export function timelinePage(points: TimelinePoint[], year: string | null, page: string | null, pageSize = 50) {
	const selectedYear = timelineYears(points).some((row) => String(row.year) === year) ? Number(year) : null;
	const matching = points.filter((point) => selectedYear === null || point.yearStart === selectedYear)
		.sort((a, b) => b.yearStart - a.yearStart || a.slug.localeCompare(b.slug));
	const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
	const requested = Number(page);
	const currentPage = Number.isSafeInteger(requested) ? Math.min(pageCount, Math.max(1, requested)) : 1;
	return { selectedYear, total: matching.length, page: currentPage, pageCount,
		items: matching.slice((currentPage - 1) * pageSize, currentPage * pageSize) };
}

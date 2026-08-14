/**
 * A revision's table of contents, in reading order. Empty when no structure
 * has been recorded for the scan.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { revisionSections } from '$lib/server/db/schema';

export type RevisionSection = {
	ord: number;
	depth: number;
	title: string;
	titleEn: string | null;
	pageStart: number;
	pageEnd: number | null;
	origin: string;
};

export async function loadRevisionSections(revisionId: string): Promise<RevisionSection[]> {
	return db
		.select({
			ord: revisionSections.ord,
			depth: revisionSections.depth,
			title: revisionSections.title,
			titleEn: revisionSections.titleEn,
			pageStart: revisionSections.pageStart,
			pageEnd: revisionSections.pageEnd,
			origin: revisionSections.origin
		})
		.from(revisionSections)
		.where(eq(revisionSections.revisionId, revisionId))
		.orderBy(asc(revisionSections.ord));
}

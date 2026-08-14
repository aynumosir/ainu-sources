#!/usr/bin/env bun
/**
 * Load a revision's table of contents from a JSON file.
 *
 * The file carries sections in reading order with page numbers that are
 * either scan positions or the printed folios a contents page cites. Printed
 * numbers are resolved against revision_page_folios — the offset between a
 * folio and its scan position drifts through a book with plates and inserts,
 * so a fixed offset would place late chapters wrongly. A printed number with
 * no detected folio fails the run rather than guessing a position.
 *
 * Replaces any sections already recorded for the revision.
 *
 * Usage: bun --preload ./scripts/sveltekit-env-shim.ts scripts/archive/ingest-sections.ts <sections.json>
 */
import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from '../../src/lib/server/db/schema';

type Db = LibSQLDatabase<typeof schema>;

export type SectionsFile = {
	revisionId: string;
	/** 'scan' = pageStart/pageEnd are scan positions; 'printed' = folio numbers to resolve. */
	pages: 'scan' | 'printed';
	origin: 'toc' | 'headings' | 'curated';
	note?: string;
	sections: Array<{
		depth?: number;
		title: string;
		titleEn?: string;
		pageStart: number;
		pageEnd?: number;
	}>;
};

export async function ingestSections(db: Db, file: SectionsFile): Promise<{ inserted: number }> {
	if (file.sections.length === 0) throw new Error('sections file lists no sections');
	const revision = await db
		.select({ id: schema.fileRevisions.id })
		.from(schema.fileRevisions)
		.where(eq(schema.fileRevisions.id, file.revisionId));
	if (revision.length === 0) throw new Error(`revision not found: ${file.revisionId}`);

	const resolve = file.pages === 'printed' ? await folioResolver(db, file.revisionId, file.sections) : null;
	const rows = file.sections.map((section, ord) => {
		const pageStart = resolve ? resolve(section.pageStart, section.title) : section.pageStart;
		const pageEnd =
			section.pageEnd === undefined ? null : resolve ? resolve(section.pageEnd, section.title) : section.pageEnd;
		return {
			revisionId: file.revisionId,
			ord,
			depth: section.depth ?? 1,
			title: section.title,
			titleEn: section.titleEn ?? null,
			pageStart,
			pageEnd,
			origin: file.origin
		};
	});
	for (const [index, row] of rows.entries()) {
		if (row.pageEnd !== null && row.pageEnd < row.pageStart) {
			throw new Error(`section "${row.title}" ends on page ${row.pageEnd} before it starts on page ${row.pageStart}`);
		}
		const previous = rows[index - 1];
		if (previous && row.pageStart < previous.pageStart) {
			throw new Error(`sections out of reading order: "${row.title}" starts before "${previous.title}"`);
		}
	}

	await db.transaction(async (tx) => {
		await tx.delete(schema.revisionSections).where(eq(schema.revisionSections.revisionId, file.revisionId));
		await tx.insert(schema.revisionSections).values(rows);
	});
	return { inserted: rows.length };
}

async function folioResolver(
	db: Db,
	revisionId: string,
	sections: SectionsFile['sections']
): Promise<(printed: number, title: string) => number> {
	const wanted = [
		...new Set(sections.flatMap((section) => [section.pageStart, ...(section.pageEnd === undefined ? [] : [section.pageEnd])]))
	];
	const folios = await db
		.select({ page: schema.revisionPageFolios.page, value: schema.revisionPageFolios.value })
		.from(schema.revisionPageFolios)
		.where(and(eq(schema.revisionPageFolios.revisionId, revisionId), inArray(schema.revisionPageFolios.value, wanted)));
	const byPrinted = new Map<number, number>();
	for (const folio of folios) {
		if (folio.value === null) continue;
		// The first scan position carrying the folio wins; a rescanned page
		// appearing twice would otherwise map a chapter to its later copy.
		const existing = byPrinted.get(folio.value);
		if (existing === undefined || folio.page < existing) byPrinted.set(folio.value, folio.page);
	}
	return (printed, title) => {
		const scan = byPrinted.get(printed);
		if (scan === undefined) {
			throw new Error(`no detected folio for printed page ${printed} ("${title}"); record the scan position instead`);
		}
		return scan;
	};
}

if (import.meta.main) {
	const [, , filePath] = process.argv;
	if (!filePath) {
		console.error('usage: ingest-sections.ts <sections.json>');
		process.exit(1);
	}
	const { db } = await import('../../src/lib/server/db');
	const file = JSON.parse(await readFile(filePath, 'utf8')) as SectionsFile;
	ingestSections(db as unknown as Db, file)
		.then((result) => console.log(JSON.stringify({ revisionId: file.revisionId, ...result })))
		.catch((error) => {
			console.error(error.message ?? error);
			process.exitCode = 1;
		});
}

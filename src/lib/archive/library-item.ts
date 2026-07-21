import type { listArchiveFiles } from '$lib/server/archive/db';
import type { OcrCoverage } from './ocr';

/** One library card: an archive list row with its revision's OCR coverage resolved. */
export type ArchiveLibraryItem = Omit<
	Awaited<ReturnType<typeof listArchiveFiles>>['items'][number],
	'coverage'
> & {
	coverage: OcrCoverage[];
};

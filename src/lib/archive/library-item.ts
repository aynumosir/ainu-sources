import type { listArchiveWorks } from '$lib/server/archive/db';
import type { OcrCoverage } from './ocr';

/** One library card: a work, the file a reader opens, and that file's OCR coverage. */
export type ArchiveLibraryItem = Omit<
	Awaited<ReturnType<typeof listArchiveWorks>>['items'][number],
	'coverage'
> & {
	coverage: OcrCoverage[];
};

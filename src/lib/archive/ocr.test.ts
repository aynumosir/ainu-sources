import { describe, expect, it } from 'vitest';
import { chooseDefaultOcrVariant, pickPreferredVariant, summarizeOcrCoverage, type OcrCoverage } from './ocr';

const coverage = (overrides: Partial<OcrCoverage> = {}): OcrCoverage => ({
	revisionId: 'revision-1',
	variant: 'pdftotext',
	status: 'complete',
	tool: 'pdftotext',
	toolVersion: null,
	preferred: false,
	pageCount: 12,
	...overrides
});

describe('summarizeOcrCoverage', () => {
	it('describes missing text', () => {
		expect(summarizeOcrCoverage([])).toEqual({ state: 'none', label: '本文なし / no text' });
	});

	it('names the engine for one variant', () => {
		expect(summarizeOcrCoverage([coverage()])).toEqual({
			state: 'available',
			label: '本文あり / text · pdftotext'
		});
	});

	it('reports partial coverage and multiple versions', () => {
		expect(
			summarizeOcrCoverage([
				coverage({ status: 'partial' }),
				coverage({ variant: 'gemini', tool: 'gemini', status: 'partial', pageCount: 8 })
			])
		).toEqual({ state: 'partial', label: '一部 / partial · 2 versions' });
	});
});

describe('chooseDefaultOcrVariant', () => {
	it('uses the preferred text-bearing variant', () => {
		expect(
			chooseDefaultOcrVariant([
				coverage({ pageCount: 20 }),
				coverage({ variant: 'gemini', preferred: true, pageCount: 8 })
			])
		).toBe('gemini');
	});

	it('falls back to the widest coverage', () => {
		expect(
			chooseDefaultOcrVariant([
				coverage({ pageCount: 8 }),
				coverage({ variant: 'gemini', pageCount: 20 })
			])
		).toBe('gemini');
	});

	it('ignores a preferred variant recorded without text', () => {
		expect(
			chooseDefaultOcrVariant([
				coverage({ variant: 'empty', status: 'none', preferred: true, pageCount: 0 }),
				coverage({ variant: 'gemini', pageCount: 8 })
			])
		).toBe('gemini');
	});
});

describe('pickPreferredVariant', () => {
	it('returns null when the revision has no variants', () => {
		expect(pickPreferredVariant([], null)).toBeNull();
	});

	it('ranks an unassessed variant above a suspect one', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'pdftotext', reliability: 'suspect' },
					{ variant: 'gemini', reliability: 'unassessed' }
				],
				'pdftotext'
			)
		).toBe('gemini');
	});

	it('ranks a sound variant above an unassessed one', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'gemini', reliability: 'unassessed' },
					{ variant: 'edited', reliability: 'sound' }
				],
				'gemini'
			)
		).toBe('edited');
	});

	it('keeps the current preferred variant within its tier', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'gemini', reliability: 'unassessed' },
					{ variant: 'pdftotext', reliability: 'unassessed' }
				],
				'pdftotext'
			)
		).toBe('pdftotext');
	});

	it('breaks ties in input order', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'pdftotext', reliability: 'unassessed' },
					{ variant: 'gemini', reliability: 'unassessed' }
				],
				null
			)
		).toBe('pdftotext');
	});

	it('picks the first ingested variant when every variant is suspect', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'pdftotext', reliability: 'suspect' },
					{ variant: 'gemini', reliability: 'suspect' }
				],
				null
			)
		).toBe('pdftotext');
	});

	it('keeps the current preferred variant when every variant is suspect', () => {
		expect(
			pickPreferredVariant(
				[
					{ variant: 'pdftotext', reliability: 'suspect' },
					{ variant: 'gemini', reliability: 'suspect' }
				],
				'gemini'
			)
		).toBe('gemini');
	});
});

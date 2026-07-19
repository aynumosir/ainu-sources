import { describe, expect, it } from 'vitest';
import { chooseDefaultOcrVariant, summarizeOcrCoverage, type OcrCoverage } from './ocr';

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

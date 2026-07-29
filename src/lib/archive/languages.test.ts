import { describe, expect, it } from 'vitest';
import { archiveCardLanguages, formatArchiveLanguages } from './languages';

describe('formatArchiveLanguages', () => {
	it('uses readable names for common archive languages', () => {
		expect(formatArchiveLanguages(['ain', 'jpn', 'eng', 'rus'])).toBe(
			'アイヌ語 Ainu · 日本語 Japanese · English · Русский Russian'
		);
	});

	it('keeps unmapped codes and ignores empty entries', () => {
		expect(formatArchiveLanguages(['ita', '', 'deu'])).toBe('ita · deu');
	});

	it('renders no marker for missing languages', () => {
		expect(formatArchiveLanguages(null)).toBe('');
		expect(formatArchiveLanguages([])).toBe('');
	});
});

describe('archiveCardLanguages', () => {
	it('drops Ainu since every work in the collection has it', () => {
		expect(archiveCardLanguages(['ain', 'jpn'])).toEqual(['日本語 Japanese']);
		expect(archiveCardLanguages(['ain', 'eng'])).toEqual(['English']);
	});

	it('renders nothing when Ainu is the only recorded language', () => {
		expect(archiveCardLanguages(['ain'])).toEqual([]);
	});

	it('keeps non-Ainu languages untouched', () => {
		expect(archiveCardLanguages(['jpn', 'rus'])).toEqual(['日本語 Japanese', 'Русский Russian']);
	});

	it('renders no marker for missing languages', () => {
		expect(archiveCardLanguages(null)).toEqual([]);
		expect(archiveCardLanguages([])).toEqual([]);
	});
});

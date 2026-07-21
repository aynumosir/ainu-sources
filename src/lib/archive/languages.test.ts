import { describe, expect, it } from 'vitest';
import { formatArchiveLanguages } from './languages';

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

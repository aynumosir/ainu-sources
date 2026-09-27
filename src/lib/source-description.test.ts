import { describe, expect, it, vi } from 'vitest';
import { localizedSummary } from './source-description';
import { sourceJsonLd } from './seo';
import type { Source } from './server/db/schema';

vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/paraglide/runtime')>(),
	getLocale: () => 'ja'
}));

const bilingual = { summary: 'A dictionary.', summaryJa: 'アイヌ語辞典。' };

describe('localized source descriptions', () => {
	it('uses Japanese only when selected, retaining the original in other locales', () => {
		expect(localizedSummary(bilingual, 'ja')).toBe(bilingual.summaryJa);
		for (const locale of ['en', 'ru', 'ain']) expect(localizedSummary(bilingual, locale)).toBe(bilingual.summary);
	});

	it('falls back to available prose, including Japanese-only and legacy Japanese records', () => {
		expect(localizedSummary({ ...bilingual, summaryJa: '  ' }, 'ja')).toBe(bilingual.summary);
		expect(localizedSummary({ summaryJa: bilingual.summaryJa }, 'en')).toBe(bilingual.summaryJa);
		expect(localizedSummary({ summary: '既存の日本語概要。' }, 'ja')).toBe('既存の日本語概要。');
		expect(localizedSummary({}, 'ja')).toBe('');
	});

	it('uses the selected description in structured metadata without changing the work language', () => {
		const record = sourceJsonLd({
			source: { ...bilingual, slug: 'dictionary', title: '辞典', type: 'dictionary', languages: ['ain', 'eng'] } as Source,
			links: [], persons: [], places: [], institutions: [], tags: []
		}, 'https://example.com');
		expect(record.description).toBe(bilingual.summaryJa);
		expect(record.inLanguage).toEqual(['ain', 'en']);
	});
});

import { describe, expect, it } from 'vitest';
import {
	extractReferenceSection,
	findCatalogueMatches,
	normalizeText
} from './sweep-references';

const source = (
	slug: string,
	title: string,
	author: string,
	yearStart: number
) => ({
	id: slug,
	slug,
	title,
	titleEn: null,
	titleAin: null,
	altTitles: null,
	author,
	yearText: String(yearStart),
	yearStart,
	type: 'article',
	category: 'secondary',
	region: 'hokkaido',
	significance: null
});

describe('reference sweep', () => {
	it('finds the final reference section', () => {
		const result = extractReferenceSection(`
Body

References

Tamura, S. 1974. Verb Suffixes -no and -nu in the Saru Dialect of Ainu.

Appendix
Ignored
`);
		expect(result?.heading).toBe('References');
		expect(result?.text).toContain('Tamura');
		expect(result?.text).not.toContain('Ignored');
	});

	it('normalizes OCR spacing and punctuation', () => {
		expect(normalizeText('アイ ヌ語法—研究')).toBe('アイヌ語法研究');
	});

	it('requires a title match and promotes year-corroborated matches', () => {
		const catalogue = [
			source(
				'1974-tamura-verb-suffixes',
				'Verb Suffixes -no and -nu in the Saru Dialect of Ainu',
				'Tamura, Suzuko',
				1974
			),
			source('1982-unrelated', 'A Completely Unrelated Article', 'Other, A.', 1982)
		];
		const matches = findCatalogueMatches(
			'Tamura, S. 1974. Verb Suffixes -no and -nu in the Saru Dialect of Ainu.',
			catalogue,
			'citing-work'
		);
		expect(matches).toHaveLength(1);
		expect(matches[0].source.slug).toBe('1974-tamura-verb-suffixes');
		expect(matches[0].confidence).toBe('probable');
		expect(matches[0].corroboration).toContain('year');
	});
});

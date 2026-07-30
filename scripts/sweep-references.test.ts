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

	it('credits the longer reference when one title contains another', () => {
		const catalogue = [
			source('1887-batchelor-grammar', 'A Grammar of the Ainu Language', 'Batchelor, John', 1887),
			source('2000-tamura-ainu-language', 'The Ainu Language', 'Tamura, Suzuko', 2000)
		];
		const matches = findCatalogueMatches(
			'Batchelor, John. 1887. A Grammar of the Ainu Language. In Chamberlain, B. H. 2000.',
			catalogue,
			'citing-work'
		);
		expect(matches.map((m) => m.source.slug)).toEqual(['1887-batchelor-grammar']);
	});

	it('keeps the shorter work when it is also cited on its own', () => {
		const catalogue = [
			source('2017-senuma-toward', 'Toward Universal Dependencies for Ainu', 'Senuma, Hajime', 2017),
			source('2018-senuma-ud', 'Universal Dependencies for Ainu', 'Senuma, Hajime', 2018)
		];
		const matches = findCatalogueMatches(
			[
				'Senuma, Hajime. 2017. Toward Universal Dependencies for Ainu. LREC.',
				'Senuma, Hajime. 2018. Universal Dependencies for Ainu. LREC.'
			].join('\n'),
			catalogue,
			'citing-work'
		);
		expect(matches.map((m) => m.source.slug).sort()).toEqual([
			'2017-senuma-toward',
			'2018-senuma-ud'
		]);
	});

	it('corroborates the occurrence that stands alone, not merely the first', () => {
		const catalogue = [
			source('1887-batchelor-grammar', 'A Grammar of the Ainu Language', 'Batchelor, John', 1887),
			source('2000-tamura-ainu-language', 'The Ainu Language', 'Tamura, Suzuko', 2000)
		];
		// Tamura's title occurs first inside Batchelor's, then on its own further on.
		const matches = findCatalogueMatches(
			[
				'Batchelor, John. 1887. A Grammar of the Ainu Language. Tokyo.',
				'x'.repeat(400),
				'Tamura, Suzuko. 2000. The Ainu Language. Tokyo: Sanseido.'
			].join(' '),
			catalogue,
			'citing-work'
		);
		const tamura = matches.find((m) => m.source.slug === '2000-tamura-ainu-language');
		expect(tamura).toBeDefined();
		expect(tamura!.confidence).toBe('probable');
		expect(tamura!.corroboration).toEqual(expect.arrayContaining(['year', 'author']));
	});

	it('does not let an uncorroborated host displace a corroborated match', () => {
		const catalogue = [
			// the host title is present, but neither its year nor its author is nearby
			source('1990-host', 'Studies on The Ainu Language and Culture', 'Nobody, X.', 1990),
			source('2000-tamura-ainu-language', 'The Ainu Language', 'Tamura, Suzuko', 2000)
		];
		const matches = findCatalogueMatches(
			'Tamura, Suzuko. 2000. Studies on The Ainu Language and Culture.',
			catalogue,
			'citing-work'
		);
		expect(matches.map((m) => m.source.slug)).toContain('2000-tamura-ainu-language');
	});
});

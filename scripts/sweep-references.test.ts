import { describe, expect, it } from 'vitest';
import {
	extractReferenceSection,
	findCatalogueMatches,
	isReferenceHeading,
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

describe('isReferenceHeading', () => {
	const accepted = [
		'References',
		'REFERENCES',
		'Bibliography',
		'Sources and References',
		'Works Cited',
		'参考文献',
		'引用文献',
		'参　考　文　献',
		'参 考 文 献',
		'参     考   文    献',
		'【参考文献】',
		'〔参考文献〕',
		'〇参考文献',
		'＊参考文献',
		'8. 参考文献',
		'参考文献・ウェブサイト',
		'参考文献、Web サイト',
		'参照・参考文献',
		'644         参照・参考文献',
		'文献目録',
		'Literaturverzeichnis'
	];
	for (const line of accepted) {
		it(`accepts ${JSON.stringify(line)}`, () => expect(isReferenceHeading(line)).toBe(true));
	}

	// Prose that merely names a bibliography must not open a reference section.
	const rejected = [
		'例文は，参考文献としてあげたアイヌ口承文学のテキストから得た．テキストのほと',
		'資料一覧については、参考文献の後に用例資料として示した。',
		'1 用例の表記、グロス、訳は全て引用者による。引用文献を参考にした。',
		'4 田村(1960)は、本稿末尾参考文献一覧の田村（福田）すず子(1960)を指す。',
		'26)の Bibliography にあげられていないし， B        .Pil',
		'',
		'Introduction',
		'第3章 動詞'
	];
	for (const line of rejected) {
		it(`rejects ${JSON.stringify(line.slice(0, 28))}`, () =>
			expect(isReferenceHeading(line)).toBe(false));
	}
});

describe('extractReferenceSection heading choice', () => {
	it('prefers the last heading, so a table-of-contents entry does not win', () => {
		const result = extractReferenceSection(
			[
				'Contents',
				'参考文献',
				'1. Introduction',
				'body text here',
				'参考文献',
				'田村すず子 1996 アイヌ語沙流方言辞典 東京: 草風館',
				'中川裕 1995 アイヌ語千歳方言辞典 東京: 草風館'
			].join('\n')
		);
		expect(result?.text).toContain('田村');
		expect(result?.text).not.toContain('Introduction');
	});

	it('opens at the FIRST occurrence when the heading is a running head', () => {
		const lines = ['body'];
		// the same heading printed atop each page of the bibliography
		for (let page = 0; page < 4; page++) {
			lines.push(`64${page}         参照・参考文献`, `entry for page ${page}`, 'more of that entry');
		}
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('entry for page 0');
		expect(result?.text).toContain('entry for page 3');
	});
});

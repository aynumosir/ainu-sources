import { describe, expect, it } from 'vitest';
import {
	extractReferenceSection,
	findCatalogueMatches,
	isReferenceHeading,
	isTerminalHeading,
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

describe('reference sweep — alias coverage', () => {
	const withAliases = (
		slug: string,
		title: string,
		altTitles: string[],
		author: string,
		yearStart: number
	) => ({ ...source(slug, title, author, yearStart), altTitles });

	it('keeps a work whose second alias is cited on its own', () => {
		// The first alias to hit is nested inside the longer work; the alternate title
		// is an independent citation further down.
		const catalogue = [
			withAliases(
				'2018-senuma-ud',
				'Universal Dependencies for Ainu',
				['Ainu Dependency Treebank Report'],
				'Senuma, Hajime',
				2018
			),
			source('2017-senuma-toward', 'Toward Universal Dependencies for Ainu', 'Senuma, Hajime', 2017)
		];
		const matches = findCatalogueMatches(
			[
				'Senuma, Hajime. 2017. Toward Universal Dependencies for Ainu. LREC.',
				'Senuma, Hajime. 2018. Ainu Dependency Treebank Report. LREC.'
			].join(' '),
			catalogue,
			'citing-work'
		);
		expect(matches.map((m) => m.source.slug).sort()).toEqual([
			'2017-senuma-toward',
			'2018-senuma-ud'
		]);
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
		'文献',
		'Literaturverzeichnis',
		// qualifiers the original whole-line regex carried, or printed alongside
		'主要参考文献',
		'引用・参考文献',
		'参考・引用文献',
		'引用・参照文献',
		'参照文献・参照ウェブサイト',
		'参考文献一覧',
		'参照文献(参照ウェブサイトを含む)',
		'3.2 参考文献',
		'References Cited',
		'Bibliographie'
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
		'第3章 動詞',
		// A numbered citation in running prose. Stripping from the first parenthesis
		// would reduce these to bare 文献, and three of them in one body would open
		// the "bibliography" at the first prose citation.
		'文献(3)によると、この語は連体形をとる',
		'文献(1)を参照',
		// A bibliography entry, not a heading: the folio stripper must not promote it.
		'1985 文献',
		'文献学入門',
		'この参考文献',
		'参考文献について'
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
		// the same heading printed atop each page of the bibliography, a page of OCR
		// lines apart, which is what marks it as a header rather than a duplicate
		for (let page = 0; page < 4; page++) {
			lines.push(`64${page}         参照・参考文献`);
			lines.push(`entry for page ${page}`);
			for (let line = 0; line < 30; line++) lines.push(`reference entry ${page}-${line}`);
		}
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('entry for page 0');
		expect(result?.text).toContain('entry for page 3');
	});

	it('takes the last chapter when each chapter carries its own bibliography', () => {
		const lines: string[] = [];
		for (let chapter = 1; chapter <= 3; chapter++) {
			lines.push(`第${chapter}章`);
			for (let i = 0; i < 200; i++) lines.push(`chapter ${chapter} body line ${i}`);
			lines.push('参考文献', `bibliography of chapter ${chapter}`, 'a second entry here');
		}
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('bibliography of chapter 3');
		expect(result?.text).not.toContain('chapter 2 body line');
	});

	it('does not pick a table-of-contents line just because a running head follows', () => {
		// TOC entry, then the real section, then one running-head page: three hits of
		// the same heading, but only the last two are contiguous.
		const lines = ['Contents', '参考文献 ... 120'];
		for (let i = 0; i < 200; i++) lines.push(`body line ${i}`);
		lines.push('参考文献', 'first bibliography page', 'entry two');
		for (let i = 0; i < 30; i++) lines.push(`reference entry ${i}`);
		lines.push('121  参考文献', 'second bibliography page');
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('first bibliography page');
		expect(result?.text).not.toContain('body line');
	});
});

describe('isTerminalHeading', () => {
	for (const line of ['Appendix', 'Appendix A', '【索引】', '第9章 索引', '索引', '120  索引', '人名索引'])
		it(`closes on ${JSON.stringify(line)}`, () => expect(isTerminalHeading(line)).toBe(true));
	for (const line of ['参考文献', 'body text', 'Indexing the corpus'])
		it(`does not close on ${JSON.stringify(line)}`, () =>
			expect(isTerminalHeading(line)).toBe(false));
});

describe('extractReferenceSection case folding', () => {
	it('treats Bibliography and BIBLIOGRAPHY as one running head', () => {
		// The Nowakowski dissertation prints the heading mixed-case on its first
		// bibliography page and upper-case on the rest.
		const lines = ['body', 'Bibliography', 'reference one, the first entry'];
		for (let i = 0; i < 30; i++) lines.push(`entry ${i}`);
		for (let page = 0; page < 3; page++) {
			lines.push('BIBLIOGRAPHY');
			for (let i = 0; i < 30; i++) lines.push(`later entry ${page}-${i}`);
		}
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('reference one, the first entry');
	});
});

describe('extractReferenceSection page furniture', () => {
	it('removes running heads and folios so a title spanning a page break matches', () => {
		const lines = ['body', '644  参考文献', 'Senuma, Hajime. 2017. Toward Universal'];
		for (let i = 0; i < 30; i++) lines.push(`filler entry ${i}`);
		lines.push('645', '646  参考文献', 'Dependencies for Ainu. LREC.');
		for (let i = 0; i < 30; i++) lines.push(`more filler ${i}`);
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).not.toMatch(/参考文献/u);
		expect(result?.text).not.toMatch(/^[\s　]*\d{1,4}[\s　]*$/mu);
		expect(result?.text).toContain('Toward Universal');
	});

	it('keeps the real bibliography when an afterword carries a further-reading heading', () => {
		const lines = ['参考文献'];
		for (let page = 0; page < 4; page++) {
			lines.push(`page ${page} real bibliography entry`);
			for (let i = 0; i < 30; i++) lines.push(`entry ${page}-${i}`);
			lines.push(`12${page}  参考文献`);
		}
		for (let i = 0; i < 50; i++) lines.push(`afterword prose ${i}`);
		lines.push('参考文献', 'a single further-reading item in the postface');
		const result = extractReferenceSection(lines.join('\n'));
		expect(result?.text).toContain('page 0 real bibliography entry');
	});
});

describe('corroboration window', () => {
	it('does not let a neighbouring entry corroborate a title', () => {
		const catalogue = [
			source('2000-tamura-ainu-language', 'The Ainu Language', 'Tamura, Suzuko', 2000)
		];
		// Batchelor's printed title contains Tamura's, and Tamura's year and surname
		// appear only in the NEXT entry, well past one entry's width.
		const matches = findCatalogueMatches(
			[
				'Batchelor, John. 1887. A Grammar of the Ainu Language. Tokyo: Yushodo.',
				'Vovin, Alexander. 1993. A Reconstruction of Proto-Ainu. Leiden: Brill.',
				'Tamura, Suzuko. 2000. Ainugo no sekai. Tokyo: Yoshikawa.'
			].join(' '),
			catalogue,
			'citing-work'
		);
		expect(matches).toHaveLength(1);
		expect(matches[0].confidence).toBe('candidate');
		expect(matches[0].corroboration).toEqual([]);
	});

	it('still corroborates from the entry the title belongs to', () => {
		const catalogue = [
			source('2000-tamura-ainu-language', 'The Ainu Language', 'Tamura, Suzuko', 2000)
		];
		const matches = findCatalogueMatches(
			'Tamura, Suzuko. 2000. The Ainu Language. Tokyo: Sanseido.',
			catalogue,
			'citing-work'
		);
		expect(matches[0].confidence).toBe('probable');
		expect(matches[0].corroboration).toEqual(expect.arrayContaining(['year', 'author']));
	});
});

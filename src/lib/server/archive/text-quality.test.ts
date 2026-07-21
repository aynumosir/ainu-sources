import { describe, expect, it } from 'vitest';
import { assessTextQuality } from './text-quality';

describe('broken text detection', () => {
	it('condemns a per-character text layer', () => {
		// What pdftotext yields when a PDF positions every glyph separately.
		const text = 'S\nt\ne\nl\nl\ne\nr\n4\n.\nS'.repeat(4);
		expect(assessTextQuality([{ page: 40, text }])).toMatchObject({ reliability: 'suspect' });
	});

	it('condemns a variant whose sampled pages are empty', () => {
		expect(assessTextQuality([{ page: 1, text: '   \n\n' }])).toMatchObject({ reliability: 'suspect' });
	});

	it('declines to certify ordinary prose as sound', () => {
		// The check finds one failure; it is not evidence that text is accurate,
		// so anything that is not plainly broken stays unassessed.
		const japanese = '本書の第2刷に当たって，ぜひ付記しなければならないことは，我が国のアイヌ語研究の\n先達金田一京助先生と，先生の愛弟子久保寺逸彦博士が他界されたことである．';
		expect(assessTextQuality([{ page: 1, text: japanese }]).reliability).toBe('unassessed');
	});

	it('does not condemn a word list of short but real lines', () => {
		const wordlist = ['kamuy', 'pirka', 'aynu', 'itak', 'cise', 'nupuri', 'wakka'].join('\n');
		expect(assessTextQuality([{ page: 5, text: wordlist }]).reliability).toBe('unassessed');
	});
});

describe('CJK spacing fragmentation', () => {
	it('condemns a space-separated katakana text layer', () => {
		// What extraction yields when the publisher stored a space between every character.
		const line = [...'アイヌ語カラフトライシカ'].join(' ');
		const text = Array.from({ length: 6 }, () => line).join('\n');
		expect(assessTextQuality([{ page: 12, text }])).toMatchObject({ reliability: 'suspect' });
	});

	it('does not condemn a glossary of two-character terms', () => {
		const terms = [
			'東京',
			'大阪',
			'京都',
			'福岡',
			'長崎',
			'広島',
			'岡山',
			'奈良',
			'三重',
			'愛知',
			'静岡',
			'千葉',
			'埼玉',
			'群馬',
			'栃木',
			'茨城',
			'福島',
			'宮城',
			'秋田',
			'山形',
			'青森',
			'石川',
			'富山',
			'長野',
			'岐阜',
			'滋賀',
			'佐賀',
			'大分',
			'宮崎',
			'沖縄'
		];
		const text = terms.map((term, index) => `${term} ${(34.5 - index * 0.4).toFixed(1)}`).join('\n');
		expect(assessTextQuality([{ page: 3, text }]).reliability).toBe('unassessed');
	});

	it('does not condemn a Cyrillic dictionary page', () => {
		const russian = [
			'слово — единица речи, служащая для выражения понятия.',
			'лексика — словарный состав языка, его словарный запас.'
		].join('\n');
		expect(assessTextQuality([{ page: 88, text: russian }]).reliability).toBe('unassessed');
	});

	it('does not condemn mixed romanized Ainu and kana lines', () => {
		const lines = [
			'kamuy コロ ピㇼカ アコロ イタク',
			'sisam コロ アイヌ イタク アン ロ',
			'pirka ノカ アコロ イタク ネ ワ',
			'cise コロ ペッ カムイ コタン'
		];
		const text = [...lines, ...lines].join('\n');
		expect(assessTextQuality([{ page: 21, text }]).reliability).toBe('unassessed');
	});

	it('does not condemn isolated CJK characters in Latin text', () => {
		const text = [
			'The field notes record 金 for gold, 銀 for silver, and 銅 for copper.',
			'Later pages add 鉄 (iron), 石 (stone), 木 (wood), 水 (water), 火 (fire), 土 (earth), 玉 (jade).'
		].join('\n');
		expect(assessTextQuality([{ page: 7, text }]).reliability).toBe('unassessed');
	});
});

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

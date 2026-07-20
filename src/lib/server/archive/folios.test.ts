import { describe, expect, it } from 'vitest';
import { detectFolios } from './folios';

const body = (n: string) => `本文の行がここにある\nさらに本文\n${n}`;

describe('printed folio detection', () => {
	it('recovers a folio that runs behind the scan position', () => {
		// Four pages of front matter, then the book starts numbering at 1.
		const pages = [
			{ page: 1, text: '扉' },
			{ page: 2, text: '' },
			{ page: 3, text: '目次' },
			{ page: 4, text: '' },
			...Array.from({ length: 8 }, (_, i) => ({ page: i + 5, text: body(String(i + 1)) }))
		];
		const folios = detectFolios(pages);
		expect(folios.find((f) => f.page === 5)?.label).toBe('1');
		expect(folios.find((f) => f.page === 12)?.label).toBe('8');
		expect(folios.some((f) => f.page <= 4)).toBe(false);
	});

	it('ignores a number that does not continue across pages', () => {
		// A year in a running head, and a table cell, neither of them folios.
		const pages = [
			{ page: 1, text: '昭和56\n本文' },
			{ page: 2, text: '本文\n1964' },
			{ page: 3, text: '本文\n42' },
			{ page: 4, text: '本文のみ' },
			{ page: 5, text: '本文\n7' }
		];
		expect(detectFolios(pages)).toEqual([]);
	});

	it('reads decorated folios and roman numerals', () => {
		const arabic = Array.from({ length: 9 }, (_, i) => ({ page: i + 1, text: body(`— ${i + 10} —`) }));
		expect(detectFolios(arabic).map((f) => f.label)).toEqual([
			'10', '11', '12', '13', '14', '15', '16', '17', '18'
		]);

		const numerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
		const roman = numerals.map((label, i) => ({ page: i + 1, text: body(label) }));
		expect(detectFolios(roman).map((f) => f.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('refuses a page that two runs number differently', () => {
		// A work whose pages carry both a folio and a numbered table column:
		// two runs advance together, and neither can be trusted over the other.
		const pages = Array.from({ length: 10 }, (_, i) => ({
			page: i + 1,
			text: `${i + 100}\n本文の行\n${i + 1}`
		}));
		expect(detectFolios(pages)).toEqual([]);
	});

	it('requires a run long enough to be numbering rather than coincidence', () => {
		const pages = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: body(String(i + 1)) }));
		expect(detectFolios(pages)).toEqual([]);
		expect(detectFolios(pages, 5)).toHaveLength(5);
	});
});

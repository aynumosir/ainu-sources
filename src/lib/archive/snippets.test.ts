import { describe, expect, it } from 'vitest';
import { highlightSnippet } from './snippets';

describe('highlightSnippet', () => {
	it('splits text into highlighted and plain runs', () => {
		expect(highlightSnippet('abc def ghi', [{ start: 4, end: 7 }])).toEqual([
			{ text: 'abc ', highlighted: false },
			{ text: 'def', highlighted: true },
			{ text: ' ghi', highlighted: false }
		]);
	});

	it('merges overlapping and adjacent offsets', () => {
		expect(
			highlightSnippet('abcdef', [
				{ start: 1, end: 3 },
				{ start: 3, end: 5 },
				{ start: 2, end: 4 }
			])
		).toEqual([
			{ text: 'a', highlighted: false },
			{ text: 'bcde', highlighted: true },
			{ text: 'f', highlighted: false }
		]);
	});

	it('clamps invalid ranges to the text bounds', () => {
		expect(highlightSnippet('abc', [{ start: -2, end: 8 }])).toEqual([
			{ text: 'abc', highlighted: true }
		]);
	});

	it('drops empty ranges', () => {
		expect(highlightSnippet('abc', [{ start: 1, end: 1 }])).toEqual([
			{ text: 'abc', highlighted: false }
		]);
	});
});

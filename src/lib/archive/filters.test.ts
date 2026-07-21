import { describe, expect, it } from 'vitest';
import { archiveFilterHref, archiveFiltersToParams, parseArchiveFilters } from './filters';

const parse = (qs: string) => parseArchiveFilters(new URLSearchParams(qs));

describe('parseArchiveFilters', () => {
	it('returns defaults for an empty query', () => {
		expect(parse('')).toEqual({
			text: undefined,
			dialect: undefined,
			decade: undefined,
			ocr: 'any',
			sort: 'updated'
		});
	});

	it('trims text and dialect', () => {
		expect(parse('q=%20ainu%20&dialect=%20Saru%20')).toMatchObject({
			text: 'ainu',
			dialect: 'Saru'
		});
	});

	it('accepts a positive integer decade', () => {
		expect(parse('decade=1900').decade).toBe(1900);
		expect(parse('decade=abc').decade).toBeUndefined();
		expect(parse('decade=0').decade).toBeUndefined();
	});

	it('parses OCR availability and known sort values', () => {
		expect(parse('searchable=1&sort=title')).toMatchObject({
			ocr: 'with',
			sort: 'title'
		});
		expect(parse('ocr=without').ocr).toBe('without');
		expect(parse('ocr=unknown').ocr).toBe('any');
		expect(parse('sort=significance').sort).toBe('significance');
		expect(parse('sort=bogus').sort).toBe('updated');
	});
});

describe('archiveFiltersToParams', () => {
	it('serializes only non-default values', () => {
		const params = archiveFiltersToParams({
			text: 'ainu',
			dialect: 'Saru',
			decade: 1900,
			ocr: 'with',
			sort: 'title'
		});
		expect(params.toString()).toBe('q=ainu&dialect=Saru&decade=1900&ocr=with&sort=title');
	});

	it('omits updated sort because it is the default', () => {
		expect(
			archiveFiltersToParams({
				ocr: 'any',
				sort: 'updated'
			}).toString()
		).toBe('');
	});

	it('serializes the without-text state', () => {
		expect(archiveFiltersToParams({ ocr: 'without', sort: 'updated' }).toString()).toBe('ocr=without');
	});
});

describe('archiveFilterHref', () => {
	it('builds a linkable URL', () => {
		expect(
			archiveFilterHref('/archive', {
				text: 'kamuy',
				ocr: 'any',
				sort: 'year-desc'
			})
		).toBe('/archive?q=kamuy&sort=year-desc');
	});
});

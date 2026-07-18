import { describe, expect, it } from 'vitest';
import { archiveFilterHref, archiveFiltersToParams, parseArchiveFilters } from './filters';

const parse = (qs: string) => parseArchiveFilters(new URLSearchParams(qs));

describe('parseArchiveFilters', () => {
	it('returns defaults for an empty query', () => {
		expect(parse('')).toEqual({
			text: undefined,
			dialect: undefined,
			decade: undefined,
			searchableOnly: false,
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

	it('parses searchable and known sort values', () => {
		expect(parse('searchable=1&sort=title')).toMatchObject({
			searchableOnly: true,
			sort: 'title'
		});
		expect(parse('sort=bogus').sort).toBe('updated');
	});
});

describe('archiveFiltersToParams', () => {
	it('serializes only non-default values', () => {
		const params = archiveFiltersToParams({
			text: 'ainu',
			dialect: 'Saru',
			decade: 1900,
			searchableOnly: true,
			sort: 'title'
		});
		expect(params.toString()).toBe('q=ainu&dialect=Saru&decade=1900&searchable=1&sort=title');
	});

	it('omits updated sort because it is the default', () => {
		expect(
			archiveFiltersToParams({
				searchableOnly: false,
				sort: 'updated'
			}).toString()
		).toBe('');
	});
});

describe('archiveFilterHref', () => {
	it('builds a linkable URL', () => {
		expect(
			archiveFilterHref('/archive', {
				text: 'kamuy',
				searchableOnly: false,
				sort: 'year-desc'
			})
		).toBe('/archive?q=kamuy&sort=year-desc');
	});
});

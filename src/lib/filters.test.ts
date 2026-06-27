import { describe, it, expect } from 'vitest';
import { parseFilters, SORT_OPTIONS } from './filters';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe('parseFilters', () => {
	it('returns sensible defaults for an empty query', () => {
		expect(parse('')).toEqual({
			q: undefined,
			category: undefined,
			types: [],
			genres: [],
			regions: [],
			languages: [],
			scripts: [],
			centuries: [],
			tag: undefined,
			person: undefined,
			hasDigital: undefined,
			sort: 'year-desc',
			page: 1
		});
	});

	it('trims q and drops it when blank', () => {
		expect(parse('q=%20%20ainu%20%20').q).toBe('ainu');
		expect(parse('q=%20%20').q).toBeUndefined();
	});

	it('collects repeated multi-value params', () => {
		const f = parse('types=book&types=manuscript&regions=hokkaido');
		expect(f.types).toEqual(['book', 'manuscript']);
		expect(f.regions).toEqual(['hokkaido']);
	});

	it('filters out empty multi-values', () => {
		expect(parse('types=&types=book&types=').types).toEqual(['book']);
	});

	it('parses centuries as finite numbers and drops non-numeric ones', () => {
		expect(parse('century=18&century=19&century=abc').centuries).toEqual([18, 19]);
	});

	it('accepts a known sort key', () => {
		expect(parse('sort=title').sort).toBe('title');
		expect(parse('sort=entries-desc').sort).toBe('entries-desc');
	});

	it('falls back to year-desc for an unknown sort key', () => {
		expect(parse('sort=bogus').sort).toBe('year-desc');
	});

	it('maps digital=1 to hasDigital true, anything else to undefined', () => {
		expect(parse('digital=1').hasDigital).toBe(true);
		expect(parse('digital=0').hasDigital).toBeUndefined();
		expect(parse('digital=yes').hasDigital).toBeUndefined();
	});

	it('parses a valid positive page number', () => {
		expect(parse('page=4').page).toBe(4);
	});

	it('defaults page to 1 for non-positive or non-numeric values', () => {
		expect(parse('page=0').page).toBe(1);
		expect(parse('page=-3').page).toBe(1);
		expect(parse('page=abc').page).toBe(1);
	});

	it('passes through tag, person and category', () => {
		const f = parse('tag=yukar&person=chiri-mashiho&category=dictionary');
		expect(f.tag).toBe('yukar');
		expect(f.person).toBe('chiri-mashiho');
		expect(f.category).toBe('dictionary');
	});
});

describe('SORT_OPTIONS', () => {
	it('lists the supported sort keys with year-desc first', () => {
		expect(SORT_OPTIONS[0]).toBe('year-desc');
		expect(SORT_OPTIONS).toEqual(['year-desc', 'year-asc', 'title', 'entries-desc', 'updated']);
	});
});

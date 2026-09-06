import { describe, expect, it } from 'vitest';
import { documentLabel, documentSection, groupBySection, pageCountOf, readerHref } from './keys';

describe('documentSection', () => {
	it('is the middle of a three-part key and empty otherwise', () => {
		expect(documentSection('bible/1co/001')).toBe('1co');
		expect(documentSection('aa-asai/001')).toBe('');
		expect(documentSection('a/b/c/d')).toBe('b/c');
	});
});

describe('documentLabel', () => {
	it('prefers the title and falls back to the key', () => {
		expect(documentLabel({ key: 'aa-asai/001', title: 'さらわれた娘' })).toBe('さらわれた娘');
		expect(documentLabel({ key: 'aa-asai/001', title: '  ' })).toBe('001');
		expect(documentLabel({ key: 'aa-asai/001', title: null })).toBe('001');
	});
});

describe('readerHref', () => {
	it('builds contents, document and part paths', () => {
		expect(readerHref('asai-take-folktales')).toBe('/sources/asai-take-folktales/read');
		expect(readerHref('asai-take-folktales', 'aa-asai/001')).toBe('/sources/asai-take-folktales/read/aa-asai/001');
		expect(readerHref('asai-take-folktales', 'aa-asai/001', 1)).toBe('/sources/asai-take-folktales/read/aa-asai/001');
		expect(readerHref('asai-take-folktales', 'aa-asai/001', 3)).toBe('/sources/asai-take-folktales/read/aa-asai/001?page=3');
	});
});

describe('pageCountOf', () => {
	it('never drops below one', () => {
		expect(pageCountOf(0, 400)).toBe(1);
		expect(pageCountOf(400, 400)).toBe(1);
		expect(pageCountOf(401, 400)).toBe(2);
	});
});

describe('groupBySection', () => {
	it('keeps reading order and splits on section change', () => {
		const groups = groupBySection([{ key: 'bible/1co/001' }, { key: 'bible/1co/002' }, { key: 'bible/2co/001' }, { key: 'x/1' }]);
		expect(groups.map((g) => [g.section, g.docs.length])).toEqual([['1co', 2], ['2co', 1], ['', 1]]);
	});
});

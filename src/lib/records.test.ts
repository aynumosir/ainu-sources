import { describe, expect, it } from 'vitest';
import { earlyRecords, recordsForCatalogue, recordsHref, recordsLinks } from './records';
import { projectRecordsIndex } from './records-index';

describe('early records integration', () => {
	it('keeps all witnesses on the work but isolates the separately catalogued Leiden copy', () => {
		expect(recordsForCatalogue('1792-uehara-moshiogusa')[0].units.map((u) => u.slug)).toEqual(['ninjal-1', 'ninjal-2', 'leiden']);
		expect(recordsForCatalogue('1792-uehara-ezo-hogen')[0].units.map((u) => u.slug)).toEqual(['leiden']);
		expect(recordsLinks('1792-uehara-ezo-hogen')[0].entries_url).toBeNull();
		expect(recordsLinks('1792-uehara-ezo-hogen')[0].units[0].url).toBe('https://rec.aynu.org/sources/moshiogusa/leiden/1');
	});
	it('does not infer availability from similar titles or unknown IDs', () => {
		expect(recordsForCatalogue('moshiogusa')).toEqual([]);
		expect(recordsLinks('missing')).toEqual([]);
	});
	it('only offers vocabulary for wordlists', () => {
		expect(recordsLinks('1739-itakura-hokkai-zuihitsu')[0].entries_url).toBeNull();
		expect(recordsLinks('1792-uehara-moshiogusa')[0].entries_url).toContain('/moshiogusa/entries');
	});
	it('uses supported remote locales and leaves downloads unlocalized', () => {
		expect(recordsHref('/sources/moshiogusa', 'ja')).toBe('https://rec.aynu.org/ja/sources/moshiogusa');
		for (const locale of ['en', 'ru', 'ain']) expect(recordsHref('/', locale)).toBe('https://rec.aynu.org/');
		expect(recordsLinks('1792-uehara-ezo-hogen')[0].units[0].tei_url).toBe('https://rec.aynu.org/export/tei/moshiogusa/leiden.xml');
	});
});

const catalogue = [{ slug: 'current', status: 'active', old_slugs: ['retired'] }];
const source = {
	slug: 'work', catalogue: 'retired', title: 'Title', titleLatin: 'Title', kind: 'prose',
	units: [{ slug: 'copy', label: '', pages: 3, items: 0, witness: { catalogue: null, title: null, holder: 'Holder', holderEn: 'Holder', shelfmark: null } }]
};
describe('records snapshot validation', () => {
	it('resolves published retired catalogue slugs and strips unrelated payloads', () => {
		const result = projectRecordsIndex({ sources: [source], private: 'discard' }, catalogue);
		expect(result.sources[0].catalogue).toBe('current');
		expect(result).not.toHaveProperty('private');
	});
	it('rejects broken identities and invalid route segments before replacing a snapshot', () => {
		for (const override of [{ catalogue: 'missing' }, { slug: '../escape' }, { units: [] }]) {
			expect(() => projectRecordsIndex({ sources: [{ ...source, ...override }] }, catalogue)).toThrow();
		}
		expect(() => projectRecordsIndex({ sources: [source, source] }, catalogue)).toThrow('Duplicate source');
		expect(() => projectRecordsIndex({ sources: [] }, catalogue)).toThrow();
	});
	it('follows merge chains and retired slugs, rejecting missing targets and cycles', () => {
		const merged = { slug: 'merged', status: 'merged', old_slugs: ['old-merged'], merged_into_slug: 'current' };
		expect(projectRecordsIndex({ sources: [{ ...source, catalogue: 'old-merged' }] }, [...catalogue, merged]).sources[0].catalogue).toBe('current');
		for (const target of ['missing', 'old-merged']) {
			expect(() => projectRecordsIndex({ sources: [{ ...source, catalogue: 'merged' }] }, [...catalogue, { ...merged, merged_into_slug: target }])).toThrow();
		}
	});
	it('keeps every published work reachable by its catalogue identity', () => {
		for (const record of earlyRecords) expect(recordsForCatalogue(record.catalogue)).toContainEqual(record);
	});
});

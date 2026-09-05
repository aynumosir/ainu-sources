/**
 * personFoldKeys: the keys under which one human being is found again when a
 * later source spells the name differently.
 */
import { describe, it, expect } from 'vitest';
import { canonicalSlugFor, foldKanji, foldRomaji, personFoldKeys } from './derive';

describe('foldKanji', () => {
	it('maps the old character forms that recur in personal names', () => {
		expect(foldKanji('金澤庄三郞')).toBe('金沢庄三郎');
		expect(foldKanji('河野廣道')).toBe('河野広道');
		expect(foldKanji('鳥居龍藏')).toBe('鳥居竜蔵');
		expect(foldKanji('新井田セイノ')).toBe('新井田セイノ');
	});
	it('keeps 齋 and 齊 apart', () => {
		expect(foldKanji('齋藤')).not.toBe(foldKanji('齊藤'));
	});
});

describe('personFoldKeys', () => {
	it('folds an old-form spelling onto the new-form key', () => {
		const a = personFoldKeys({ canon: null, name: '金澤 庄三郎', nameEn: null });
		const b = personFoldKeys({ canon: null, name: '金沢 庄三郎', nameEn: null });
		expect(a.some((k) => b.includes(k))).toBe(true);
	});

	it('meets a romanised name in either word order through foldRomaji', () => {
		expect(foldRomaji('Genzō Sarashina')).toBe(foldRomaji('Sarashina Genzo'));
		const a = personFoldKeys({ canon: null, name: 'Genzō Sarashina', nameEn: 'Genzō Sarashina' });
		const b = personFoldKeys({ canon: null, name: '更科 源蔵', nameEn: 'Sarashina Genzo' });
		expect(a.some((k) => b.includes(k))).toBe(true);
	});

	it('folds two rows that name the same Wikidata item', () => {
		const a = personFoldKeys({ canon: null, name: '横山 むつみ', nameEn: null, wikidata: 'Q128896159' });
		const b = personFoldKeys({ canon: null, name: '知里 むつみ', nameEn: null, wikidata: 'Q128896159' });
		expect(a).toContain('q:Q128896159');
		expect(a.some((k) => b.includes(k))).toBe(true);
	});

	it('keeps two different people apart', () => {
		const a = personFoldKeys({ canon: null, name: '田村 すゞ子', nameEn: 'Tamura Suzuko' });
		const b = personFoldKeys({ canon: null, name: '中川 裕', nameEn: 'Nakagawa Hiroshi' });
		expect(a.some((k) => b.includes(k))).toBe(false);
		expect(personFoldKeys({ canon: null, name: '', nameEn: null })).toEqual([]);
	});
});

it('does not resolve a qualified author through a surname-only alias', () => {
 expect(canonicalSlugFor('Sato, Genrokuro')).toBeNull();
 expect(canonicalSlugFor('SATO, Yuka')).toBeNull();
 expect(canonicalSlugFor('Sato, Tomomi')).toBe('sato-tomomi');
});

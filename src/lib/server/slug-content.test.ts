import { describe, it, expect } from 'vitest';
import { slugHasContent, slugContentError } from './slug-content';
import { slugify } from '$lib/format';

describe('slugHasContent', () => {
	// Every one of these was minted by the derivation path and shipped as a
	// public slug; they are the reason this predicate exists.
	it.each([
		'ainu-14',
		'ainu-16',
		'ainu-ainu',
		'ainu-ainu-2',
		'ainu-no',
		'ainu-no-to-3',
		'ainu-o-ku',
		'noainu',
		'noainu-2',
		'noainu-3',
		'ainu-5f075bb5',
		'ainu-66b37c83',
		'source-fa25e090',
		'no-4875640b',
		'2001-7-13-1-13-13-17-kzfw9y'
	])('rejects %s', (slug) => {
		expect(slugHasContent(slug)).toBe(false);
		expect(slugContentError(slug)).toMatch(/names nothing/);
	});

	// Real slugs from the catalogue, including ones that look odd but identify
	// their work: romanized volume markers, a Cyrillic transliteration, an
	// author-only slug.
	it.each([
		'1621-deangelis-second-ezo-report',
		'1630-anon-matsumae-no-kotoba',
		'2016-dobrotvorsky-18-kazan',
		'1947-anon-ainuka-dai1shu',
		'2004-anetai-densho-yuyo-shokubutsu-pui-dai10ho',
		'1898-kanazawa-ninjal-topical-ainu-conversation-dictionary',
		'2000-komatsu-samani-ainu-vocabulary',
		'1987-kayano',
		'ainu-mintanshu'
	])('accepts %s', (slug) => {
		expect(slugHasContent(slug)).toBe(true);
		expect(slugContentError(slug)).toBeNull();
	});

	it('ignores a leading year, which dates a work without naming it', () => {
		expect(slugHasContent('1875-ainu')).toBe(false);
		expect(slugHasContent('1875-dobrotvorsky')).toBe(true);
	});

	it('does not count a segment carrying digits', () => {
		expect(slugHasContent('ainu-2232e395')).toBe(false);
		expect(slugHasContent('m-m-m-m-18-1875')).toBe(false);
	});

	// Japanese surnames are built from the same syllables as the particles, so a
	// decomposition test that ignores this rejects real authors. Nakagawa is
	// na+ka+ga+wa and Wakana is wa+ka+na, and both name people in the catalogue.
	it.each(['nakagawa', 'wakana', 'kanazawa', 'kayano', 'naganuma', 'kawakami'])(
		'keeps the surname %s',
		(surname) => {
			expect(slugHasContent(`1900-${surname}`)).toBe(true);
		}
	);

	it('handles degenerate input', () => {
		expect(slugHasContent('')).toBe(false);
		expect(slugHasContent('-')).toBe(false);
		expect(slugHasContent('1875')).toBe(false);
	});
});

describe('the titles that produced the bad slugs', () => {
	// slugify skips kanji, so what these leave behind is the category word and
	// a particle. The predicate is what notices.
	it.each([
		['アイヌ語入門 : 改訂版 練習編14', 'ainu-14'],
		['様似のアイヌ語語彙集', 'noainu']
	])('%s slugifies to a slug that names nothing', (title, expected) => {
		const base = slugify(title);
		expect(base).toBe(expected);
		expect(slugHasContent(base)).toBe(false);
	});

	it('a title with latin material still derives a usable slug', () => {
		const base = slugify('Ainu-English-Japanese Dictionary (Batchelor)');
		expect(slugHasContent(base)).toBe(true);
	});
});

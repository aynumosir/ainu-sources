import { describe, expect, it } from 'vitest';
import { projectMdbIndex } from './mdb-index';
import { mdbLexemesHref, mdbLinks } from './mdb';
import snapshot from './mdb-index.json';

const catalogue = [
	{ slug: 'work', status: 'active', old_slugs: ['old-work'] },
	{ slug: 'merged-work', status: 'merged', merged_into_slug: 'old-work', old_slugs: [] }
];
const source = { id: 'Dictionary_ID', catalogue: 'work', title: 'Dictionary', lexemes: 3 };
const input = (s = source) => ({ version: 1, sources: [s] });

describe('dictionary coverage', () => {
	it('resolves old and merged catalogue slugs without changing the dictionary ID', () => {
		for (const slug of ['work', 'old-work', 'merged-work']) {
			expect(projectMdbIndex(input({ ...source, catalogue: slug }), catalogue).sources).toEqual([source]);
		}
	});
	it('rejects missing, private and cyclic catalogue identities', () => {
		expect(() => projectMdbIndex(input(), [])).toThrow('Unresolved');
		expect(() => projectMdbIndex(input(), [{ ...catalogue[0], status: 'hidden' }])).toThrow('Unresolved');
		expect(() => projectMdbIndex(input(), [{ ...catalogue[0], status: 'merged', merged_into_slug: 'old-work' }])).toThrow('cycle');
	});
	it('rejects malformed or ambiguous coverage rather than displaying misleading links', () => {
		for (const bad of [null, {}, { version: 2, sources: [source] }, { version: 1, sources: [] },
			{ version: 1, sources: [source, source] }, input({ ...source, id: '' }), input({ ...source, title: '' }),
			...[0, -1, 1.5, NaN, Infinity].map((lexemes) => input({ ...source, lexemes }))]) {
			expect(() => projectMdbIndex(bad, catalogue)).toThrow();
		}
	});
	it('encodes exact IDs and uses the MDB locale supported by the reader', () => {
		for (const locale of ['en', 'ja', 'ru', 'ain']) {
			const url = new URL(mdbLexemesHref('Dictionary & source=other/#?', locale));
			expect(url.origin).toBe('https://mdb.aynu.org');
			expect(url.pathname).toBe(locale === 'ja' ? '/ja/lexemes' : '/lexemes');
			expect([...url.searchParams]).toEqual([['source', 'Dictionary & source=other/#?']]);
		}
	});
	it('shows only attested dictionaries with validated positive counts', () => {
		expect(mdbLinks('missing')).toEqual([]);
		for (const source of snapshot.sources) {
			const [link] = mdbLinks(source.catalogue);
			expect(link.lexemes).toBeGreaterThan(0);
			expect(new URL(link.url).searchParams.get('source')).toBe(source.id);
		}
	});
});

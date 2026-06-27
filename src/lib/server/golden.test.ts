import { describe, it, expect } from 'vitest';
import {
	projectSource,
	canonicalStringify,
	hashProjection,
	rootHash,
	SOURCE_SCALAR_COLUMNS,
	type ProjectSourceInput
} from './golden';

// A small, fully-populated, hand-built fixture. Child arrays are listed in a
// deliberately UN-sorted order so the determinism/order-independence tests have
// something to normalise.
const fixture: ProjectSourceInput = {
	source: {
		id: 'src-1',
		slug: '1875-dobrotvorsky-ainu-russian-dictionary',
		title: 'アイヌ・ロシア語辞典',
		titleEn: 'Ainu–Russian Dictionary',
		titleAin: null,
		altTitles: ['Айнско-русскій словарь'],
		category: 'primary',
		type: 'dictionary',
		author: 'M. M. Dobrotvorsky',
		yearText: '1875',
		yearStart: 1875,
		yearEnd: 1875,
		yearCertainty: 'exact',
		dialect: 'Sakhalin',
		region: 'sakhalin',
		languages: ['ain', 'rus'],
		scripts: ['cyrl', 'latn'],
		holdingInstitution: 'Kazan University',
		callNumber: 'X-123',
		entryCount: 12000,
		entryCountLabel: 'entries',
		license: 'public-domain',
		summary: 'First substantial Ainu–Russian dictionary.',
		notes: null,
		reliability: 'high',
		provenanceRepo: 'ainu-dictionaries',
		provenancePath: 'dobrotvorsky/1875.json',
		externalIds: { wikidata: 'Q123', ndl: '000000' },
		featured: true,
		createdAt: new Date('2024-01-02T03:04:05.678Z'),
		updatedAt: new Date('2025-06-07T08:09:10.111Z'),
		createdBy: 'user-a',
		updatedBy: 'user-b'
	},
	links: [
		{ type: 'pdf', label: 'Full scan', url: 'https://example.org/b.pdf', sortOrder: 2, notes: 'ignored' },
		{ type: 'doi', label: null, url: 'https://doi.org/10.1/x', sortOrder: 1 },
		{ type: 'pdf', label: 'Cover', url: 'https://example.org/a.pdf', sortOrder: 0 }
	],
	tags: ['dictionary', 'sakhalin-ainu', 'comparative', { name: 'lexicography' }],
	persons: [
		{ slug: 'dobrotvorsky', role: 'author', sortOrder: 0 },
		{ slug: 'anonymous-scribe', role: 'recorder', sortOrder: 1 }
	],
	places: [
		{ slug: 'sakhalin', role: 'dialect', notes: null },
		{ slug: 'kazan', role: 'holding', notes: 'archived' }
	],
	institutions: [
		{ slug: 'kazan-university', role: 'holding', callNumber: 'X-123', notes: null }
	],
	relations: [
		{ type: 'cites', toSlugOrId: '1850-zzz', direction: 'out' },
		{ type: 'edition-of', toSlugOrId: '1860-aaa', direction: 'in' }
	]
};

/** Fisher–Yates-ish deterministic shuffle so the test is reproducible. */
function shuffle<T>(arr: T[], seed = 7): T[] {
	const a = arr.slice();
	let s = seed;
	const rnd = () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

describe('projectSource — shape', () => {
	it('captures every sources scalar column plus the child arrays', () => {
		const p = projectSource(fixture);
		for (const col of SOURCE_SCALAR_COLUMNS) {
			expect(p, `missing scalar column ${col}`).toHaveProperty(col);
		}
		expect(Object.keys(p).sort()).toEqual(
			[...SOURCE_SCALAR_COLUMNS, 'links', 'tags', 'persons', 'places', 'institutions', 'relations'].sort()
		);
	});

	it('normalises Date timestamps to epoch-ms and parses booleans/json', () => {
		const p = projectSource(fixture);
		expect(p.createdAt).toBe(new Date('2024-01-02T03:04:05.678Z').getTime());
		expect(p.updatedAt).toBe(new Date('2025-06-07T08:09:10.111Z').getTime());
		expect(p.featured).toBe(true);
		expect(p.languages).toEqual(['ain', 'rus']);
		expect(p.externalIds).toEqual({ wikidata: 'Q123', ndl: '000000' });
	});

	it('projects links as {type,label,url,sortOrder} sorted by (type,url), dropping notes/id', () => {
		const p = projectSource(fixture);
		expect(p.links).toEqual([
			{ type: 'doi', label: null, url: 'https://doi.org/10.1/x', sortOrder: 1 },
			{ type: 'pdf', label: 'Cover', url: 'https://example.org/a.pdf', sortOrder: 0 },
			{ type: 'pdf', label: 'Full scan', url: 'https://example.org/b.pdf', sortOrder: 2 }
		]);
	});

	it('projects tag names sorted, accepting both strings and {name} rows', () => {
		const p = projectSource(fixture);
		expect(p.tags).toEqual(['comparative', 'dictionary', 'lexicography', 'sakhalin-ainu']);
	});

	it('projects associations by stable slug key and relations with direction', () => {
		const p = projectSource(fixture);
		expect(p.persons).toEqual([
			{ slug: 'anonymous-scribe', role: 'recorder', sortOrder: 1 },
			{ slug: 'dobrotvorsky', role: 'author', sortOrder: 0 }
		]);
		expect(p.places).toEqual([
			{ slug: 'kazan', role: 'holding', notes: 'archived' },
			{ slug: 'sakhalin', role: 'dialect', notes: null }
		]);
		expect(p.institutions).toEqual([
			{ slug: 'kazan-university', role: 'holding', callNumber: 'X-123', notes: null }
		]);
		expect(p.relations).toEqual([
			{ type: 'edition-of', toSlugOrId: '1860-aaa', direction: 'in' },
			{ type: 'cites', toSlugOrId: '1850-zzz', direction: 'out' }
		]);
	});
});

describe('canonicalStringify', () => {
	it('sorts object keys recursively so insertion order cannot change the bytes', () => {
		const a = { b: 1, a: { d: 4, c: 3 } };
		const b = { a: { c: 3, d: 4 }, b: 1 };
		expect(canonicalStringify(a)).toBe(canonicalStringify(b));
		expect(canonicalStringify(a)).toBe('{"a":{"c":3,"d":4},"b":1}');
	});

	it('preserves array element order (arrays are meaningful, not key-sorted)', () => {
		expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
	});
});

describe('determinism', () => {
	it('same input → identical canonicalStringify and hash', () => {
		const a = projectSource(fixture);
		const b = projectSource(fixture);
		expect(canonicalStringify(a)).toBe(canonicalStringify(b));
		expect(hashProjection(a)).toBe(hashProjection(b));
	});
});

describe('order-independence', () => {
	it('shuffling link/tag/person/place/relation input arrays yields the SAME hash', () => {
		const baseline = hashProjection(projectSource(fixture));
		const shuffled: ProjectSourceInput = {
			source: fixture.source,
			links: shuffle(fixture.links!, 3),
			tags: shuffle(fixture.tags!, 11),
			persons: shuffle(fixture.persons!, 5),
			places: shuffle(fixture.places!, 9),
			institutions: shuffle(fixture.institutions!, 13),
			relations: shuffle(fixture.relations!, 17)
		};
		expect(hashProjection(projectSource(shuffled))).toBe(baseline);
	});

	it('reordering the scalar source keys yields the SAME hash', () => {
		const reordered: ProjectSourceInput = {
			...fixture,
			source: Object.fromEntries(shuffle(Object.entries(fixture.source), 23))
		};
		expect(hashProjection(projectSource(reordered))).toBe(hashProjection(projectSource(fixture)));
	});
});

describe('stable fixture hash', () => {
	it('projects to the exact pinned sha256 (guards against silent projection drift)', () => {
		expect(hashProjection(projectSource(fixture))).toBe(
			'6f6d61f0e5dde3587b6b53b1be05daab9d0283b9d30a734d33fd905e084c08a6'
		);
	});
});

describe('rootHash', () => {
	const entries = [
		{ id: 'src-1', slug: 's1', hash: 'aaaa' },
		{ id: 'src-2', slug: 's2', hash: 'bbbb' },
		{ id: 'src-3', slug: 's3', hash: 'cccc' }
	];

	it('is stable under source reordering', () => {
		expect(rootHash(entries)).toBe(rootHash(shuffle(entries, 4)));
	});

	it('accepts bare hash strings equivalently to manifest entries', () => {
		expect(rootHash(entries)).toBe(rootHash(entries.map((e) => e.hash)));
	});

	it('changes when any per-source hash changes', () => {
		const mutated = entries.map((e, i) => (i === 0 ? { ...e, hash: 'zzzz' } : e));
		expect(rootHash(mutated)).not.toBe(rootHash(entries));
	});
});

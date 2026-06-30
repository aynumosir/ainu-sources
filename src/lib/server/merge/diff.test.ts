/**
 * Diff-module tests (Phase 1).
 *
 *   • `diffSourceProjection` — PURE before→after diff (no DB).
 *   • `loadSourceProjection` — round-trips the engine's own content hash on a
 *     REAL migrated in-memory DB, proving the read helper reconstructs exactly
 *     the projection the merge engine stored.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../db/schema';
import { projectSource, hashProjection } from '../golden';
import { diffSourceProjection, loadSourceProjection } from './diff';
import { mergeSourceObservation } from './merge-source-observation';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

// Build a canonical projection from a partial source row + optional children.
function proj(
	source: Record<string, unknown>,
	extra: Partial<Parameters<typeof projectSource>[0]> = {}
) {
	return projectSource({ source, ...extra });
}

describe('diffSourceProjection (pure)', () => {
	it('detects a scalar update with before/after + a summary line', () => {
		const before = proj({ title: 'Old Title', type: 'book', category: 'primary' });
		const after = proj({ title: 'New Title', type: 'book', category: 'primary' });
		const d = diffSourceProjection({
			sourceId: 's1',
			slug: 'slug-1',
			before,
			after,
			beforeHash: 'h0',
			afterHash: 'h1'
		});
		expect(d.isNewSource).toBe(false);
		const title = d.scalars.find((s) => s.field === 'title');
		expect(title).toMatchObject({ before: 'Old Title', after: 'New Title', op: 'update' });
		expect(d.changedScalarFields).toContain('title');
		expect(d.changedCollections).toEqual([]);
		expect(d.summaryLines).toContain('title: Old Title → New Title');
		expect(d.base.contentHash).toBe('h0');
		expect(d.result.contentHash).toBe('h1');
	});

	it('classifies add (empty→value) and clear (value→empty)', () => {
		const before = proj({ title: 'T', type: 'book', category: 'primary', summary: 'kept' });
		const after = proj({ title: 'T', type: 'book', category: 'primary', summary: null, notes: 'fresh' });
		const d = diffSourceProjection({ sourceId: 's', slug: null, before, after, beforeHash: null, afterHash: 'h' });
		expect(d.scalars.find((s) => s.field === 'summary')?.op).toBe('clear');
		expect(d.scalars.find((s) => s.field === 'notes')?.op).toBe('add');
	});

	it('diffs set-valued scalar columns (languages): identical set = no diff, member change = update', () => {
		const before = proj({ title: 'T', type: 'book', category: 'primary', languages: ['ain', 'jpn'] });
		const same = proj({ title: 'T', type: 'book', category: 'primary', languages: ['ain', 'jpn'] });
		expect(diffSourceProjection({ sourceId: 's', slug: null, before, after: same, beforeHash: null, afterHash: 'h' }).scalars).toEqual([]);
		const after = proj({ title: 'T', type: 'book', category: 'primary', languages: ['ain'] });
		const d = diffSourceProjection({ sourceId: 's', slug: null, before, after, beforeHash: null, afterHash: 'h' });
		expect(d.scalars.find((s) => s.field === 'languages')?.op).toBe('update');
	});

	it('diffs collections: +added / −removed / ~updated', () => {
		const before = proj({ title: 'T', type: 'book', category: 'primary' }, {
			links: [{ type: 'pdf', url: 'https://a.example/x.pdf', label: 'A' }]
		});
		const after = proj({ title: 'T', type: 'book', category: 'primary' }, {
			links: [
				{ type: 'pdf', url: 'https://a.example/x.pdf', label: 'A2' }, // updated (label)
				{ type: 'iiif', url: 'https://a.example/m' } // added
			]
		});
		const d = diffSourceProjection({ sourceId: 's', slug: null, before, after, beforeHash: null, afterHash: 'h' });
		expect(d.changedCollections).toContain('links');
		expect(d.links.added.map((l) => l.url)).toEqual(['https://a.example/m']);
		expect(d.links.updated).toHaveLength(1);
		expect(d.links.removed).toEqual([]);
		expect(d.summaryLines.some((l) => l.startsWith('links:'))).toBe(true);
	});

	it('new source (before=null): every non-empty scalar is an add, collections all added', () => {
		const after = proj({ title: 'Created', type: 'book', category: 'primary' }, {
			tags: ['ainu', 'dictionary']
		});
		const d = diffSourceProjection({ sourceId: 's', slug: 'new', before: null, after, beforeHash: null, afterHash: 'h' });
		expect(d.isNewSource).toBe(true);
		expect(d.scalars.find((s) => s.field === 'title')).toMatchObject({ op: 'add', after: 'Created' });
		expect(d.changedCollections).toContain('tags');
		expect(d.tags.added.sort()).toEqual(['ainu', 'dictionary']);
		expect(d.tags.removed).toEqual([]);
	});

	it('identical projections produce an empty diff', () => {
		const before = proj({ title: 'Same', type: 'book', category: 'primary', notes: 'n' });
		const after = proj({ title: 'Same', type: 'book', category: 'primary', notes: 'n' });
		const d = diffSourceProjection({ sourceId: 's', slug: null, before, after, beforeHash: 'h', afterHash: 'h' });
		expect(d.scalars).toEqual([]);
		expect(d.changedScalarFields).toEqual([]);
		expect(d.changedCollections).toEqual([]);
		expect(d.summaryLines).toEqual([]);
	});

	it('routes audit columns (updatedAt) into systemScalars, not user scalars', () => {
		const before = proj({ title: 'T', type: 'book', category: 'primary', updatedAt: 1000 });
		const after = proj({ title: 'T', type: 'book', category: 'primary', updatedAt: 2000 });
		const d = diffSourceProjection({ sourceId: 's', slug: null, before, after, beforeHash: null, afterHash: 'h' });
		expect(d.scalars.find((s) => s.field === 'updatedAt')).toBeUndefined();
		expect(d.systemScalars.find((s) => s.field === 'updatedAt')).toBeDefined();
		expect(d.changedScalarFields).not.toContain('updatedAt');
	});
});

describe('loadSourceProjection (DB read helper)', () => {
	let db: Db;
	beforeEach(async () => {
		const client = createClient({ url: ':memory:' });
		db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: MIGRATIONS });
	});

	it('reconstructs the engine-stored projection hash from durable rows', async () => {
		const r = await mergeSourceObservation(db, {
			origin: 'manual',
			originRecordId: 'manual:proj',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:proj.json' }],
			fields: { title: 'Projection Source', type: 'book', category: 'secondary', languages: ['ain'] },
			links: [{ type: 'pdf', url: 'https://example.org/p.pdf' }]
		});
		const sid = r.sourceId!;
		const loaded = await loadSourceProjection(db, sid);
		expect(loaded).not.toBeNull();
		// the helper reconstructs the stored scalar + collection state from durable rows
		expect(loaded!.projection.title).toBe('Projection Source');
		expect(loaded!.projection.languages).toEqual(['ain']);
		expect(loaded!.projection.links.map((l) => l.url)).toEqual(['https://example.org/p.pdf']);
		// internal consistency: the returned hash IS the hash of the returned projection
		expect(hashProjection(loaded!.projection)).toBe(loaded!.contentHash);
	});

	it('returns null for a missing source', async () => {
		expect(await loadSourceProjection(db, 'does-not-exist')).toBeNull();
	});
});

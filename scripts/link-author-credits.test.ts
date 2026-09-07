import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../src/lib/server/db/schema';
import { applyCreditLinks, fold, planCreditLinks } from './link-author-credits';

it('folds credit spellings onto one form', () => {
	expect(fold('田村, すず子')).toBe(fold('田村 すゞ子'));
	expect(fold('北原 モコットゥナシ')).toBe(fold('北原 モコットゥナㇱ'));
	expect(fold('石田 收藏')).toBe(fold('石田 収蔵'));
	expect(fold('加藤')).not.toBe(fold('賀藤'));
});

it('links only credit parts that name exactly one active person', () => {
	const personRows = [
		{ id: 'p1', slug: 'nakagawa-hiroshi', name: '中川 裕', nameEn: 'Nakagawa Hiroshi', nameKana: null, status: 'active', birthYear: 1955, deathYear: 1922 },
		{ id: 'p2', slug: 'sato-tomomi', name: '佐藤 知己', nameEn: 'Sato Tomomi', nameKana: null, status: 'active' },
		{ id: 'p3', slug: 'merged-person', name: '旧 記録', nameEn: null, nameKana: null, status: 'merged' },
		// two distinct people whose romanizations fold onto one form
		{ id: 'p4', slug: 'k-sato-a', name: '佐藤 甲', nameEn: 'Kō Sato', nameKana: null, status: 'active' },
		{ id: 'p5', slug: 'k-sato-b', name: '佐藤 乙', nameEn: 'Ko Sato', nameKana: null, status: 'active' }
	];
	const sourceRows = [
		{ id: 's1', slug: 'comma-form', author: '中川, 裕', status: 'active', provenanceRepo: 'cinii' },
		{ id: 's2', slug: 'with-institution', author: '佐藤 知己, 北海道ウタリ協会', status: 'active', provenanceRepo: null },
		{ id: 's3', slug: 'edited-by', author: '田村すず子(編), 早稲田大学語学教育研究所', status: 'active', provenanceRepo: null },
		{ id: 's4', slug: 'ambiguous', author: 'Ko Sato', status: 'active', provenanceRepo: null },
		{ id: 's5', slug: 'latin-order', author: 'Tomomi Sato', status: 'active', provenanceRepo: 'openalex' },
		{ id: 's6', slug: 'corpus', author: '中川 裕', status: 'active', provenanceRepo: 'ainu-corpora' },
		{ id: 's7', slug: 'merged-source', author: '中川 裕', status: 'merged', provenanceRepo: null },
		{ id: 's8', slug: 'already-linked', author: '佐藤 知己', status: 'active', provenanceRepo: null },
		{ id: 's11b', slug: 'linked-in-other-role', author: '中川 裕', status: 'active', provenanceRepo: null },
		{ id: 's9', slug: 'glyph-variant', author: '未知の共著者、佐藤 知巳', status: 'active', provenanceRepo: null },
		{ id: 's10', slug: 'marc-chain', author: '中川, 裕, 片山, 龍峯', status: 'active', provenanceRepo: 'ndl' },
		{ id: 's11', slug: 'posthumous-window', author: '中川 裕', status: 'active', provenanceRepo: null, yearStart: 1923 },
		{ id: 's12', slug: 'dead-long-before', author: '中川 裕', status: 'active', provenanceRepo: null, yearStart: 1999 }
	];
	const plans = planCreditLinks({
		personRows,
		sourceRows,
		edgeRows: [
			{ sourceId: 's8', personId: 'p2', role: 'author' },
			{ sourceId: 's11b', personId: 'p1', role: 'speaker' }
		],
		aliasRows: [{ slug: 'sato-tomomi', aliases: [{ name: '佐藤 知巳' }] }]
	});
	const bySource = new Map(plans.map((p) => [p.sourceSlug, p]));
	expect(bySource.get('comma-form')).toMatchObject({ personSlug: 'nakagawa-hiroshi', role: 'author' });
	expect(bySource.get('with-institution')).toMatchObject({ personSlug: 'sato-tomomi', role: 'author' });
	// 田村すず子 has no person row here, so the (編) part names nobody and stays unlinked
	expect(bySource.has('edited-by')).toBe(false);
	expect(bySource.has('ambiguous')).toBe(false);
	expect(bySource.get('latin-order')).toMatchObject({ personSlug: 'sato-tomomi', role: 'author' });
	expect(bySource.has('corpus')).toBe(false);
	expect(bySource.has('merged-source')).toBe(false);
	expect(bySource.has('already-linked')).toBe(false);
	expect(bySource.has('linked-in-other-role')).toBe(false);
	expect(bySource.get('glyph-variant')).toMatchObject({ personSlug: 'sato-tomomi', sortOrder: 0 });
	expect(bySource.get('marc-chain')).toMatchObject({ personSlug: 'nakagawa-hiroshi', role: 'author' });
	expect(bySource.has('posthumous-window')).toBe(true);
	expect(bySource.has('dead-long-before')).toBe(false);
});

it('inserts planned links once and re-plans to zero', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'credit-links-test-'));
	const client = createClient({ url: `file:${join(scratch, 'test.db')}` });
	try {
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
		await db.insert(schema.persons).values([
			{ id: 'p1', slug: 'nakagawa-hiroshi', name: '中川 裕' },
			{ id: 'p2', slug: 'tamura-suzuko', name: '田村 すゞ子' }
		]);
		await db.insert(schema.sources).values([
			{ id: 's1', slug: 'book', title: 'Book', type: 'book', author: '中川, 裕' },
			{ id: 's2', slug: 'reader', title: 'Reader', type: 'book', author: '田村すず子(編)' }
		]);
		const personRows = [
			{ id: 'p1', slug: 'nakagawa-hiroshi', name: '中川 裕', nameEn: null, nameKana: null, status: 'active' },
			{ id: 'p2', slug: 'tamura-suzuko', name: '田村 すゞ子', nameEn: null, nameKana: null, status: 'active' }
		];
		const sourceRows = [
			{ id: 's1', slug: 'book', author: '中川, 裕', status: 'active', provenanceRepo: null },
			{ id: 's2', slug: 'reader', author: '田村すず子(編)', status: 'active', provenanceRepo: null }
		];
		const plan = async () => {
			const edgeRows = await db
				.select({
					sourceId: schema.sourcePersons.sourceId,
					personId: schema.sourcePersons.personId,
					role: schema.sourcePersons.role
				})
				.from(schema.sourcePersons);
			return planCreditLinks({ personRows, sourceRows, edgeRows, aliasRows: [] });
		};
		const first = await plan();
		expect(first).toHaveLength(2);
		expect(first.find((p) => p.sourceSlug === 'reader')).toMatchObject({ personSlug: 'tamura-suzuko', role: 'editor' });
		expect(await applyCreditLinks(db, first)).toBe(2);
		expect(await plan()).toEqual([]);
		const edges = await db.select().from(schema.sourcePersons);
		expect(edges).toHaveLength(2);
		expect(new Set(edges.map((e) => `${e.role}:${e.sortOrder}`))).toEqual(new Set(['author:0', 'editor:0']));
		expect(edges.every((e) => e.origin === 'sweep-author-credits')).toBe(true);
	} finally {
		client.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});

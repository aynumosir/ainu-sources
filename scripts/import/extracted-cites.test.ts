import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { run } from './extracted-cites';

const DATA_DIR = fileURLToPath(new URL('../data/extracted-cites', import.meta.url));

interface ExtractedReference {
	n: number;
	title?: string;
	authors?: string[];
}

interface ExtractedCitesFile {
	schema?: string;
	verified?: boolean;
	citingWork?: { slug?: string };
	extraction?: { referenceCount?: number };
	references?: (ExtractedReference & { match?: { slug?: string } })[];
}

function dataFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return dataFiles(full);
		return entry.name.endsWith('.json') ? [full] : [];
	});
}

describe('extracted citation data', () => {
	for (const filename of dataFiles(DATA_DIR).sort()) {
		it(`${path.relative(DATA_DIR, filename)} has a complete, numbered reference list`, () => {
			const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as ExtractedCitesFile;
			const references = data.references ?? [];

			expect(data.schema).toBe('extracted-cites/v1');
			expect(data.citingWork?.slug).toBeTruthy();
			expect(references).toHaveLength(data.extraction?.referenceCount ?? -1);
			expect(references.map((ref) => ref.n)).toEqual(
				Array.from({ length: references.length }, (_, index) => index + 1)
			);
			expect(references.every((ref) => Boolean(ref.title))).toBe(true);
			if (data.verified) {
				expect(references.every((ref) => Boolean(ref.authors?.length))).toBe(true);
			} else {
				expect(references.every((ref) => Boolean(ref.match?.slug))).toBe(true);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// The importer against a real (in-memory) schema built from the migrations.
// ---------------------------------------------------------------------------

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

/** Write one dataset to a temp dir and import it. */
async function importFixture(
	db: Db,
	references: unknown[],
	opts: { verified?: boolean; allowMassWithdrawal?: boolean } = {}
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extracted-cites-'));
	fs.writeFileSync(
		path.join(dir, 'fixture.json'),
		JSON.stringify({
			schema: 'extracted-cites/v1',
			verified: opts.verified ?? true,
			citingWork: { slug: 'citing-work', title: 'Citing work', year: 1992 },
			references
		})
	);
	try {
		return await run(db, { dataDir: dir, allowMassWithdrawal: opts.allowMassWithdrawal });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const relationRows = async (db: Db) =>
	(
		await db
			.select({
				slug: schema.sources.slug,
				status: schema.sourceRelations.status,
				origin: schema.sourceRelations.origin
			})
			.from(schema.sourceRelations)
			.innerJoin(schema.sources, eq(schema.sourceRelations.toSourceId, schema.sources.id))
			.where(eq(schema.sourceRelations.type, 'cites'))
	).sort((a, b) => a.slug.localeCompare(b.slug));

const citedSlugs = async (db: Db) =>
	(
		await db
			.select({ slug: schema.sources.slug })
			.from(schema.sourceRelations)
			.innerJoin(schema.sources, eq(schema.sourceRelations.toSourceId, schema.sources.id))
			.where(eq(schema.sourceRelations.type, 'cites'))
	)
		.map((r) => r.slug)
		.sort();

describe('extracted-cites importer', () => {
	let db: Db;
	beforeEach(async () => {
		db = await makeDb();
		await db
			.insert(schema.sources)
			.values({ slug: 'citing-work', title: 'Citing work', type: 'publication' });
	});

	it('creates a record for an Ainu-related reference it cannot match, and cites it', async () => {
		await importFixture(db, [
			{
				n: 1,
				authors: ['Chiri, Mashiho'],
				year: 1956,
				title: 'アイヌ語入門',
				ainuRelated: true,
				match: null
			}
		]);
		const cited = await citedSlugs(db);
		expect(cited).toHaveLength(1);
		expect(cited[0]).toMatch(/^1956-chiri/u);
	});

	it('skips a reference marked ainuRelated: false, minting neither record nor edge', async () => {
		await importFixture(db, [
			{ n: 1, authors: ['Chomsky, Noam'], year: 1986, title: 'Barriers', ainuRelated: false, match: null }
		]);
		expect(await citedSlugs(db)).toEqual([]);
		const slugs = (await db.select({ slug: schema.sources.slug }).from(schema.sources)).map(
			(r) => r.slug
		);
		expect(slugs).toEqual(['citing-work']);
	});

	it('still cites an ainuRelated: false reference that is already catalogued', async () => {
		await db
			.insert(schema.sources)
			.values({ slug: '1979-dixon-ergativity', title: 'Ergativity', type: 'publication' });
		await importFixture(db, [
			{
				n: 1,
				authors: ['Dixon, R. M. W.'],
				year: 1979,
				title: 'Ergativity',
				ainuRelated: false,
				match: { slug: '1979-dixon-ergativity', confidence: 'exact' }
			}
		]);
		expect(await citedSlugs(db)).toEqual(['1979-dixon-ergativity']);
	});
});

describe('extracted-cites reconciliation', () => {
	let db: Db;
	const ref = (n: number, slug: string, confidence = 'probable') => ({
		n,
		authors: ['Someone'],
		year: 1990 + n,
		title: `Title ${n}`,
		ainuRelated: true,
		match: { slug, confidence }
	});

	beforeEach(async () => {
		db = await makeDb();
		await db.insert(schema.sources).values([
			{ slug: 'citing-work', title: 'Citing work', type: 'publication' },
			{ slug: 'cited-a', title: 'Cited A', type: 'publication' },
			{ slug: 'cited-b', title: 'Cited B', type: 'publication' },
			{ slug: 'cited-c', title: 'Cited C', type: 'publication' }
		]);
	});

	it('withdraws an edge the datasets no longer assert', async () => {
		await importFixture(db, [ref(1, 'cited-a'), ref(2, 'cited-b'), ref(3, 'cited-c')], {
			verified: false
		});
		expect((await relationRows(db)).map((r) => [r.slug, r.status])).toEqual([
			['cited-a', 'accepted'],
			['cited-b', 'accepted'],
			['cited-c', 'accepted']
		]);

		// cited-b's reference is gone from the regenerated dataset
		const summary = await importFixture(db, [ref(1, 'cited-a'), ref(3, 'cited-c')], {
			verified: false
		});
		expect(summary.detail).toMatchObject({ withdrawn: 1 });
		expect((await relationRows(db)).map((r) => [r.slug, r.status])).toEqual([
			['cited-a', 'accepted'],
			['cited-b', 'removed'],
			['cited-c', 'accepted']
		]);
	});

	it('demotes an edge the datasets now assert only as a candidate', async () => {
		await importFixture(db, [ref(1, 'cited-a'), ref(2, 'cited-b')], { verified: false });
		await importFixture(db, [ref(1, 'cited-a'), ref(2, 'cited-b', 'candidate')], {
			verified: false
		});
		const byslug = Object.fromEntries((await relationRows(db)).map((r) => [r.slug, r.status]));
		expect(byslug['cited-a']).toBe('accepted');
		expect(byslug['cited-b']).toBe('candidate');
	});

	it('leaves another producer’s edges alone', async () => {
		const [citing] = await db
			.select({ id: schema.sources.id })
			.from(schema.sources)
			.where(eq(schema.sources.slug, 'citing-work'));
		const [other] = await db
			.select({ id: schema.sources.id })
			.from(schema.sources)
			.where(eq(schema.sources.slug, 'cited-c'));
		await db.insert(schema.sourceRelations).values({
			id: crypto.randomUUID(),
			fromSourceId: citing.id,
			toSourceId: other.id,
			type: 'cites',
			status: 'accepted',
			origin: null
		});
		await importFixture(db, [ref(1, 'cited-a')], { verified: false });
		const untouched = (await relationRows(db)).find((r) => r.origin === null);
		expect(untouched?.status).toBe('accepted');
	});

	it('refuses a mass withdrawal unless it is asked for explicitly', async () => {
		await importFixture(db, [ref(1, 'cited-a'), ref(2, 'cited-b'), ref(3, 'cited-c')], {
			verified: false
		});
		// A dataset directory reduced to one reference would retract two of three edges.
		const blocked = await importFixture(db, [ref(1, 'cited-a')], { verified: false });
		expect(blocked.detail).toMatchObject({ withdrawn: 0 });
		expect((await relationRows(db)).filter((r) => r.status === 'accepted')).toHaveLength(3);

		const forced = await importFixture(db, [ref(1, 'cited-a')], {
			verified: false,
			allowMassWithdrawal: true
		});
		expect(forced.detail).toMatchObject({ withdrawn: 2 });
	});
});

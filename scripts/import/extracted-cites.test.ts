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

/** Write one verified dataset to a temp dir and import it. */
async function importFixture(db: Db, references: unknown[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extracted-cites-'));
	fs.writeFileSync(
		path.join(dir, 'fixture.json'),
		JSON.stringify({
			schema: 'extracted-cites/v1',
			verified: true,
			citingWork: { slug: 'citing-work', title: 'Citing work', year: 1992 },
			references
		})
	);
	try {
		return await run(db, { dataDir: dir });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

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

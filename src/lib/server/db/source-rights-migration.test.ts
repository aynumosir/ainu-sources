import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import * as schema from './schema';

it('removes source permissions without changing catalogue records or linked files', async () => {
	const migrationsFolder = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
	const oldMigrations = await mkdtemp(join(tmpdir(), 'source-rights-migration-'));
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	try {
		const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
		journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 31);
		await mkdir(join(oldMigrations, 'meta'));
		await writeFile(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal));
		await Promise.all(journal.entries.map((entry: { tag: string }) =>
			copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`))
		));
		await migrate(db, { migrationsFolder: oldMigrations });
		await client.execute('PRAGMA foreign_keys = ON');
		await db.insert(schema.sources).values([
			{ id: 'source-1', slug: 'source-one', title: '資料一', summaryJa: '日本語の説明', type: 'book', license: 'CC BY 4.0' },
			{ id: 'source-2', slug: 'source-two', title: '資料二', type: 'article' }
		]);
		await client.execute(`UPDATE sources SET human_download = 1, local_processing = 1,
			hosted_ai_text = 1, hosted_ai_images = 1, bulk_export = 1 WHERE id = 'source-1'`);
		await db.insert(schema.sourceFiles).values({ id: 'file-1', sourceId: 'source-1', role: 'scan' });
		const sourcesBefore = await db.select().from(schema.sources);
		const filesBefore = await db.select().from(schema.sourceFiles);
		const indexesBefore = await client.execute('PRAGMA index_list(sources)');

		await migrate(db, { migrationsFolder });
		await migrate(db, { migrationsFolder });

		const columns = await client.execute('PRAGMA table_info(sources)');
		for (const name of ['human_download', 'local_processing', 'hosted_ai_text', 'hosted_ai_images', 'bulk_export']) {
			expect(columns.rows.map((column) => column.name)).not.toContain(name);
		}
		expect(await db.select().from(schema.sources)).toEqual(sourcesBefore);
		expect(await db.select().from(schema.sourceFiles)).toEqual(filesBefore);
		expect((await client.execute('PRAGMA index_list(sources)')).rows).toEqual(indexesBefore.rows);
		expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
	} finally {
		client.close();
		await rm(oldMigrations, { recursive: true, force: true });
	}
});

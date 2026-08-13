import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { artifactKindFor, linkDerivedFiles } from './link-derived-files';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

let db: Db;

beforeEach(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-derived-'));
	db = drizzle(createClient({ url: `file:${path.join(dir, 'test.db')}` }), { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	await db.insert(schema.user).values({ id: 'u1', name: 'U', email: 'u@example.test', emailVerified: true });
	await db.insert(schema.sources).values({
		id: 'src',
		slug: 'work-one',
		title: 'Work One',
		type: 'dictionary',
		humanDownload: true
	});
	await db.insert(schema.archiveBlobs).values([
		{ sha256: 'a'.repeat(64), bytes: 10, detectedMediaType: 'application/pdf', storageState: 'verified', verifiedAt: new Date() },
		{ sha256: 'b'.repeat(64), bytes: 4, detectedMediaType: 'application/xml', storageState: 'verified', verifiedAt: new Date() }
	]);
	for (const [file, role, blob, filename, media] of [
		['scan', 'scan', 'a', 'source.pdf', 'application/pdf'],
		['bbox', 'derivative', 'b', 'bbox.xml', 'application/xml']
	] as const) {
		await db.insert(schema.sourceFiles).values({ id: file, sourceId: 'src', role });
		await db.insert(schema.fileRevisions).values({
			id: `rev-${file}`,
			sourceFileId: file,
			revisionNo: 1,
			blobSha256: blob.repeat(64),
			originalFilename: filename,
			declaredMediaType: media,
			artifactKind: 'original',
			isCurrent: true,
			submittedBy: 'u1'
		});
	}
});

describe('linkDerivedFiles', () => {
	it('reads what a derivative holds from the file itself', () => {
		expect(artifactKindFor('bbox.xml', 'application/xml')).toBe('bbox');
		expect(artifactKindFor('資料一.bbox.xml', 'application/xml')).toBe('bbox');
		expect(artifactKindFor('source.linear.pdf', 'application/pdf')).toBe('linearized');
	});

	it('writes nothing without --apply', async () => {
		const summary = await linkDerivedFiles(db, { apply: false });
		expect(summary).toMatchObject({ derived: 1, linked: 1, kindsCorrected: 1 });
		expect(await db.select().from(schema.revisionDerivations)).toHaveLength(0);
	});

	it('links the derivative to the scan revision it describes', async () => {
		await linkDerivedFiles(db, { apply: true });

		const [edge] = await db.select().from(schema.revisionDerivations);
		expect(edge).toMatchObject({ derivedRevisionId: 'rev-bbox', parentRevisionId: 'rev-scan', relation: 'bbox' });
		const [revision] = await db
			.select({ kind: schema.fileRevisions.artifactKind })
			.from(schema.fileRevisions)
			.where(eq(schema.fileRevisions.id, 'rev-bbox'));
		expect(revision.kind).toBe('bbox');
	});

	it('runs twice without writing the edge twice', async () => {
		await linkDerivedFiles(db, { apply: true });
		await linkDerivedFiles(db, { apply: true });
		expect(await db.select().from(schema.revisionDerivations)).toHaveLength(1);
	});

	it('leaves a derivative whose work has no current scan alone', async () => {
		await db.run(sql`update file_revisions set is_current = 0 where id = 'rev-scan'`);

		const summary = await linkDerivedFiles(db, { apply: true });

		expect(summary).toMatchObject({ derived: 1, linked: 0, withoutScan: 1 });
		expect(await db.select().from(schema.revisionDerivations)).toHaveLength(0);
	});
});

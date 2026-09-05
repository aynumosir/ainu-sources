import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../src/lib/server/db/schema';
import { applyAttributions, type AttributionReview } from './apply-person-attributions';

it('moves only reviewed links, preserves metadata, rejects drift atomically and is idempotent', async () => {
 const scratch = mkdtempSync(join(tmpdir(), 'attribution-test-'));
 const client = createClient({ url: `file:${join(scratch, 'test.db')}` });
 try {
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await db.insert(schema.persons).values({ id: 'old', slug: 'old', name: 'Old' });
  await db.insert(schema.sources).values({ id: 'book', slug: 'book', title: 'Book', type: 'book' });
  await db.insert(schema.sourcePersons).values([
   { id: 'move', sourceId: 'book', personId: 'old', confidence: 0.8, origin: 'catalogue' },
   { id: 'untouched', sourceId: 'book', personId: 'old', role: 'editor' }
  ]);
  const review: AttributionReview = {
   newPersons: [{ id: 'new', slug: 'new', name: 'New' }],
   changes: [{ id: 'move', sourceId: 'book', sourceSlug: 'book', fromPersonId: 'old', toSlug: 'new', role: 'author' }], additions: []
  };
  const before = await db.select().from(schema.sourcePersons);
  expect(await applyAttributions(db, true, review)).toEqual({ persons: 1, changes: 1, additions: 0 });
  expect(await db.select().from(schema.sourcePersons)).toEqual(before);
  const bad = structuredClone(review);
  bad.changes.push({ ...bad.changes[0], sourceSlug: 'missing' });
  await expect(applyAttributions(db, false, bad)).rejects.toThrow('source changed');
  expect(await db.select().from(schema.persons)).toHaveLength(1);
  expect(await db.select().from(schema.sourcePersons)).toEqual(before);
  await applyAttributions(db, false, review);
  const after = await db.select().from(schema.sourcePersons);
  expect(after.find(r => r.id === 'move')).toEqual({ ...before.find(r => r.id === 'move'), personId: 'new' });
  expect(after.find(r => r.id === 'untouched')).toEqual(before.find(r => r.id === 'untouched'));
  expect(await applyAttributions(db, false, review)).toEqual({ persons: 0, changes: 0, additions: 0 });
  // A later harvest may recreate a rejected attribution with a fresh edge ID.
  await db.insert(schema.sourcePersons).values({ id: 'resurrected', sourceId: 'book', personId: 'old' });
  expect((await applyAttributions(db, false, review)).changes).toBe(1);
  expect(await db.select().from(schema.sourcePersons)).toEqual(after);
  const roleReview: AttributionReview = {
   newPersons: [],
   changes: [{ id: 'move', sourceId: 'book', sourceSlug: 'book', fromPersonId: 'new', toSlug: 'new', role: 'author', toRole: 'translator' }],
   additions: [{ id: 'added', sourceId: 'book', sourceSlug: 'book', personSlug: 'old', role: 'compiler', sortOrder: 2 }]
  };
  expect(await applyAttributions(db, false, roleReview)).toEqual({ persons: 0, changes: 1, additions: 1 });
  expect(await applyAttributions(db, false, roleReview)).toEqual({ persons: 0, changes: 0, additions: 0 });
  expect((await db.select().from(schema.sourcePersons)).find(r => r.id === 'move')?.role).toBe('translator');
 } finally { client.close(); rmSync(scratch, { recursive: true, force: true }); }
});

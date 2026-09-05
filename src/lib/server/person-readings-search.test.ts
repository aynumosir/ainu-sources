import { expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./db', () => ({ get db() { return state.db; } }));
import { listPersons } from './queries';

it('finds verified readings in hiragana or katakana with optional name spacing', async () => {
	const client = createClient({ url: 'file::memory:' });
	try {
		const db = drizzle(client, { schema });
		state.db = db;
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../drizzle', import.meta.url)) });
		await db.insert(schema.persons).values([
			{ id: 'person', slug: 'person', name: '小川 正人', nameKana: 'おがわ まさひと', nameEn: 'Ogawa Masahito' },
			{ id: 'old', slug: 'old', name: '小川 正人', nameKana: 'おがわまさひと', status: 'merged', mergedIntoPersonId: 'person' }
		]);
		for (const q of ['おがわまさひと', 'おがわ まさひと', 'オガワ　マサヒト', 'ｵｶﾞﾜ ﾏｻﾋﾄ', 'Ogawa', '小川'])
			expect((await listPersons({ q })).map(p => p.id)).toEqual(['person']);
		expect(await listPersons({ q: 'おがわまさと' })).toEqual([]);
	} finally { client.close(); }
});

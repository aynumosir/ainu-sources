import { expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./db', () => ({ get db() { return state.db; } }));
import { listPersons } from './queries';
import { personAliases } from '../person-aliases';

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

it('finds an alias and its reading on the active professional name with role filters', async () => {
	const client = createClient({ url: 'file::memory:' });
	try {
		const db = drizzle(client, { schema });
		state.db = db;
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../drizzle', import.meta.url)) });
		await db.insert(schema.persons).values([
			{ id: 'yoko', slug: 'kawakami-yoko', name: '豊川 容子', nameKana: 'とよかわ ようこ' },
			{ id: 'former', slug: 'toyokawa-yoko', name: '豊川 容子', status: 'merged', mergedIntoPersonId: 'yoko' }
		]);
		await db.insert(schema.sources).values({ id: 'radio', slug: 'radio', title: 'Radio', type: 'other' });
		await db.insert(schema.sourcePersons).values({ id: 'speaker', sourceId: 'radio', personId: 'yoko', role: 'speaker' });
		for (const q of ['川上容子', '川上 容子', '川上　容子', '川上', 'かわかみようこ', 'カワカミ ヨウコ', 'ｶﾜｶﾐﾖｳｺ', 'Kawakami', '豊川', '豊川容子', '豊川　容子', 'とよかわようこ'])
			expect((await listPersons({ q })).map(p => p.id)).toEqual(['yoko']);
		expect((await listPersons({ q: '川上', role: 'speaker' })).map(p => p.id)).toEqual(['yoko']);
		expect(await listPersons({ q: '川上', role: 'translator' })).toEqual([]);
	} finally { client.close(); }
});


it('finds a former pen name and a documented alternative reading', async () => {
 const client = createClient({url: 'file::memory:'});
 try {
  const db = drizzle(client,{schema}); state.db=db;
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../../../drizzle',import.meta.url))});
  await db.insert(schema.persons).values([
   {id:'seto',slug:'p-c4w1s9',name:'瀬戸 海惠',nameKana:'せと みえ'},
   {id:'terajima',slug:'terashima-ryoan',name:'寺島 良安',nameKana:'てらじま りょうあん'}
  ]);
  for (const q of ['瀬戸成子','せとしげこ','セトシゲコ','Seto Shigeko','瀬戸海惠']) expect((await listPersons({q})).map(p=>p.id)).toEqual(['seto']);
  for (const q of ['てらしまりょうあん','テラシマ リョウアン','てらじまりょうあん']) expect((await listPersons({q})).map(p=>p.id)).toEqual(['terajima']);
 } finally { client.close(); }
});

it('finds Russian names without kana and full Japanese–Ainu name readings', async () => {
 const client = createClient({url:'file::memory:'});
 try {
  const db=drizzle(client,{schema});state.db=db;
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../../../drizzle',import.meta.url))});
  await db.insert(schema.persons).values([
   {id:'anna',slug:'bugaeva-anna',name:'アンナ・ブガエワ',nameEn:'Anna Bugaeva'},
   {id:'kitahara',slug:'mokottunas-kitahara',name:'北原 モコットゥナㇱ 次郎太',nameKana:'きたはら モコットゥナㇱ じろうた'}
  ]);
  for(const q of ['Анна Бугаева','анна бугаева','АННА БУГАЕВА','Бугаева']) expect((await listPersons({q})).map(p=>p.id)).toEqual(['anna']);
  for(const q of ['北原次郎太','北原モコットゥナㇱ次郎太','きたはらじろうた','きたはら モコットゥナㇱ じろうた','きたはらもこっとぅなㇱ']) expect((await listPersons({q})).map(p=>p.id)).toEqual(['kitahara']);
 } finally {client.close();}
});

it('keeps redundant Kitahara forms searchable without displaying alias lines', () => {
 expect(personAliases('mokottunas-kitahara')).toEqual([]);
 expect(personAliases('bugaeva-anna').map(a => a.name)).toContain('Анна Бугаева');
 expect(personAliases('kawakami-yoko').map(a => a.name)).toContain('川上 容子');
});

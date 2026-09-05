#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

const snapshot = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
const ignore = new Set(['created_at', 'updated_at']);
try {
 for (const table of ['persons', 'source_persons', 'person_slug_redirects']) {
  const actual = (await client.execute(`SELECT * FROM ${table}`)).rows;
  const expected = snapshot[table] as Record<string, unknown>[];
  const key = table === 'person_slug_redirects' ? 'old_slug' : 'id';
  if (actual.length !== expected.length) throw new Error(`${table}: row count changed (${actual.length}, expected ${expected.length})`);
  const byKey = new Map(actual.map(r => [r[key], r]));
  for (const row of expected) {
   const found = byKey.get(row[key] as string);
   if (!found) throw new Error(`${table}: missing row ${row[key]}`);
   for (const column of Object.keys(row)) {
    if (!ignore.has(column) && found[column] !== row[column])
     throw new Error(`${table}.${column}: unexpected value on ${row[key]}`);
   }
  }
  console.log(`${table}: ${actual.length} rows match`);
 }
 if ((await client.execute('PRAGMA foreign_key_check')).rows.length) throw new Error('Foreign-key violations');
 console.log('Foreign-key check passed');
} finally { client.close(); }

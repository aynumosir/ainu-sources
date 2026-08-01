#!/usr/bin/env bun
/**
 * Repair the duplicate sources a pre-#106 `import:dictionaries` run created.
 *
 * Before #106 the importer identified a folder only by its `repo_path`
 * identifier. Six folders had none — their records were made through the API or
 * are held by an external catalogue — so the engine created a second source for
 * each instead of attaching.
 *
 * For every folder in catalog.json this finds the record its `source_slug`
 * names (the winner, the one citations point at) and any OTHER record claiming
 * the same `provenance_path` (the loser, created by the bad run), then:
 *
 *   1. soft-merges the loser into the winner, so the loser's slug 302s onward
 *      rather than 404ing;
 *   2. moves the `repo_path` identifier onto the winner, so later importer
 *      runs attach by `repo_path_exact` instead of finding the loser.
 *
 * Step 2 matters more than it looks: leaving the identifier on a merged loser
 * would make every future run reattach to it.
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun scripts/fix-seeder-duplicates.ts [--apply]
 *       (plan by default; writes nothing without --apply)
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../src/lib/server/db/schema';
import { softMerge } from '../src/lib/server/merge/lifecycle';

const { sources, sourceIdentifiers } = schema;
const APPLY = process.argv.includes('--apply');
const ORIGIN = 'ainu-dictionaries';
const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(import.meta.dir, '../../..');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = drizzle(
	createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined }),
	{ schema }
);

const catalog = JSON.parse(
	fs.readFileSync(path.join(AINU_ROOT, 'ainu-dictionaries', 'catalog.json'), 'utf8')
) as Array<{ source_dir: string; source_slug?: string }>;

console.log(APPLY ? '== APPLY ==' : '== PLAN (no writes; pass --apply) ==');
let merged = 0;
let moved = 0;

for (const e of catalog) {
	if (!e.source_slug) continue;

	const [winner] = await db
		.select({ id: sources.id, slug: sources.slug })
		.from(sources)
		.where(eq(sources.slug, e.source_slug))
		.limit(1);
	if (!winner) {
		console.log(`? ${e.source_dir}: no source with slug ${e.source_slug}`);
		continue;
	}

	const claimants = await db
		.select({ id: sources.id, slug: sources.slug, status: sources.status })
		.from(sources)
		.where(eq(sources.provenancePath, e.source_dir));

	for (const c of claimants) {
		if (c.id === winner.id) continue;
		console.log(`  ${e.source_dir}: merge ${c.slug} -> ${winner.slug}`);
		merged += 1;
		if (APPLY) {
			await softMerge(db, {
				loserId: c.id,
				winnerId: winner.id,
				reason: `duplicate created by a pre-#106 import:dictionaries run`,
				actor: 'fix-seeder-duplicates'
			});
		}
	}

	// The identifier must end up on the winner whether or not a loser existed.
	const valueNorm = `${ORIGIN}:${e.source_dir}`.toLowerCase();
	const [ident] = await db
		.select({ id: sourceIdentifiers.id, sourceId: sourceIdentifiers.sourceId })
		.from(sourceIdentifiers)
		.where(
			and(eq(sourceIdentifiers.kind, 'repo_path'), eq(sourceIdentifiers.valueNorm, valueNorm))
		)
		.limit(1);
	if (ident && ident.sourceId !== winner.id) {
		console.log(`  ${e.source_dir}: repo_path identifier -> ${winner.slug}`);
		moved += 1;
		if (APPLY) {
			await db
				.update(sourceIdentifiers)
				.set({ sourceId: winner.id })
				.where(eq(sourceIdentifiers.id, ident.id));
		}
	}
}

console.log(`\n${APPLY ? 'merged' : 'would merge'}: ${merged}`);
console.log(`${APPLY ? 'moved' : 'would move'} repo_path identifiers: ${moved}`);

#!/usr/bin/env bun
/**
 * Measure the language composition of every work that carries text and store
 * it on sources.text_composition; works whose text disappeared are cleared.
 * A fresh run overwrites earlier measurements.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/lib/server/db';
import { sources } from '../../src/lib/server/db/schema';
import { refreshSourceTextComposition } from '../../src/lib/server/archive/language-composition';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	requireEnv('DATABASE_URL');

	// Works to measure: everything whose current revisions carry ingested
	// text, plus everything still carrying a measurement, so removals clear.
	const rows = await db.all<{ id: string; slug: string }>(sql`
		select distinct s.id, s.slug from sources s
		join source_files f on f.source_id = s.id
		join file_revisions r on r.source_file_id = f.id and r.is_current = 1
		join ocr_ingest_state state on state.revision_id = r.id
		union
		select id, slug from sources where text_composition is not null
	`);
	console.log(`${rows.length} works with text to measure`);

	let measured = 0;
	let cleared = 0;
	const top: Array<{ slug: string; label: string }> = [];
	for (const row of rows) {
		if (dryRun) continue;
		const composition = await refreshSourceTextComposition(db, row.id);
		if (composition) {
			measured += 1;
			top.push({
				slug: row.slug,
				label: composition.shares
					.slice(0, 3)
					.map((s) => `${s.lang} ${(s.share * 100).toFixed(0)}%`)
					.join(' ')
			});
		} else {
			cleared += 1;
		}
	}
	if (dryRun) {
		console.log('dry run: no measurements written');
		return;
	}
	console.log(`measured ${measured}, cleared ${cleared}`);
	for (const { slug, label } of top.slice(0, 15)) {
		console.log(`  ${label.padEnd(28)} ${slug}`);
	}
}

await main();

#!/usr/bin/env bun
/**
 * Judge every text variant and record whether it is fit to quote.
 *
 * Samples pages spread through each work rather than the first few, because the
 * front matter of a book is often typeset differently from its body.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { assessTextQuality, type QualitySample } from '../../src/lib/server/archive/text-quality';

type Variant = { revisionId: string; variant: string; slug: string; sourceKind: string };

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);

	const variants = await db.all<Variant>(sql`
		select cov.revision_id as revisionId, cov.variant as variant,
			cov.source_kind as sourceKind, src.slug as slug
		from revision_ocr_coverage cov
		join file_revisions fr on fr.id = cov.revision_id and fr.is_current = 1
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		order by src.slug, cov.variant
	`);
	console.log(`${variants.length} text variants to assess`);

	let unassessed = 0;
	let suspect = 0;
	for (const variant of variants) {
		// Nine pages spread across the work, avoiding front matter.
		const samples = await db.all<QualitySample>(sql`
			with numbered as (
				select cast(c.page as integer) as page,
					group_concat(c.text, char(10)) as text,
					row_number() over (order by cast(c.page as integer)) as rn,
					count(*) over () as total
				from ocr_chunks c
				join ocr_ingest_state s on s.revision_id = c.revision_id
					and s.variant = c.variant and s.active_generation = c.ingest_generation
				where c.revision_id = ${variant.revisionId} and c.variant = ${variant.variant}
				group by cast(c.page as integer)
			)
			select page, text from numbered
			where rn % max(1, total / 9) = 0
			limit 9
		`);
		const verdict = assessTextQuality(samples.map((s) => ({ page: s.page, text: s.text ?? '' })));
		if (verdict.reliability === 'suspect') {
			suspect += 1;
			console.log(`  suspect  ${variant.slug} (${variant.variant}, ${variant.sourceKind}): ${verdict.note}`);
		} else {
			unassessed += 1;
		}
		if (dryRun) continue;
		await db.run(sql`
			update revision_ocr_coverage
			set reliability = ${verdict.reliability}, reliability_note = ${verdict.note}
			where revision_id = ${variant.revisionId} and variant = ${variant.variant}
		`);
	}
	console.log(`\nsuspect ${suspect}, left unassessed ${unassessed}`);
}

await main();

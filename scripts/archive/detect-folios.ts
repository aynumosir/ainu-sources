#!/usr/bin/env bun
/**
 * Record the page number each work prints on itself.
 *
 * Reads the folio from the text a page already has, whatever its source, so no
 * scan is re-read. Pages whose numbering is absent or contradicted are left
 * without a folio and the archive keeps citing scan position for them.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { detectFolios, type PageText } from '../../src/lib/server/archive/folios';

type Revision = { revisionId: string; slug: string; variant: string };

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);

	// One variant per revision: the preferred one where a preference is
	// recorded, otherwise whichever has the most pages.
	const revisions = (await db.all<Revision>(sql`
		select s.revision_id as revisionId, src.slug as slug, s.variant as variant
		from ocr_ingest_state s
		join file_revisions fr on fr.id = s.revision_id and fr.is_current = 1
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		left join revision_ocr_coverage cov
			on cov.revision_id = s.revision_id and cov.variant = s.variant
		group by s.revision_id
		having max(coalesce(cov.preferred, 0)) = coalesce(cov.preferred, 0)
		order by src.slug
	`)).slice(0, limit);
	console.log(`${revisions.length} revisions with text`);

	let numbered = 0;
	let unnumbered = 0;
	for (const revision of revisions) {
		const pages = await db.all<PageText>(sql`
			select cast(c.page as integer) as page, group_concat(c.text, char(10)) as text
			from ocr_chunks c
			join ocr_ingest_state s on s.revision_id = c.revision_id
				and s.variant = c.variant and s.active_generation = c.ingest_generation
			where c.revision_id = ${revision.revisionId} and c.variant = ${revision.variant}
				and cast(c.page as integer) > 0
			group by cast(c.page as integer)
			order by cast(c.page as integer)
		`);
		if (pages.length === 0) continue;
		const folios = detectFolios(pages);
		if (folios.length === 0) {
			unnumbered += 1;
			console.log(`  no folios   ${revision.slug} (${pages.length} pages)`);
			continue;
		}
		numbered += 1;
		const share = Math.round((folios.length / pages.length) * 100);
		console.log(`  ${folios.length}/${pages.length} (${share}%) ${revision.slug}`);
		if (dryRun) continue;

		await db.run(sql`delete from revision_page_folios where revision_id = ${revision.revisionId}`);
		const now = Date.now();
		for (let i = 0; i < folios.length; i += 200) {
			const batch = folios.slice(i, i + 200);
			const values = batch.map(
				(f) => sql`(${revision.revisionId}, ${f.page}, ${f.label}, ${f.value}, ${revision.variant}, ${now})`
			);
			await db.run(sql`
				insert into revision_page_folios (revision_id, page, label, value, derived_from, detected_at)
				values ${sql.join(values, sql`, `)}
			`);
		}
	}
	console.log(`\nnumbered ${numbered}, no folios ${unnumbered}`);
}

await main();

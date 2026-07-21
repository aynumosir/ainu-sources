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

	// Every variant of every revision: extraction may drop running heads that
	// recognition captures, so folios are detected from whichever variant has them.
	const revisions = (await db.all<Revision>(sql`
		select s.revision_id as revisionId, src.slug as slug, s.variant as variant
		from ocr_ingest_state s
		join file_revisions fr on fr.id = s.revision_id and fr.is_current = 1
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		order by src.slug, s.variant
	`)).slice(0, limit);
	// Group by revision so each gets one folio table (union of all variants).
	const byRevision = new Map<string, Revision[]>();
	for (const r of revisions) {
		if (!byRevision.has(r.revisionId)) byRevision.set(r.revisionId, []);
		byRevision.get(r.revisionId)!.push(r);
	}
	console.log(`${byRevision.size} revisions, ${revisions.length} variants`);

	let numbered = 0;
	let unnumbered = 0;
	for (const [revisionId, variants] of byRevision) {
		const slug = variants[0].slug;
		// Detect folios from each variant and keep the union: a page is
		// numbered if any variant found a folio for it.
		const merged = new Map<number, { label: string; value: number; from: string }>();
		let totalPages = 0;
		for (const revision of variants) {
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
			totalPages = Math.max(totalPages, pages.length);
			for (const folio of detectFolios(pages)) {
				if (!merged.has(folio.page)) {
					merged.set(folio.page, { label: folio.label, value: folio.value, from: revision.variant });
				}
			}
		}
		if (merged.size === 0) {
			unnumbered += 1;
			console.log(`  no folios   ${slug} (${totalPages} pages)`);
			continue;
		}
		numbered += 1;
		const share = Math.round((merged.size / totalPages) * 100);
		console.log(`  ${merged.size}/${totalPages} (${share}%) ${slug}`);
		if (dryRun) continue;

		await db.run(sql`delete from revision_page_folios where revision_id = ${revisionId}`);
		const folios = [...merged.entries()].map(([page, f]) => ({ page, ...f })).sort((a, b) => a.page - b.page);
		const now = Date.now();
		for (let i = 0; i < folios.length; i += 200) {
			const batch = folios.slice(i, i + 200);
			const values = batch.map(
				(f) => sql`(${revisionId}, ${f.page}, ${f.label}, ${f.value}, ${f.from}, ${now})`
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

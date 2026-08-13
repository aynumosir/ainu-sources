#!/usr/bin/env bun
/**
 * Assert the things the archive's repairs established, so they stay true.
 *
 * The database itself enforces what it can: one file per work and role, one
 * path per repository, one place per file per repository. What it cannot see
 * is text — whether a scan is held twice over, whether recognized pages are
 * reachable by search, whether the index still matches the rows underneath.
 * Each check here failed at least once on real data.
 *
 * Read-only. Exits non-zero on the first violation found, so CI can gate on it.
 *
 * Connection: DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote).
 */
import { createClient, type Client } from '@libsql/client';

export type Violation = { check: string; detail: string; count: number; sample: string[] };

const CHECKS: Array<{ name: string; describe: string; sql: string; label: (row: Record<string, unknown>) => string }> = [
	{
		name: 'one blob, one file',
		describe:
			'A scan held as the current revision of two files is recognized twice and answers a search twice. ' +
			'`archive:merge-duplicate-files` collapses them.',
		sql: `
			select fr.blob_sha256 as blob, group_concat(distinct s.slug) as slugs
			from file_revisions fr
			join source_files sf on sf.id = fr.source_file_id
			join sources s on s.id = sf.source_id
			where fr.is_current = 1 and fr.blob_sha256 is not null
			group by fr.blob_sha256
			having count(distinct sf.id) > 1
		`,
		label: (row) => `${String(row.blob).slice(0, 12)} under ${row.slugs}`
	},
	{
		name: 'recognized text is reachable',
		describe: 'An ingest state naming a generation that holds no rows leaves a work looking searchable while it is not.',
		sql: `
			select st.revision_id as revision, st.variant as variant
			from ocr_ingest_state st
			where not exists (
				select 1 from ocr_chunks c
				where c.revision_id = st.revision_id and c.variant = st.variant
				and c.ingest_generation = st.active_generation
			)
		`,
		label: (row) => `${String(row.revision).slice(0, 8)} ${row.variant}`
	},
	{
		name: 'no text outside a live generation',
		describe: 'Chunks belonging to no active generation are text nobody can find, left behind by an interrupted ingest.',
		sql: `
			select c.revision_id as revision, c.variant as variant, count(*) as rows
			from ocr_chunks c
			where not exists (
				select 1 from ocr_ingest_state st
				where st.revision_id = c.revision_id and st.variant = c.variant
				and st.active_generation = c.ingest_generation
			)
			group by c.revision_id, c.variant
		`,
		label: (row) => `${String(row.revision).slice(0, 8)} ${row.variant} (${row.rows} rows)`
	},
	{
		name: 'every chunk has an ingest state',
		describe: 'Text with no state row is invisible to the search join, whichever generation it claims.',
		sql: `
			select distinct c.revision_id as revision, c.variant as variant
			from ocr_chunks c
			where not exists (
				select 1 from ocr_ingest_state st
				where st.revision_id = c.revision_id and st.variant = c.variant
			)
		`,
		label: (row) => `${String(row.revision).slice(0, 8)} ${row.variant}`
	}
];

export async function checkInvariants(client: Client): Promise<Violation[]> {
	const violations: Violation[] = [];
	for (const check of CHECKS) {
		const rows = (await client.execute(check.sql)).rows as unknown as Array<Record<string, unknown>>;
		if (rows.length) {
			violations.push({
				check: check.name,
				detail: check.describe,
				count: rows.length,
				sample: rows.slice(0, 5).map(check.label)
			});
		}
	}
	// The argument is what makes this worth running: bare 'integrity-check'
	// verifies only that the index is internally well formed, and passes happily
	// while it indexes rows that no longer exist. With rank = 1 fts5 reads the
	// content table and compares, which is the question being asked — a delete
	// that reached ocr_chunks without the trigger shows up as hits on absent rows.
	try {
		await client.execute(`insert into ocr_chunks_fts(ocr_chunks_fts, rank) values('integrity-check', 1)`);
	} catch (error) {
		violations.push({
			check: 'search index matches its rows',
			detail: 'The full-text index disagrees with ocr_chunks. Rebuild it with the `rebuild` command.',
			count: 1,
			sample: [String(error).slice(0, 200)]
		});
	}
	return violations;
}

if (import.meta.main) {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error('DATABASE_URL is not set');
		process.exit(1);
	}
	const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
	const violations = await checkInvariants(client);
	for (const violation of violations) {
		console.error(`✗ ${violation.check}: ${violation.count}`);
		console.error(`  ${violation.detail}`);
		for (const line of violation.sample) console.error(`  · ${line}`);
	}
	if (violations.length) process.exit(1);
	console.log(`✓ archive invariants hold (${CHECKS.length + 1} checks)`);
}

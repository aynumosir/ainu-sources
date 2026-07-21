#!/usr/bin/env bun
/**
 * Re-extract page-aligned text for revisions whose text is one unaligned block.
 *
 * A large part of the collection was ingested as a single page-0 chunk: the
 * whole document in one row. Those works are searchable but a hit cannot name
 * a page, the reader cannot show text beside the scan it belongs to, and the
 * workspace has to refuse page-level edits.
 *
 * Most of them are PDFs that already carry a text layer, so nothing needs to
 * be recognised — `pdftotext` emits the same text with form feeds between
 * pages, and splitting on those recovers the alignment that was lost at
 * ingest. Works with no extractable per-page text are reported and left alone;
 * those are the ones that genuinely need OCR.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { activateOcrGeneration, type OcrPageInput } from '../../src/lib/server/archive/ocr';
import { revisionOcrCoverage } from '../../src/lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

const PAGE_BREAK = '\f';

type Candidate = {
	revisionId: string;
	variant: string;
	slug: string;
	title: string;
	pageCount: number | null;
	blobSha256: string | null;
};

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

/**
 * Two populations need the same treatment. Some revisions hold their text as
 * one page-0 block; others were never ingested at all although the file
 * carries a text layer. Both are answered by extracting the layer per page.
 */
async function findCandidates(db: any, mode: 'unaligned' | 'missing'): Promise<Candidate[]> {
	if (mode === 'missing') {
		return db.all<Candidate>(sql`
			select fr.id as revisionId, 'pdftotext' as variant,
				src.slug as slug, src.title as title,
				cast(fr.page_count as integer) as pageCount,
				fr.blob_sha256 as blobSha256
			from file_revisions fr
			join source_files sf on sf.id = fr.source_file_id
			join sources src on src.id = sf.source_id
			where fr.is_current = 1
				-- Some file slots hold companion artefacts rather than the scan.
				and fr.declared_media_type = 'application/pdf'
				and not exists (select 1 from ocr_ingest_state s where s.revision_id = fr.id)
			order by src.slug
		`);
	}
	return db.all<Candidate>(sql`
		select c.revision_id as revisionId, c.variant as variant,
			src.slug as slug, src.title as title,
			cast(fr.page_count as integer) as pageCount,
			fr.blob_sha256 as blobSha256
		from ocr_chunks c
		join ocr_ingest_state s on s.revision_id = c.revision_id
			and s.variant = c.variant and s.active_generation = c.ingest_generation
		join file_revisions fr on fr.id = c.revision_id and fr.is_current = 1
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		group by c.revision_id, c.variant
		having max(cast(c.page as integer)) = 0
		order by src.slug
	`);
}

/**
 * Blobs are read straight from object storage rather than through the archive
 * API. This is maintenance, not reading: it should not consume a reader's
 * download budget, and the API rate-limits a bulk pass by design.
 */
function fetchPdf(blobSha256: string, dir: string): string {
	const key = `blobs/sha256/${blobSha256.slice(0, 2)}/${blobSha256}`;
	const file = path.join(dir, `${blobSha256}.pdf`);
	execFileSync(
		'aws',
		['s3api', 'get-object', '--bucket', requireEnv('R2_BUCKET'), '--key', key, '--endpoint-url', requireEnv('R2_ENDPOINT'), file],
		{ stdio: 'ignore', env: { ...process.env, AWS_ACCESS_KEY_ID: requireEnv('R2_ACCESS_KEY_ID'), AWS_SECRET_ACCESS_KEY: requireEnv('R2_SECRET_ACCESS_KEY'), AWS_DEFAULT_REGION: 'auto' } }
	);
	return file;
}

function extractPages(pdf: string): OcrPageInput[] {
	const out = `${pdf}.txt`;
	execFileSync('pdftotext', ['-layout', pdf, out], { stdio: 'ignore' });
	const raw = readFileSync(out, 'utf8');
	return raw
		.split(PAGE_BREAK)
		.map((text, index) => ({ page: index + 1, text: text.trim() }))
		.filter((page) => page.text.length > 0);
}

async function recordCoverage(db: any, revisionId: string, variant: string): Promise<void> {
	const now = new Date();
	const existing = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, variant)))
		.limit(1);
	if (existing.length > 0) {
		await db
			.update(revisionOcrCoverage)
			.set({ status: 'complete', tool: variant, sourceKind: 'extracted', measuredAt: now })
			.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, variant)));
		return;
	}
	const preferred = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.preferred, true)))
		.limit(1);
	await db.insert(revisionOcrCoverage).values({
		revisionId,
		variant,
		status: 'complete',
		// This text was taken from the file, not read from the image.
		sourceKind: 'extracted',
		tool: variant,
		toolVersion: null,
		preferred: preferred.length === 0,
		measuredAt: now
	});
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const mode = process.argv.includes('--missing') ? 'missing' : 'unaligned';
	const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);
	const candidates = (await findCandidates(db, mode)).slice(0, limit);
	console.log(
		mode === 'missing'
			? `${candidates.length} revisions have no ingested text`
			: `${candidates.length} revisions hold whole-document text`
	);

	const workDir = mkdtempSync(path.join(tmpdir(), 'realign-'));
	let aligned = 0;
	let needsOcr = 0;
	let failed = 0;
	try {
		for (const candidate of candidates) {
			const label = `${candidate.slug} (${candidate.variant})`;
			try {
				if (!candidate.blobSha256) throw new Error('revision has no blob');
				const pdf = fetchPdf(candidate.blobSha256, workDir);
				const pages = extractPages(pdf);
				rmSync(pdf, { force: true });
				rmSync(`${pdf}.txt`, { force: true });
				if (pages.length <= 1) {
					console.log(`needs OCR   ${label}: no per-page text layer`);
					needsOcr += 1;
					continue;
				}
				if (dryRun) {
					console.log(`would align ${label}: ${pages.length} pages of ${candidate.pageCount ?? '?'}`);
					aligned += 1;
					continue;
				}
				await activateOcrGeneration(db as never, candidate.revisionId, candidate.variant, pages);
				await recordCoverage(db, candidate.revisionId, candidate.variant);
				console.log(`aligned     ${label}: ${pages.length} pages`);
				aligned += 1;
			} catch (error) {
				console.error(`failed      ${label}: ${(error as Error).message}`);
				failed += 1;
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
	console.log(`\naligned ${aligned}, needs OCR ${needsOcr}, failed ${failed}`);
}

await main();

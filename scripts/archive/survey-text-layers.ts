#!/usr/bin/env bun
/**
 * Report which revisions without recorded text actually need OCR.
 *
 * A PDF that carries its own text layer needs extraction, not recognition.
 * Assuming otherwise is what made the backfill look several times larger than
 * it is, so every revision is checked against the file rather than the
 * catalogue before any engine is chosen.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';

type Row = {
	revisionId: string;
	slug: string;
	title: string;
	pageCount: number | null;
	blobSha256: string | null;
	mediaType: string | null;
	languages: string | null;
};

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function fetchBlob(sha: string, dir: string): string {
	const key = `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
	const file = path.join(dir, `${sha}.bin`);
	execFileSync(
		'aws',
		['s3api', 'get-object', '--bucket', requireEnv('R2_BUCKET'), '--key', key, '--endpoint-url', requireEnv('R2_ENDPOINT'), file],
		{
			stdio: 'ignore',
			env: {
				...process.env,
				AWS_ACCESS_KEY_ID: requireEnv('R2_ACCESS_KEY_ID'),
				AWS_SECRET_ACCESS_KEY: requireEnv('R2_SECRET_ACCESS_KEY'),
				AWS_DEFAULT_REGION: 'auto'
			}
		}
	);
	return file;
}

/** Characters of extractable text, and how many pages carry any. */
function textLayer(pdf: string): { chars: number; pagesWithText: number; pages: number } {
	const out = `${pdf}.txt`;
	try {
		execFileSync('pdftotext', ['-layout', pdf, out], { stdio: 'ignore' });
	} catch {
		return { chars: 0, pagesWithText: 0, pages: 0 };
	}
	const raw = readFileSync(out, 'utf8');
	rmSync(out, { force: true });
	const pages = raw.split('\f');
	const withText = pages.filter((p) => p.trim().length > 20);
	return { chars: raw.replace(/\s+/g, '').length, pagesWithText: withText.length, pages: pages.length };
}

async function main() {
	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);
	const rows = await db.all<Row>(sql`
		select fr.id as revisionId, src.slug as slug, src.title as title,
			cast(fr.page_count as integer) as pageCount, fr.blob_sha256 as blobSha256,
			fr.declared_media_type as mediaType, src.languages as languages
		from file_revisions fr
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		where fr.is_current = 1
			and not exists (
				select 1 from ocr_ingest_state s where s.revision_id = fr.id
			)
		order by src.slug
	`);
	console.log(`${rows.length} current revisions have no ingested text\n`);

	const dir = mkdtempSync(path.join(tmpdir(), 'survey-'));
	const needsOcr: Row[] = [];
	let extractable = 0;
	let unreadable = 0;
	try {
		for (const row of rows) {
			if (!row.blobSha256) {
				console.log(`no blob      ${row.slug}`);
				unreadable += 1;
				continue;
			}
			try {
				const blob = fetchBlob(row.blobSha256, dir);
				const layer = textLayer(blob);
				rmSync(blob, { force: true });
				// A handful of stray characters is a scanner artefact, not a text layer.
				if (layer.pagesWithText >= Math.max(2, layer.pages * 0.5)) {
					console.log(`extractable  ${row.slug}: ${layer.pagesWithText}/${layer.pages} pages carry text`);
					extractable += 1;
				} else {
					console.log(`needs OCR    ${row.slug}: ${row.pageCount ?? '?'} pages, ${row.languages ?? 'languages unrecorded'}`);
					needsOcr.push(row);
				}
			} catch (error) {
				console.log(`unreadable   ${row.slug}: ${(error as Error).message.slice(0, 60)}`);
				unreadable += 1;
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const pages = needsOcr.reduce((sum, row) => sum + (row.pageCount ?? 0), 0);
	console.log(`\nextractable ${extractable}, needs OCR ${needsOcr.length}, unreadable ${unreadable}`);
	console.log(`pages needing OCR: ${pages} (revisions with a recorded page count)`);
}

await main();

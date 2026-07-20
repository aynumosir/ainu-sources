#!/usr/bin/env bun
/**
 * Produce text for revisions that carry no text of any kind.
 *
 * Recognition is the last resort in this archive, not the first. A publisher's
 * text layer is extracted where one exists, a curated transcription is
 * preferred where one exists, and only pages that have neither reach this
 * script. Each page is transcribed by a hosted model and written as its own
 * text variant, so the source stays attributable and a better engine can be
 * added later as another variant rather than a replacement.
 *
 * Pages are cached on disk as they are transcribed: a work of several thousand
 * pages must survive an interruption without paying for the same pages twice.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql, and, eq } from 'drizzle-orm';
import { activateOcrGeneration, type OcrPageInput } from '../../src/lib/server/archive/ocr';
import { revisionOcrCoverage } from '../../src/lib/server/db/schema';

const VARIANT = 'gemini';
const RENDER_DPI = 200;
const CONCURRENCY = Number(process.env.RECOGNIZE_CONCURRENCY ?? 4);
const RENDER_WINDOW = Number(process.env.RECOGNIZE_RENDER_WINDOW ?? 24);
const MODEL = process.env.RECOGNIZE_MODEL ?? 'gemini-3-flash';

const PROMPT = `Transcribe this scanned page exactly as printed.

The page is from an Ainu-language publication. It mixes romanized Ainu,
Japanese (kanji, hiragana, katakana), and sometimes Cyrillic or Russian.

Rules:
- Reproduce every character as printed, including = and - inside Ainu words,
  macrons, and bracketed editorial marks.
- Keep the reading order and line breaks of the page.
- Do not translate, correct, normalize, or explain anything.
- Do not add commentary, headings, or markdown.
- If a character is illegible, write a single ? in its place.
- If the page carries no text, output nothing.

Output only the transcription.`;

type Row = { revisionId: string; slug: string; blobSha256: string };

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function fetchBlob(sha: string, dir: string): string {
	const file = path.join(dir, `${sha}.pdf`);
	execFileSync(
		'aws',
		['s3api', 'get-object', '--bucket', requireEnv('R2_BUCKET'), '--key', `blobs/sha256/${sha.slice(0, 2)}/${sha}`,
			'--endpoint-url', requireEnv('R2_ENDPOINT'), file],
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

async function transcribe(image: string): Promise<string> {
	const body = {
		model: MODEL,
		temperature: 0,
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: PROMPT },
					{ type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(image).toString('base64')}` } }
				]
			}
		]
	};
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			const response = await fetch(`${process.env.PROXY_BASE ?? 'http://127.0.0.1:8317'}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${requireEnv('PROXY_TOKEN')}` },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(300_000)
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const json = await response.json();
			return json.choices?.[0]?.message?.content ?? '';
		} catch (error) {
			if (attempt === 6) throw error;
			// Upstream 429 and 503 are load, not refusal; back off and let it clear.
			await new Promise((r) => setTimeout(r, attempt * attempt * 3000));
		}
	}
	return '';
}

async function recognizeWork(row: Row, cacheRoot: string, workDir: string): Promise<OcrPageInput[]> {
	const cache = path.join(cacheRoot, row.revisionId);
	mkdirSync(cache, { recursive: true });
	const pdf = fetchBlob(row.blobSha256, workDir);
	const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
	const total = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
	const renderDir = path.join(workDir, 'pages');
	const pages: OcrPageInput[] = [];
	const failures: number[] = [];

	// Rendering a whole book before transcribing anything means minutes of
	// silence and gigabytes of PNGs on disk. Pages are rendered a window at a
	// time and discarded once read.
	for (let first = 1; first <= total; first += RENDER_WINDOW) {
		const last = Math.min(first + RENDER_WINDOW - 1, total);
		const window = Array.from({ length: last - first + 1 }, (_, i) => first + i);
		const missing = window.filter((n) => !existsSync(path.join(cache, `${n}.txt`)));
		if (missing.length > 0) {
			rmSync(renderDir, { recursive: true, force: true });
			mkdirSync(renderDir, { recursive: true });
			execFileSync(
				'pdftoppm',
				['-f', String(first), '-l', String(last), '-r', String(RENDER_DPI), '-png', pdf, path.join(renderDir, 'p')],
				{ stdio: 'ignore' }
			);
		}
		// pdftoppm names files by absolute page number, zero-padded to the
		// width of the document's last page.
		const rendered = new Map(
			(missing.length > 0 ? readdirSync(renderDir).filter((f) => f.endsWith('.png')) : []).map((file) => [
				Number(/p-?(\d+)\.png$/.exec(file)?.[1] ?? 0),
				file
			])
		);
		for (let start = 0; start < window.length; start += CONCURRENCY) {
			const slice = window.slice(start, start + CONCURRENCY);
			const results = await Promise.all(
				slice.map(async (pageNumber) => {
					const cached = path.join(cache, `${pageNumber}.txt`);
					if (existsSync(cached)) return { page: pageNumber, text: readFileSync(cached, 'utf8') };
					const image = rendered.get(pageNumber);
					if (!image) return { page: pageNumber, text: '' };
					try {
						const text = (await transcribe(path.join(renderDir, image))).trim();
						writeFileSync(cached, text, 'utf8');
						return { page: pageNumber, text };
					} catch (error) {
						// One page that will not transcribe must not discard a
						// book. The page is left uncached so a later run
						// retries it, and the work continues without it.
						failures.push(pageNumber);
						console.error(`      page ${pageNumber}: ${(error as Error).message.slice(0, 60)}`);
						return { page: pageNumber, text: '' };
					}
				})
			);
			for (const result of results) if (result.text.length > 0) pages.push(result);
		}
		console.log(`    ${row.slug}: ${last}/${total} pages`);
	}
	rmSync(renderDir, { recursive: true, force: true });
	rmSync(pdf, { force: true });
	// Ingesting a book with a tenth of its pages missing would present a gap as
	// the whole text, so that case is refused and left for another run.
	if (total > 0 && failures.length / total > 0.1) {
		throw new Error(`${failures.length} of ${total} pages failed to transcribe`);
	}
	if (failures.length > 0) {
		console.log(`    ${row.slug}: ${failures.length} pages could not be read and are absent`);
	}
	return pages.sort((a, b) => a.page - b.page);
}

async function recordCoverage(db: any, revisionId: string): Promise<void> {
	const now = new Date();
	const existing = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, VARIANT)))
		.limit(1);
	if (existing.length > 0) {
		await db
			.update(revisionOcrCoverage)
			.set({ status: 'complete', sourceKind: 'recognized', tool: VARIANT, toolVersion: MODEL, measuredAt: now })
			.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, VARIANT)));
		return;
	}
	const preferred = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.preferred, true)))
		.limit(1);
	await db.insert(revisionOcrCoverage).values({
		revisionId,
		variant: VARIANT,
		status: 'complete',
		sourceKind: 'recognized',
		tool: VARIANT,
		toolVersion: MODEL,
		preferred: preferred.length === 0,
		measuredAt: now
	});
}

async function main() {
	const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
	const cacheRoot = process.env.RECOGNIZE_CACHE ?? path.join(tmpdir(), 'recognize-cache');
	mkdirSync(cacheRoot, { recursive: true });

	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);
	const rows = (await db.all<Row>(sql`
		select fr.id as revisionId, src.slug as slug, fr.blob_sha256 as blobSha256
		from file_revisions fr
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		where fr.is_current = 1
			and fr.declared_media_type = 'application/pdf'
			and fr.blob_sha256 is not null
			and not exists (select 1 from ocr_ingest_state s where s.revision_id = fr.id)
		order by src.slug
	`)).slice(0, limit);
	console.log(`${rows.length} revisions have no text of any kind`);

	const workDir = mkdtempSync(path.join(tmpdir(), 'recognize-'));
	let ingested = 0;
	let failed = 0;
	try {
		for (const row of rows) {
			console.log(`  ${row.slug}`);
			try {
				const pages = await recognizeWork(row, cacheRoot, workDir);
				if (pages.length === 0) {
					console.log(`    ${row.slug}: no text recognized`);
					continue;
				}
				await activateOcrGeneration(db as never, row.revisionId, VARIANT, pages);
				await recordCoverage(db, row.revisionId);
				console.log(`    ${row.slug}: ingested ${pages.length} pages`);
				ingested += 1;
			} catch (error) {
				console.error(`    ${row.slug}: failed ${(error as Error).message.slice(0, 120)}`);
				failed += 1;
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
	console.log(`\ningested ${ingested}, failed ${failed}`);
}

await main();

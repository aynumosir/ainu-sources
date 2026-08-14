#!/usr/bin/env bun
/**
 * Export every active OCR chunk as JSONL for embedding.
 *
 * One line per chunk: {"id": chunk_id, "text": head of the chunk}. The text
 * is capped: a chunk holding a whole book cannot be represented by one
 * vector anyway, and bge-m3's window ends near 8k tokens. Chunks from
 * superseded ingest generations are excluded, and a vector whose chunk later
 * leaves the active generation stops matching at query time, so re-running
 * export → embed → upsert after an OCR ingest converges without deletions.
 *
 * Usage:
 *   bun --preload ./scripts/sveltekit-env-shim.ts scripts/archive/export-embedding-batch.ts out/chunks.jsonl
 * Then:
 *   uv run scripts/archive/embed-chunks.py out/chunks.jsonl out/vectors
 *   for f in out/vectors/*.ndjson; do bunx wrangler vectorize insert archive-ocr --file "$f"; done
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../../src/lib/server/db';

const EMBED_TEXT_CAP = 4000;
const PAGE_SIZE = 2000;

const [, , outPath] = process.argv;
if (!outPath) {
	console.error('usage: export-embedding-batch.ts <out.jsonl>');
	process.exit(1);
}
await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
const out = createWriteStream(outPath);

let lastChunkId = '';
let exported = 0;
for (;;) {
	const rows = await db.all<{ chunkId: string; text: string }>(sql`
		select c.chunk_id as chunkId, substr(c.text, 1, ${EMBED_TEXT_CAP}) as text
		from ocr_chunks c
		inner join ocr_ingest_state state
			on state.revision_id = c.revision_id
			and state.variant = c.variant
			and state.active_generation = c.ingest_generation
		inner join file_revisions fr on fr.id = c.revision_id and fr.is_current = 1
		where length(trim(c.text)) > 0 and c.chunk_id > ${lastChunkId}
		order by c.chunk_id
		limit ${PAGE_SIZE}
	`);
	if (rows.length === 0) break;
	for (const row of rows) {
		out.write(JSON.stringify({ id: row.chunkId, text: row.text }) + '\n');
	}
	exported += rows.length;
	lastChunkId = rows.at(-1)!.chunkId;
	console.error(`exported ${exported}...`);
}
await new Promise((resolve) => out.end(resolve));
console.log(JSON.stringify({ exported, out: outPath }));

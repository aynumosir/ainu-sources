#!/usr/bin/env bun
/**
 * Batch slug rename (re-slug) applier — the write side of the
 * "old slugs never break" promise (see src/lib/server/resolve-slug.ts).
 *
 * Input: a TSV with header `old_slug  new_slug  title  author  flags`
 * (title/author/flags are reviewer context from the proposal pipeline; only
 * old_slug/new_slug are consumed). Rows with an EMPTY new_slug are proposals
 * that were reviewed away — counted and skipped.
 *
 * For each applicable row, in ONE atomic db.batch (a server-side transaction;
 * `db.transaction()` is banned repo-wide — see admin/review/[id]/+page.server.ts):
 *   1. sources.slug: old → new (+ updated_at)
 *   2. slug_redirects: old_slug → source id, so every public route 301s
 *   3. source_revisions: an 'update' revision with the standard
 *      {source, links, tags} snapshot (same shape as merge-write.ts),
 *      summary "slug renamed: <old> → <new> (re-slug 2026-07)"
 *
 * Safety:
 *   • --plan (default) prints the per-row decision + stats, writes NOTHING
 *   • --apply performs the writes
 *   • idempotent: a rerun finds old_slug already redirecting to a source whose
 *     current slug IS new_slug and skips the row
 *   • refuses rows whose new_slug fails ^[a-z0-9][a-z0-9-]{1,59}$, collides
 *     with a live slug or a retired one, or is proposed twice in the TSV
 *   • chains are collapsed: if old_slug is already a redirect to some OTHER
 *     current slug, the row is skipped with a warning (redirects store the
 *     source id, so a redirect→redirect chain can never form)
 *
 * Run:  bun run reslug <renames.tsv>            plan (no writes)
 *       bun run reslug <renames.tsv> --apply    write
 * Reads DATABASE_URL / DATABASE_AUTH_TOKEN from env (same as drizzle.config.ts).
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';

const { sources, slugRedirects, sourceRevisions, sourceLinks, sourceTags, tags } = schema;
type Db = LibSQLDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// TSV parsing / validation (pure — unit-tested in apply-reslug.test.ts)
// ---------------------------------------------------------------------------

/** The only slugs this tool will ever mint: [a-z0-9-], 2–60 chars, no leading '-'. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

export interface ReslugRow {
	/** 1-based line number in the TSV, for error messages */
	line: number;
	oldSlug: string;
	newSlug: string;
}

export interface ParseResult {
	/** rows with a non-empty new_slug — the applicable renames */
	rows: ReslugRow[];
	/** rows the proposal pipeline left blank (no rename proposed) */
	emptyNew: number;
	/** hard problems: bad header, missing old_slug, in-file duplicates */
	errors: string[];
}

export function parseReslugTsv(text: string): ParseResult {
	const rows: ReslugRow[] = [];
	const errors: string[] = [];
	let emptyNew = 0;

	const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
	const header = lines[0]?.split('\t') ?? [];
	if (header[0]?.trim() !== 'old_slug' || header[1]?.trim() !== 'new_slug') {
		errors.push(`bad header: expected "old_slug\\tnew_slug\\t…", got "${lines[0] ?? ''}"`);
		return { rows, emptyNew, errors };
	}

	const seenOld = new Set<string>();
	const seenNew = new Set<string>();
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '') continue;
		const line = i + 1;
		const cols = lines[i].split('\t');
		const oldSlug = (cols[0] ?? '').trim();
		const newSlug = (cols[1] ?? '').trim();
		if (!oldSlug) {
			errors.push(`line ${line}: empty old_slug`);
			continue;
		}
		if (seenOld.has(oldSlug)) {
			errors.push(`line ${line}: duplicate old_slug "${oldSlug}"`);
			continue;
		}
		seenOld.add(oldSlug);
		if (!newSlug) {
			emptyNew++;
			continue;
		}
		if (seenNew.has(newSlug)) {
			errors.push(`line ${line}: duplicate new_slug "${newSlug}"`);
			continue;
		}
		seenNew.add(newSlug);
		rows.push({ line, oldSlug, newSlug });
	}
	return { rows, emptyNew, errors };
}

// ---------------------------------------------------------------------------
// Per-row decision + apply (db-parameterized — unit-testable on :memory:)
// ---------------------------------------------------------------------------

export type Decision =
	| { kind: 'apply'; sourceId: string }
	| { kind: 'already-applied' } // rerun: old_slug already redirects to new_slug
	| { kind: 'chain'; currentSlug: string } // old_slug is a redirect elsewhere
	| { kind: 'missing' } // old_slug matches no source
	| { kind: 'refused'; reason: string };

export async function decideRename(db: Db, row: ReslugRow): Promise<Decision> {
	const { oldSlug, newSlug } = row;
	if (!SLUG_RE.test(newSlug))
		return { kind: 'refused', reason: `new_slug "${newSlug}" fails ${SLUG_RE}` };
	if (oldSlug === newSlug)
		return { kind: 'refused', reason: 'old_slug and new_slug are identical' };

	// Already a retired slug? Idempotent rerun vs. a would-be chain.
	const [redir] = await db
		.select({ currentSlug: sources.slug })
		.from(slugRedirects)
		.innerJoin(sources, eq(slugRedirects.sourceId, sources.id))
		.where(eq(slugRedirects.oldSlug, oldSlug))
		.limit(1);
	if (redir) {
		if (redir.currentSlug === newSlug) return { kind: 'already-applied' };
		return { kind: 'chain', currentSlug: redir.currentSlug };
	}

	const [src] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(eq(sources.slug, oldSlug))
		.limit(1);
	if (!src) return { kind: 'missing' };

	// new_slug must be free among LIVE slugs and RETIRED ones alike.
	const [taken] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(eq(sources.slug, newSlug))
		.limit(1);
	if (taken) return { kind: 'refused', reason: `new_slug "${newSlug}" is already a live slug` };
	const [retired] = await db
		.select({ oldSlug: slugRedirects.oldSlug })
		.from(slugRedirects)
		.where(eq(slugRedirects.oldSlug, newSlug))
		.limit(1);
	if (retired)
		return { kind: 'refused', reason: `new_slug "${newSlug}" is a retired slug (redirect)` };

	return { kind: 'apply', sourceId: src.id };
}

export const RESLUG_TAG = 're-slug 2026-07';

/** The three writes of one rename, atomically. The snapshot parts are read
 *  first (one batch, like merge-write.ts `snapshot()`) and the post-rename
 *  source state is composed from them, so history shows the final state; the
 *  three WRITES then ride in ONE atomic db.batch — libsql executes a batch as
 *  a single transaction and rolls it back on any error. */
export async function applyRename(
	db: Db,
	sourceId: string,
	oldSlug: string,
	newSlug: string
): Promise<void> {
	const [srcRows, links, tagRows] = await db.batch([
		db.select().from(sources).where(eq(sources.id, sourceId)).limit(1),
		db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId)),
		db
			.select({ name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id))
			.where(eq(sourceTags.sourceId, sourceId))
	]);
	const src = srcRows[0];
	if (!src) throw new Error(`source ${sourceId} vanished between decide and apply`);

	const renamedAt = new Date();
	const snapshot = {
		source: { ...src, slug: newSlug, updatedAt: renamedAt },
		links,
		tags: tagRows.map((t) => t.name)
	};
	await db.batch([
		db.update(sources).set({ slug: newSlug, updatedAt: renamedAt }).where(eq(sources.id, sourceId)),
		db.insert(slugRedirects).values({ oldSlug, sourceId }),
		db.insert(sourceRevisions).values({
			sourceId,
			userId: null,
			userName: 'apply-reslug',
			summary: `slug renamed: ${oldSlug} → ${newSlug} (${RESLUG_TAG})`,
			action: 'update',
			snapshot
		})
	]);
}

export interface RunStats {
	applicable: number;
	applied: number; // (or would-apply, in plan mode)
	alreadyApplied: number;
	chains: number;
	missing: number;
	refused: number;
}

export async function runReslug(
	db: Db,
	rows: ReslugRow[],
	opts: { apply: boolean; log?: (msg: string) => void }
): Promise<RunStats> {
	const log = opts.log ?? console.log;
	const stats: RunStats = {
		applicable: rows.length,
		applied: 0,
		alreadyApplied: 0,
		chains: 0,
		missing: 0,
		refused: 0
	};
	for (const row of rows) {
		const d = await decideRename(db, row);
		const at = `line ${row.line}: ${row.oldSlug} → ${row.newSlug}`;
		switch (d.kind) {
			case 'apply':
				if (opts.apply) await applyRename(db, d.sourceId, row.oldSlug, row.newSlug);
				stats.applied++;
				log(`${opts.apply ? 'APPLIED' : 'WOULD APPLY'}  ${at}`);
				break;
			case 'already-applied':
				stats.alreadyApplied++;
				log(`SKIP (already applied)  ${at}`);
				break;
			case 'chain':
				stats.chains++;
				log(`! SKIP (chain)  ${at} — "${row.oldSlug}" is already a redirect to "${d.currentSlug}"`);
				break;
			case 'missing':
				stats.missing++;
				log(`! SKIP (not found)  ${at} — no source has slug "${row.oldSlug}"`);
				break;
			case 'refused':
				stats.refused++;
				log(`✗ REFUSED  ${at} — ${d.reason}`);
				break;
		}
	}
	return stats;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');
	const files = args.filter((a) => a !== '--apply' && a !== '--plan');
	if (files.length !== 1) {
		console.error('usage: bun scripts/apply-reslug.ts <renames.tsv> [--plan|--apply]');
		process.exit(1);
	}

	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:');
	if (!isFile && !process.env.DATABASE_AUTH_TOKEN)
		throw new Error('DATABASE_AUTH_TOKEN is not set');
	const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
	if (isFile) await client.execute('PRAGMA foreign_keys = ON'); // local convention, see db/index.ts
	const db = drizzle(client, { schema });

	const parsed = parseReslugTsv(readFileSync(files[0], 'utf8'));
	for (const e of parsed.errors) console.error(`✗ TSV ${e}`);

	console.log(`${apply ? '== APPLY ==' : '== PLAN (no writes; pass --apply to write) =='}`);
	const stats = await runReslug(db, parsed.rows, { apply });

	console.log('\n--- stats ---');
	console.log(`rows without a proposed new_slug (skipped): ${parsed.emptyNew}`);
	console.log(`applicable rows:  ${stats.applicable}`);
	console.log(`${apply ? 'applied' : 'would apply'}:      ${stats.applied}`);
	console.log(`already applied:  ${stats.alreadyApplied}`);
	console.log(`chain skips:      ${stats.chains}`);
	console.log(`old_slug missing: ${stats.missing}`);
	console.log(`refused:          ${stats.refused}`);
	console.log(`TSV errors:       ${parsed.errors.length}`);

	// Refusals and malformed input are hard failures so CI / the operator notices.
	process.exitCode = stats.refused > 0 || parsed.errors.length > 0 ? 1 : 0;
}

if (import.meta.main) await main();

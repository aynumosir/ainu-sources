#!/usr/bin/env bun
/**
 * Feed #1 — Dictionaries / wordlists / old documents importer (idempotent).
 *
 * The merge-engine replacement for seed.ts's `seedDictionaries`. Reads
 * $AINU_ROOT/ainu-dictionaries/catalog.json and, for each entry IN CATALOG ORDER,
 * derives the SAME fields seed.ts did (via scripts/import/lib/derive.ts, byte-for-
 * byte) and submits ONE `curated_assertion` observation per entry through
 * mergeSourceObservation. The engine attaches to the existing source by its
 * `repo_path` identifier and emits value-hash noop claims (no duplicate source),
 * then this importer reconciles the author/dialect/tag entities idempotently.
 *
 * Origin        : 'ainu-dictionaries'
 * Idempotency key: (origin, originRecordId = source_dir, contentHash) — the engine's
 *                  observation UNIQUE index. A re-run with unchanged catalog is a
 *                  dup-noop (zero projection change).
 * Identity key  : identifier repo_path = 'ainu-dictionaries:<source_dir>' (matches the
 *                  bootstrap's `${repo}:${path}` form → repo_path_exact attach).
 * Derivation    : curated_assertion @ 0.8 (≤ the bootstrap band, so it never clobbers
 *                  a bootstrapped/editorial value; noop-by-valueHash regardless).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun run import:dictionaries
 *       DATABASE_URL=file:/tmp/clone.db bun run import:dictionaries --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	parseYear,
	langsForDict,
	regionFor,
	CATALOG_OVERRIDES,
	TAG_DEFS,
	type CatalogEntry
} from './lib/derive';
import { openDb, addPersons, addPlaces, attachTags, type EntityStamp } from './lib/entities';
import { openRun, closeRun, emitSource, driftMissing } from './lib/run';
import type { MergeInput } from '../../src/lib/server/merge';

// ── argv ─────────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

const url = argValue('--db') ?? process.env.DATABASE_URL;
if (!url) {
	console.error('✗ No database specified. Pass --db file:/path/to/db or set DATABASE_URL.');
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}
const DRY_RUN = hasFlag('--dry-run');
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : Infinity;

const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(import.meta.dir, '../../..');
const DICT_DIR = path.join(AINU_ROOT, 'ainu-dictionaries');
const CATALOG_FILE = path.join(DICT_DIR, 'catalog.json');

const ORIGIN = 'ainu-dictionaries';
const DERIVATION = 'curated_assertion';
const CONFIDENCE = 0.8;

/**
 * Derive the engine `fields` map for one catalog entry — byte-identical to
 * seed.ts's `seedDictionaries` row build. Empty/null values are OMITTED (the
 * engine skips empties anyway, and omitting avoids empty-overwrite noise on the
 * historically-populated clone); the returned `author`/`dialect` are the raw
 * (possibly override-substituted) strings used for the entity graph.
 */
function deriveEntry(e: CatalogEntry): {
	fields: Record<string, unknown>;
	author: string | undefined;
	dialect: string;
} {
	const ov = CATALOG_OVERRIDES[e.source_dir];
	const y = parseYear(ov?.year ?? e.year);
	const base = langsForDict(e);
	const languages = ov?.languages ?? base.languages;
	const scripts = ov?.scripts ?? base.scripts;
	const author = ov?.author ?? e.author;
	const dialect = e.dialect || '';
	const region = regionFor(dialect) || null;

	const fields: Record<string, unknown> = {
		title: e.title,
		category: 'primary',
		type: e.type,
		yearCertainty: y.yearCertainty,
		languages,
		scripts,
		entryCountLabel: 'entries'
	};
	if (e.title_en) fields.titleEn = e.title_en;
	if (author && !/^unknown$/i.test(author)) fields.author = author;
	if (y.yearText) fields.yearText = y.yearText;
	if (y.yearStart != null) fields.yearStart = y.yearStart;
	if (y.yearEnd != null) fields.yearEnd = y.yearEnd;
	if (dialect) fields.dialect = dialect;
	if (region) fields.region = region;
	if (e.rows != null) fields.entryCount = e.rows;
	if (e.license) fields.license = e.license;

	return { fields, author, dialect };
}

async function main() {
	if (!fs.existsSync(CATALOG_FILE)) {
		console.error(`✗ catalog not found: ${CATALOG_FILE}\n  Set AINU_ROOT to the dir containing ainu-dictionaries/.`);
		process.exit(1);
	}
	const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
	const entries = LIMIT === Infinity ? catalog : catalog.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:dictionaries → ${url!.split('?')[0]}  (${entries.length}/${catalog.length} entries)`
	);

	const db = openDb(url!, authToken);
	const runId = DRY_RUN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-dictionaries@1' });

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, created: 0, other: 0, persons: 0, places: 0, tags: 0 };

	for (const e of entries) {
		seen.add(e.source_dir);
		const { fields, author, dialect } = deriveEntry(e);

		if (DRY_RUN) {
			console.log(`  ${e.source_dir}: ${Object.keys(fields).length} fields`);
			continue;
		}

		const input: MergeInput = {
			origin: ORIGIN,
			originRecordId: e.source_dir,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields,
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${e.source_dir}` }],
			links: [],
			presence: 'seen',
			runId,
			rawPayload: e as unknown as Record<string, unknown>
		};

		const result = await emitSource(db, input, { provenanceRepo: ORIGIN, provenancePath: e.source_dir });
		if (result.status === 'noop') stats.noop += 1;
		else if (result.status === 'applied') stats.applied += 1;
		else stats.other += 1;

		const sid = result.sourceId;
		if (!sid) continue;
		const stamp: EntityStamp = {
			origin: ORIGIN,
			observationId: result.observationId,
			confidence: CONFIDENCE,
			now: new Date()
		};
		await addPersons(db, sid, author, stamp);
		await addPlaces(db, sid, dialect, stamp);
		await attachTags(db, sid, [e.title, e.title_en, e.type, dialect], stamp, TAG_DEFS);
	}

	let drifted = 0;
	if (!DRY_RUN) {
		drifted = await driftMissing(db, ORIGIN, seen, { derivation: DERIVATION, confidence: CONFIDENCE, runId });
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, entries: entries.length }
		});
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:dictionaries failed:', err);
		process.exit(1);
	});

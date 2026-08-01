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
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--plan] [--limit N].
 *        --plan resolves each entry's identity against the database and reports
 *        attach vs create, writing nothing; --dry-run stops before that.
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
import { addPersons, addPlaces, attachTags, type Db, type EntityStamp } from './lib/entities';
import {
	openRun,
	closeRun,
	emitSource,
	driftMissing,
	parseImporterCli,
	summarize,
	type ImporterRunOptions,
	type ImporterSummary
} from './lib/run';
import type { MergeInput } from '../../src/lib/server/merge';
import { resolveIdentity } from '../../src/lib/server/merge/identity';
import { normalizeIdentifier } from '../../src/lib/server/merge/normalize';
import { eq } from 'drizzle-orm';
import { sources, slugRedirects } from '../../src/lib/server/db/schema';

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

export async function run(db: Db, opts: ImporterRunOptions = {}): Promise<ImporterSummary> {
	const DRY_RUN = opts.dryRun ?? false;
	const PLAN = opts.plan ?? false;
	// The two report different things and only one branch can run; taking plan
	// silently would make --dry-run mean something other than it says.
	if (DRY_RUN && PLAN) {
		throw new Error('--dry-run and --plan are mutually exclusive: pass one');
	}
	const planned = new Map<string, number>();
	const LIMIT = opts.limit ?? Infinity;
	if (!fs.existsSync(CATALOG_FILE)) {
		throw new Error(`catalog not found: ${CATALOG_FILE}\n  Set AINU_ROOT to the dir containing ainu-dictionaries/.`);
	}
	const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
	const entries = LIMIT === Infinity ? catalog : catalog.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:dictionaries  (${entries.length}/${catalog.length} entries)`
	);

	const runId = DRY_RUN || PLAN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-dictionaries@1' });

	/**
	 * The source a folder's catalogue slug points at.
	 *
	 * Identity normally runs off the `repo_path` identifier, which only records
	 * seeded from here carry. A folder whose record was made another way — by
	 * hand, through the API, or harvested from an external catalogue — has no
	 * such identifier, and the engine then creates a SECOND source for it. The
	 * folder's own `source_slug` already names the right record, so resolve it
	 * (through a redirect if the slug has since been renamed) and hand the
	 * engine a deterministic attach target.
	 */
	async function targetFor(slug: string | undefined): Promise<string | undefined> {
		if (!slug) return undefined;
		const [live] = await db
			.select({ id: sources.id })
			.from(sources)
			.where(eq(sources.slug, slug))
			.limit(1);
		const [red] = live
			? [undefined]
			: await db
					.select({ id: slugRedirects.sourceId })
					.from(slugRedirects)
					.where(eq(slugRedirects.oldSlug, slug))
					.limit(1);
		return usable(live?.id ?? red?.id);
	}

	/**
	 * A merged or soft-deleted record must never be handed to the engine as an
	 * attach target: attaching would revive a record the catalogue has retired.
	 * A merged one still points at its winner, so follow that; a soft-deleted
	 * one has nowhere to go, and returning nothing lets ordinary identity
	 * resolution decide.
	 */
	async function usable(id: string | undefined): Promise<string | undefined> {
		const seen = new Set<string>();
		let cur = id;
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			const [row] = await db
				.select({ status: sources.status, winner: sources.mergedIntoSourceId })
				.from(sources)
				.where(eq(sources.id, cur))
				.limit(1);
			if (!row) return undefined;
			if (row.status === 'soft_deleted') return undefined;
			if (row.status !== 'merged') return cur;
			cur = row.winner ?? undefined;
		}
		return undefined;
	}

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, created: 0, other: 0, persons: 0, places: 0, tags: 0 };

	for (const e of entries) {
		seen.add(e.source_dir);
		const { fields, author, dialect } = deriveEntry(e);

		if (PLAN) {
			// Ask the engine what it WOULD do with this entry, writing nothing.
			// --dry-run stops before identity resolution, so it cannot show that
			// a folder is about to be created a second time rather than attached.
			const decision = await resolveIdentity(db, {
				identifiers: [
					normalizeIdentifier({ kind: 'repo_path', value: `${ORIGIN}:${e.source_dir}` })
				],
				fields,
				targetSourceId: await targetFor(e.source_slug)
			});
			planned.set(decision.action, (planned.get(decision.action) ?? 0) + 1);
			const mark = decision.action === 'create' ? '! ' : '  ';
			console.log(`${mark}${e.source_dir}: ${decision.action} (${decision.matchDecision})`);
			continue;
		}

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
			targetSourceId: await targetFor(e.source_slug),
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
	if (!DRY_RUN && !PLAN) {
		drifted = await driftMissing(db, ORIGIN, seen, { derivation: DERIVATION, confidence: CONFIDENCE, runId });
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, entries: entries.length }
		});
	}

	if (PLAN) {
		const parts = [...planned].map(([k, v]) => `${k}=${v}`).join(' ');
		console.log(`[PLAN] would: ${parts || 'nothing'}`);
		const creates = planned.get('create') ?? 0;
		if (creates) console.log(`[PLAN] ${creates} folder(s) would be CREATED rather than attached`);
		return summarize('dictionaries', stats, 0, { entries: entries.length });
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
	return summarize('dictionaries', stats, drifted, { entries: entries.length });
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	run(db, opts)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('\n✗ import:dictionaries failed:', err);
			process.exit(1);
		});
}

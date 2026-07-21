#!/usr/bin/env bun
/**
 * import-all — the idempotent, re-runnable SEED (the wipe-rebuild `seed.ts`'s
 * successor). It runs every harvest importer, IN seed.ts's load-bearing source
 * order, over ONE shared db handle, and DELETES NOTHING:
 *
 *   dictionaries → grammar → corpus → manual → academic → curated-biblio
 *                → extracted-cites → relations → person-enrichment
 *
 * The order is load-bearing (Risk C): every source-observing feed runs before the
 * relations post-pass (which derives source→source edges from the sources that
 * already exist) and the person-enrichment post-pass (which backfills person
 * scalars). Each importer opens its OWN `source_observation_runs` row, routes every
 * write through the merge engine (dup-noop on re-submit, value-hash noop per field),
 * and re-observes upstream disappearances as drift — never a delete, never a wipe,
 * no transaction. So a 2nd full run over an unchanged catalogue is a pure noop
 * (rootHash unchanged); the 1st run over a bootstrap clone is approved-additive
 * (new academic candidates + set canonicalization + upstream catch-up).
 *
 * SOURCES_ENABLE_PROPOSE: the orchestrator is deliberately unaware of it. When the
 * flag is on, the merge engine itself routes a NEW / low-trust observation to
 * `change_requests` (status 'proposed') instead of auto-applying — the importer
 * counts it under `other` and the review queue drains it. Nothing here changes.
 *
 * Continue-on-error: a feed that throws (e.g. a missing sibling repo) is logged and
 * SKIPPED; the remaining feeds still run, and the process exits non-zero so a CI/cron
 * caller notices. Use --only to run a single feed.
 *
 * Flags:
 *   --db file:/path (or DATABASE_URL)   the target database (required)
 *   --token T (or DATABASE_AUTH_TOKEN)  auth token for a remote libSQL url
 *   --dry-run                           derive + report, write nothing (pass-through)
 *   --limit N                           cap records per source feed (pass-through)
 *   --only <feed>                       run just one feed (name from the order above)
 *
 * Run:  AINU_ROOT=~/projects/Ainu DATABASE_URL=file:/tmp/clone.db bun run import:all
 *       DATABASE_URL=file:/tmp/clone.db bun run import:all --dry-run
 *       DATABASE_URL=file:/tmp/clone.db bun run import:all --only academic --limit 50
 */
import { openDb, type Db } from './import/lib/entities';
import type { ImporterRunOptions, ImporterSummary } from './import/lib/run';
import { run as importDictionaries } from './import/dictionaries';
import { run as importGrammar } from './import/grammar';
import { run as importCorpus } from './import/corpus';
import { run as importManual } from './import/manual';
import { run as importAcademic } from './import/academic';
import { run as importCuratedBiblio } from './import/curated-biblio';
import { run as importExtractedCites } from './import/extracted-cites';
import { run as importRelations } from './import/relations';
import { run as importPersonEnrichment } from './import/person-enrichment';

// ── the feeds, IN seed.ts's load-bearing source order ──────────────────────────
interface Feed {
	name: string;
	run: (db: Db, opts: ImporterRunOptions) => Promise<ImporterSummary>;
}
const FEEDS: Feed[] = [
	{ name: 'dictionaries', run: importDictionaries },
	{ name: 'grammar', run: importGrammar },
	{ name: 'corpus', run: importCorpus },
	{ name: 'manual', run: importManual },
	{ name: 'academic', run: importAcademic },
	{ name: 'curated-biblio', run: importCuratedBiblio },
	{ name: 'extracted-cites', run: importExtractedCites },
	{ name: 'relations', run: importRelations },
	{ name: 'person-enrichment', run: importPersonEnrichment }
];

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
const ONLY = argValue('--only');

if (ONLY && !FEEDS.some((f) => f.name === ONLY)) {
	console.error(`✗ Unknown --only feed '${ONLY}'. Known feeds: ${FEEDS.map((f) => f.name).join(', ')}.`);
	process.exit(1);
}

async function main() {
	const feeds = ONLY ? FEEDS.filter((f) => f.name === ONLY) : FEEDS;
	const proposeOn = process.env.SOURCES_ENABLE_PROPOSE === 'true';
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:all → ${url!.split('?')[0]}` +
			`  (${feeds.length} feed${feeds.length === 1 ? '' : 's'}${ONLY ? `: ${ONLY}` : ''}` +
			`${LIMIT === Infinity ? '' : `, limit ${LIMIT}`}${proposeOn ? ', PROPOSE on' : ''})`
	);

	// ONE shared db handle across every importer (each still opens its own run row).
	const db = openDb(url!, authToken);
	const opts: ImporterRunOptions = { dryRun: DRY_RUN, limit: LIMIT };

	const summaries: ImporterSummary[] = [];
	const failures: { feed: string; error: unknown }[] = [];
	const t0 = Date.now();

	for (const feed of feeds) {
		console.log(`\n── ${feed.name} ─────────────────────────────────────────────`);
		try {
			const summary = await feed.run(db, opts);
			summaries.push(summary);
		} catch (error) {
			// Continue-on-error: log + record, keep the remaining feeds running.
			console.error(`✗ feed '${feed.name}' FAILED (continuing):`, error instanceof Error ? error.message : error);
			failures.push({ feed: feed.name, error });
		}
	}

	// ── aggregate ────────────────────────────────────────────────────────────────
	const total = { applied: 0, noop: 0, candidate: 0, conflict: 0, drifted: 0, other: 0 };
	for (const s of summaries) {
		total.applied += s.applied;
		total.noop += s.noop;
		total.candidate += s.candidate;
		total.conflict += s.conflict;
		total.drifted += s.drifted;
		total.other += s.other;
	}

	console.log(`\n=== import:all ${DRY_RUN ? '(dry-run) ' : ''}summary ===`);
	console.table(
		Object.fromEntries(
			summaries.map((s) => [
				s.feed,
				{
					applied: s.applied,
					noop: s.noop,
					candidate: s.candidate,
					conflict: s.conflict,
					drifted: s.drifted,
					other: s.other
				}
			])
		)
	);
	console.log(
		`TOTAL: applied=${total.applied} noop=${total.noop} candidate=${total.candidate} ` +
			`conflict=${total.conflict} drifted=${total.drifted} other=${total.other} ` +
			`(${summaries.length}/${feeds.length} feeds ok, ${((Date.now() - t0) / 1000).toFixed(1)}s)`
	);

	if (failures.length) {
		console.error(`\n✗ ${failures.length} feed(s) FAILED: ${failures.map((f) => f.feed).join(', ')}`);
		process.exit(1);
	}
	console.log(`\n✓ import:all complete — no wipe, nothing deleted.`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:all failed:', err);
		process.exit(1);
	});

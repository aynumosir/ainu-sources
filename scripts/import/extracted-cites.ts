#!/usr/bin/env bun
/**
 * Extracted-cites importer (idempotent). Turns hand-verified reference lists
 * transcribed from a work's own bibliography into `cites` edges in
 * `source_relations`, so a scanned archive work connects to the sources it cites
 * and the significance PageRank (scripts/archive/refresh-significance.ts) sees them.
 *
 * This is the OCR-sourced counterpart to the relations importer's OpenAlex tail:
 * relations.ts resolves `cites` endpoints through the `openalex_work` identifier,
 * which only exists for works OpenAlex indexes. A 1992 MA thesis and its 1930s–80s
 * references are not in that graph, so their edges are extracted from the work's
 * printed reference list instead and resolved here BY SLUG.
 *
 * Input : scripts/data/extracted-cites/<citing-slug>.json (schema 'extracted-cites/v1').
 *         Each file carries a citingWork, the parsed references, and a citesEdges list
 *         of { from, to, type:'cites', confidence, ref } where from/to are source slugs.
 * Resolve: slug → source id over ACTIVE sources, with a slug_redirects fallback so an
 *          edge written against a retired slug still lands on the current source.
 * Upsert : existence-checked on (from, to, 'cites') — never a delete, never a wipe. A
 *          re-run over an unchanged file inserts zero rows. Direction is deterministic
 *          (citing → cited), so an exact check re-attaches the existing row.
 * Status : 'accepted' (source_relations default), origin 'extracted-cites',
 *          derivation 'reference-extraction'.
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run].
 *
 * Run:  DATABASE_URL=file:/tmp/clone.db bun run import:extracted-cites --dry-run
 *       DATABASE_URL=file:/tmp/clone.db bun run import:extracted-cites
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
	openRun,
	closeRun,
	emitSource,
	parseImporterCli,
	tallyStatus,
	type ImporterRunOptions,
	type ImporterSummary,
	type StatusTally
} from './lib/run';
import { sources, sourceRelations, slugRedirects } from '../../src/lib/server/db/schema';
import { ACTIVE_SOURCE_STATUS, PUBLIC_RELATION_STATUS } from '../../src/lib/server/visibility';
import type { Db } from './lib/entities';

const DATA_DIR = path.join(import.meta.dir, '..', 'data', 'extracted-cites');
const ORIGIN = 'extracted-cites';
const DERIVATION = 'reference-extraction';
const uuid = () => crypto.randomUUID();

interface CitesEdge {
	from: string;
	to: string;
	type?: string;
	confidence?: string;
	ref?: number;
}
interface ReferenceMatch {
	slug?: string | null;
	confidence?: string;
	note?: string | null;
}
interface ExtractedReference {
	n: number;
	authors?: string[];
	year?: number;
	yearText?: string;
	title: string;
	titleEn?: string;
	container?: string;
	editor?: string;
	volume?: string;
	pages?: string;
	publisher?: string;
	place?: string;
	edition?: string;
	institution?: string;
	type?: string;
	note?: string;
	ainuRelated?: boolean;
	match?: ReferenceMatch | null;
}
interface ExtractedFile {
	schema?: string;
	citingWork?: {
		slug?: string;
		title?: string;
		author?: string;
		year?: number;
		type?: string;
		institution?: string;
		place?: string;
	};
	extraction?: { referencePages?: string };
	references?: ExtractedReference[];
	citesEdges?: CitesEdge[];
}

/** Read every extracted-cites/*.json file, tagged with its filename for diagnostics. */
function readFiles(): { file: string; data: ExtractedFile }[] {
	if (!fs.existsSync(DATA_DIR)) return [];
	return fs
		.readdirSync(DATA_DIR)
		.filter((f) => f.endsWith('.json'))
		.sort()
		.map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) as ExtractedFile }));
}

async function relationExists(db: Db, fromId: string, toId: string): Promise<boolean> {
	const [hit] = await db
		.select({ id: sourceRelations.id })
		.from(sourceRelations)
		.where(
			and(
				eq(sourceRelations.fromSourceId, fromId),
				eq(sourceRelations.toSourceId, toId),
				eq(sourceRelations.type, 'cites')
			)
		)
		.limit(1);
	return !!hit;
}

function slugPart(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
}

/** Stable fallback slug for a bibliography record that has no confirmed catalogue match. */
function referenceSlug(ref: ExtractedReference): string {
	const year = ref.year ?? 'nd';
	const surname = slugPart(ref.authors?.[0]?.split(',')[0] ?? 'anonymous') || 'anonymous';
	const title = slugPart(ref.title) || `reference-${ref.n}`;
	return `${year}-${surname}-${title}`.slice(0, 60).replace(/-+$/u, '');
}

function resolvedReferenceSlug(ref: ExtractedReference): string {
	const confidence = ref.match?.confidence;
	if (ref.match?.slug && (confidence === 'exact' || confidence === 'probable')) return ref.match.slug;
	return referenceSlug(ref);
}

function sourceFields(ref: ExtractedReference): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		title: ref.title,
		category: 'secondary',
		type: ref.type ?? 'publication',
		yearCertainty: ref.year ? 'exact' : 'unknown'
	};
	if (ref.titleEn) fields.titleEn = ref.titleEn;
	if (ref.authors?.length) fields.author = ref.authors.join('; ');
	if (ref.year) {
		fields.yearStart = ref.year;
		fields.yearText = ref.yearText ?? String(ref.year);
	}
	const details = [
		ref.container,
		ref.volume ? `vol. ${ref.volume}` : null,
		ref.pages ? `pp. ${ref.pages}` : null,
		ref.edition,
		ref.publisher,
		ref.institution,
		ref.place,
		ref.note
	].filter(Boolean);
	if (details.length) fields.notes = details.join('. ');
	if (ref.ainuRelated) fields.region = 'general';
	return fields;
}

async function findSourceId(db: Db, slug: string): Promise<string | undefined> {
	const [direct] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(and(eq(sources.slug, slug), eq(sources.status, ACTIVE_SOURCE_STATUS)))
		.limit(1);
	if (direct) return direct.id;
	const [redirect] = await db
		.select({ sourceId: slugRedirects.sourceId })
		.from(slugRedirects)
		.where(eq(slugRedirects.oldSlug, slug))
		.limit(1);
	return redirect?.sourceId ?? undefined;
}

async function ensureCitingWork(
	db: Db,
	file: string,
	data: ExtractedFile,
	runId: string | null,
	stats: StatusTally,
	dryRun: boolean
): Promise<string | undefined> {
	const work = data.citingWork;
	if (!work?.slug) return undefined;
	const existing = await findSourceId(db, work.slug);
	if (existing || dryRun) return existing;
	const result = await emitSource(
		db,
		{
			origin: ORIGIN,
			originRecordId: `${work.slug}/work`,
			derivation: 'curated_assertion',
			confidence: 0.9,
			evidence: 1,
			slug: work.slug,
			fields: {
				title: work.title ?? work.slug,
				author: work.author,
				yearText: work.year ? String(work.year) : undefined,
				yearStart: work.year,
				yearCertainty: work.year ? 'exact' : 'unknown',
				category: 'secondary',
				type: work.type ?? 'publication',
				holdingInstitution: work.institution,
				region: 'general'
			},
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${work.slug}/work` }],
			presence: 'seen',
			runId,
			rawPayload: work
		},
		{ provenanceRepo: ORIGIN, provenancePath: file }
	);
	tallyStatus(stats, result.status);
	return result.sourceId ?? undefined;
}

async function ensureReference(
	db: Db,
	file: string,
	citingSlug: string,
	ref: ExtractedReference,
	runId: string | null,
	stats: StatusTally,
	dryRun: boolean
): Promise<string | undefined> {
	const slug = resolvedReferenceSlug(ref);
	const existing = await findSourceId(db, slug);
	if (existing || dryRun) return existing;
	const confidence =
		ref.match?.confidence === 'exact'
			? 0.95
			: ref.match?.confidence === 'probable'
				? 0.85
				: ref.match?.confidence === 'candidate'
					? 0.65
					: 0.8;
	const recordId = `${citingSlug}/ref/${ref.n}`;
	const result = await emitSource(
		db,
		{
			origin: ORIGIN,
			originRecordId: recordId,
			derivation: 'extracted',
			confidence,
			evidence: 1,
			slug,
			fields: sourceFields(ref),
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${recordId}` }],
			presence: 'seen',
			runId,
			rawPayload: ref as unknown as Record<string, unknown>
		},
		{ provenanceRepo: ORIGIN, provenancePath: `${file}#ref-${ref.n}` }
	);
	tallyStatus(stats, result.status);
	return result.sourceId ?? undefined;
}

export async function run(db: Db, opts: ImporterRunOptions = {}): Promise<ImporterSummary> {
	const DRY_RUN = opts.dryRun ?? false;
	console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}import:extracted-cites`);

	const files = readFiles();
	if (files.length === 0) {
		console.warn(`  ! no files in ${DATA_DIR}`);
		return summary(0, 0, 0, 0);
	}

	const stats = { attached: 0, added: 0, skippedConfidence: 0, unresolved: 0 };
	const sourceStats: StatusTally = { applied: 0, noop: 0, candidate: 0, conflict: 0, other: 0 };
	const unresolvedSlugs = new Set<string>();

	const runId = DRY_RUN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-extracted-cites@1' });

	for (const { file, data } of files) {
		if (data.schema !== 'extracted-cites/v1') throw new Error(`${file}: unsupported schema ${data.schema}`);
		const citingSlug = data.citingWork?.slug;
		if (!citingSlug) throw new Error(`${file}: citingWork.slug is required`);
		const fromId = await ensureCitingWork(db, file, data, runId, sourceStats, DRY_RUN);
		for (const ref of data.references ?? []) {
			const targetSlug = resolvedReferenceSlug(ref);
			const toId = await ensureReference(db, file, citingSlug, ref, runId, sourceStats, DRY_RUN);
			if (!fromId || !toId) {
				stats.unresolved += 1;
				if (!fromId) unresolvedSlugs.add(citingSlug);
				if (!toId) unresolvedSlugs.add(targetSlug);
				continue;
			}
			if (fromId === toId) continue;
			if (await relationExists(db, fromId, toId)) {
				stats.attached += 1;
				continue;
			}
			if (DRY_RUN) {
				stats.added += 1;
				continue;
			}
			await db.insert(sourceRelations).values({
				id: uuid(),
				fromSourceId: fromId,
				toSourceId: toId,
				type: 'cites',
				notes: `Reference ${ref.n}; bibliography ${data.extraction?.referencePages ?? ''}`.trim(),
				status: PUBLIC_RELATION_STATUS,
				origin: ORIGIN,
				derivation: DERIVATION,
				observationId: null,
				evidence: null,
				confidence: null
			});
			stats.added += 1;
		}
	}

	if (runId) await closeRun(db, runId, { status: 'completed', summary: { ...stats, files: files.length } });

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: ${files.length} file(s) → +${stats.added} added / ${stats.attached} attached` +
			` (${stats.skippedConfidence} below confidence, ${stats.unresolved} unresolved endpoints)`
	);
	if (unresolvedSlugs.size) console.log(`  unresolved slugs: ${[...unresolvedSlugs].sort().join(', ')}`);
	const result = summary(stats.added, stats.attached, stats.skippedConfidence, stats.unresolved);
	result.applied += sourceStats.applied;
	result.noop += sourceStats.noop;
	result.candidate += sourceStats.candidate;
	result.conflict += sourceStats.conflict;
	result.other += sourceStats.other;
	result.detail = { ...result.detail, sourceObservations: sourceStats };
	return result;
}

function summary(added: number, attached: number, skipped: number, unresolved: number): ImporterSummary {
	return {
		feed: 'extracted-cites',
		applied: added,
		noop: attached,
		candidate: skipped,
		conflict: 0,
		drifted: 0,
		other: unresolved,
		detail: { added, attached, skippedConfidence: skipped, unresolved }
	};
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	run(db, opts)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('\n✗ import:extracted-cites failed:', err);
			process.exit(1);
		});
}

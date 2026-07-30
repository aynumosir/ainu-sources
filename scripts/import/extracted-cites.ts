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
 * Input : JSON files below scripts/data/extracted-cites/ (schema 'extracted-cites/v1').
 *         Each file carries a citingWork, the parsed references (each with a resolved
 *         `match` slug + confidence), and a `verified` flag.
 *           • verified: true  — a hand-checked list (e.g. the Tajima transcription).
 *             Missing cited works are CREATED as bibliographic records; every edge is
 *             `accepted` (the citation itself is certain even where the matched record
 *             identity is not). A reference marked `ainuRelated: false` is the author's
 *             general-linguistics reading; it is skipped, keeping the catalogue to Ainu
 *             scholarship and PageRank to the works Ainu studies cites among itself.
 *           • verified: false — an automated sweep (scripts/sweep-references.ts). Edges
 *             are drawn ONLY to sources that already exist; nothing is created from the
 *             noisy OCR. A strong match (`probable`) is `accepted`; a weak one
 *             (`candidate`) is written as a `candidate` edge for review.
 * Resolve: slug → source id over ACTIVE sources, with a slug_redirects fallback so an
 *          edge written against a retired slug still lands on the current source.
 * Upsert : existence-checked on (from, to, 'cites') — never a delete, never a wipe. A
 *          re-run over an unchanged file inserts zero rows. Direction is deterministic
 *          (citing → cited), so an exact check re-attaches the existing row.
 * Status : 'accepted' or 'candidate' per the rule above, origin 'extracted-cites',
 *          derivation 'reference-extraction'. Only 'accepted' 'cites' edges feed the
 *          public network / PageRank significance.
 * Reconcile: the datasets are the whole truth for `origin='extracted-cites'`, so a run
 *          is a full replacement of what this feed asserts. An edge it no longer
 *          asserts is withdrawn (status 'removed', never deleted), and one it now
 *          asserts more weakly is demoted from 'accepted' to 'candidate'. Without
 *          this, a matcher correction could add edges but never take one back, so a
 *          false citation stayed public once written. Edges from other producers
 *          (the OpenAlex tail carries no origin) are never touched.
 *          One known limit: a single row holds one origin, so an edge that both this
 *          feed and OpenAlex assert is withdrawn when only this feed drops it.
 *          Distinguishing that needs per-producer observations rather than one row.
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run]
 *        [--allow-mass-withdrawal] to proceed when a run would withdraw most of the
 *        feed, which otherwise aborts — an empty or half-populated data directory
 *        would silently erase the citation network.
 *
 * Run:  DATABASE_URL=file:/tmp/clone.db bun run import:extracted-cites --dry-run
 *       DATABASE_URL=file:/tmp/clone.db bun run import:extracted-cites
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
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

const DATA_DIR = fileURLToPath(new URL('../data/extracted-cites', import.meta.url));
const ORIGIN = 'extracted-cites';
const DERIVATION = 'reference-extraction';
const uuid = () => crypto.randomUUID();

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
	verified?: boolean;
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
}

/** Read every JSON dataset below extracted-cites/, tagged with its relative path. */
function readFiles(dataDir: string = DATA_DIR): { file: string; data: ExtractedFile }[] {
	if (!fs.existsSync(dataDir)) return [];
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.name.endsWith('.json')) files.push(full);
		}
	};
	visit(dataDir);
	return files
		.sort()
		.map((full) => ({
			file: path.relative(dataDir, full),
			data: JSON.parse(fs.readFileSync(full, 'utf8')) as ExtractedFile
		}));
}

async function findRelation(
	db: Db,
	fromId: string,
	toId: string
): Promise<{ id: string; status: string | null } | undefined> {
	const [hit] = await db
		.select({ id: sourceRelations.id, status: sourceRelations.status })
		.from(sourceRelations)
		.where(
			and(
				eq(sourceRelations.fromSourceId, fromId),
				eq(sourceRelations.toSourceId, toId),
				eq(sourceRelations.type, 'cites')
			)
		)
		.limit(1);
	return hit;
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

function resolvedReferenceSlug(ref: ExtractedReference, verified: boolean): string {
	const confidence = ref.match?.confidence;
	if (ref.match?.slug && (confidence === 'exact' || confidence === 'probable' || !verified)) {
		return ref.match.slug;
	}
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
	verified: boolean,
	runId: string | null,
	stats: StatusTally,
	dryRun: boolean
): Promise<string | undefined> {
	const work = data.citingWork;
	if (!work?.slug) return undefined;
	const existing = await findSourceId(db, work.slug);
	if (existing || dryRun || !verified) return existing;
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
	verified: boolean,
	runId: string | null,
	stats: StatusTally,
	dryRun: boolean
): Promise<string | undefined> {
	const slug = resolvedReferenceSlug(ref, verified);
	const existing = await findSourceId(db, slug);
	if (existing || dryRun || !verified) return existing;
	// A hand-checked bibliography lists the general-linguistics literature its author
	// drew on alongside the Ainu works. `ainuRelated: false` marks the former; this
	// catalogue holds Ainu scholarship, so those references are read but never minted
	// as records, and the edge to them is left undrawn.
	//
	// Only a hand-checked file carries that judgement. The test names `verified`
	// rather than relying on the early return above to have filtered the swept files,
	// so promoting one of them to `verified: true` cannot silently discard its
	// references on the strength of a field no human set.
	if (verified && ref.ainuRelated === false) return undefined;
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

/** Status of an edge this feed no longer asserts. Removal is a status, never a delete. */
const WITHDRAWN_STATUS = 'removed';
/**
 * Abort rather than withdraw more than this share of the feed's live edges. A run over
 * an empty or half-copied data directory looks exactly like "every citation retracted",
 * and that must not be a silent outcome.
 */
const MASS_WITHDRAWAL_SHARE = 0.34;

interface Reconciliation {
	withdrawn: number;
	demoted: number;
	aborted: boolean;
}

/**
 * Bring the feed's live edges into line with what the datasets assert: withdraw the
 * ones they have stopped asserting, and demote the ones they now assert only as
 * candidates. `asserted` maps `fromId\ttoId` to the status this run wants.
 */
async function reconcile(
	db: Db,
	asserted: Map<string, string>,
	dryRun: boolean,
	allowMassWithdrawal: boolean
): Promise<Reconciliation> {
	const live = await db
		.select({
			id: sourceRelations.id,
			fromSourceId: sourceRelations.fromSourceId,
			toSourceId: sourceRelations.toSourceId,
			status: sourceRelations.status
		})
		.from(sourceRelations)
		.where(
			and(
				eq(sourceRelations.type, 'cites'),
				eq(sourceRelations.origin, ORIGIN),
				inArray(sourceRelations.status, [PUBLIC_RELATION_STATUS, 'candidate'])
			)
		);

	const stale: string[] = [];
	const demote: string[] = [];
	for (const relation of live) {
		const want = asserted.get(`${relation.fromSourceId}\t${relation.toSourceId}`);
		if (want === undefined) stale.push(relation.id);
		else if (want === 'candidate' && relation.status === PUBLIC_RELATION_STATUS) demote.push(relation.id);
	}

	if (
		live.length > 0 &&
		stale.length / live.length > MASS_WITHDRAWAL_SHARE &&
		!allowMassWithdrawal
	) {
		console.warn(
			`  ! refusing to withdraw ${stale.length} of ${live.length} ${ORIGIN} edges` +
				` (over ${Math.round(MASS_WITHDRAWAL_SHARE * 100)}%). Check that the dataset` +
				` directory is complete, then re-run with --allow-mass-withdrawal.`
		);
		return { withdrawn: 0, demoted: 0, aborted: true };
	}

	if (!dryRun) {
		for (const batch of chunk(stale, 200)) {
			await db
				.update(sourceRelations)
				.set({ status: WITHDRAWN_STATUS })
				.where(inArray(sourceRelations.id, batch));
		}
		for (const batch of chunk(demote, 200)) {
			await db
				.update(sourceRelations)
				.set({ status: 'candidate', confidence: 0.6 })
				.where(inArray(sourceRelations.id, batch));
		}
	}
	return { withdrawn: stale.length, demoted: demote.length, aborted: false };
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

export async function run(
	db: Db,
	opts: ImporterRunOptions & { dataDir?: string; allowMassWithdrawal?: boolean } = {}
): Promise<ImporterSummary> {
	const DRY_RUN = opts.dryRun ?? false;
	const dataDir = opts.dataDir ?? DATA_DIR;
	console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}import:extracted-cites`);

	const files = readFiles(dataDir);
	if (files.length === 0) {
		console.warn(`  ! no files in ${dataDir}`);
		return summary(0, 0, 0, 0);
	}

	const stats = { attached: 0, added: 0, skippedConfidence: 0, unresolved: 0 };
	const sourceStats: StatusTally = { applied: 0, noop: 0, candidate: 0, conflict: 0, other: 0 };
	const unresolvedSlugs = new Set<string>();
	// Every edge these datasets assert, and how strongly. Reconciliation below reads it
	// as the complete statement of what this feed currently claims.
	const asserted = new Map<string, string>();

	const runId = DRY_RUN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-extracted-cites@1' });

	for (const { file, data } of files) {
		if (data.schema !== 'extracted-cites/v1') throw new Error(`${file}: unsupported schema ${data.schema}`);
		const verified = data.verified === true;
		const citingSlug = data.citingWork?.slug;
		if (!citingSlug) throw new Error(`${file}: citingWork.slug is required`);
		const fromId = await ensureCitingWork(db, file, data, verified, runId, sourceStats, DRY_RUN);
		for (const ref of data.references ?? []) {
			const targetSlug = resolvedReferenceSlug(ref, verified);
			const toId = await ensureReference(db, file, citingSlug, ref, verified, runId, sourceStats, DRY_RUN);
			if (!fromId || !toId) {
				stats.unresolved += 1;
				if (!fromId) unresolvedSlugs.add(citingSlug);
				if (!toId) unresolvedSlugs.add(targetSlug);
				continue;
			}
			if (fromId === toId) continue;
			const desiredStatus =
				verified || ref.match?.confidence === 'exact' || ref.match?.confidence === 'probable'
					? PUBLIC_RELATION_STATUS
					: 'candidate';
			const desiredConfidence =
				verified || ref.match?.confidence === 'exact'
					? 1
					: ref.match?.confidence === 'probable'
						? 0.85
						: 0.6;
			// The strongest assertion wins when a bibliography lists a work twice.
			const key = `${fromId}\t${toId}`;
			if (asserted.get(key) !== PUBLIC_RELATION_STATUS) asserted.set(key, desiredStatus);
			const existingRelation = await findRelation(db, fromId, toId);
			if (existingRelation) {
				if (!DRY_RUN && desiredStatus === PUBLIC_RELATION_STATUS && existingRelation.status !== desiredStatus) {
					await db
						.update(sourceRelations)
						.set({ status: desiredStatus, confidence: desiredConfidence })
						.where(eq(sourceRelations.id, existingRelation.id));
				}
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
					status: desiredStatus,
					origin: ORIGIN,
					derivation: DERIVATION,
					observationId: null,
					evidence: null,
					confidence: desiredConfidence
				});
			stats.added += 1;
		}
	}

	const reconciliation = await reconcile(
		db,
		asserted,
		DRY_RUN,
		opts.allowMassWithdrawal ?? false
	);

	if (runId)
		await closeRun(db, runId, {
			status: reconciliation.aborted ? 'partial' : 'completed',
			summary: { ...stats, files: files.length, ...reconciliation }
		});

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: ${files.length} file(s) → +${stats.added} added / ${stats.attached} attached` +
			` / ${reconciliation.withdrawn} withdrawn / ${reconciliation.demoted} demoted` +
			` (${stats.skippedConfidence} below confidence, ${stats.unresolved} unresolved endpoints)`
	);
	if (unresolvedSlugs.size) console.log(`  unresolved slugs: ${[...unresolvedSlugs].sort().join(', ')}`);
	const result = summary(stats.added, stats.attached, stats.skippedConfidence, stats.unresolved);
	result.applied += sourceStats.applied;
	result.noop += sourceStats.noop;
	result.candidate += sourceStats.candidate;
	result.conflict += sourceStats.conflict;
	result.other += sourceStats.other;
	result.detail = {
		...result.detail,
		sourceObservations: sourceStats,
		withdrawn: reconciliation.withdrawn,
		demoted: reconciliation.demoted,
		withdrawalBlocked: reconciliation.aborted
	};
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
	run(db, { ...opts, allowMassWithdrawal: process.argv.includes('--allow-mass-withdrawal') })
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('\n✗ import:extracted-cites failed:', err);
			process.exit(1);
		});
}

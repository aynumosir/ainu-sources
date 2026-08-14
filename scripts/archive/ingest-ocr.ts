#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
	archiveRepositories,
	fileCheckouts,
	fileRevisions,
	ocrIngestState,
	revisionOcrCoverage,
	sourceFiles
} from '../../src/lib/server/db/schema';
import { activateOcrGeneration, type OcrPageInput } from '../../src/lib/server/archive/ocr';
import { refreshSourceTextComposition } from '../../src/lib/server/archive/language-composition';
import {
	assessTextQuality,
	sampleVariantPages,
	type SamplingDb
} from '../../src/lib/server/archive/text-quality';
import { pickPreferredVariant } from '../../src/lib/archive/ocr';
import { parseImporterCli, type ImporterRunOptions } from '../import/lib/run';
import type { Db } from '../import/lib/entities';

const SCRIPT_DIR = (import.meta as ImportMeta & { dir?: string }).dir ?? path.dirname(fileURLToPath(import.meta.url));
const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(SCRIPT_DIR, '../../..');

export interface IngestOcrOptions extends ImporterRunOptions {
	ainuRoot: string;
	now?: Date;
}

export interface IngestOcrSummary {
	ingested: number;
	unchanged: number;
	scansWithoutText: number;
	conflicts: number;
}

type Checkout = { revisionId: string; sourceId: string; repo: string; path: string };

/**
 * Read every text file committed beside a scan into the archive's searchable text.
 *
 * A scan is checked out at `<repository>/<path>`, and its text sits next to it
 * under the same name with the variant in place of the extension: `source.pdf`
 * is read by `source.gemini.txt`. The checkout is the key, so a repository is
 * free to name its files whatever suits it — the dozen works whose scan is
 * called `source.pdf` stay distinct — and a file checked out by several
 * repositories is read from whichever of them carries the text.
 */
export async function ingestOcr(db: Db, opts: IngestOcrOptions): Promise<IngestOcrSummary> {
	const checkouts = await currentCheckouts(db);
	const summary: IngestOcrSummary = {
		ingested: 0,
		unchanged: 0,
		scansWithoutText: 0,
		conflicts: 0
	};

	// One text file per (revision, variant): a scan checked out by two
	// repositories can carry a text file in each, and taking both would leave
	// successive runs alternating between two texts for one variant.
	const chosen = new Map<string, { checkout: Checkout; filePath: string; variant: string }>();
	const revisionsWithText = new Set<string>();
	for (const checkout of checkouts) {
		for (const file of await siblingTextFiles(opts.ainuRoot, checkout)) {
			if (chosen.size >= (opts.limit ?? Infinity)) break;
			const key = `${checkout.revisionId}:${file.variant}`;
			const existing = chosen.get(key);
			if (existing) {
				console.warn(
					`skip conflict ${checkout.repo}/${file.path} — ${existing.checkout.repo}/${existing.filePath} already carries variant ${file.variant} for this scan`
				);
				summary.conflicts += 1;
				continue;
			}
			chosen.set(key, { checkout, filePath: file.path, variant: file.variant });
			revisionsWithText.add(checkout.revisionId);
		}
	}
	summary.scansWithoutText = new Set(
		checkouts.filter((row) => !revisionsWithText.has(row.revisionId)).map((row) => row.revisionId)
	).size;

	for (const { checkout, filePath, variant } of chosen.values()) {
		const revisionId = checkout.revisionId;
		const bytes = await fs.readFile(path.join(opts.ainuRoot, checkout.repo, filePath));
		const contentHash = createHash('sha256').update(bytes).digest('hex');
		const [state] = await db
			.select({ contentHash: ocrIngestState.contentHash })
			.from(ocrIngestState)
			.where(and(eq(ocrIngestState.revisionId, revisionId), eq(ocrIngestState.variant, variant)))
			.limit(1);
		if (state?.contentHash === contentHash) {
			summary.unchanged += 1;
			continue;
		}

		const pages = parseOcrPages(bytes.toString('utf8'));
		if (!opts.dryRun) {
			const now = opts.now ?? new Date();
			await db.transaction(async (tx) => {
				await activateOcrGeneration(tx as unknown as Db, revisionId, variant, pages, {
					contentHash,
					ingestedAt: now
				});
				const [coverage] = await tx
					.select({ preferred: revisionOcrCoverage.preferred })
					.from(revisionOcrCoverage)
					.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, variant)))
					.limit(1);
				if (coverage) {
					await tx
						.update(revisionOcrCoverage)
						.set({
							status: 'complete',
							tool: variant,
							toolVersion: null,
							measuredAt: now
						})
						.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, variant)));
				} else {
					await tx.insert(revisionOcrCoverage).values({
						revisionId: revisionId,
						variant: variant,
						status: 'complete',
						tool: variant,
						toolVersion: null,
						measuredAt: now
					});
				}

				const samples = await sampleVariantPages(tx as unknown as SamplingDb, revisionId, variant);
				const verdict = assessTextQuality(samples);
				if (verdict.reliability === 'suspect') {
					// Sound is human-certified; the automated assessor does not downgrade it.
					await tx
						.update(revisionOcrCoverage)
						.set({ reliability: 'suspect', reliabilityNote: verdict.note })
						.where(
							and(
								eq(revisionOcrCoverage.revisionId, revisionId),
								eq(revisionOcrCoverage.variant, variant),
								ne(revisionOcrCoverage.reliability, 'sound')
							)
						);
				} else {
					// Clear a stale suspect verdict; sound and unassessed rows stay as they are.
					await tx
						.update(revisionOcrCoverage)
						.set({ reliability: 'unassessed', reliabilityNote: null })
						.where(
							and(
								eq(revisionOcrCoverage.revisionId, revisionId),
								eq(revisionOcrCoverage.variant, variant),
								eq(revisionOcrCoverage.reliability, 'suspect')
							)
						);
				}

				const coverageRows = await tx
					.select({
						variant: revisionOcrCoverage.variant,
						reliability: revisionOcrCoverage.reliability,
						preferred: revisionOcrCoverage.preferred
					})
					.from(revisionOcrCoverage)
					.where(eq(revisionOcrCoverage.revisionId, revisionId))
					.orderBy(sql`rowid`);
				const pick = pickPreferredVariant(
					coverageRows.map((row) => ({
						variant: row.variant,
						reliability: row.reliability as 'unassessed' | 'sound' | 'suspect'
					})),
					coverageRows.find((row) => row.preferred)?.variant ?? null
				);
				if (pick) {
					await tx
						.update(revisionOcrCoverage)
						.set({ preferred: false })
						.where(and(eq(revisionOcrCoverage.revisionId, revisionId), ne(revisionOcrCoverage.variant, pick)));
					await tx
						.update(revisionOcrCoverage)
						.set({ preferred: true })
						.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.variant, pick)));
				}

				// Inside the transaction, so a crash never records the file's
				// content hash while leaving the work's stored composition
				// stale — the unchanged-file branch would then skip it forever.
				await refreshSourceTextComposition(tx as unknown as Db, checkout.sourceId, opts.now ?? new Date());
			});
		}
		summary.ingested += 1;
	}

	return summary;
}

/**
 * The variant a text file beside a scan carries, or null if it names something
 * else. Read against the scan's own name rather than by splitting on dots:
 * engines are named after model versions — `gpt-5.4`, `gemini-3.1` — and a rule
 * that took the last dotted segment read those as the variant `4`, leaving the
 * transcription on disk and the work with no text at all.
 */
export function variantOfSiblingText(filename: string, stem: string): string | null {
	const prefix = `${stem}.`;
	if (!filename.startsWith(prefix) || !filename.endsWith('.txt')) return null;
	const variant = filename.slice(prefix.length, -'.txt'.length);
	if (!variant) return null;
	// Human variants are database-owned. Ingestion skips these reserved names so publication artifacts stay outside machine inputs.
	if (['edited', 'manual', 'approved'].includes(variant)) return null;
	return variant;
}

export function parseOcrPages(text: string): OcrPageInput[] {
	const marker = /^--- page (\d+) ---$/gmu;
	const matches = [...text.matchAll(marker)];
	if (matches.length === 0) return [{ page: 0, text }];
	return matches.map((match, index) => {
		const next = matches[index + 1];
		const start = (match.index ?? 0) + match[0].length;
		const end = next?.index ?? text.length;
		return { page: Number(match[1]), text: text.slice(start, end).replace(/^\r?\n/u, '').trimEnd() };
	});
}

/** Text files sitting beside the scan, named after it, one per variant. */
async function siblingTextFiles(
	ainuRoot: string,
	checkout: Checkout
): Promise<Array<{ path: string; variant: string }>> {
	const dir = path.dirname(checkout.path);
	const scanName = path.basename(checkout.path);
	const stem = scanName.slice(0, scanName.length - path.extname(scanName).length);
	let entries: string[];
	try {
		entries = await fs.readdir(path.join(ainuRoot, checkout.repo, dir));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw e;
	}
	const out: Array<{ path: string; variant: string }> = [];
	for (const entry of entries.sort()) {
		const variant = variantOfSiblingText(entry, stem);
		if (!variant) continue;
		out.push({ path: path.join(dir, entry), variant });
	}
	return out;
}

/** Every checkout of every current scan revision, in a stable order. */
async function currentCheckouts(db: Db): Promise<Checkout[]> {
	const rows = await db
		.select({
			revisionId: fileRevisions.id,
			sourceId: sourceFiles.sourceId,
			repo: archiveRepositories.name,
			path: fileCheckouts.path
		})
		.from(fileCheckouts)
		.innerJoin(sourceFiles, eq(fileCheckouts.sourceFileId, sourceFiles.id))
		.innerJoin(archiveRepositories, eq(fileCheckouts.repoId, archiveRepositories.id))
		.innerJoin(fileRevisions, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.where(eq(fileRevisions.isCurrent, true));
	return rows.sort((left, right) =>
		`${left.repo}/${left.path}`.localeCompare(`${right.repo}/${right.path}`)
	);
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	ingestOcr(db, { ainuRoot: AINU_ROOT, ...opts })
		.then((summary) => {
			console.log(
				`archive:ingest-ocr ingested=${summary.ingested} unchanged=${summary.unchanged} scans-without-text=${summary.scansWithoutText} conflicts=${summary.conflicts}`
			);
		})
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}

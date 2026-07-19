#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
	fileRevisions,
	ocrIngestState,
	revisionOcrCoverage,
	sourceFiles
} from '../../src/lib/server/db/schema';
import { replaceOcrPages, type OcrPageInput } from '../../src/lib/server/archive/ocr';
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
	skippedNoMatch: number;
	skippedNoRevision: number;
}

type SourceFileRow = { id: string; checkoutPath: string };
type CurrentRevisionRow = { id: string; sourceFileId: string };

export async function ingestOcr(db: Db, opts: IngestOcrOptions): Promise<IngestOcrSummary> {
	const grammarDir = path.join(opts.ainuRoot, 'ainu-grammar');
	const files = await collectOcrFiles(grammarDir, opts.limit ?? Infinity);
	const fileByStem = await sourceFilesByCheckoutStem(db);
	const currentRevisionByFileId = await currentRevisionsByFileId(db);
	const summary: IngestOcrSummary = {
		ingested: 0,
		unchanged: 0,
		skippedNoMatch: 0,
		skippedNoRevision: 0
	};

	for (const filePath of files) {
		const parsed = parseOcrFilename(path.basename(filePath));
		if (!parsed) continue;
		const sourceFile = fileByStem.get(parsed.stem);
		if (!sourceFile) {
			console.warn(`skip no-match ${path.relative(grammarDir, filePath)}`);
			summary.skippedNoMatch += 1;
			continue;
		}
		const revision = currentRevisionByFileId.get(sourceFile.id);
		if (!revision) {
			console.warn(`skip no-revision ${path.relative(grammarDir, filePath)}`);
			summary.skippedNoRevision += 1;
			continue;
		}

		const bytes = await fs.readFile(filePath);
		const contentHash = createHash('sha256').update(bytes).digest('hex');
		const [state] = await db
			.select({ contentHash: ocrIngestState.contentHash })
			.from(ocrIngestState)
			.where(and(eq(ocrIngestState.revisionId, revision.id), eq(ocrIngestState.variant, parsed.variant)))
			.limit(1);
		if (state?.contentHash === contentHash) {
			summary.unchanged += 1;
			continue;
		}

		const pages = parseOcrPages(bytes.toString('utf8'));
		if (!opts.dryRun) {
			const now = opts.now ?? new Date();
			await db.transaction(async (tx) => {
				const [preferred] = await tx
					.select({ revisionId: revisionOcrCoverage.revisionId })
					.from(revisionOcrCoverage)
					.where(and(eq(revisionOcrCoverage.revisionId, revision.id), eq(revisionOcrCoverage.preferred, true)))
					.limit(1);
				const shouldPrefer = !preferred;
				await replaceOcrPages(tx as unknown as Db, revision.id, parsed.variant, pages);
				await tx
					.insert(ocrIngestState)
					.values({
						revisionId: revision.id,
						variant: parsed.variant,
						contentHash,
						pageCount: pages.length,
						ingestedAt: now
					})
					.onConflictDoUpdate({
						target: [ocrIngestState.revisionId, ocrIngestState.variant],
						set: { contentHash, pageCount: pages.length, ingestedAt: now }
					});
				const [coverage] = await tx
					.select({ preferred: revisionOcrCoverage.preferred })
					.from(revisionOcrCoverage)
					.where(and(eq(revisionOcrCoverage.revisionId, revision.id), eq(revisionOcrCoverage.variant, parsed.variant)))
					.limit(1);
				if (coverage) {
					await tx
						.update(revisionOcrCoverage)
						.set({
							status: 'complete',
							tool: parsed.variant,
							toolVersion: null,
							measuredAt: now,
							...(shouldPrefer ? { preferred: true } : {})
						})
						.where(and(eq(revisionOcrCoverage.revisionId, revision.id), eq(revisionOcrCoverage.variant, parsed.variant)));
				} else {
					await tx.insert(revisionOcrCoverage).values({
						revisionId: revision.id,
						variant: parsed.variant,
						status: 'complete',
						tool: parsed.variant,
						toolVersion: null,
						preferred: shouldPrefer,
						measuredAt: now
					});
				}
			});
		}
		summary.ingested += 1;
	}

	return summary;
}

export function parseOcrFilename(filename: string): { stem: string; variant: string } | null {
	const match = /^(.+)\.([^.]+)\.txt$/u.exec(filename);
	if (!match) return null;
	// Human variants are database-owned. Ingestion skips these reserved names so publication artifacts stay outside machine inputs.
	if (['edited', 'manual', 'approved'].includes(match[2])) return null;
	return { stem: match[1], variant: match[2] };
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

async function collectOcrFiles(grammarDir: string, limit: number): Promise<string[]> {
	const out: string[] = [];
	for (const subdir of ['books', 'articles']) {
		const dir = path.join(grammarDir, subdir, 'ocr');
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw e;
		}
		for (const entry of entries) {
			if (!entry.endsWith('.txt')) continue;
			out.push(path.join(dir, entry));
			if (out.length >= limit) return out;
		}
	}
	return out;
}

async function sourceFilesByCheckoutStem(db: Db): Promise<Map<string, SourceFileRow>> {
	const rows = await db
		.select({ id: sourceFiles.id, checkoutPath: sourceFiles.checkoutPath })
		.from(sourceFiles)
		.where(isNotNull(sourceFiles.checkoutPath));
	const out = new Map<string, SourceFileRow>();
	for (const row of rows) {
		if (!row.checkoutPath) continue;
		out.set(stemFromCheckoutPath(row.checkoutPath), { id: row.id, checkoutPath: row.checkoutPath });
	}
	return out;
}

async function currentRevisionsByFileId(db: Db): Promise<Map<string, CurrentRevisionRow>> {
	const rows = await db
		.select({ id: fileRevisions.id, sourceFileId: fileRevisions.sourceFileId })
		.from(fileRevisions)
		.where(eq(fileRevisions.isCurrent, true));
	return new Map(rows.map((row) => [row.sourceFileId, row]));
}

function stemFromCheckoutPath(checkoutPath: string): string {
	const base = path.basename(checkoutPath);
	return base.slice(0, base.length - path.extname(base).length);
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	ingestOcr(db, { ainuRoot: AINU_ROOT, ...opts })
		.then((summary) => {
			console.log(
				`archive:ingest-ocr ingested=${summary.ingested} unchanged=${summary.unchanged} skipped-no-match=${summary.skippedNoMatch} skipped-no-revision=${summary.skippedNoRevision}`
			);
		})
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}

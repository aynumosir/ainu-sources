import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
	fileRevisions,
	ocrPageEdits,
	ocrPageState,
	sourceFiles,
	sources
} from '../../src/lib/server/db/schema';
import type { Db } from '../import/lib/entities';

export const APPROVED_SNAPSHOT_EXPORTER_VERSION = 'ocr-page-snapshot/1';
export const APPROVED_SNAPSHOT_SUFFIX = '.approved.snapshot.json';

type SnapshotPage = { page: number; edit_id: string; checksum: string };

export type ApprovedSnapshotManifest = {
	schema: 1;
	publication_snapshot: string;
	exporter_version: string;
	exported_at: string;
	revision_id: string;
	revision_no: number;
	file_id: string;
	source_slug: string;
	text_path: string;
	artifact_checksum: string;
	resulting_commit: string | null;
	pages: SnapshotPage[];
};

function checksum(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function snapshotId(value: unknown): string {
	return `ocr_${checksum(JSON.stringify(value)).slice(0, 24)}`;
}

function renderApprovedText(pages: Array<{ page: number; text: string }>): string {
	return pages.map((row) => `--- page ${row.page} ---\n${row.text}`).join('\n') + (pages.length ? '\n' : '');
}

function artifactPaths(outputRoot: string, checkoutPath: string) {
	const normalizedCheckout = checkoutPath.replaceAll('\\', '/');
	const directory = path.posix.dirname(normalizedCheckout);
	const basename = path.posix.basename(normalizedCheckout);
	const stem = basename.slice(0, basename.length - path.posix.extname(basename).length);
	const relativeTextPath = path.posix.join(directory, 'ocr', `${stem}.approved.txt`);
	const relativeManifestPath = path.posix.join(directory, 'ocr', `${stem}${APPROVED_SNAPSHOT_SUFFIX}`);
	const root = path.resolve(outputRoot);
	const textPath = path.resolve(root, relativeTextPath);
	const manifestPath = path.resolve(root, relativeManifestPath);
	for (const candidate of [textPath, manifestPath]) {
		if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('snapshot path escapes output root');
	}
	return { relativeTextPath, relativeManifestPath, textPath, manifestPath };
}

export async function exportApprovedSnapshot(
	db: Db,
	revisionId: string,
	outputRoot: string,
	opts: { now?: Date; resultingCommit?: string | null } = {}
): Promise<{ manifest: ApprovedSnapshotManifest; textPath: string; manifestPath: string }> {
	const [revision] = await db
		.select({
			revisionId: fileRevisions.id,
			revisionNo: fileRevisions.revisionNo,
			fileId: sourceFiles.id,
			checkoutPath: sourceFiles.checkoutPath,
			sourceSlug: sources.slug
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.where(eq(fileRevisions.id, revisionId))
		.limit(1);
	if (!revision) throw new Error(`revision ${revisionId} was not found`);
	if (!revision.checkoutPath) throw new Error(`revision ${revisionId} has no repository checkout path`);
	const pages = await db
		.select({ page: ocrPageState.page, editId: ocrPageEdits.editId, text: ocrPageEdits.text })
		.from(ocrPageState)
		.innerJoin(ocrPageEdits, eq(ocrPageState.currentEditId, ocrPageEdits.editId))
		.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.status, 'approved')))
		.orderBy(ocrPageState.page);
	if (pages.length === 0) throw new Error(`revision ${revisionId} has no approved page text`);
	const body = renderApprovedText(pages);
	const pinnedPages = pages.map((row) => ({ page: row.page, edit_id: row.editId, checksum: checksum(row.text) }));
	const publicationSnapshot = snapshotId({
		exporter_version: APPROVED_SNAPSHOT_EXPORTER_VERSION,
		revision_id: revision.revisionId,
		pages: pinnedPages
	});
	const paths = artifactPaths(outputRoot, revision.checkoutPath);
	const manifest: ApprovedSnapshotManifest = {
		schema: 1,
		publication_snapshot: publicationSnapshot,
		exporter_version: APPROVED_SNAPSHOT_EXPORTER_VERSION,
		exported_at: (opts.now ?? new Date()).toISOString(),
		revision_id: revision.revisionId,
		revision_no: revision.revisionNo,
		file_id: revision.fileId,
		source_slug: revision.sourceSlug,
		text_path: paths.relativeTextPath,
		artifact_checksum: checksum(body),
		resulting_commit: opts.resultingCommit ?? null,
		pages: pinnedPages
	};
	await fs.mkdir(path.dirname(paths.textPath), { recursive: true });
	await fs.writeFile(paths.textPath, body, 'utf8');
	await fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
	return { manifest, textPath: paths.textPath, manifestPath: paths.manifestPath };
}

async function collectManifests(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(directory: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(fullPath);
			else if (entry.isFile() && entry.name.endsWith(APPROVED_SNAPSHOT_SUFFIX)) out.push(fullPath);
		}
	}
	await walk(path.resolve(root));
	return out.sort();
}

function parseManifest(value: unknown, manifestPath: string): ApprovedSnapshotManifest {
	const row = value as Partial<ApprovedSnapshotManifest> | null;
	if (
		!row ||
		row.schema !== 1 ||
		typeof row.publication_snapshot !== 'string' ||
		row.exporter_version !== APPROVED_SNAPSHOT_EXPORTER_VERSION ||
		typeof row.revision_id !== 'string' ||
		typeof row.text_path !== 'string' ||
		typeof row.artifact_checksum !== 'string' ||
		!Array.isArray(row.pages)
	) {
		throw new Error(`${manifestPath}: invalid approved snapshot manifest`);
	}
	return row as ApprovedSnapshotManifest;
}

export async function verifyApprovedSnapshots(
	db: Db,
	root: string
): Promise<{ manifests: number; pages: number }> {
	const manifestPaths = await collectManifests(root);
	let pageCount = 0;
	for (const manifestPath of manifestPaths) {
		const manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), manifestPath);
		const expectedSnapshot = snapshotId({
			exporter_version: manifest.exporter_version,
			revision_id: manifest.revision_id,
			pages: manifest.pages
		});
		if (manifest.publication_snapshot !== expectedSnapshot) throw new Error(`${manifestPath}: publication snapshot mismatch`);
		const textPath = path.resolve(root, manifest.text_path);
		const resolvedRoot = path.resolve(root);
		if (textPath !== resolvedRoot && !textPath.startsWith(`${resolvedRoot}${path.sep}`)) {
			throw new Error(`${manifestPath}: text path escapes snapshot root`);
		}
		const body = await fs.readFile(textPath, 'utf8');
		if (checksum(body) !== manifest.artifact_checksum) throw new Error(`${manifestPath}: text artifact checksum mismatch`);
		const current = await db
			.select({
				page: ocrPageState.page,
				status: ocrPageState.status,
				editId: ocrPageState.currentEditId,
				text: ocrPageEdits.text
			})
			.from(ocrPageState)
			.innerJoin(ocrPageEdits, eq(ocrPageState.currentEditId, ocrPageEdits.editId))
			.where(eq(ocrPageState.revisionId, manifest.revision_id));
		const byPage = new Map(current.map((row) => [row.page, row]));
		const artifactPages: Array<{ page: number; text: string }> = [];
		for (const page of manifest.pages) {
			const head = byPage.get(page.page);
			if (!head || head.status !== 'approved' || head.editId !== page.edit_id) {
				throw new Error(`${manifestPath}: page ${page.page} edit is no longer current and approved`);
			}
			if (checksum(head.text) !== page.checksum) throw new Error(`${manifestPath}: page ${page.page} checksum mismatch`);
			artifactPages.push({ page: page.page, text: head.text });
			pageCount += 1;
		}
		if (body !== renderApprovedText(artifactPages)) throw new Error(`${manifestPath}: text artifact content mismatch`);
	}
	return { manifests: manifestPaths.length, pages: pageCount };
}

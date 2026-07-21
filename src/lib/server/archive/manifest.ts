import { createHash } from 'node:crypto';
import { asc, and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import {
	archiveBlobs,
	archiveRepositories,
	fileRevisions,
	sourceFiles,
	sources
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';

type Db = LibSQLDatabase<typeof schema>;

type ManifestRow = {
	schema: 2;
	snapshot_id: string;
	path: string;
	source_slug: string;
	file_id: string;
	revision_id: string;
	role: string;
	sort_order: number;
	sha256: string;
	bytes: number;
	media_type: string;
	pages: number | null;
};

function utf8Compare(a: string, b: string): number {
	const enc = new TextEncoder();
	const aa = enc.encode(a);
	const bb = enc.encode(b);
	const len = Math.min(aa.length, bb.length);
	for (let i = 0; i < len; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
	return aa.length - bb.length;
}

function snapshotId(bodyWithoutSnapshot: string): string {
	const digest = createHash('sha256').update(bodyWithoutSnapshot).digest('hex').slice(0, 24);
	return `snap_${digest}`;
}

export async function renderManifest(db: Db, repoName?: string): Promise<{ body: string; etag: string }> {
	const clauses = [
		eq(fileRevisions.reviewStatus, 'approved'),
		eq(fileRevisions.isCurrent, true),
		eq(fileRevisions.accessState, 'available'),
		eq(archiveBlobs.storageState, 'verified')
	];
	if (repoName) clauses.push(eq(archiveRepositories.name, repoName));
	const rows = await db
		.select({
			path: sourceFiles.checkoutPath,
			sourceSlug: sources.slug,
			fileId: sourceFiles.id,
			revisionId: fileRevisions.id,
			role: sourceFiles.role,
			sortOrder: sourceFiles.sortOrder,
			sha256: fileRevisions.blobSha256,
			bytes: archiveBlobs.bytes,
			mediaType: archiveBlobs.detectedMediaType,
			pages: fileRevisions.pageCount
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.innerJoin(archiveRepositories, eq(sourceFiles.checkoutRepoId, archiveRepositories.id))
		.where(and(...clauses))
		.orderBy(asc(sourceFiles.checkoutPath));
	const base = rows
		.filter((r): r is typeof r & { path: string; sha256: string } => !!r.path && !!r.sha256)
		.sort((a, b) => utf8Compare(a.path, b.path))
		.map((r) => ({
			schema: 2,
			snapshot_id: '',
			path: r.path.replaceAll('\\', '/'),
			source_slug: r.sourceSlug,
			file_id: r.fileId,
			revision_id: r.revisionId,
			role: r.role,
			sort_order: r.sortOrder,
			sha256: r.sha256,
			bytes: r.bytes,
			media_type: r.mediaType,
			pages: r.pages
		}) satisfies ManifestRow);
	const id = snapshotId(base.map((r) => JSON.stringify(r)).join('\n'));
	const body = base.map((r) => JSON.stringify({ ...r, snapshot_id: id })).join('\n') + (base.length ? '\n' : '');
	return { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
}

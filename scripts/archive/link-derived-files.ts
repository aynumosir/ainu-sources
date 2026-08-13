#!/usr/bin/env bun
/**
 * Say what a derived file was derived from.
 *
 * Page images and linearized PDFs are produced on demand and live in R2 under
 * the revision they came from, so the revision that made them is never in
 * doubt. A derivative committed to a repository is different: Batchelor's
 * `bbox.xml` sits beside the scan as a file of the work, and nothing in the
 * catalogue says which scan revision it describes. A later revision of that
 * scan would leave it stale with no way to tell.
 *
 * This records the missing edge: every current revision of a `derivative` file
 * is linked to the current scan revision of the same work, and its artifact
 * kind is set from what it holds. The edge is what makes staleness a question
 * the data can answer.
 *
 * Connection: DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote), or --db/--token.
 * Writes nothing without --apply.
 */
import { sql } from 'drizzle-orm';
import { parseImporterCli } from '../import/lib/run';
import type { Db } from '../import/lib/entities';

type DerivedFile = {
	slug: string;
	fileId: string;
	revisionId: string;
	mediaType: string;
	artifactKind: string;
	filename: string;
	scanRevisionId: string | null;
};

export interface LinkSummary {
	derived: number;
	linked: number;
	kindsCorrected: number;
	withoutScan: number;
}

/** What a committed derivative holds, read from the file it is. */
export function artifactKindFor(filename: string, mediaType: string): string {
	if (/\.bbox\.xml$|^bbox\.xml$/iu.test(filename)) return 'bbox';
	if (mediaType === 'application/pdf') return 'linearized';
	return 'original';
}

export async function linkDerivedFiles(db: Db, opts: { apply: boolean }): Promise<LinkSummary> {
	const summary: LinkSummary = { derived: 0, linked: 0, kindsCorrected: 0, withoutScan: 0 };
	const files = (await db.all(sql`
		select
			s.slug as slug, sf.id as fileId, fr.id as revisionId, fr.declared_media_type as mediaType,
			fr.artifact_kind as artifactKind, fr.original_filename as filename,
			(
				select scan_rev.id from file_revisions scan_rev
				join source_files scan_file on scan_file.id = scan_rev.source_file_id
				where scan_file.source_id = sf.source_id and scan_file.role = 'scan' and scan_rev.is_current = 1
				limit 1
			) as scanRevisionId
		from source_files sf
		join sources s on s.id = sf.source_id
		join file_revisions fr on fr.source_file_id = sf.id and fr.is_current = 1
		where sf.role = 'derivative'
		order by s.slug
	`)) as unknown as DerivedFile[];

	for (const file of files) {
		summary.derived += 1;
		const kind = artifactKindFor(file.filename, file.mediaType);
		if (!file.scanRevisionId) {
			console.log(`${file.slug}: ${file.filename} — no current scan to derive from, left alone`);
			summary.withoutScan += 1;
			continue;
		}
		console.log(`${file.slug}: ${file.filename} (${kind}) ← scan revision ${file.scanRevisionId.slice(0, 8)}`);
		if (file.artifactKind !== kind) {
			summary.kindsCorrected += 1;
			if (opts.apply) {
				await db.run(sql`update file_revisions set artifact_kind = ${kind} where id = ${file.revisionId}`);
			}
		}
		summary.linked += 1;
		if (opts.apply) {
			await db.run(sql`
				insert into revision_derivations (derived_revision_id, parent_revision_id, relation, parameters_json)
				values (${file.revisionId}, ${file.scanRevisionId}, ${kind}, null)
				on conflict do nothing
			`);
		}
	}
	return summary;
}

if (import.meta.main) {
	const { db } = parseImporterCli();
	const apply = process.argv.includes('--apply');
	linkDerivedFiles(db, { apply })
		.then((summary) => {
			console.log(
				`\n${apply ? 'linked' : 'would link'}: derived=${summary.derived} linked=${summary.linked} ` +
					`artifact-kinds-corrected=${summary.kindsCorrected} without-scan=${summary.withoutScan}`
			);
			if (!apply) console.log('nothing written — pass --apply');
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}

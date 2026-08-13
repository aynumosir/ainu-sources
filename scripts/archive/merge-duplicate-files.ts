#!/usr/bin/env bun
/**
 * Merge files that describe the same thing.
 *
 * Before checkouts became rows of their own, a work materialized into two
 * repositories needed two `source_files` rows to hold two paths. Each of those
 * carried its own revision of identical bytes, and each was recognized
 * separately, so one book ended up with two texts, two folio maps, and two sets
 * of search hits that differ from one another.
 *
 * This collapses each such group onto the file whose text is richest, carries
 * over any page the other one alone recognized, moves the checkouts across, and
 * removes what is left. Chunks are deleted explicitly rather than by cascade so
 * the FTS triggers fire and the index follows.
 *
 * A group where either side carries human page edits is reported and left
 * alone: choosing between two hand-corrected texts is not a script's decision.
 *
 * The same scan can also sit under two catalogue records — a book and the
 * dataset extracted from it, each holding the whole PDF. Which record the scan
 * belongs to is a bibliographic judgement, so those are reported and left alone
 * until `--adopt <slug>` names the record that keeps it.
 *
 * Connection: DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote), or --db/--token.
 * Writes nothing without --apply.
 */
import { sql } from 'drizzle-orm';
import { refreshSourceTextComposition } from '../../src/lib/server/archive/language-composition';
import { parseImporterCli } from '../import/lib/run';
import type { Db } from '../import/lib/entities';

type FileRow = {
	fileId: string;
	sourceId: string;
	slug: string;
	role: string;
	label: string;
	revisionId: string | null;
	chunks: number;
	folios: number;
	edits: number;
};

type Group = { slug: string; sourceId: string; role: string; label: string; files: FileRow[] };

export interface MergeSummary {
	groups: number;
	merged: number;
	skipped: number;
	pagesCarriedOver: number;
	checkoutsMoved: number;
	filesRemoved: number;
	chunksRemoved: number;
}

export async function mergeDuplicateFiles(
	db: Db,
	opts: { apply: boolean; adopt?: string[] }
): Promise<MergeSummary> {
	const summary: MergeSummary = {
		groups: 0,
		merged: 0,
		skipped: 0,
		pagesCarriedOver: 0,
		checkoutsMoved: 0,
		filesRemoved: 0,
		chunksRemoved: 0
	};
	for (const group of [...(await findGroups(db)), ...(await findSharedBlobGroups(db, opts.adopt ?? []))]) {
		summary.groups += 1;
		const [keep, ...drop] = group.files;
		const header = `${group.slug} [${group.role}${group.label ? ` ${group.label}` : ''}]`;
		if (group.files.some((file) => file.edits > 0)) {
			console.log(`${header}: SKIPPED — human page edits present`);
			summary.skipped += 1;
			continue;
		}
		console.log(`${header}\n  keep ${keep.fileId} (${keep.chunks} chunks, ${keep.folios} folios)`);
		for (const loser of drop) {
			console.log(`  drop ${loser.fileId} (${loser.chunks} chunks, ${loser.folios} folios)`);
			const carried = await carryOverPages(db, keep, loser, opts.apply);
			summary.pagesCarriedOver += carried;
			if (carried) console.log(`    carried over ${carried} page(s) recognized only here`);
			const moved = await moveCheckouts(db, keep.fileId, loser.fileId, opts.apply);
			summary.checkoutsMoved += moved.moved;
			for (const path of moved.paths) console.log(`    checkout moved: ${path}`);
			for (const path of moved.collided) console.log(`    checkout dropped (repo already holds this file): ${path}`);
			if (opts.apply) {
				summary.chunksRemoved += await removeFile(db, loser);
				await refreshSourceTextComposition(db, loser.sourceId, new Date());
			} else {
				summary.chunksRemoved += loser.chunks;
			}
			summary.filesRemoved += 1;
		}
		if (opts.apply && keep.sourceId !== group.sourceId) {
			// The richest text sat under the record giving the scan up, so the file
			// itself moves to the record that keeps it.
			await db.run(sql`update source_files set source_id = ${group.sourceId} where id = ${keep.fileId}`);
		}
		if (opts.apply) await refreshSourceTextComposition(db, group.sourceId, new Date());
		summary.merged += 1;
	}
	return summary;
}

/**
 * One blob held as the current revision of files under different records. A
 * book and a dataset extracted from it are separate works, so nothing here can
 * decide which of them the scan belongs to — `--adopt <slug>` says.
 */
async function findSharedBlobGroups(db: Db, adopt: string[]): Promise<Group[]> {
	const rows = (await db.all(sql`
		select
			sf.id as fileId, sf.source_id as sourceId, s.slug as slug, sf.role as role,
			coalesce(sf.label, '') as label, fr.id as revisionId, fr.blob_sha256 as blob,
			(select count(*) from ocr_chunks oc where oc.revision_id = fr.id) as chunks,
			(select count(*) from revision_page_folios f where f.revision_id = fr.id) as folios,
			(select count(*) from ocr_page_edits e where e.revision_id = fr.id)
				+ (select count(*) from ocr_page_state st where st.revision_id = fr.id) as edits
		from source_files sf
		join sources s on s.id = sf.source_id
		join file_revisions fr on fr.source_file_id = sf.id and fr.is_current = 1
		where fr.blob_sha256 in (
			select fr2.blob_sha256 from file_revisions fr2
			join source_files sf2 on sf2.id = fr2.source_file_id
			where fr2.is_current = 1
			group by fr2.blob_sha256
			having count(distinct sf2.source_id) > 1
		)
		order by fr.blob_sha256, chunks desc, folios desc, sf.id asc
	`)) as unknown as Array<FileRow & { blob: string }>;
	const byBlob = new Map<string, Array<FileRow & { blob: string }>>();
	for (const row of rows) {
		const group = byBlob.get(row.blob) ?? [];
		group.push({ ...row, chunks: Number(row.chunks), folios: Number(row.folios), edits: Number(row.edits) });
		byBlob.set(row.blob, group);
	}
	const groups: Group[] = [];
	for (const [blob, files] of byBlob) {
		const held = files.map((file) => file.slug);
		const chosen = files.find((file) => adopt.includes(file.slug));
		if (!chosen) {
			console.log(
				`one scan under ${held.length} records: ${held.join(', ')} (blob ${blob.slice(0, 12)})\n` +
					`  left alone — name the record that keeps it with --adopt <slug>`
			);
			continue;
		}
		// The richest text still wins, as everywhere else here; adoption decides
		// which record it ends up under, and the file moves there if it has to.
		groups.push({
			slug: chosen.slug,
			sourceId: chosen.sourceId,
			role: chosen.role,
			label: chosen.label,
			files: [...files].sort((a, b) => b.chunks - a.chunks || b.folios - a.folios || (a.fileId < b.fileId ? -1 : 1))
		});
	}
	return groups;
}

async function findGroups(db: Db): Promise<Group[]> {
	const rows = (await db.all(sql`
		select
			sf.id as fileId, sf.source_id as sourceId, s.slug as slug, sf.role as role,
			coalesce(sf.label, '') as label, fr.id as revisionId,
			(select count(*) from ocr_chunks oc where oc.revision_id = fr.id) as chunks,
			(select count(*) from revision_page_folios f where f.revision_id = fr.id) as folios,
			(select count(*) from ocr_page_edits e where e.revision_id = fr.id)
				+ (select count(*) from ocr_page_state st where st.revision_id = fr.id) as edits
		from source_files sf
		join sources s on s.id = sf.source_id
		left join file_revisions fr on fr.source_file_id = sf.id and fr.is_current = 1
		where (sf.source_id, sf.role, coalesce(sf.label, '')) in (
			select source_id, role, coalesce(label, '') from source_files
			group by source_id, role, coalesce(label, '')
			having count(*) > 1
		)
		order by s.slug, sf.role, label, chunks desc, folios desc, sf.id asc
	`)) as unknown as FileRow[];
	const groups = new Map<string, Group>();
	for (const row of rows) {
		const key = `${row.sourceId}:${row.role}:${row.label}`;
		const group = groups.get(key) ?? {
			slug: row.slug,
			sourceId: row.sourceId,
			role: row.role,
			label: row.label,
			files: []
		};
		group.files.push({ ...row, chunks: Number(row.chunks), folios: Number(row.folios), edits: Number(row.edits) });
		groups.set(key, group);
	}
	return [...groups.values()];
}

/**
 * Pages the losing revision recognized and the surviving one did not. They are
 * written into the survivor's active generation for that variant, which is what
 * search reads, so the text stays reachable at the page it belongs to.
 */
async function carryOverPages(db: Db, keep: FileRow, loser: FileRow, apply: boolean): Promise<number> {
	if (!keep.revisionId || !loser.revisionId) return 0;
	const missing = (await db.all(sql`
		select distinct lose.variant as variant, lose.page as page
		from ocr_chunks lose
		where lose.revision_id = ${loser.revisionId}
		and not exists (
			select 1 from ocr_chunks kept
			where kept.revision_id = ${keep.revisionId}
			and kept.variant = lose.variant and kept.page = lose.page
		)
		order by lose.variant, lose.page
	`)) as unknown as Array<{ variant: string; page: number }>;
	if (!missing.length || !apply) return missing.length;
	for (const { variant, page } of missing) {
		const [state] = (await db.all(sql`
			select active_generation as generation from ocr_ingest_state
			where revision_id = ${keep.revisionId} and variant = ${variant}
		`)) as unknown as Array<{ generation: string }>;
		if (!state) {
			// The survivor never had this variant at all; the whole of it moves across.
			await db.run(sql`
				insert into ocr_ingest_state (revision_id, variant, content_hash, page_count, active_generation, ingested_at)
				select ${keep.revisionId}, variant, content_hash, page_count, active_generation, ingested_at
				from ocr_ingest_state where revision_id = ${loser.revisionId} and variant = ${variant}
			`);
			await db.run(sql`
				insert into revision_ocr_coverage (revision_id, variant, status, tool, tool_version, preferred, reliability, reliability_note, measured_at)
				select ${keep.revisionId}, variant, status, tool, tool_version, 0, reliability, reliability_note, measured_at
				from revision_ocr_coverage where revision_id = ${loser.revisionId} and variant = ${variant}
			`);
		}
		const generation =
			state?.generation ??
			((
				(await db.all(sql`
					select active_generation as generation from ocr_ingest_state
					where revision_id = ${keep.revisionId} and variant = ${variant}
				`)) as unknown as Array<{ generation: string }>
			)[0]?.generation ??
				null);
		if (!generation) throw new Error(`no active generation for ${keep.revisionId} ${variant}`);
		await db.run(sql`
			insert into ocr_chunks (
				chunk_id, revision_id, variant, page, block, text, text_norm,
				checksum, normalization_version, ingest_generation
			)
			select
				${generation} || ':' || page || ':' || block, ${keep.revisionId}, variant, page, block, text, text_norm,
				checksum, normalization_version, ${generation}
			from ocr_chunks
			where revision_id = ${loser.revisionId} and variant = ${variant} and page = ${page}
		`);
		await db.run(sql`
			update ocr_ingest_state
			set page_count = (
				select count(distinct page) from ocr_chunks
				where revision_id = ${keep.revisionId} and variant = ${variant} and ingest_generation = ${generation}
			)
			where revision_id = ${keep.revisionId} and variant = ${variant}
		`);
	}
	return missing.length;
}

async function moveCheckouts(
	db: Db,
	keepFileId: string,
	loserFileId: string,
	apply: boolean
): Promise<{ moved: number; paths: string[]; collided: string[] }> {
	const rows = (await db.all(sql`
		select c.id as id, c.path as path, c.repo_id as repoId,
			exists (
				select 1 from file_checkouts held
				where held.source_file_id = ${keepFileId} and held.repo_id = c.repo_id
			) as taken
		from file_checkouts c
		where c.source_file_id = ${loserFileId}
		order by c.path
	`)) as unknown as Array<{ id: string; path: string; repoId: string; taken: number }>;
	const paths: string[] = [];
	const collided: string[] = [];
	for (const row of rows) {
		if (Number(row.taken)) {
			collided.push(row.path);
			continue;
		}
		paths.push(row.path);
		if (apply) {
			await db.run(sql`update file_checkouts set source_file_id = ${keepFileId} where id = ${row.id}`);
		}
	}
	return { moved: paths.length, paths, collided };
}

/**
 * Chunks first and by hand: `ocr_chunks` rows removed by foreign-key cascade do
 * not fire the AFTER DELETE trigger that maintains the FTS index, which would
 * leave the index holding text whose rows are gone.
 */
async function removeFile(db: Db, file: FileRow): Promise<number> {
	const revisions = (await db.all(sql`
		select id from file_revisions where source_file_id = ${file.fileId}
	`)) as unknown as Array<{ id: string }>;
	let chunks = 0;
	for (const revision of revisions) {
		const [{ n }] = (await db.all(sql`
			select count(*) as n from ocr_chunks where revision_id = ${revision.id}
		`)) as unknown as Array<{ n: number }>;
		chunks += Number(n);
		await db.run(sql`delete from ocr_chunks where revision_id = ${revision.id}`);
		await db.run(sql`delete from revision_page_folios where revision_id = ${revision.id}`);
		await db.run(sql`delete from revision_ocr_coverage where revision_id = ${revision.id}`);
		await db.run(sql`delete from ocr_ingest_state where revision_id = ${revision.id}`);
		await db.run(sql`delete from file_revisions where id = ${revision.id}`);
	}
	await db.run(sql`delete from file_checkouts where source_file_id = ${file.fileId}`);
	await db.run(sql`delete from source_files where id = ${file.fileId}`);
	return chunks;
}

if (import.meta.main) {
	const { db } = parseImporterCli();
	const apply = process.argv.includes('--apply');
	const adopt = process.argv.flatMap((arg, i) =>
		arg === '--adopt' ? [process.argv[i + 1]] : arg.startsWith('--adopt=') ? [arg.slice('--adopt='.length)] : []
	).filter(Boolean);
	mergeDuplicateFiles(db, { apply, adopt })
		.then((summary) => {
			console.log(
				`\n${apply ? 'merged' : 'would merge'}: groups=${summary.groups} merged=${summary.merged} skipped=${summary.skipped} ` +
					`files-removed=${summary.filesRemoved} checkouts-moved=${summary.checkoutsMoved} ` +
					`pages-carried-over=${summary.pagesCarriedOver} chunks-removed=${summary.chunksRemoved}`
			);
			if (!apply) console.log('nothing written — pass --apply');
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}

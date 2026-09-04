#!/usr/bin/env bun
/**
 * Merge duplicate persons — two rows for one human being, minted from two
 * spellings (金澤/金沢, Latin/Japanese, given–family/family–given) before the
 * importer folded such variants.
 *
 * Input: a TSV with header `keep_slug  merge_slug  new_slug  note`. Each row
 * folds the person at `merge_slug` into the person at `keep_slug`; a non-empty
 * `new_slug` also renames the kept person. A row with an empty `merge_slug`
 * and a `new_slug` only renames (a generated `p-` slug getting its readable
 * one). `note` is reviewer context.
 *
 * For each row, in ONE atomic db.batch (a server-side transaction, the same
 * mechanism as scripts/apply-reslug.ts):
 *   1. source_persons of the merged person move to the kept person; a
 *      (source, role) pair the kept person already has is dropped, not doubled
 *   2. the kept person's names follow the house convention: the Japanese
 *      display name wins over a romanisation, the modern character form wins
 *      over the old one, and a romanised name with its macrons wins over the
 *      same name without them; every other scalar the kept row lacked
 *      (kana, Ainu name, years, Wikidata, Wikipedia, researchmap, ORCID, bio)
 *      is filled from the merged row
 *   3. person_slug_redirects: merge_slug → kept person, redirects the merged
 *      person already owned → kept person, and the old keep_slug → kept person
 *      when renaming, so /people/<old> keeps answering
 *   4. the merged row stays, as status 'merged' with merged_into_person_id,
 *      like a merged source; the kept row takes new_slug when given
 *
 * Safety:
 *   • --plan (default) prints every decision and writes nothing
 *   • --apply performs the writes; a list with a parse error applies nothing
 *   • idempotent: a merged row, and a keep_slug already renamed to new_slug,
 *     are recognised and skipped on a rerun
 *   • refuses a slug outside ^[a-z0-9][a-z0-9-]{1,59}$, a new_slug that a live
 *     person holds or a redirect retired, one proposed twice, and a merge
 *     whose two rows carry different Wikidata items
 *   • exits non-zero when any row was refused or names a slug that does not exist
 *
 * Run:  bun run merge-persons scripts/data/person-merges.tsv            plan
 *       bun run merge-persons scripts/data/person-merges.tsv --apply    write
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { foldKanji, foldRomaji } from './import/lib/derive';

const { persons, sourcePersons, personSlugRedirects } = schema;
type Db = LibSQLDatabase<typeof schema>;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const HEADER = ['keep_slug', 'merge_slug', 'new_slug', 'note'];

export interface MergeRow {
	line: number;
	keepSlug: string;
	/** empty for a rename-only row */
	mergeSlug: string;
	newSlug: string | null;
}

export interface ParseResult {
	rows: MergeRow[];
	errors: string[];
}

export function parseMergeTsv(text: string): ParseResult {
	const lines = text.split(/\r?\n/);
	const errors: string[] = [];
	const rows: MergeRow[] = [];
	const head = (lines[0] ?? '').split('\t').map((c) => c.trim());
	if (head.length !== HEADER.length || HEADER.some((h, i) => head[i] !== h)) {
		return { rows, errors: [`bad header: expected ${HEADER.join(' / ')}`] };
	}
	const seenMerge = new Set<string>();
	const seenNew = new Set<string>();
	lines.slice(1).forEach((raw, i) => {
		if (!raw.trim()) return;
		const line = i + 2;
		const [keepSlug = '', mergeSlug = '', newSlug = ''] = raw.split('\t').map((c) => c.trim());
		if (!SLUG_RE.test(keepSlug) || (mergeSlug && !SLUG_RE.test(mergeSlug))) {
			errors.push(`line ${line}: keep_slug and merge_slug must be slugs`);
			return;
		}
		if (!mergeSlug && !newSlug) {
			errors.push(`line ${line}: a row needs a merge_slug, a new_slug, or both`);
			return;
		}
		if (keepSlug === mergeSlug) {
			errors.push(`line ${line}: keep_slug equals merge_slug`);
			return;
		}
		if (mergeSlug && seenMerge.has(mergeSlug)) {
			errors.push(`line ${line}: ${mergeSlug} merged twice`);
			return;
		}
		if (mergeSlug) seenMerge.add(mergeSlug);
		if (newSlug) {
			if (!SLUG_RE.test(newSlug)) {
				errors.push(`line ${line}: new_slug ${newSlug} is not a slug`);
				return;
			}
			if (seenNew.has(newSlug)) {
				errors.push(`line ${line}: new_slug ${newSlug} proposed twice`);
				return;
			}
			seenNew.add(newSlug);
		}
		rows.push({ line, keepSlug, mergeSlug, newSlug: newSlug || null });
	});
	return { rows, errors };
}

export interface MergeStats {
	applicable: number;
	applied: number;
	alreadyApplied: number;
	missing: number;
	refused: number;
}

type PersonRow = typeof persons.$inferSelect;

const GAP_FILL = [
	'nameKana',
	'nameAin',
	'birthYear',
	'deathYear',
	'wikidata',
	'wikipedia',
	'researchmap',
	'orcid',
	'bio'
] as const;

const CJK = /[぀-ヿ㐀-鿿]/;
const DIACRITIC = /[^\x00-\x7f]/;

/** The display name the merged pair should carry: Japanese script over a
 *  romanisation, and the modern character form over the old one. */
export function pickName(keep: string, merge: string): string {
	if (!CJK.test(keep) && CJK.test(merge)) return merge;
	if (CJK.test(keep) && CJK.test(merge) && foldKanji(keep) !== keep && foldKanji(merge) === merge)
		return merge;
	return keep;
}

/** The romanised name: the form with its macrons wins over the same name
 *  stripped of them; otherwise the kept value, or the merged one as a gap fill. */
export function pickNameEn(keep: string | null, merge: string | null): string | null {
	if (!keep) return merge;
	if (!merge) return keep;
	if (foldRomaji(keep) === foldRomaji(merge) && !DIACRITIC.test(keep) && DIACRITIC.test(merge))
		return merge;
	return keep;
}

async function personBySlug(db: Db, slug: string): Promise<PersonRow | undefined> {
	return (await db.select().from(persons).where(eq(persons.slug, slug)).limit(1))[0];
}

async function personById(db: Db, id: string): Promise<PersonRow | undefined> {
	return (await db.select().from(persons).where(eq(persons.id, id)).limit(1))[0];
}

async function redirectTarget(db: Db, slug: string): Promise<string | undefined> {
	const r = await db
		.select({ personId: personSlugRedirects.personId })
		.from(personSlugRedirects)
		.where(eq(personSlugRedirects.oldSlug, slug))
		.limit(1);
	return r[0]?.personId;
}

export async function runMerges(
	db: Db,
	rows: MergeRow[],
	opts: { apply: boolean; log?: (line: string) => void }
): Promise<MergeStats> {
	const stats: MergeStats = {
		applicable: rows.length,
		applied: 0,
		alreadyApplied: 0,
		missing: 0,
		refused: 0
	};
	const out = opts.log ?? ((line: string) => console.log(line));
	const log = (r: MergeRow, msg: string) =>
		out(
			`line ${r.line}  ${r.mergeSlug || '(rename)'} → ${r.keepSlug}${r.newSlug ? ` (→ ${r.newSlug})` : ''}: ${msg}`
		);

	for (const r of rows) {
		// keep_slug may already have been renamed to new_slug by an earlier run
		let keep = await personBySlug(db, r.keepSlug);
		if (!keep) {
			const renamed = await redirectTarget(db, r.keepSlug);
			if (renamed) keep = await personById(db, renamed);
		}
		if (!keep || keep.status !== 'active') {
			log(r, 'keep_slug names no active person');
			stats.missing++;
			continue;
		}
		const rename = r.newSlug && r.newSlug !== keep.slug ? r.newSlug : null;
		if (rename) {
			const live = await personBySlug(db, rename);
			const retired = await redirectTarget(db, rename);
			if (live || retired) {
				log(r, `refused: new_slug ${rename} is taken`);
				stats.refused++;
				continue;
			}
		}
		if (!r.mergeSlug) {
			if (!rename) {
				log(r, 'already renamed');
				stats.alreadyApplied++;
				continue;
			}
			log(r, `rename ${keep.slug} → ${rename} [${keep.name} / ${keep.nameEn ?? ''}]`);
			if (opts.apply) {
				await db.batch([
					db.insert(personSlugRedirects).values({ oldSlug: keep.slug, personId: keep.id }),
					db
						.update(persons)
						.set({ slug: rename, updatedAt: new Date() })
						.where(eq(persons.id, keep.id))
				]);
			}
			stats.applied++;
			continue;
		}
		const merge = await personBySlug(db, r.mergeSlug);
		if (!merge || merge.status === 'merged') {
			const into = merge?.mergedIntoPersonId ?? (await redirectTarget(db, r.mergeSlug));
			if (into === keep.id) {
				log(r, 'already merged');
				stats.alreadyApplied++;
			} else {
				log(r, into ? 'merge_slug already folds into another person' : 'merge_slug not found');
				stats.missing++;
			}
			continue;
		}
		if (keep.wikidata && merge.wikidata && keep.wikidata !== merge.wikidata) {
			log(r, `refused: different Wikidata items ${keep.wikidata} vs ${merge.wikidata}`);
			stats.refused++;
			continue;
		}

		const keptJoins = await db
			.select({ sourceId: sourcePersons.sourceId, role: sourcePersons.role })
			.from(sourcePersons)
			.where(eq(sourcePersons.personId, keep.id));
		const mergedJoins = await db
			.select({ id: sourcePersons.id, sourceId: sourcePersons.sourceId, role: sourcePersons.role })
			.from(sourcePersons)
			.where(eq(sourcePersons.personId, merge.id));
		const have = new Set(keptJoins.map((j) => `${j.sourceId} ${j.role}`));
		const move = mergedJoins.filter((j) => !have.has(`${j.sourceId} ${j.role}`));
		const drop = mergedJoins.filter((j) => have.has(`${j.sourceId} ${j.role}`));

		const patch: Record<string, unknown> = {};
		const name = pickName(keep.name, merge.name);
		if (name !== keep.name) patch.name = name;
		const nameEn = pickNameEn(keep.nameEn, merge.nameEn);
		if (nameEn !== keep.nameEn) patch.nameEn = nameEn;
		for (const k of GAP_FILL) {
			const mine = keep[k];
			const theirs = merge[k];
			if ((mine === null || mine === undefined || mine === '') && theirs) patch[k] = theirs;
		}
		const changed = Object.keys(patch);
		if (rename) patch.slug = rename;

		log(
			r,
			`${move.length} joins move, ${drop.length} duplicate joins drop, sets ${changed.join(',') || 'nothing'}` +
				` [${merge.name} / ${merge.nameEn ?? ''} → ${keep.name} / ${keep.nameEn ?? ''}` +
				(patch.name || patch.nameEn ? ` ⇒ ${name} / ${nameEn ?? ''}` : '') +
				']'
		);
		if (!opts.apply) {
			stats.applied++;
			continue;
		}

		const now = new Date();
		const writes = [
			db
				.update(personSlugRedirects)
				.set({ personId: keep.id })
				.where(eq(personSlugRedirects.personId, merge.id)),
			...move.map((j) =>
				db.update(sourcePersons).set({ personId: keep.id }).where(eq(sourcePersons.id, j.id))
			),
			...drop.map((j) => db.delete(sourcePersons).where(eq(sourcePersons.id, j.id))),
			db.insert(personSlugRedirects).values({ oldSlug: merge.slug, personId: keep.id }),
			...(rename
				? [db.insert(personSlugRedirects).values({ oldSlug: keep.slug, personId: keep.id })]
				: []),
			db
				.update(persons)
				.set({ status: 'merged', mergedIntoPersonId: keep.id, updatedAt: now })
				.where(eq(persons.id, merge.id)),
			db
				.update(persons)
				.set({ ...patch, updatedAt: now })
				.where(eq(persons.id, keep.id))
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await db.batch(writes as unknown as [any, ...any[]]);
		stats.applied++;
	}
	return stats;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');
	const files = args.filter((a) => a !== '--apply' && a !== '--plan');
	if (files.length !== 1) {
		console.error('usage: bun scripts/merge-persons.ts <merges.tsv> [--plan|--apply]');
		process.exit(1);
	}
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:');
	if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');
	const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
	if (isFile) await client.execute('PRAGMA foreign_keys = ON'); // local convention, see db/index.ts
	const db = drizzle(client, { schema });

	const parsed = parseMergeTsv(readFileSync(files[0], 'utf8'));
	for (const e of parsed.errors) console.error(`✗ TSV ${e}`);
	if (parsed.errors.length) {
		console.error('the list has errors; nothing was applied');
		process.exit(2);
	}
	console.log(apply ? '== APPLY ==' : '== PLAN (no writes; pass --apply to write) ==');
	const stats = await runMerges(db, parsed.rows, { apply });
	console.log('\n--- stats ---');
	console.log(`applicable rows:  ${stats.applicable}`);
	console.log(`${apply ? 'applied' : 'would apply'}:      ${stats.applied}`);
	console.log(`already merged:   ${stats.alreadyApplied}`);
	console.log(`slug missing:     ${stats.missing}`);
	console.log(`refused:          ${stats.refused}`);
	if (stats.refused || stats.missing) process.exit(2);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}

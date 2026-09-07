#!/usr/bin/env bun
/**
 * Link author credits to the person records they name.
 *
 * The importers reconcile person edges only while a record is new: the academic
 * importer is watermark-incremental, and author fields that arrive later through
 * a merge-engine observation never trigger the entity pass again. Credits whose
 * spelling the person index did not resolve at import time therefore stay
 * unlinked even though the person record exists.
 *
 * This sweep re-reads every active source's author credit and links each name
 * part that names exactly one active person. It creates no person records, and
 * it skips ainu-corpora collections, where roles are curated per collection by
 * corpusContributorRole and a blanket author link would come back as a second,
 * contradictory edge on the next corpus import.
 *
 * A credit part is folded (NFKC, iteration marks, itaiji, accents, punctuation)
 * and matched against the folded forms of each person's name, romanization,
 * kana reading, and recorded aliases. Two persons folding to the same form make
 * the form ineligible: a part must name one person, or it stays unlinked.
 *
 * Run:
 *   DATABASE_URL=file:./local.db bun run scripts/link-author-credits.ts [--dry-run]
 */
import aliases from '../src/lib/data/person-aliases.json';
import { persons, sources, sourcePersons } from '../src/lib/server/db/schema';
import { ACTIVE_SOURCE_STATUS } from '../src/lib/server/visibility';
import { type Db } from './import/lib/entities';
import { authorParts, INSTITUTION_RE, isGarbageName, stripParens } from './import/lib/derive';
import { parseImporterCli } from './import/lib/run';

const uuid = () => crypto.randomUUID();

/** Orthographic variants that appear in harvested credit strings. */
const ITAIJI: Record<string, string> = {
	眞: '真', 收: '収', 巖: '巌', 巗: '巌', 靜: '静', 﨑: '崎', 巳: '己', 國: '国',
	嶋: '島', 龍: '竜', 邊: '辺', 澤: '沢', 廣: '広', 藏: '蔵', 齋: '斉'
};
const VOICED: Record<string, string> = {
	か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず',
	せ: 'ぜ', そ: 'ぞ', た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば',
	ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ'
};
/** Small-kana extensions fold onto the full syllable they abbreviate (ㇱ→シ). */
const SMALL_KANA: Record<string, string> = {
	ㇰ: 'ク', ㇱ: 'シ', ㇲ: 'ス', ㇳ: 'ト', ㇴ: 'ヌ', ㇵ: 'ハ', ㇶ: 'ヒ', ㇷ: 'フ',
	ㇸ: 'ヘ', ㇹ: 'ホ', ㇺ: 'ム', ㇻ: 'ラ', ㇼ: 'リ', ㇽ: 'ル', ㇾ: 'レ', ㇿ: 'ロ',
	ㇷ゚: 'プ'
};
export function fold(raw: string): string {
	let s = String(raw).normalize('NFKC');
	s = [...s].map((c) => ITAIJI[c] ?? SMALL_KANA[c] ?? c).join('');
	const expanded: string[] = [];
	for (const c of s) {
		// Iteration marks stand for a repeat of the previous mora — plain (ゝ)
		// or voiced (ゞ: すゞ = すず) — so they replace themselves with it.
		if (c === 'ゝ' && expanded.length) expanded.push(expanded[expanded.length - 1]);
		else if (c === 'ゞ' && expanded.length) {
			const prev = expanded[expanded.length - 1];
			expanded.push(VOICED[prev] ?? prev);
		} else expanded.push(c);
	}
	// NFKD splits Latin diacritics (stripped below) but also voiced kana (ず→す+゛);
	// NFC after the strip revoices them, so 加藤 and 賀藤 stay distinct.
	s = expanded
		.join('')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.normalize('NFC');
	return s
		.toLowerCase()
		.replace(/[\s,.·・'’ʼ"()「」『』（）]/g, '')
		.replace(/[^\wァ-ヿぁ-ゖ一-鿿Ѐ-ӿ-]/g, '');
}

export interface PersonRow {
	id: string;
	slug: string;
	name: string;
	nameEn: string | null;
	nameKana: string | null;
	status: string;
	birthYear?: number | null;
	deathYear?: number | null;
}
export interface SourceRow {
	id: string;
	slug: string;
	author: string | null;
	status: string;
	provenanceRepo: string | null;
	yearStart?: number | null;
}
export interface EdgeRow {
	sourceId: string;
	personId: string;
	role: string;
}
export interface CreditLinkPlan {
	sourceSlug: string;
	sourceId: string;
	personId: string;
	personSlug: string;
	role: string;
	sortOrder: number;
	author: string;
}

/** A credit part names a person when every fold form it can take lands on that person alone. */
export function planCreditLinks(input: {
	personRows: PersonRow[];
	sourceRows: SourceRow[];
	edgeRows: EdgeRow[];
	aliasRows?: { slug: string; aliases?: { name: string; nameEn?: string | null }[] }[];
}): CreditLinkPlan[] {
	const aliasesFor = input.aliasRows ?? (aliases as { slug: string; aliases?: { name: string; nameEn?: string | null }[] }[]);
	const active = input.personRows.filter((p) => p.status === 'active');
	const byId = new Map(active.map((p) => [p.id, p]));
	const idx = new Map<string, Set<string>>();
	const add = (raw: string | null | undefined, id: string) => {
		if (!raw) return;
		const f = fold(raw);
		if (f.length < 3) return;
		const hit = idx.get(f) ?? new Set<string>();
		hit.add(id);
		idx.set(f, hit);
	};
	for (const p of active) {
		add(p.name, p.id);
		add(p.nameEn, p.id);
		add(p.nameKana, p.id);
	}
	for (const a of aliasesFor) {
		const p = active.find((x) => x.slug === a.slug);
		if (!p) continue;
		for (const alt of a.aliases ?? []) {
			add(alt.name, p.id);
			add(alt.nameEn, p.id);
		}
	}
	const existing = new Set(input.edgeRows.map((e) => `${e.sourceId}|${e.personId}|${e.role}`));
	const plans: CreditLinkPlan[] = [];
	for (const s of input.sourceRows) {
		if (s.status !== ACTIVE_SOURCE_STATUS || !s.author) continue;
		if (s.provenanceRepo === 'ainu-corpora') continue;
		let order = 0;
		for (const part of authorParts(s.author)) {
			// A comma chain carries several names; every sub-name gets its own
			// chance, and one that names nobody must not end the search.
			const chain = part.includes(',');
			const seen = new Set<string>();
			for (const name of creditNames(part)) {
				if (isGarbageName(name) || INSTITUTION_RE.test(name)) continue;
				const bare = stripParens(name).trim();
				const forms = new Set([fold(bare)]);
				const toks = bare.split(/\s+/).filter(Boolean);
				if (toks.length === 2 && /^[A-Za-z]/.test(bare)) forms.add(fold(`${toks[1]} ${toks[0]}`));
				const hits = new Set<string>();
				for (const f of forms) for (const id of idx.get(f) ?? []) hits.add(id);
				if (hits.size !== 1) continue;
				const [personId] = [...hits];
				if (seen.has(personId)) continue;
				const person = byId.get(personId)!;
				// A credit naming someone who died long before publication (a
				// photograph, a source text) is not an authorship; a small window
				// still admits posthumous editions of a person's own work.
				if (s.yearStart && person.deathYear && s.yearStart - person.deathYear > 3) continue;
				if (s.yearStart && person.birthYear && s.yearStart - person.birthYear > 100) continue;
				const role = /訳/.test(name)
					? 'translator'
					: /編|監修|校訂/.test(name)
						? 'editor'
						: 'author';
				if (existing.has(`${s.id}|${personId}|${role}`)) {
					seen.add(personId);
					if (!chain) break;
					continue;
				}
				seen.add(personId);
				plans.push({
					sourceSlug: s.slug,
					sourceId: s.id,
					personId,
					personSlug: person.slug,
					role,
					sortOrder: order++,
					author: s.author
				});
				if (!chain) break;
			}
		}
	}
	return plans;
}

/**
 * One credit part can carry a comma chain — a single "Last, First" name, a MARC
 * run like "田村, すず子, 片山, 龍峯", or a name followed by an institution.
 * Yield the whole string first, then the adjacent comma pairs, then the bare
 * segments, so each shape gets its chance at an exact match.
 */
function* creditNames(part: string): Generator<string> {
	yield part;
	const segs = part.split(',').map((s) => s.trim()).filter(Boolean);
	if (segs.length < 2) return;
	for (let i = 0; i + 1 < segs.length; i += 2) yield `${segs[i]} ${segs[i + 1]}`;
	for (const seg of segs) yield seg;
}

/** Insert the planned credit links inside one transaction. */
export async function applyCreditLinks(db: Db, plans: CreditLinkPlan[]): Promise<number> {
	if (!plans.length) return 0;
	return db.transaction(async (tx) => {
		const people = await tx.select({ id: persons.id, slug: persons.slug }).from(persons);
		const bySlug = new Map(people.map((p) => [p.slug, p.id]));
		const rows = plans.map((p) => {
			const personId = bySlug.get(p.personSlug);
			if (!personId) throw new Error(`Credit person missing: ${p.personSlug}`);
			return {
				id: uuid(),
				sourceId: p.sourceId,
				personId,
				role: p.role,
				sortOrder: p.sortOrder,
				origin: 'sweep-author-credits'
			};
		});
		await tx.insert(sourcePersons).values(rows).onConflictDoNothing();
		return rows.length;
	});
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	const personRows = await db.select().from(persons);
	const sourceRows = await db.select().from(sources);
	const edgeRows = await db.select().from(sourcePersons);
	const plans = planCreditLinks({ personRows, sourceRows, edgeRows });
	const byRole = new Map<string, number>();
	for (const p of plans) byRole.set(p.role, (byRole.get(p.role) ?? 0) + 1);
	console.log(
		`${opts.dryRun ? '[DRY-RUN] ' : ''}credit links planned: ${plans.length}`,
		Object.fromEntries(byRole)
	);
	for (const p of plans.slice(0, 25)) console.log(`  ${p.sourceSlug} -> ${p.personSlug} (${p.role})`);
	if (!opts.dryRun) console.log('inserted:', await applyCreditLinks(db, plans));
}

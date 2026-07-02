#!/usr/bin/env bun
/**
 * Feed #4 — Manual / hand-curated tools & resources importer (idempotent).
 *
 * The merge-engine replacement for seed.ts's `seedManual`. This feed has no
 * sibling repo — its "upstream" is the hand-curated `MANUAL_SOURCES` list carried
 * inline below (byte-identical to the seed's), so it survives a re-seed. For each
 * record IN LIST ORDER, it derives the SAME fields seed.ts did and submits ONE
 * `curated_assertion` observation per record through mergeSourceObservation. The
 * engine attaches to the existing source by its `repo_path` identifier
 * (`manual:<slug>`, exactly the COLON form the bootstrap minted) and emits
 * value-hash noop claims (no duplicate source), then this importer reconciles the
 * topical tags idempotently.
 *
 * Origin        : 'manual'
 * Idempotency key: (origin, originRecordId = slug, contentHash) — the engine's
 *                  observation UNIQUE index. A re-run with unchanged data is a
 *                  dup-noop (zero projection change).
 * Identity key  : identifier repo_path = 'manual:<slug>' (COLON, lowercased — matches
 *                  the bootstrap's `${repo}:${path}` form → repo_path_exact attach;
 *                  a SLASH would fork a duplicate source).
 * Derivation    : curated_assertion @ 0.8 (NOT editorial_decision — these hand-curated
 *                  tools are asserted facts, not an on-site editorial override; ≤ the
 *                  bootstrap band, so it never clobbers a bootstrapped/editorial value;
 *                  noop-by-valueHash regardless of band).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  bun run import:manual
 *       DATABASE_URL=file:/tmp/clone.db bun run import:manual --dry-run
 */
import { TAG_DEFS } from './lib/derive';
import { openDb, attachTags, type EntityStamp } from './lib/entities';
import { openRun, closeRun, emitSource, driftMissing } from './lib/run';
import type { MergeInput } from '../../src/lib/server/merge';

// ── argv ─────────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

const url = argValue('--db') ?? process.env.DATABASE_URL;
if (!url) {
	console.error('✗ No database specified. Pass --db file:/path/to/db or set DATABASE_URL.');
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}
const DRY_RUN = hasFlag('--dry-run');
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : Infinity;

const ORIGIN = 'manual';
const DERIVATION = 'curated_assertion';
const CONFIDENCE = 0.8;

// ── MANUAL_SOURCES — the feed's inline data (VERBATIM from seed.ts's seedManual) ─
//
// Hand-curated, all verifiable at the listed URLs. Kept here (not in a sibling
// repo) so they survive a re-seed. provenanceRepo = 'manual'.
//
// ⚠ BANNED: never add YouTube channel UCb6agoDa9ujg0412JpeWdbg (AI-generated
//   content, unsuitable for a scholarly index).
interface ManualSource {
	slug: string;
	title: string;
	titleEn: string;
	type: string;
	category?: string; // defaults to 'tool'
	author?: string;
	languages: string[];
	scripts?: string[];
	yearStart?: number;
	summary: string;
	links: { type: string; url: string; label?: string }[];
}

const MANUAL_SOURCES: ManualSource[] = [
	{
		slug: 'aynuwiki',
		title: 'Aynuwiki',
		titleEn: 'Aynuwiki',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語・アイヌ文化に関する協同編集のウィキ。',
		links: [{ type: 'website', url: 'https://wiki.aynu.org/', label: 'wiki.aynu.org' }]
	},
	{
		slug: 'ukosamaani-sait',
		title: 'Ukosamaani Sait',
		titleEn: 'Ukosamaani Sait',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語のツール・リソースを集めたポータルサイト。',
		links: [{ type: 'website', url: 'https://site.aynu.org/', label: 'site.aynu.org' }]
	},
	{
		slug: 'poro-cinumkekampi',
		title: 'Poro Cinumkekampi',
		titleEn: 'Poro Cinumkekampi (online dictionary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'オンラインのアイヌ語辞典。',
		links: [{ type: 'website', url: 'https://dict.aynu.org/', label: 'dict.aynu.org' }]
	},
	{
		slug: 'itak-uoeroskip',
		title: 'Itak-uoeroskip',
		titleEn: 'Itak-uoeroskip (terminology glossary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の用語集（言語学・文法用語などの対訳）。',
		links: [{ type: 'website', url: 'https://itak.aynu.org/', label: 'itak.aynu.org' }]
	},
	{
		slug: 'aynu-itah',
		title: 'Айну-Итах',
		titleEn: 'Ajnu-Itah (Russian–Ainu resource)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'rus'],
		scripts: ['latn', 'cyrl'],
		summary: 'ロシア語によるアイヌ語の辞書・資料。',
		links: [{ type: 'website', url: 'https://itah.aynu.org/', label: 'itah.aynu.org' }]
	},
	{
		slug: 'tu-itak-re-itak',
		title: 'tu itak re itak',
		titleEn: 'tu itak re itak (quiz)',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の学習クイズ。',
		links: [{ type: 'website', url: 'https://quiz.aynu.org/', label: 'quiz.aynu.org' }]
	},
	{
		slug: 'ainu-mcp',
		title: 'ainu-mcp',
		titleEn: 'ainu-mcp (Model Context Protocol server)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn', 'eng'],
		summary: 'アイヌ語の辞書・コーパス・文法を統合する Model Context Protocol サーバー。',
		links: [{ type: 'website', url: 'https://mcp.aynu.org/', label: 'mcp.aynu.org' }]
	},
	{
		slug: 'kampisos',
		title: 'Kampisos',
		titleEn: 'Kampisos (corpus search)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: '検索・絞り込み機能付きのアイヌ語コーパス（170万語以上）。',
		links: [{ type: 'website', url: 'https://kampisos.aynu.io/', label: 'kampisos.aynu.io' }]
	},
	{
		slug: 'tunci',
		title: 'Tunci',
		titleEn: 'Tunci (machine translation)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の機械翻訳ツール。',
		links: [{ type: 'website', url: 'https://tunci.aynu.io/', label: 'tunci.aynu.io' }]
	},
	{
		slug: 'minecraft-ainu',
		title: 'minecraft-ainu',
		titleEn: 'minecraft-ainu (resource pack)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'Minecraft をアイヌ語化するリソースパック。',
		links: [
			{ type: 'github', url: 'https://github.com/aynumosir/minecraft-ainu', label: 'GitHub' }
		]
	},
	{
		slug: 'ainconv',
		title: 'ainconv',
		titleEn: 'ainconv (script conversion library)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		scripts: ['latn', 'kana', 'cyrl'],
		summary: 'アイヌ語表記（ラテン文字・カナ・キリル文字）を相互変換するライブラリ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	},
	{
		slug: 'ainu-utils',
		title: 'ainu-utils',
		titleEn: 'ainu-utils (processing utilities)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'アイヌ語テキスト処理ユーティリティ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	}
];

// Video / animation sources (type: 'video', category: 'corpus').
// NOTE: サクアニメ entries go here once the exact channel/playlist URL is
// confirmed. The banned channel (see above) must never be listed.
const MANUAL_VIDEOS: ManualSource[] = [];

/**
 * Derive the engine `fields` map for one manual record — byte-identical to
 * seed.ts's `seedManual` row build. Empty/null values are OMITTED (the engine
 * skips empties anyway, and omitting avoids empty-overwrite noise on the
 * historically-populated clone); the returned `tagTexts` feeds the topical
 * keyword sweep exactly as seed's `attachTags(id, m.title, m.titleEn, m.type)`.
 */
function deriveManual(m: ManualSource): {
	fields: Record<string, unknown>;
	tagTexts: (string | null | undefined)[];
} {
	const fields: Record<string, unknown> = {
		title: m.title,
		titleEn: m.titleEn,
		category: m.category ?? 'tool',
		type: m.type,
		languages: m.languages,
		scripts: m.scripts ?? ['latn'],
		summary: m.summary,
		yearCertainty: m.yearStart ? 'exact' : 'unknown'
	};
	if (m.author) fields.author = m.author;
	if (m.yearStart) {
		fields.yearText = `${m.yearStart}`;
		fields.yearStart = m.yearStart;
	}
	return { fields, tagTexts: [m.title, m.titleEn, m.type] };
}

async function main() {
	const records = [...MANUAL_SOURCES, ...MANUAL_VIDEOS];
	const entries = LIMIT === Infinity ? records : records.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:manual → ${url!.split('?')[0]}  (${entries.length}/${records.length} records)`
	);

	const db = openDb(url!, authToken);
	const runId = DRY_RUN
		? null
		: await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-manual@1' });

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, other: 0 };

	for (const m of entries) {
		seen.add(m.slug);
		const { fields, tagTexts } = deriveManual(m);

		if (DRY_RUN) {
			console.log(`  ${m.slug}: ${Object.keys(fields).length} fields, ${m.links.length} links`);
			continue;
		}

		const input: MergeInput = {
			origin: ORIGIN,
			originRecordId: m.slug,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields,
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${m.slug}` }],
			links: m.links.map((l) => ({ type: l.type, url: l.url, label: l.label ?? null })),
			presence: 'seen',
			runId,
			rawPayload: m as unknown as Record<string, unknown>
		};

		const result = await emitSource(db, input, { provenanceRepo: ORIGIN, provenancePath: m.slug });
		if (result.status === 'noop') stats.noop += 1;
		else if (result.status === 'applied') stats.applied += 1;
		else stats.other += 1;

		const sid = result.sourceId;
		if (!sid) continue;
		const stamp: EntityStamp = {
			origin: ORIGIN,
			observationId: result.observationId,
			confidence: CONFIDENCE,
			now: new Date()
		};
		await attachTags(db, sid, tagTexts, stamp, TAG_DEFS);
	}

	let drifted = 0;
	if (!DRY_RUN) {
		drifted = await driftMissing(db, ORIGIN, seen, {
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			runId
		});
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, entries: entries.length }
		});
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:manual failed:', err);
		process.exit(1);
	});

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import { measureLanguageComposition, refreshSourceTextComposition } from './language-composition';
import { replaceOcrPages } from './ocr';
import { displayShares, type SourceTextComposition } from '$lib/archive/text-composition';
import { ingestOcr } from '../../../../scripts/archive/ingest-ocr';

function share(measurement: { shares: { lang: string; share: number }[] }, lang: string): number {
	return measurement.shares.find((s) => s.lang === lang)?.share ?? 0;
}

describe('measureLanguageComposition', () => {
	// Attested texts: Chiri Yukie's kamuy yukar (Latin Ainu), the archive's
	// own OCR of a Japanese article, and an Edo-period interlinear passage
	// (Kaga family documents) where katakana lines are Ainu and the glosses
	// under them are Japanese.

	it('reads Latin-script Ainu as Ainu', () => {
		const r = measureLanguageComposition([
			{
				text: [
					'kamuycikap kamuy yayeyukar, "sirokani pe ran ran piskan"',
					'pet esoro sap=as ayne, aynu kotan enkasike',
					'e=aynumitpo ku=ne wa tapne ekasi itak koitaraye ku=ki kusu'
				].join('\n')
			}
		]);
		expect(share(r, 'ain')).toBeGreaterThan(0.95);
	});

	it('reads English linguistics prose as English, including Ainu-derived names', () => {
		const r = measureLanguageComposition([
			{
				text: 'The reflexive prefixes attach to transitive verbs in the Saru dialect of Ainu, as Tamura demonstrated.'
			}
		]);
		expect(share(r, 'eng')).toBeGreaterThan(0.9);
	});

	it('keeps katakana loanwords inside Japanese prose Japanese', () => {
		const r = measureLanguageComposition([
			{
				text: 'アイヌ語千歳方言の再帰接頭辞について、テキストのデータを分析した。アイヌ語に再帰接頭辞として二つの形式があることは古くから知られている。'
			}
		]);
		expect(share(r, 'jpn')).toBeGreaterThan(0.95);
		expect(share(r, 'ain')).toBe(0);
	});

	it('reads kana-spelled Ainu as Ainu in modern and small-kana-less orthography alike', () => {
		const modern = measureLanguageComposition([
			{ text: 'イランカラㇷ゚テ。カムイ オッタ アㇻキアン ルウェ ネ。' }
		]);
		expect(share(modern, 'ain')).toBeGreaterThan(0.9);
		// 加賀家文書の口説 (Edo period): katakana line, Japanese gloss line.
		const interlinear = measureLanguageComposition([
			{
				text: [
					'ウセブ　チウベフ　シヤランベ　エキリ',
					'反物　あらもの　呉服　類',
					'カムイ ウタラ オカイ ルウェ',
					'usep saranpe ikiri'
				].join('\n')
			}
		]);
		expect(share(interlinear, 'ain')).toBeGreaterThan(0.4);
		expect(share(interlinear, 'jpn')).toBeGreaterThan(0.1);
	});

	it('reads katakana-spelled Japanese speech as Japanese', () => {
		// Sakhalin transcripts write the speaker's Japanese in katakana.
		const r = measureLanguageComposition([
			{ text: 'ワシ ワシ マオカサ イッタトキ コノ ムカシバナシ キイタッケ' }
		]);
		expect(share(r, 'jpn')).toBeGreaterThan(0.9);
	});

	it('counts what resists classification as und, never as a language', () => {
		const r = measureLanguageComposition([{ text: 'クヌ ヲピ ヱセ' }]);
		expect(share(r, 'ain') + share(r, 'und')).toBeGreaterThan(0);
		expect(r.shares.every((s) => ['ain', 'jpn', 'und'].includes(s.lang))).toBe(true);
	});

	it('keeps an attested Ainu headword Ainu on its English gloss line', () => {
		const r = measureLanguageComposition([
			{ text: 'kamuy: the god, a bear; used of deities in general' }
		]);
		expect(share(r, 'ain')).toBeGreaterThan(0.1);
		expect(share(r, 'eng')).toBeGreaterThan(0.7);
	});

	it('reads romanized Japanese as Japanese, never as Ainu', () => {
		const r = measureLanguageComposition([
			{ text: 'Tamura Suzuko 1988 Ainugo no doshi no kozo. Tokyo: Hosei Daigaku.' }
		]);
		expect(share(r, 'ain')).toBe(0);
	});

	it('refuses to let a known fragment speak for unknown text', () => {
		const r = measureLanguageComposition([{ text: `the ${'ẑẑẑẑẑ '.repeat(10)}` }]);
		expect(share(r, 'und')).toBeGreaterThan(0.9);
	});

	it('measures nothing on empty, symbol-only, or kana-mark-only text', () => {
		expect(measureLanguageComposition([{ text: '' }]).chars).toBe(0);
		expect(measureLanguageComposition([{ text: '12 34 --- § ¶' }]).chars).toBe(0);
		expect(measureLanguageComposition([{ text: 'ーーーー ーー ゛゜' }]).chars).toBe(0);
	});
});

describe('displayShares', () => {
	const base: SourceTextComposition = {
		version: 1,
		method: 'run-trigrams-1',
		inputs: [{ revisionId: 'rev-1', variant: 'gemini' }],
		measuredAt: 0,
		chars: 10_000,
		shares: [
			{ lang: 'jpn', share: 0.72, chars: 7200 },
			{ lang: 'ain', share: 0.25, chars: 2500 },
			{ lang: 'und', share: 0.02, chars: 200 },
			{ lang: 'eng', share: 0.005, chars: 50 }
		]
	};

	it('shows named languages above one percent and hides the und residue', () => {
		expect(displayShares(base).map((s) => s.lang)).toEqual(['jpn', 'ain']);
	});

	it('shows nothing when the text is too small to trust', () => {
		expect(displayShares({ ...base, chars: 300 })).toEqual([]);
		expect(displayShares(null)).toEqual([]);
	});
});

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: `file:/tmp/composition-test-${crypto.randomUUID()}.db` });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

async function seedWork(db: Db) {
	await db
		.insert(user)
		.values({ id: 'contributor', name: 'Contributor', email: 'contributor@example.test' });
	await db.insert(schema.sources).values({
		id: 'source-1',
		slug: 'source-one',
		title: '資料一',
		category: 'primary',
		type: 'book',
		humanDownload: true
	});
	await db.insert(schema.archiveRepositories).values({ id: 'repo-1', name: 'books' });
	await db.insert(schema.sourceFiles).values({
		id: 'file-1',
		sourceId: 'source-1',
		role: 'scan',
		sortOrder: 10,
		createdBy: 'contributor'
	});
	await db.insert(schema.fileCheckouts).values({
		id: 'checkout-file-1',
		sourceFileId: 'file-1',
		repoId: 'repo-1',
		path: 'books/資料一.pdf'
	});
	await db.insert(schema.archiveBlobs).values({
		sha256: 'a'.repeat(64),
		bytes: 1234,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date(),
		createdBy: 'contributor'
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 1,
		blobSha256: 'a'.repeat(64),
		originalFilename: '資料一.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		pageCount: 2,
		isCurrent: true,
		submittedBy: 'contributor',
		submittedAt: new Date(1_000)
	});
}

describe('refreshSourceTextComposition', () => {
	it('stores the measured composition of the current revision text', async () => {
		const db = await makeDb();
		await seedWork(db);
		await replaceOcrPages(db, 'rev-1', 'gemini', [
			{ page: 1, text: 'アイヌ語の資料を紹介する。この文献は口承文学の記録である。' },
			{ page: 2, text: 'kamuycikap kamuy yayeyukar sirokani pe ran ran piskan konkani pe' }
		]);
		const stored = await refreshSourceTextComposition(db, 'source-1', new Date('2026-01-02T00:00:00Z'));
		expect(stored).not.toBeNull();
		expect(stored!.inputs).toEqual([{ revisionId: 'rev-1', variant: 'gemini' }]);
		expect(stored!.measuredAt).toBe(Date.parse('2026-01-02T00:00:00Z'));
		expect(share(stored!, 'jpn')).toBeGreaterThan(0.2);
		expect(share(stored!, 'ain')).toBeGreaterThan(0.2);
		const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, 'source-1'));
		expect(row.textComposition).toEqual(stored);
	});

	it('falls back to a variant with text when the preferred variant has none', async () => {
		const db = await makeDb();
		await seedWork(db);
		await replaceOcrPages(db, 'rev-1', 'gemini', [
			{ page: 1, text: 'sirokani pe ran ran piskan konkani pe ran ran piskan' }
		]);
		await db.insert(schema.revisionOcrCoverage).values({
			revisionId: 'rev-1',
			variant: 'pdftotext',
			status: 'none',
			preferred: true
		});
		const stored = await refreshSourceTextComposition(db, 'source-1');
		expect(stored).not.toBeNull();
		expect(stored!.inputs).toEqual([{ revisionId: 'rev-1', variant: 'gemini' }]);
	});

	it('clears a stored measurement when the work no longer has text', async () => {
		const db = await makeDb();
		await seedWork(db);
		await db
			.update(schema.sources)
			.set({
				textComposition: {
					version: 1,
					method: 'run-trigrams-1',
					inputs: [],
					measuredAt: 0,
					chars: 1,
					shares: []
				}
			})
			.where(eq(schema.sources.id, 'source-1'));
		const stored = await refreshSourceTextComposition(db, 'source-1');
		expect(stored).toBeNull();
		const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, 'source-1'));
		expect(row.textComposition).toBeNull();
	});

	it('is refreshed by OCR ingestion', async () => {
		const db = await makeDb();
		await seedWork(db);
		const ainuRoot = await mkdtemp(join(tmpdir(), 'composition-ocr-'));
		try {
			const scanDir = join(ainuRoot, 'books', 'books');
			await mkdir(scanDir, { recursive: true });
			await writeFile(
				join(scanDir, '資料一.gemini.txt'),
				'--- page 1 ---\nsirokani pe ran ran piskan konkani pe ran ran piskan\n'
			);
			await ingestOcr(db, { ainuRoot, dryRun: false, now: new Date('2026-01-01T00:00:00.000Z') });
			const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, 'source-1'));
			expect(row.textComposition).not.toBeNull();
			expect(share(row.textComposition!, 'ain')).toBeGreaterThan(0.9);
		} finally {
			await rm(ainuRoot, { recursive: true, force: true });
		}
	});
});

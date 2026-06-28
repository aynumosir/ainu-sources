/**
 * Merge-engine property tests (§5).
 *
 * Each test runs against a REAL, isolated libSQL in-memory database built by
 * applying the drizzle migrations — so claims, identifiers, provenance, CAS,
 * lifecycle and FK enforcement are all exercised end to end, not mocked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { SOURCE_SCALAR_COLUMNS } from '../golden';
import { mergeSourceObservation } from './merge-source-observation';
import { FIELD_POLICIES } from './field-policies';
import { EDITORIAL_BAND } from './rank';
import { readProvenance, casUpdate } from './cas';
import type { MergeInput } from './types';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

let db: Db;
beforeEach(async () => {
	db = await makeDb();
});

// --- helpers ---------------------------------------------------------------
const merge = (input: MergeInput) => mergeSourceObservation(db, input);

async function getSource(id: string) {
	const [s] = await db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1);
	return s;
}
async function allSources() {
	return db.select().from(schema.sources);
}
async function linksOf(sourceId: string) {
	return db.select().from(schema.sourceLinks).where(eq(schema.sourceLinks.sourceId, sourceId));
}
async function identifiers() {
	return db.select().from(schema.sourceIdentifiers);
}

// ---------------------------------------------------------------------------
// exhaustiveness of the field-policy map (no unmapped sources column)
// ---------------------------------------------------------------------------
describe('field policies', () => {
	it('map EVERY sources scalar + lifecycle column with no unmapped column', () => {
		const lifecycle = ['status', 'mergedIntoSourceId', 'driftStatus', 'firstSeenAt', 'lastSeenAt', 'contentChangedAt'];
		for (const col of [...SOURCE_SCALAR_COLUMNS, ...lifecycle]) {
			expect(FIELD_POLICIES[col], `unmapped column ${col}`).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// §5 property tests
// ---------------------------------------------------------------------------
describe('merge engine — properties', () => {
	// 1
	it('same DOI twice ⇒ same source (idempotent)', async () => {
		const input: MergeInput = {
			origin: 'crossref',
			originRecordId: 'crossref:10.1234/paperx',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'doi', value: 'https://doi.org/10.1234/PAPERX' }],
			fields: { title: 'Paper X', type: 'article', category: 'secondary' }
		};
		const r1 = await merge(input);
		const r2 = await merge(input);
		expect(r1.sourceId).toBeDefined();
		expect(r2.status).toBe('noop'); // identical payload → duplicate observation hash
		// a third, materially-different observation of the same DOI still attaches
		const r3 = await merge({ ...input, originRecordId: 'crossref:10.1234/paperx#2', fields: { ...input.fields, summary: 'now with a summary' } });
		expect(r3.sourceId).toBe(r1.sourceId);
		expect((await allSources()).length).toBe(1);
		const doi = (await identifiers()).find((i) => i.kind === 'doi');
		expect(doi?.valueNorm).toBe('10.1234/paperx'); // resolver stripped + lowercased
	});

	// 2
	it('OpenAlex redirect ⇒ alias identifier resolves to the same source', async () => {
		const r1 = await merge({
			origin: 'openalex',
			originRecordId: 'openalex:W1',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'openalex_work', value: 'W1' }],
			fields: { title: 'Work', type: 'article', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'openalex',
			originRecordId: 'openalex:W2',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'openalex_work', value: 'W2', redirectsTo: 'W1' }],
			fields: { title: 'Work', type: 'article', category: 'secondary' }
		});
		expect(r2.sourceId).toBe(r1.sourceId);
		expect((await allSources()).length).toBe(1);
		const ids = await identifiers();
		expect(ids.find((i) => i.valueNorm === 'W2')?.status).toBe('redirected');
		expect(ids.find((i) => i.valueNorm === 'W1')?.sourceId).toBe(r1.sourceId);
	});

	// 3
	it('same repo_path twice ⇒ same source', async () => {
		const base: MergeInput = {
			origin: 'ainu-dictionaries',
			originRecordId: 'ainu-dictionaries:dobro',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'ainu-dictionaries:dobrotvorsky/1875.json' }],
			fields: { title: 'Dobrotvorsky', type: 'dictionary', category: 'primary' }
		};
		const r1 = await merge(base);
		const r2 = await merge({ ...base, originRecordId: 'ainu-dictionaries:dobro#2', fields: { ...base.fields, summary: 'changed' } });
		expect(r2.sourceId).toBe(r1.sourceId);
		expect((await allSources()).length).toBe(1);
	});

	// 4
	it('repo_path rename ⇒ rebind by content (no duplicate source)', async () => {
		const fields = {
			title: 'Renamed Work',
			titleEn: 'Renamed Work',
			author: 'Author A',
			summary: 'a stable description',
			yearText: '1900',
			yearStart: 1900,
			type: 'book',
			category: 'secondary'
		};
		const r1 = await merge({
			origin: 'ainu-corpora',
			originRecordId: 'ainu-corpora:old',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'ainu-corpora:old/path.json' }],
			fields
		});
		const r2 = await merge({
			origin: 'ainu-corpora',
			originRecordId: 'ainu-corpora:new',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'ainu-corpora:new/path.json' }],
			fields
		});
		expect(r2.sourceId).toBe(r1.sourceId); // rebound, not duplicated
		expect((await allSources()).length).toBe(1);
		const repoIds = (await identifiers()).filter((i) => i.kind === 'repo_path');
		expect(repoIds.length).toBe(2); // both old + new path attached to the one source
	});

	// 5
	it('title-only ⇒ new candidate source, NEVER updates an active source', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:seed',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:seed.json' }],
			fields: { title: 'Lone Title', type: 'book', category: 'secondary', summary: 'original' }
		});
		const r2 = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:lone',
			derivation: 'observed',
			confidence: 0.7,
			fields: { title: 'Lone Title', type: 'book', category: 'secondary', summary: 'DIFFERENT' }
		});
		expect(r2.status).toBe('candidate');
		expect(r2.sourceId).not.toBe(r1.sourceId);
		const active = await getSource(r1.sourceId!);
		expect(active.summary).toBe('original'); // untouched
		expect(active.status).toBe('active');
		const cand = await getSource(r2.sourceId!);
		expect(cand.status).toBe('candidate');
		expect(cand.slug.startsWith('cand-')).toBe(true);
		const rels = await db.select().from(schema.sourceRelations);
		expect(rels.some((rel) => rel.fromSourceId === r2.sourceId && rel.toSourceId === r1.sourceId && rel.status === 'candidate')).toBe(true);
	});

	// 6a
	it('medium (title+author+year) WITH corroboration ⇒ attach', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:med',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:med.json' }],
			fields: { title: 'Medium Work', author: 'Jane Doe', yearStart: 1950, yearText: '1950', type: 'article', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:med',
			derivation: 'observed',
			confidence: 0.85,
			fields: { title: 'Medium Work', author: 'Jane Doe', yearStart: 1950, yearText: '1950', type: 'article', category: 'secondary', summary: 'added' }
		});
		expect(r2.sourceId).toBe(r1.sourceId);
		expect((await allSources()).length).toBe(1);
	});

	// 6b
	it('medium (title+author+year) WITHOUT corroboration ⇒ candidate', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:shared',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:shared.json' }],
			fields: { title: 'Shared Title', author: 'Alice', yearStart: 1960, yearText: '1960', type: 'article', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:shared',
			derivation: 'observed',
			confidence: 0.9,
			fields: { title: 'Shared Title', author: 'Bob', yearStart: 1999, yearText: '1999', type: 'article', category: 'secondary' }
		});
		expect(r2.status).toBe('candidate');
		expect(r2.sourceId).not.toBe(r1.sourceId);
		expect((await allSources()).length).toBe(2);
	});

	// 7
	it('lower-rank observed claim does NOT clobber a curated field', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:c',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:c.json' }],
			fields: { title: 'Curated Title', type: 'book', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:c',
			derivation: 'observed',
			confidence: 0.99, // higher score, but a LOWER band
			identifiers: [{ kind: 'repo_path', value: 'manual:c.json' }],
			fields: { title: 'Observed Override', type: 'book', category: 'secondary' }
		});
		expect(r2.heldClaims.some((c) => c.fieldName === 'title')).toBe(true);
		expect((await getSource(r1.sourceId!)).title).toBe('Curated Title');
	});

	// 8
	it('editorial_decision wins an editable field over any machine band', async () => {
		const r1 = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:e',
			derivation: 'observed',
			confidence: 1.0,
			evidence: 5, // max machine score
			identifiers: [{ kind: 'repo_path', value: 'manual:e.json' }],
			fields: { title: 'Machine Title', type: 'book', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'website',
			originRecordId: `website:${r1.sourceId}`,
			derivation: 'editorial_decision',
			confidence: 0.5, // far lower score
			evidence: 1,
			identifiers: [{ kind: 'repo_path', value: 'manual:e.json' }],
			fields: { title: 'Human Title', type: 'book', category: 'secondary' }
		});
		expect(r2.appliedClaims.some((c) => c.fieldName === 'title')).toBe(true);
		expect((await getSource(r1.sourceId!)).title).toBe('Human Title');
	});

	// 9
	it('unsafe javascript:/data: URL is rejected at ingest', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:u',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:u.json' }],
			fields: { title: 'Has Links', type: 'website', category: 'secondary' },
			links: [
				{ type: 'website', url: 'javascript:alert(1)' },
				{ type: 'pdf', url: 'https://example.org/a.pdf' },
				{ type: 'other', url: 'data:text/html,evil' }
			]
		});
		expect(r1.rejectedClaims.filter((c) => c.fieldName === 'links' && c.reason?.startsWith('unsafe_url')).length).toBe(2);
		const links = await linksOf(r1.sourceId!);
		expect(links.length).toBe(1);
		expect(links[0].url).toBe('https://example.org/a.pdf');
	});

	// 10
	it('null/empty value does NOT clobber a non-null value', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:n',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:n.json' }],
			fields: { title: 'Keep', summary: 'Important summary', type: 'book', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'manual',
			originRecordId: 'manual:n2',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:n.json' }],
			fields: { title: 'Keep', summary: '', type: 'book', category: 'secondary' }
		});
		expect(r2.rejectedClaims.some((c) => c.fieldName === 'summary' && c.reason === 'empty_overwrite')).toBe(true);
		expect((await getSource(r1.sourceId!)).summary).toBe('Important summary');
	});

	// 11
	it('explicit delete ⇒ status change, NOT a row delete', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:d',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:d.json' }],
			fields: { title: 'To Delete', type: 'book', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'website',
			originRecordId: `website:${r1.sourceId}`,
			derivation: 'editorial_decision',
			confidence: 1.0,
			identifiers: [{ kind: 'repo_path', value: 'manual:d.json' }],
			lifecycle: { op: 'soft_delete', reason: 'spam' }
		});
		expect(r2.lifecycleEvents.some((e) => e.eventType === 'soft_delete')).toBe(true);
		const s = await getSource(r1.sourceId!);
		expect(s).toBeDefined();
		expect(s.status).toBe('soft_deleted');
		expect((await allSources()).length).toBe(1); // row preserved
		const events = await db.select().from(schema.sourceLifecycleEvents).where(eq(schema.sourceLifecycleEvents.sourceId, r1.sourceId!));
		expect(events.some((e) => e.eventType === 'soft_delete' && e.toStatus === 'soft_deleted')).toBe(true);
	});

	// 12
	it('duplicate observation hash ⇒ noop (no new observation, no new claims)', async () => {
		const input: MergeInput = {
			origin: 'crossref',
			originRecordId: 'crossref:dup',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'doi', value: '10.5555/dup' }],
			fields: { title: 'Dup', type: 'article', category: 'secondary' }
		};
		await merge(input);
		const claimsBefore = (await db.select().from(schema.sourceFieldClaims)).length;
		const r2 = await merge(input);
		expect(r2.status).toBe('noop');
		expect((await db.select().from(schema.sourceObservations)).length).toBe(1);
		expect((await db.select().from(schema.sourceFieldClaims)).length).toBe(claimsBefore);
	});

	// 13
	it('upstream disappearance ⇒ drift only (no delete, no field change)', async () => {
		const r1 = await merge({
			origin: 'ndl',
			originRecordId: 'ndl:123',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'ndl', value: '123' }],
			fields: { title: 'Held Record', type: 'book', category: 'secondary' }
		});
		const r2 = await merge({
			origin: 'ndl',
			originRecordId: 'ndl:123',
			derivation: 'observed',
			confidence: 0.9,
			presence: 'missing',
			identifiers: [{ kind: 'ndl', value: '123' }],
			fields: { title: 'Held Record', type: 'book', category: 'secondary' }
		});
		expect(r2.status).toBe('drift');
		const s = await getSource(r1.sourceId!);
		expect(s.driftStatus).toBe('missing');
		expect(s.status).toBe('active'); // NOT deleted
		expect(s.title).toBe('Held Record'); // unchanged
		const rec = await db.select().from(schema.sourceObservedRecords).where(and(eq(schema.sourceObservedRecords.origin, 'ndl'), eq(schema.sourceObservedRecords.originRecordId, 'ndl:123')));
		expect(rec[0].status).toBe('missing');
		expect(rec[0].missingCount).toBeGreaterThanOrEqual(1);
	});

	// 14
	it('link merge keeps existing IIIF/PDF/user links (set-union, never drops)', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:l',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:l.json' }],
			fields: { title: 'Links Source', type: 'book', category: 'secondary' },
			links: [
				{ type: 'iiif', url: 'https://iiif.example/manifest' },
				{ type: 'pdf', url: 'https://example.org/scan.pdf' },
				{ type: 'website', url: 'https://user.example/page' }
			]
		});
		expect((await linksOf(r1.sourceId!)).length).toBe(3);
		await merge({
			origin: 'crossref',
			originRecordId: 'crossref:l',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'repo_path', value: 'manual:l.json' }],
			fields: { title: 'Links Source', type: 'book', category: 'secondary' },
			links: [{ type: 'doi', url: 'https://doi.org/10.9999/z' }]
		});
		const links = await linksOf(r1.sourceId!);
		expect(links.length).toBe(4);
		const urls = new Set(links.map((l) => l.url));
		expect(urls.has('https://iiif.example/manifest')).toBe(true);
		expect(urls.has('https://example.org/scan.pdf')).toBe(true);
		expect(urls.has('https://user.example/page')).toBe(true);
		expect(urls.has('https://doi.org/10.9999/z')).toBe(true);
	});

	// 15
	it('CAS stale-writer loses cleanly under a simulated concurrent provenance change', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:cas',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:cas.json' }],
			fields: { title: 'CAS Source', type: 'book', category: 'secondary' }
		});
		const sid = r1.sourceId!;
		const prov0 = await readProvenance(db, sid, 'title');
		const stale = prov0!.currentClaimId; // the value BOTH writers read

		const [obs] = await db.select().from(schema.sourceObservations).limit(1);
		// concurrent winner commits first, advancing the row to a new claim
		const c1 = crypto.randomUUID();
		await db.insert(schema.sourceFieldClaims).values({ id: c1, observationId: obs.id, sourceId: sid, fieldName: 'title', value: 'concurrent', valueHash: 'hc1', op: 'set', rankBand: 900, rankScore: 999, status: 'applied' });
		const won = await casUpdate(db, sid, 'title', stale, { currentClaimId: c1, valueHash: 'hc1', rankBand: 900, rankScore: 999, origin: 'x', derivation: 'editorial_decision', confidence: 1, evidence: 1 });
		expect(won).toBe(true);

		// the stale writer still holds the OLD expected claim id → must lose cleanly
		const c2 = crypto.randomUUID();
		await db.insert(schema.sourceFieldClaims).values({ id: c2, observationId: obs.id, sourceId: sid, fieldName: 'title', value: 'stale', valueHash: 'hc2', op: 'set', rankBand: 800, rankScore: 500, status: 'submitted' });
		const lost = await casUpdate(db, sid, 'title', stale, { currentClaimId: c2, valueHash: 'hc2', rankBand: 800, rankScore: 500, origin: 'y', derivation: 'curated_assertion', confidence: 0.8, evidence: 0 });
		expect(lost).toBe(false); // no throw, no clobber
		expect((await readProvenance(db, sid, 'title'))!.currentClaimId).toBe(c1);
	});

	// 16
	it('set-valued fields (languages/scripts/altTitles) never drop an existing member', async () => {
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:set',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [{ kind: 'repo_path', value: 'manual:set.json' }],
			fields: { title: 'Set Source', type: 'book', category: 'secondary', languages: ['ain', 'jpn'], scripts: ['kana'], altTitles: ['Alt One'] }
		});
		await merge({
			origin: 'crossref',
			originRecordId: 'crossref:set',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'repo_path', value: 'manual:set.json' }],
			fields: { title: 'Set Source', type: 'book', category: 'secondary', languages: ['rus'], scripts: ['cyrl'], altTitles: ['Alt Two'] }
		});
		const s = await getSource(r1.sourceId!);
		expect(new Set(s.languages)).toEqual(new Set(['ain', 'jpn', 'rus']));
		expect(new Set(s.scripts)).toEqual(new Set(['kana', 'cyrl']));
		expect(new Set(s.altTitles)).toEqual(new Set(['Alt One', 'Alt Two']));
	});

	// bonus: malformed strong identifier ⇒ observation rejected (kept in ledger)
	it('malformed DOI ⇒ observation rejected, recorded, no source created', async () => {
		const r = await merge({
			origin: 'crossref',
			originRecordId: 'crossref:bad',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [{ kind: 'doi', value: 'not-a-doi' }],
			fields: { title: 'Bad', type: 'article', category: 'secondary' }
		});
		expect(r.status).toBe('rejected');
		expect(r.sourceId).toBeUndefined();
		expect((await allSources()).length).toBe(0);
		const obs = await db.select().from(schema.sourceObservations);
		expect(obs.length).toBe(1);
		expect(obs[0].status).toBe('rejected'); // kept in the ledger, no loss
	});

	// FIX 1 (Codex B1) — an explicit delete must go through CAS like any other
	// claim: a LOW-band machine delete is HELD and must NOT clear a curated value,
	// while an editorial delete WINS and clears it. (Uses `summary`, a nullable
	// scalar — `title` is NOT NULL so clearing it is an orthogonal concern.)
	it('explicit delete is CAS-gated: low-band HELD (value kept), editorial APPLIED (cleared)', async () => {
		const id = { kind: 'repo_path', value: 'manual:del.json' };
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:del',
			derivation: 'curated_assertion', // band 800
			confidence: 0.8,
			identifiers: [id],
			fields: { title: 'Keep Title', summary: 'Curated summary', type: 'book', category: 'secondary' }
		});
		const sid = r1.sourceId!;
		expect((await getSource(sid)).summary).toBe('Curated summary');

		// low-band machine delete of `summary` → must be HELD by CAS, value preserved
		const r2 = await merge({
			origin: 'openalex',
			originRecordId: 'openalex:del',
			derivation: 'observed', // band 700 < 800 (higher score, lower band)
			confidence: 0.99,
			identifiers: [id],
			explicitDeletes: ['summary']
		});
		expect(r2.heldClaims.some((c) => c.fieldName === 'summary')).toBe(true);
		expect(r2.appliedClaims.some((c) => c.fieldName === 'summary')).toBe(false);
		expect((await getSource(sid)).summary).toBe('Curated summary'); // UNCHANGED — delete held
		expect((await readProvenance(db, sid, 'summary'))!.rankBand).toBe(800); // curated still the winner

		// editorial delete → WINS CAS → field cleared
		const r3 = await merge({
			origin: 'website',
			originRecordId: `website:${sid}`,
			derivation: 'editorial_decision', // band 900 > 800
			confidence: 1.0,
			identifiers: [id],
			explicitDeletes: ['summary']
		});
		expect(r3.appliedClaims.some((c) => c.fieldName === 'summary')).toBe(true);
		expect((await getSource(sid)).summary).toBeNull(); // cleared — editorial wins
	});

	// FIX 2 (Codex/Fugu B2) — a note that appends BELOW the current winner must not
	// downgrade the provenance rank, otherwise a later same-band note can REPLACE the
	// whole field and drop the original editorial text.
	it('below-band notes append keeps the editorial text and does NOT downgrade rank', async () => {
		const id = { kind: 'repo_path', value: 'manual:notes.json' };
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:notes',
			derivation: 'editorial_decision', // band 900
			confidence: 0.5,
			identifiers: [id],
			fields: { title: 'Notes Source', type: 'book', category: 'secondary', notes: 'EDITORIAL_A' }
		});
		const sid = r1.sourceId!;
		expect((await getSource(sid)).notes).toBe('EDITORIAL_A');
		expect((await readProvenance(db, sid, 'notes'))!.rankBand).toBe(EDITORIAL_BAND);

		// low-band observed note B → appends below; rank must stay at the editorial high-water mark
		await merge({
			origin: 'openalex',
			originRecordId: 'openalex:notesB',
			derivation: 'observed', // band 700, low score
			confidence: 0.5,
			evidence: 0,
			identifiers: [id],
			fields: { notes: 'MACHINE_B' }
		});
		const afterB = await getSource(sid);
		expect(afterB.notes).toContain('EDITORIAL_A'); // preserved (appended)
		expect(afterB.notes).toContain('MACHINE_B');
		expect((await readProvenance(db, sid, 'notes'))!.rankBand).toBe(EDITORIAL_BAND); // NOT downgraded

		// a SUBSEQUENT band-700 note with a HIGH score — would WIN a 700-vs-700 tie and
		// REPLACE the field if the rank had been downgraded to 700 by note B.
		await merge({
			origin: 'crossref',
			originRecordId: 'crossref:notesC',
			derivation: 'observed', // band 700
			confidence: 1.0,
			evidence: 5, // max machine score
			identifiers: [id],
			fields: { notes: 'MACHINE_C' }
		});
		const afterC = await getSource(sid);
		expect(afterC.notes).toContain('EDITORIAL_A'); // STILL preserved — no replacement
		expect(afterC.notes).toContain('MACHINE_C');
		expect((await readProvenance(db, sid, 'notes'))!.rankBand).toBe(EDITORIAL_BAND);
	});

	// FIX 3 (cutover blocker) — a set_union field is additive for machine claims but
	// an editorial_decision REPLACES it exactly, so an editor removing a wrong member
	// actually takes effect (not a silent no-op / N4 violation).
	it('editorial_decision REPLACES a set_union field (removal sticks); machine stays additive', async () => {
		const id = { kind: 'repo_path', value: 'manual:langs.json' };
		const r1 = await merge({
			origin: 'manual',
			originRecordId: 'manual:langs',
			derivation: 'curated_assertion',
			confidence: 0.8,
			identifiers: [id],
			fields: { title: 'Langs Source', type: 'book', category: 'secondary', languages: ['ain'] }
		});
		const sid = r1.sourceId!;
		// machine adds jpn via union (some members are machine-added)
		await merge({
			origin: 'openalex',
			originRecordId: 'openalex:langs',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [id],
			fields: { languages: ['jpn'] }
		});
		expect(new Set((await getSource(sid)).languages)).toEqual(new Set(['ain', 'jpn']));

		// editorial de-selects jpn → languages becomes EXACTLY ['ain']
		const r3 = await merge({
			origin: 'website',
			originRecordId: `website:${sid}`,
			derivation: 'editorial_decision',
			confidence: 1.0,
			identifiers: [id],
			fields: { languages: ['ain'] }
		});
		expect(r3.appliedClaims.some((c) => c.fieldName === 'languages')).toBe(true);
		const edited = await getSource(sid);
		expect(new Set(edited.languages)).toEqual(new Set(['ain'])); // jpn REMOVED — not a silent no-op
		expect(edited.languages).not.toContain('jpn');

		// a later machine claim is still ADDITIVE against the editorial baseline
		await merge({
			origin: 'crossref',
			originRecordId: 'crossref:langs',
			derivation: 'observed',
			confidence: 0.9,
			identifiers: [id],
			fields: { languages: ['rus'] }
		});
		const final = await getSource(sid);
		expect(new Set(final.languages)).toEqual(new Set(['ain', 'rus'])); // rus added, jpn stays removed
	});
});

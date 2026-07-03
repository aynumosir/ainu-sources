/**
 * Website write-path cutover tests (§ phase-6).
 *
 * These run the REAL `createSourceViaMerge` / `updateSourceViaMerge` (the
 * functions the edit form + write API call) against an isolated libSQL
 * in-memory database built from the drizzle migrations — so the engine, ledger,
 * CAS, identity resolution, tag/link reconcile and revision history are all
 * exercised end to end.
 *
 * The headline guarantee proven here: a NORMAL on-site edit produces the SAME
 * projected `sources` row + links + tags as the PRE-cutover write path would
 * have (editorial_decision wins → the user's value applies), and nothing is
 * silently discarded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { slugify } from '$lib/format';
import { projectSource } from './golden';
import { scalarValues, type SourceInput, type EditUser } from './queries';
import { mergeSourceObservation } from './merge';
import { createSourceViaMerge, updateSourceViaMerge, mergeNotice } from './merge-write';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));
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

const USER: EditUser = { id: 'u1', name: 'Editor One' };

// --- builders --------------------------------------------------------------

/** A full SourceInput as the form would submit it (every field present). */
function makeInput(over: Partial<SourceInput> = {}): SourceInput {
	return {
		title: 'Seed Title',
		titleEn: null,
		titleAin: null,
		category: 'primary',
		type: 'dictionary',
		author: null,
		yearText: null,
		yearStart: null,
		yearEnd: null,
		yearCertainty: 'exact',
		dialect: null,
		region: null,
		languages: [],
		scripts: [],
		holdingInstitution: null,
		callNumber: null,
		entryCount: null,
		entryCountLabel: null,
		license: null,
		summary: null,
		notes: null,
		reliability: null,
		links: [],
		tagNames: [],
		...over
	};
}

/** Seed a "bootstrapped-style" source WITH ledger rows (claims + provenance),
 *  the way a collector/harvester writes it — the realistic starting point an
 *  on-site editorial edit lands on. */
async function seedLedgerSource(opts: {
	origin?: string;
	derivation?: string;
	confidence?: number;
	fields: Record<string, unknown>;
	links?: { type: string; url: string; label?: string | null }[];
}): Promise<string> {
	const r = await mergeSourceObservation(db, {
		origin: opts.origin ?? 'ainu-dictionaries',
		originRecordId: 'seed:' + crypto.randomUUID(),
		derivation: opts.derivation ?? 'curated_assertion',
		confidence: opts.confidence ?? 0.8,
		identifiers: [{ kind: 'repo_path', value: 'seed-' + crypto.randomUUID() + '.json' }],
		fields: opts.fields,
		links: opts.links
	});
	if (!r.sourceId) throw new Error('seed failed: ' + JSON.stringify(r));
	return r.sourceId;
}

async function getSource(id: string) {
	const [s] = await db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1);
	return s;
}
async function linksOf(id: string) {
	return db.select().from(schema.sourceLinks).where(eq(schema.sourceLinks.sourceId, id));
}
async function tagNamesOf(id: string): Promise<string[]> {
	const rows = await db
		.select({ name: schema.tags.name })
		.from(schema.sourceTags)
		.innerJoin(schema.tags, eq(schema.sourceTags.tagId, schema.tags.id))
		.where(eq(schema.sourceTags.sourceId, id));
	return rows.map((r) => r.name).sort();
}
async function provenanceOf(id: string, field: string) {
	const [p] = await db
		.select()
		.from(schema.sourceFieldProvenance)
		.where(and(eq(schema.sourceFieldProvenance.sourceId, id), eq(schema.sourceFieldProvenance.fieldName, field)))
		.limit(1);
	return p;
}
async function revisionsOf(id: string) {
	return db.select().from(schema.sourceRevisions).where(eq(schema.sourceRevisions.sourceId, id));
}

// ---------------------------------------------------------------------------
// 1. Editing a scalar field — projection updates, revision written, the
//    field_provenance winner is the editorial claim.
// ---------------------------------------------------------------------------
describe('cutover — scalar edit', () => {
	it('an editorial scalar edit applies, records a revision, and wins provenance', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Seed Title', type: 'dictionary', category: 'primary', summary: 'original summary' }
		});

		const { slug, result } = await updateSourceViaMerge(
			db,
			id,
			makeInput({ summary: 'a freshly edited summary' }),
			USER,
			'fix the summary'
		);

		expect(slug).toBeTruthy();
		expect(result.sourceId).toBe(id); // attached, did NOT fork
		expect(mergeNotice(result)).toBeNull(); // clean apply → redirect path

		// projection updated to the user's value
		expect((await getSource(id)).summary).toBe('a freshly edited summary');

		// the winning provenance is the editorial claim (band 900)
		const prov = await provenanceOf(id, 'summary');
		expect(prov.derivation).toBe('editorial_decision');
		expect(prov.rankBand).toBe(900);

		// a revision is recorded, attributed to the real user + summary
		const revs = await revisionsOf(id);
		const editRev = revs.find((r) => r.action === 'update');
		expect(editRev).toBeDefined();
		expect(editRev!.userId).toBe('u1');
		expect(editRev!.userName).toBe('Editor One');
		expect(editRev!.summary).toBe('fix the summary');
	});

	it('clearing a previously-set field clears it (explicit delete, not held)', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Seed Title', type: 'dictionary', category: 'primary', author: 'Some Author' }
		});
		const { result } = await updateSourceViaMerge(db, id, makeInput({ author: null }), USER);
		expect(mergeNotice(result)).toBeNull();
		expect((await getSource(id)).author).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. Editing over a pre-existing MACHINE claim — the editorial edit still wins.
// ---------------------------------------------------------------------------
describe('cutover — editorial beats machine', () => {
	it('an editorial title edit wins over a prior observed (machine) claim', async () => {
		const id = await seedLedgerSource({
			origin: 'crossref',
			derivation: 'observed',
			confidence: 0.99,
			fields: { title: 'Machine Title', type: 'article', category: 'secondary' }
		});
		// sanity: the seed's title provenance is a machine band
		expect((await provenanceOf(id, 'title')).derivation).toBe('observed');

		await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Human Title', type: 'article', category: 'secondary' }),
			USER
		);

		expect((await getSource(id)).title).toBe('Human Title');
		expect((await provenanceOf(id, 'title')).derivation).toBe('editorial_decision');
	});
});

// ---------------------------------------------------------------------------
// 2b. Editing a set field (languages/scripts) to REMOVE a member now actually
//     removes it. An editorial_decision REPLACES the member set (#34), so a
//     de-selected member is dropped from the projection — under the OLD additive-
//     only set-union this was a silent no-op (the cutover blocker the reviews
//     flagged). Persistent removal is by design an editorial act: the underlying
//     claims are never erased (no-loss), and a later LOWER-band machine harvest
//     unions below the editorial winner, so it may re-ADD a member but can never
//     drop one.
// ---------------------------------------------------------------------------
describe('cutover — set member removal (editorial replace)', () => {
	it('de-selecting a language member removes it from the projection', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Multi', type: 'book', category: 'secondary', languages: ['ain', 'jpn'] }
		});
		expect([...((await getSource(id)).languages as string[])].sort()).toEqual(['ain', 'jpn']);

		// the form resubmits the intended set WITHOUT 'jpn'
		const { result } = await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Multi', type: 'book', category: 'secondary', languages: ['ain'] }),
			USER
		);
		expect(mergeNotice(result)).toBeNull();

		// 'jpn' is GONE — the editorial set REPLACED the prior union (no longer a no-op)
		expect((await getSource(id)).languages).toEqual(['ain']);
		// the winning provenance is the editorial claim
		expect((await provenanceOf(id, 'languages')).derivation).toBe('editorial_decision');
	});

	it('the same removal works for scripts', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Multi', type: 'book', category: 'secondary', scripts: ['latn', 'kana'] }
		});
		await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Multi', type: 'book', category: 'secondary', scripts: ['latn'] }),
			USER
		);
		expect((await getSource(id)).scripts).toEqual(['latn']);
	});

	it('a later LOWER-band machine harvest unions below the editorial winner (re-adds, never drops)', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Multi', type: 'book', category: 'secondary', languages: ['ain', 'jpn'] }
		});
		// editorial removes 'jpn'
		await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Multi', type: 'book', category: 'secondary', languages: ['ain'] }),
			USER
		);
		expect((await getSource(id)).languages).toEqual(['ain']);

		// a machine harvest re-asserts ['rus'] (pinned to the same source here):
		// set-union is rank-agnostic, so it ADDS below the editorial winner.
		await mergeSourceObservation(db, {
			origin: 'crossref',
			originRecordId: 'machine:set:' + crypto.randomUUID(),
			derivation: 'observed',
			confidence: 0.9,
			targetSourceId: id,
			fields: { languages: ['rus'] }
		});
		expect([...((await getSource(id)).languages as string[])].sort()).toEqual(['ain', 'rus']);
	});
});

// ---------------------------------------------------------------------------
// 2c. Editing `notes` to a new value: the editorial note REPLACES a lower-band
//     note AND the field's provenance rank stays editorial (the #34 no-downgrade
//     fix). Because the rank is NOT downgraded on a subsequent append, a later
//     machine note can only APPEND below — it can never clobber the human note.
// ---------------------------------------------------------------------------
describe('cutover — notes replace + no machine clobber', () => {
	it('an editorial notes edit replaces a machine note and lifts the rank to editorial', async () => {
		const id = await seedLedgerSource({
			origin: 'crossref',
			derivation: 'observed',
			confidence: 0.9,
			fields: { title: 'Noted', type: 'article', category: 'secondary', notes: 'machine note' }
		});
		expect((await getSource(id)).notes).toBe('machine note');
		expect((await provenanceOf(id, 'notes')).rankBand).toBe(700); // machine band

		const { result } = await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Noted', type: 'article', category: 'secondary', notes: 'human note' }),
			USER
		);
		expect(mergeNotice(result)).toBeNull();

		// REPLACED (not 'machine note\n\nhuman note') — editorial outranks the machine band
		expect((await getSource(id)).notes).toBe('human note');
		const prov = await provenanceOf(id, 'notes');
		expect(prov.derivation).toBe('editorial_decision');
		expect(prov.rankBand).toBe(900);
	});

	it('a later machine note appends below and can NEVER clobber the editorial note', async () => {
		const id = await seedLedgerSource({ fields: { title: 'Noted', type: 'article', category: 'secondary' } });
		await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Noted', type: 'article', category: 'secondary', notes: 'human note' }),
			USER
		);
		expect((await getSource(id)).notes).toBe('human note');

		// machine note #1 — appends BELOW; the #34 fix keeps the rank at editorial
		await mergeSourceObservation(db, {
			origin: 'crossref',
			originRecordId: 'machine:note1:' + crypto.randomUUID(),
			derivation: 'observed',
			confidence: 0.99,
			targetSourceId: id,
			fields: { notes: 'machine note one' }
		});
		expect((await getSource(id)).notes).toContain('human note');
		expect((await provenanceOf(id, 'notes')).rankBand).toBe(900); // NOT downgraded to 700 (#34)

		// machine note #2 — because the rank stayed editorial, a different machine
		// source still cannot WIN and replace the field, so the human note survives.
		await mergeSourceObservation(db, {
			origin: 'openalex',
			originRecordId: 'machine:note2:' + crypto.randomUUID(),
			derivation: 'observed',
			confidence: 0.99,
			targetSourceId: id,
			fields: { notes: 'machine note two' }
		});
		expect((await getSource(id)).notes).toContain('human note'); // never dropped
		expect((await provenanceOf(id, 'notes')).rankBand).toBe(900);
	});
});

// ---------------------------------------------------------------------------
// 3 & 4. Links flow through the engine — add appears + collector link preserved;
//        remove is honored + an untouched collector link survives.
// ---------------------------------------------------------------------------
describe('cutover — links', () => {
	it('adding a link appears and a pre-existing collector link is preserved', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Linky', type: 'book', category: 'secondary' },
			links: [{ type: 'iiif', url: 'https://iiif.example/manifest' }]
		});
		expect((await linksOf(id)).length).toBe(1);

		// the form resubmits the existing collector link AND adds a new one
		await updateSourceViaMerge(
			db,
			id,
			makeInput({
				title: 'Linky',
				type: 'book',
				category: 'secondary',
				links: [
					{ type: 'iiif', url: 'https://iiif.example/manifest', label: null },
					{ type: 'website', url: 'https://user.example/added', label: 'Added' }
				]
			}),
			USER
		);

		const urls = new Set((await linksOf(id)).map((l) => l.url));
		expect(urls.has('https://iiif.example/manifest')).toBe(true); // collector link kept
		expect(urls.has('https://user.example/added')).toBe(true); // new link added
	});

	it('removing a link is honored; a collector link the user did not touch survives', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Linky', type: 'book', category: 'secondary' },
			links: [
				{ type: 'iiif', url: 'https://iiif.example/manifest' },
				{ type: 'pdf', url: 'https://example.org/scan.pdf' }
			]
		});
		expect((await linksOf(id)).length).toBe(2);

		// the user drops the pdf, keeps (resubmits) the iiif link
		await updateSourceViaMerge(
			db,
			id,
			makeInput({
				title: 'Linky',
				type: 'book',
				category: 'secondary',
				links: [{ type: 'iiif', url: 'https://iiif.example/manifest', label: null }]
			}),
			USER
		);

		const urls = (await linksOf(id)).map((l) => l.url);
		expect(urls).toEqual(['https://iiif.example/manifest']); // pdf removed, iiif survives
	});

	it('tags are reconciled (added + removed) by the website path', async () => {
		const id = await seedLedgerSource({ fields: { title: 'Tagged', type: 'book', category: 'secondary' } });
		await updateSourceViaMerge(db, id, makeInput({ title: 'Tagged', type: 'book', category: 'secondary', tagNames: ['placenames', 'grammar'] }), USER);
		expect(await tagNamesOf(id)).toEqual(['grammar', 'placenames']);
		// drop one, keep one
		await updateSourceViaMerge(db, id, makeInput({ title: 'Tagged', type: 'book', category: 'secondary', tagNames: ['grammar'] }), USER);
		expect(await tagNamesOf(id)).toEqual(['grammar']);
	});
});

// ---------------------------------------------------------------------------
// 5. Creating a new source — source + claims + provenance + golden projection.
// ---------------------------------------------------------------------------
describe('cutover — create', () => {
	it('creates an active source with claims, provenance, and a correct projection', async () => {
		const input = makeInput({
			title: '辞典',
			titleEn: 'A Brand New Dictionary',
			type: 'dictionary',
			category: 'primary',
			author: 'New Author',
			yearStart: 1901,
			yearText: '1901',
			languages: ['ain', 'jpn'],
			summary: 'a created source',
			links: [{ type: 'pdf', url: 'https://example.org/new.pdf', label: 'PDF' }],
			tagNames: ['lexicon']
		});

		const { slug, result } = await createSourceViaMerge(db, input, USER, 'first import');
		expect(result.sourceId).toBeTruthy();
		const id = result.sourceId!;
		expect(mergeNotice(result)).toBeNull();

		const s = await getSource(id);
		expect(s.status).toBe('active');
		expect(s.title).toBe('辞典');
		expect(s.titleEn).toBe('A Brand New Dictionary');
		expect(s.author).toBe('New Author');
		expect(s.yearStart).toBe(1901);
		expect(s.createdBy).toBe('u1');
		expect(s.updatedBy).toBe('u1');
		// slug derives from titleEn (matches the prior createSource behavior)
		expect(slug).toBe(slugify('A Brand New Dictionary'));
		expect(s.slug).toBe(slug);

		// claims + provenance written (editorial)
		const titleProv = await provenanceOf(id, 'title');
		expect(titleProv.derivation).toBe('editorial_decision');
		const claims = await db.select().from(schema.sourceFieldClaims).where(eq(schema.sourceFieldClaims.sourceId, id));
		expect(claims.some((c) => c.fieldName === 'title')).toBe(true);

		// golden projection reflects the submitted data
		const projection = projectSource({
			source: s as unknown as Record<string, unknown>,
			links: await linksOf(id),
			tags: await tagNamesOf(id)
		});
		expect(projection.title).toBe('辞典');
		expect(projection.titleEn).toBe('A Brand New Dictionary');
		expect(projection.languages).toEqual(['ain', 'jpn']);
		expect(projection.links).toEqual([
			{ type: 'pdf', label: 'PDF', url: 'https://example.org/new.pdf', sortOrder: 0 }
		]);
		expect(projection.tags).toEqual(['lexicon']);

		// a create revision is recorded
		const revs = await revisionsOf(id);
		expect(revs.length).toBe(1);
		expect(revs[0].action).toBe('create');
		expect(revs[0].userName).toBe('Editor One');
		expect(revs[0].summary).toBe('first import');
	});
});

// ---------------------------------------------------------------------------
// 5b. Slug minting on create: an explicit slug wins over derivation; the
//     fallback TRANSLITERATES (kana→romaji, Cyrillic→Latin) instead of
//     degrading to machine garbage; the id-suffix last resort fires ONLY
//     when too little real material remains (e.g. an all-kanji title).
// ---------------------------------------------------------------------------
describe('cutover — slug minting on create', () => {
	it('mints an explicit slug verbatim (wins over title derivation)', async () => {
		const { slug } = await createSourceViaMerge(
			db,
			makeInput({ title: 'アイヌ語法概説', slug: '1936-chiri-ainu-gohou' }),
			USER
		);
		expect(slug).toBe('1936-chiri-ainu-gohou');
	});

	it('transliterates a kana title when no explicit slug is given', async () => {
		const { slug } = await createSourceViaMerge(db, makeInput({ title: 'アイヌタイムズ' }), USER);
		expect(slug).toBe('ainutaimuzu');
	});

	it('adds the id-suffix last resort ONLY when too little transliterates', async () => {
		// all-kanji title: slugify skips kanji spans entirely → no material
		const { slug } = await createSourceViaMerge(db, makeInput({ title: '言語学概論' }), USER);
		expect(slug).toMatch(/^source-[0-9a-f]{8}$/);
		// short-but-real material (アイヌ → 'ainu', 4 < 6 chars) keeps the material
		const { slug: short } = await createSourceViaMerge(db, makeInput({ title: 'アイヌ語辞典' }), USER);
		expect(short).toMatch(/^ainu-[0-9a-f]{8}$/);
	});
});

// ---------------------------------------------------------------------------
// 6. The held/conflict path is reachable AND surfaced (N4: never silent).
//    Simulated by a higher-rank existing claim than even an editorial edit.
// ---------------------------------------------------------------------------
describe('cutover — held edit is surfaced, never silently discarded', () => {
	it('an edit held below a higher-confidence value is reported and does not clobber', async () => {
		const id = await seedLedgerSource({
			fields: { title: 'Locked', type: 'book', category: 'secondary', summary: 'locked summary' }
		});
		// Simulate a value pinned ABOVE the editorial band (e.g. a future
		// higher-confidence source) on the `summary` field.
		await db
			.update(schema.sourceFieldProvenance)
			.set({ rankBand: 950 })
			.where(and(eq(schema.sourceFieldProvenance.sourceId, id), eq(schema.sourceFieldProvenance.fieldName, 'summary')));

		const { result } = await updateSourceViaMerge(
			db,
			id,
			makeInput({ title: 'Locked', type: 'book', category: 'secondary', summary: 'I tried to change it' }),
			USER
		);

		// surfaced, not silently dropped
		expect(result.heldClaims.some((c) => c.fieldName === 'summary')).toBe(true);
		const notice = mergeNotice(result);
		expect(notice).toBeTruthy();
		expect(notice).toContain('summary');
		// the pinned value is unchanged
		expect((await getSource(id)).summary).toBe('locked summary');
	});
});

// ---------------------------------------------------------------------------
// 7. EQUIVALENCE: a normal edit through the cutover yields the SAME projected
//    sources row + links + tags as the PRE-cutover write path would have —
//    INCLUDING the two cases that diverged under the old engine and are fixed by
//    #34: removing a set member (languages: ['ain','jpn'] → ['ain']) and changing
//    `notes` to a new value (replace, not append). Both now match the legacy
//    direct-write semantics.
// ---------------------------------------------------------------------------
describe('cutover — normal-edit equivalence with the pre-cutover write path', () => {
	/** Replica of the PRE-cutover updateSource: write scalarValues + reconcile
	 *  links/tags directly (the exact behavior the cutover must preserve). */
	async function legacyApply(id: string, input: SourceInput): Promise<void> {
		await db
			.update(schema.sources)
			.set({ ...scalarValues(input), updatedBy: USER.id ?? null, updatedAt: new Date() })
			.where(eq(schema.sources.id, id));
		// links (writeLinksAndTags replica)
		const existingLinks = await db.select().from(schema.sourceLinks).where(eq(schema.sourceLinks.sourceId, id));
		const key = (t: string, u: string) => `${t}\n${u}`;
		const byKey = new Map(existingLinks.map((l) => [key(l.type, l.url), l]));
		const incoming = new Map<string, { type: string; url: string; label: string | null; sortOrder: number }>();
		(input.links ?? [])
			.filter((l) => l.url?.trim())
			.forEach((l, i) => {
				const type = l.type || 'website';
				const url = l.url.trim();
				incoming.set(key(type, url), { type, url, label: l.label?.trim() || null, sortOrder: incoming.get(key(type, url))?.sortOrder ?? i });
			});
		for (const l of incoming.values()) {
			const ex = byKey.get(key(l.type, l.url));
			if (ex) await db.update(schema.sourceLinks).set({ label: l.label, sortOrder: l.sortOrder }).where(eq(schema.sourceLinks.id, ex.id));
			else await db.insert(schema.sourceLinks).values({ sourceId: id, type: l.type, label: l.label, url: l.url, sortOrder: l.sortOrder });
		}
		for (const l of existingLinks) if (!incoming.has(key(l.type, l.url))) await db.delete(schema.sourceLinks).where(eq(schema.sourceLinks.id, l.id));
		// tags
		const existingTags = await db.select({ id: schema.sourceTags.id, tagId: schema.sourceTags.tagId }).from(schema.sourceTags).where(eq(schema.sourceTags.sourceId, id));
		const existingByTag = new Map(existingTags.map((r) => [r.tagId, r.id]));
		const desired: string[] = [];
		for (const raw of input.tagNames ?? []) {
			const name = raw.trim();
			if (!name) continue;
			const tslug = slugify(name) || name;
			const [t] = await db.select().from(schema.tags).where(eq(schema.tags.slug, tslug)).limit(1);
			if (t) desired.push(t.id);
			else {
				const tid = crypto.randomUUID();
				await db.insert(schema.tags).values({ id: tid, slug: tslug, name, category: 'topic' });
				desired.push(tid);
			}
		}
		const desiredSet = new Set(desired);
		for (const tid of desiredSet) if (!existingByTag.has(tid)) await db.insert(schema.sourceTags).values({ sourceId: id, tagId: tid });
		for (const [tid, rowId] of existingByTag) if (!desiredSet.has(tid)) await db.delete(schema.sourceTags).where(eq(schema.sourceTags.id, rowId));
	}

	/** Seed an identical plain source (no ledger) — a legacy/bootstrapped row. */
	async function seedTwin(slug: string): Promise<string> {
		const id = crypto.randomUUID();
		await db.insert(schema.sources).values({
			id,
			slug,
			title: 'Twin Title',
			titleEn: 'Twin Title EN',
			category: 'primary',
			type: 'dictionary',
			author: 'Old Author',
			region: 'hokkaido',
			languages: ['ain', 'jpn'],
			summary: 'old summary',
			notes: 'stable notes',
			provenanceRepo: 'manual',
			createdBy: 'u0',
			updatedBy: 'u0'
		});
		await db.insert(schema.sourceLinks).values({ sourceId: id, type: 'pdf', url: 'https://example.org/twin.pdf', label: 'Scan', sortOrder: 0 });
		// shared 'lexicon' tag (unique slug) — create once, reuse across twins
		let [tag] = await db.select().from(schema.tags).where(eq(schema.tags.slug, 'lexicon')).limit(1);
		if (!tag) {
			const tagId = crypto.randomUUID();
			await db.insert(schema.tags).values({ id: tagId, slug: 'lexicon', name: 'lexicon', category: 'topic' });
			[tag] = await db.select().from(schema.tags).where(eq(schema.tags.slug, 'lexicon')).limit(1);
		}
		await db.insert(schema.sourceTags).values({ sourceId: id, tagId: tag.id });
		return id;
	}

	async function projectionOf(id: string) {
		const s = await getSource(id);
		return projectSource({
			source: s as unknown as Record<string, unknown>,
			links: await linksOf(id),
			tags: await tagNamesOf(id)
		});
	}
	function stripVolatile(p: Record<string, unknown>) {
		const { id, slug, createdAt, updatedAt, ...rest } = p;
		void id;
		void slug;
		void createdAt;
		void updatedAt;
		return rest;
	}

	it('produces a byte-identical substantive projection vs the legacy path (incl. set removal + notes replace)', async () => {
		const oldId = await seedTwin('twin-old');
		const newId = await seedTwin('twin-new');

		// a normal edit: change scalar/controlled fields, REMOVE a set member
		// ('jpn' dropped from languages) and CHANGE notes to a new value — the two
		// cases that used to diverge from the legacy path before #34.
		const edit = (): SourceInput =>
			makeInput({
				title: 'Edited Title',
				titleEn: 'Twin Title EN',
				category: 'primary',
				type: 'dictionary',
				author: 'New Author',
				region: 'sakhalin',
				languages: ['ain'], // 'jpn' de-selected — a set-member removal
				summary: 'a fresh summary',
				notes: 'a freshly edited notes body', // notes replaced, not appended
				links: [{ type: 'pdf', url: 'https://example.org/twin.pdf', label: 'Scan' }],
				tagNames: ['lexicon']
			});

		await legacyApply(oldId, edit());
		const { result } = await updateSourceViaMerge(db, newId, edit(), USER);
		expect(mergeNotice(result)).toBeNull();

		const legacy = stripVolatile(await projectionOf(oldId));
		const merged = stripVolatile(await projectionOf(newId));
		expect(merged).toEqual(legacy);

		// and the edited values actually took effect (sanity), including the
		// previously-divergent set-member removal + notes replace now matching legacy
		expect((await getSource(newId)).title).toBe('Edited Title');
		expect((await getSource(newId)).region).toBe('sakhalin');
		expect((await getSource(newId)).languages).toEqual(['ain']); // 'jpn' removed
		expect((await getSource(newId)).notes).toBe('a freshly edited notes body'); // replaced
	});
});

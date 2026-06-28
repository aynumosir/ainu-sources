/**
 * Website write path — the create/update "cutover".
 *
 * The on-site edit form and the token-gated write API used to mutate `sources`,
 * `source_links` and `source_tags` directly (see the now-removed
 * `writeLinksAndTags` in queries.ts). They now route every create/update through
 * the provenance-aware merge engine (`mergeSourceObservation`) as an
 * `editorial_decision` observation, so a deliberate on-site edit WINS over any
 * machine claim (the N4 guarantee) while harvested data is preserved no-loss.
 *
 * What the engine owns after this cutover:
 *   • scalar / controlled / set fields  → field claims + band-rank CAS apply
 *   • digital links                      → set-union (never drops a collector link)
 *   • the flat `sources` projection      → projectAndStore
 *   • a source_revisions row             → written by the engine (we then re-stamp
 *                                          it with the real user + summary)
 *
 * What the website path still owns (the engine has no mechanism for these):
 *   • TAGS                — the engine has NO tag observation; we reconcile them
 *                           directly (add new, drop removed) exactly as before.
 *   • LINK REMOVAL / label — the engine's set-union is additive-only; the form's
 *                           contract is "submit the full intended set" (an
 *                           omitted link is a removal), so we explicitly remove
 *                           the links the user dropped and re-stamp label/sortOrder.
 *   • createdBy / updatedBy — the engine does not set these audit columns.
 *
 * How an edit attaches to ITS source: `resolveIdentity` matches by identifier /
 * substantive content, NOT by `originRecordId`, so a title edit would otherwise
 * fork a new source. We give every edited source a stable internal
 * `repo_path = website:<id>` identifier and pass it on the observation, so the
 * edit attaches via `repo_path_exact` regardless of which fields changed.
 */
import { and, desc, eq } from 'drizzle-orm';
import { slugify } from '$lib/format';
import { safeUrl } from '$lib/safe-url';
import { db as appDb } from './db';
import {
	sources,
	sourceLinks,
	sourceTags,
	sourceIdentifiers,
	sourceRevisions,
	tags,
	type Source
} from './db/schema';
import { mergeSourceObservation } from './merge';
import type { Db, MergeInput, MergeResult, LinkInput } from './merge';
import type { SourceInput, EditUser } from './queries';

export interface WebsiteEditResult {
	/** The source's slug (for the post-save redirect). Empty only if no source
	 *  was materialized (a rejected creation). */
	slug: string;
	/** The full merge outcome — surfaced to the form action / API verbatim. */
	result: MergeResult;
}

// ---------------------------------------------------------------------------
// Field mapping: SourceInput → the engine's observation payload
// ---------------------------------------------------------------------------

/** Optional text / enum scalar columns. Empty + currently-set ⇒ explicit clear. */
const EDIT_TEXT_FIELDS = [
	'titleEn',
	'titleAin',
	'author',
	'yearText',
	'dialect',
	'region',
	'holdingInstitution',
	'callNumber',
	'entryCountLabel',
	'license',
	'summary',
	'notes',
	'reliability'
] as const;

/** Integer scalar columns. Null + currently-set ⇒ explicit clear. */
const EDIT_INT_FIELDS = ['yearStart', 'yearEnd', 'entryCount'] as const;

/**
 * Build the engine `fields` map + `explicitDeletes` list from a submitted form,
 * reproducing today's `scalarValues()` semantics:
 *   • a non-empty value sets the field,
 *   • an empty value that previously HELD a value is an explicit clear (→ null),
 *   • `yearCertainty` defaults to 'exact' (never cleared),
 *   • set fields (languages/scripts) are passed when present: the engine applies
 *     them as an editorial REPLACE of the member set (#34), so de-selecting a
 *     member (a partial removal) actually takes effect — it is no longer a silent
 *     no-op. The one removal NOT expressible this way is a FULL clear (an empty
 *     set): the engine deliberately never clears a set field, so the prior members
 *     are retained. Clearing every member is therefore the lone set behavior that
 *     diverges from the legacy direct-write — an engine limitation, by design.
 */
function buildObservation(
	input: SourceInput,
	current: Source | null
): { fields: Record<string, unknown>; explicitDeletes: string[] } {
	const fields: Record<string, unknown> = {};
	const explicitDeletes: string[] = [];
	const cur = current as Record<string, unknown> | null;
	const isSet = (v: unknown) => v != null && String(v).trim() !== '';

	// required / always-present
	fields.title = input.title;
	fields.category = input.category;
	fields.type = input.type;
	fields.yearCertainty = input.yearCertainty || 'exact';

	const raw = input as unknown as Record<string, unknown>;
	for (const f of EDIT_TEXT_FIELDS) {
		const v0 = raw[f];
		const v = typeof v0 === 'string' ? v0.trim() : v0;
		if (v != null && v !== '') fields[f] = v;
		else if (cur && isSet(cur[f])) explicitDeletes.push(f);
	}
	for (const f of EDIT_INT_FIELDS) {
		const v0 = raw[f];
		const v = typeof v0 === 'number' && Number.isFinite(v0) ? v0 : null;
		if (v != null) fields[f] = v;
		else if (cur && cur[f] != null) explicitDeletes.push(f);
	}

	// set fields — editorial REPLACES the member set (#34): submitting a smaller
	// set drops the de-selected member (a partial removal sticks). An empty set is
	// not passed — the engine never clears a set field, so a full clear is the one
	// removal it cannot express (the prior members are kept).
	if (input.languages?.length) fields.languages = input.languages;
	if (input.scripts?.length) fields.scripts = input.scripts;

	return { fields, explicitDeletes };
}

/** Normalize the submitted links to the engine's `LinkInput` shape. */
function toLinkInputs(input: SourceInput): LinkInput[] {
	return (input.links ?? [])
		.filter((l) => l.url?.trim())
		.map((l) => ({ type: l.type || 'website', url: l.url.trim(), label: l.label?.trim() || null }));
}

// ---------------------------------------------------------------------------
// Tags — the engine has no tag observation; reconciled here (add new, drop removed)
// ---------------------------------------------------------------------------

async function tagIdsFor(db: Db, names: string[]): Promise<string[]> {
	const ids: string[] = [];
	for (const rawName of names) {
		const name = rawName.trim();
		if (!name) continue;
		const slug = slugify(name) || name;
		const [existing] = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1);
		if (existing) {
			ids.push(existing.id);
		} else {
			const id = crypto.randomUUID();
			await db.insert(tags).values({ id, slug, name, category: 'topic' });
			ids.push(id);
		}
	}
	return ids;
}

async function reconcileTags(db: Db, sourceId: string, tagNames: string[]): Promise<void> {
	const desired = new Set(await tagIdsFor(db, tagNames));
	const existing = await db
		.select({ id: sourceTags.id, tagId: sourceTags.tagId })
		.from(sourceTags)
		.where(eq(sourceTags.sourceId, sourceId));
	const existingByTag = new Map(existing.map((r) => [r.tagId, r.id]));
	for (const tagId of desired) {
		if (!existingByTag.has(tagId))
			await db.insert(sourceTags).values({ sourceId, tagId, status: 'active', origin: 'website' });
	}
	for (const [tagId, rowId] of existingByTag) {
		if (!desired.has(tagId)) await db.delete(sourceTags).where(eq(sourceTags.id, rowId));
	}
}

// ---------------------------------------------------------------------------
// Links — additions/preservation flow through the engine's set-union (with
// website provenance on new rows); the website path performs the explicit
// removal of links the user dropped (the engine's set-union cannot express a
// removal) and re-stamps label/sortOrder to the submitted presentation.
// ---------------------------------------------------------------------------

async function reconcileLinks(db: Db, sourceId: string, input: SourceInput): Promise<void> {
	// Submitted set, keyed by the SAME sanitized (type,url) the engine stored.
	const submitted = new Map<string, { label: string | null; sortOrder: number }>();
	let order = 0;
	for (const l of input.links ?? []) {
		const url = safeUrl(l.url); // engine drops unsafe urls — nothing to reconcile
		if (!url) continue;
		const type = (l.type || 'website').trim() || 'website';
		const key = `${type}\n${url}`;
		if (!submitted.has(key)) submitted.set(key, { label: l.label?.trim() || null, sortOrder: order++ });
	}

	const existing = await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId));
	for (const l of existing) {
		const want = submitted.get(`${l.type}\n${l.url}`);
		if (want) {
			// keep it; re-stamp presentation (preserve notes + provenance columns)
			if (l.label !== want.label || l.sortOrder !== want.sortOrder)
				await db
					.update(sourceLinks)
					.set({ label: want.label, sortOrder: want.sortOrder })
					.where(eq(sourceLinks.id, l.id));
		} else {
			// absent from the submission ⇒ an intentional removal (the read path does
			// not filter by status, so a soft 'removed' status would still display —
			// delete to honor the removal, exactly as the prior write path did).
			await db.delete(sourceLinks).where(eq(sourceLinks.id, l.id));
		}
	}
}

// ---------------------------------------------------------------------------
// Stable internal identifier so an edit ATTACHES to its source (repo_path_exact)
// ---------------------------------------------------------------------------

function editIdentifierValue(sourceId: string): string {
	// repo_path normalizes to lowercase; source ids are lowercase uuids already.
	return `website:${sourceId}`;
}

async function ensureEditIdentifier(db: Db, sourceId: string): Promise<void> {
	const valueNorm = editIdentifierValue(sourceId);
	const [existing] = await db
		.select({ id: sourceIdentifiers.id })
		.from(sourceIdentifiers)
		.where(and(eq(sourceIdentifiers.kind, 'repo_path'), eq(sourceIdentifiers.valueNorm, valueNorm)))
		.limit(1);
	if (existing) return;
	await db.insert(sourceIdentifiers).values({
		sourceId,
		kind: 'repo_path',
		valueRaw: valueNorm,
		valueNorm,
		strength: 'medium',
		status: 'active',
		origin: 'website'
	});
}

// ---------------------------------------------------------------------------
// Audit columns + revision re-stamp
// ---------------------------------------------------------------------------

async function applyAuditColumns(
	db: Db,
	sourceId: string,
	user: EditUser,
	isNew: boolean
): Promise<void> {
	const set: Record<string, unknown> = { updatedBy: user.id ?? null };
	if (isNew) set.createdBy = user.id ?? null;
	await db.update(sources).set(set).where(eq(sources.id, sourceId));
}

/** Compact snapshot recorded with each revision — identical shape to before. */
async function snapshot(db: Db, sourceId: string): Promise<Record<string, unknown>> {
	const [[src], links, tagRows] = await Promise.all([
		db.select().from(sources).where(eq(sources.id, sourceId)).limit(1),
		db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId)),
		db
			.select({ name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id))
			.where(eq(sourceTags.sourceId, sourceId))
	]);
	if (!src) return {};
	return { source: src, links, tags: tagRows.map((t) => t.name) };
}

/**
 * The engine writes a source_revisions row, but stamps it with the audit `actor`
 * string and a `merge:…` summary. Re-stamp that row with the real user id + name
 * + the user's revision summary + the final snapshot (taken AFTER tag/link
 * reconcile) so the history page is unchanged from before. If the engine wrote no
 * revision (a duplicate-observation noop), record one ourselves so every save is
 * still attributed — exactly as the prior path did.
 */
async function finalizeRevision(
	db: Db,
	sourceId: string,
	user: EditUser,
	summary: string | undefined,
	action: 'create' | 'update',
	beforeRevisionIds: Set<string>
): Promise<void> {
	const snap = await snapshot(db, sourceId);
	const summ = summary?.trim() || (action === 'create' ? 'Created' : 'Updated');
	const all = await db
		.select()
		.from(sourceRevisions)
		.where(eq(sourceRevisions.sourceId, sourceId))
		.orderBy(desc(sourceRevisions.createdAt));
	const fresh = all.find((r) => !beforeRevisionIds.has(r.id));
	if (fresh) {
		await db
			.update(sourceRevisions)
			.set({
				userId: user.id ?? null,
				userName: user.name ?? null,
				summary: summ,
				action,
				snapshot: snap
			})
			.where(eq(sourceRevisions.id, fresh.id));
	} else {
		await db.insert(sourceRevisions).values({
			sourceId,
			userId: user.id ?? null,
			userName: user.name ?? null,
			summary: summ,
			action,
			snapshot: snap
		});
	}
}

async function slugOf(db: Db, sourceId: string): Promise<string> {
	const [s] = await db.select({ slug: sources.slug }).from(sources).where(eq(sources.id, sourceId)).limit(1);
	return s?.slug ?? '';
}

// ---------------------------------------------------------------------------
// Public entry points (db-parameterized so they are unit-testable on :memory:)
// ---------------------------------------------------------------------------

const baseObservation = (): Pick<MergeInput, 'origin' | 'derivation' | 'confidence' | 'evidence'> => ({
	origin: 'website',
	// editorial_decision (band 900) WINS over every machine band regardless of
	// machine score — a deliberate on-site edit beats passive extraction (N4).
	derivation: 'editorial_decision',
	confidence: 1,
	evidence: 1
});

export async function createSourceViaMerge(
	db: Db,
	input: SourceInput,
	user: EditUser,
	summary?: string
): Promise<WebsiteEditResult> {
	const { fields, explicitDeletes } = buildObservation(input, null);
	// A unique handle forces the create path (rather than a title-collision
	// candidate) and seeds an identity the source can be re-found by.
	const newKey = crypto.randomUUID();
	const result = await mergeSourceObservation(db, {
		...baseObservation(),
		originRecordId: `website:new:${newKey}`,
		fields,
		explicitDeletes,
		links: toLinkInputs(input),
		identifiers: [{ kind: 'repo_path', value: `website:new:${newKey}` }],
		actor: user.id ?? null
	});

	const sid = result.sourceId;
	if (!sid) return { slug: '', result }; // rejected — nothing materialized

	await ensureEditIdentifier(db, sid); // canonical edit handle for future edits
	await reconcileTags(db, sid, input.tagNames ?? []);
	await reconcileLinks(db, sid, input);
	await applyAuditColumns(db, sid, user, true);
	await finalizeRevision(db, sid, user, summary, 'create', new Set());
	return { slug: await slugOf(db, sid), result };
}

export async function updateSourceViaMerge(
	db: Db,
	id: string,
	input: SourceInput,
	user: EditUser,
	summary?: string
): Promise<WebsiteEditResult> {
	// Both reads are independent — run them together (one fewer sequential
	// round-trip on the stateless Worker client).
	const [currentRows, beforeRevs] = await Promise.all([
		db.select().from(sources).where(eq(sources.id, id)).limit(1),
		db.select({ id: sourceRevisions.id }).from(sourceRevisions).where(eq(sourceRevisions.sourceId, id))
	]);
	const current = currentRows[0];
	if (!current) throw new Error('Source not found');
	const beforeRevisionIds = new Set(beforeRevs.map((r) => r.id));

	const { fields, explicitDeletes } = buildObservation(input, current);
	// Attach to THIS source DETERMINISTICALLY via targetSourceId: the edit lands on
	// its own row instead of forking on a title/author/year change, and the engine
	// skips its catalogue scan + identifier round-trips entirely. Replaces the prior
	// `repo_path = website:<id>` re-find handle (which required an extra insert +
	// lookup per edit and was the fragile part of the cutover on remote Turso).
	const result = await mergeSourceObservation(db, {
		...baseObservation(),
		originRecordId: `website:${id}`,
		targetSourceId: id,
		fields,
		explicitDeletes,
		links: toLinkInputs(input),
		actor: user.id ?? null
	});

	const sid = result.sourceId ?? id;
	await reconcileTags(db, sid, input.tagNames ?? []);
	await reconcileLinks(db, sid, input);
	await applyAuditColumns(db, sid, user, false);
	await finalizeRevision(db, sid, user, summary, 'update', beforeRevisionIds);
	return { slug: await slugOf(db, sid), result };
}

// ---------------------------------------------------------------------------
// Surfacing the outcome — NEVER silently discard an edit (N4)
// ---------------------------------------------------------------------------

/**
 * A human-readable notice when part of an edit did NOT apply (held below a
 * higher-confidence value, recorded as a conflict, or rejected). Returns null
 * when the whole edit applied cleanly (the caller then redirects as before).
 */
export function mergeNotice(result: MergeResult): string | null {
	if (result.heldClaims.length) {
		const fields = result.heldClaims.map((c) => c.fieldName).join(', ');
		return `Your change to ${fields} is held below a higher-confidence value and was not applied. The rest of your edit was saved.`;
	}
	if (result.conflicts.length) {
		return 'A conflict was recorded for review; part of your edit was not applied. The rest of your edit was saved.';
	}
	if (result.rejectedClaims.length) {
		const fields = result.rejectedClaims.map((c) => `${c.fieldName} (${c.reason})`).join(', ');
		return `Some fields were not saved: ${fields}. The rest of your edit was saved.`;
	}
	if (result.status === 'rejected') return 'Your edit could not be applied.';
	return null;
}

// Bound-to-the-app convenience wrappers (used by queries.ts re-exports).
export const createSourceOnApp = (input: SourceInput, user: EditUser, summary?: string) =>
	createSourceViaMerge(appDb, input, user, summary);
export const updateSourceOnApp = (id: string, input: SourceInput, user: EditUser, summary?: string) =>
	updateSourceViaMerge(appDb, id, input, user, summary);

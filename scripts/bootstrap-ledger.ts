#!/usr/bin/env bun
/**
 * Phase 3 — Bootstrap the durability ledger from the current catalogue.
 *
 * ONE-TIME, IDEMPOTENT, RESUMABLE. Populates the (empty) Phase-2 ledger tables
 * — source_observation_runs / source_observed_records / source_observations /
 * source_identifiers / source_field_claims / source_field_provenance /
 * source_lifecycle_events — from the existing `sources` catalogue, and stamps
 * the engine-maintained durability columns on `sources`
 * (content_hash / normalizer_version / first_seen_at / last_seen_at).
 *
 * ── No-loss guarantee ──────────────────────────────────────────────────────
 * This script is ADDITIVE ONLY. It INSERTs into the new ledger tables and sets
 * ONLY the durability columns on `sources` that are DELIBERATELY EXCLUDED from
 * the golden projection (src/lib/server/golden.ts: SOURCE_SCALAR_COLUMNS does
 * not list status / drift_status / content_hash / normalizer_version /
 * *_seen_at). It NEVER touches a projected/original `sources` column, never
 * deletes, and never modifies source_links / tags / persons / places /
 * institutions / relations / revisions. Therefore the golden rootHash is
 * UNCHANGED after a run — the no-loss gate.
 *
 * ── Idempotency / resumability ─────────────────────────────────────────────
 *  - Every ledger row is guarded by its UNIQUE / idempotency key (observations:
 *    (origin,originRecordId,contentHash); claims: (observationId,fieldName,
 *    valueHash); provenance: (sourceId,fieldName); identifiers: (kind,valueNorm);
 *    observed_records: (origin,originRecordId)) or an existence check (lifecycle).
 *  - Each source is bootstrapped inside ONE transaction whose FINAL write sets
 *    sources.content_hash. So `content_hash IS NOT NULL` ⇔ that source committed
 *    fully. A re-run skips such sources up front → second run inserts 0 rows.
 *  - Progress is recorded in migration_watermarks(jobName='bootstrap-ledger').
 *
 * ── Per source (id preserved — never re-minted) ────────────────────────────
 *  1. (once for the whole run) a source_observation_runs row.
 *  2. a source_observed_records row (origin, originRecordId = source.id).
 *  3. ONE source_observations row carrying the canonical projection payload
 *     (derivation='curated_assertion', confidence=0.80, contentHash = canonical
 *     projection hash). Idempotency key (origin,originRecordId,contentHash).
 *  4. source_identifiers from externalIds (doi/openalex/cinii/jstage/ndl, +
 *     crossref→doi, cinii-books→cinii) and provenanceRepo:provenancePath as a
 *     'repo_path' identifier. UNIQUE(kind,valueNorm) honoured: a value already
 *     held by ANOTHER source is skipped + logged, never moved.
 *  5. one source_field_claims row per NON-NULL canonical field + a
 *     source_field_provenance winner. Default derivation='curated_assertion'
 *     @0.80; a field whose value GENUINELY CHANGED from the source's own
 *     create-snapshot baseline (replayed from source_revisions, F5) is recorded
 *     as derivation='editorial_decision'@0.95 (band 900) instead, so legacy
 *     human edits stay sticky and outrank future passive harvests.
 *  6. one source_lifecycle_events row (eventType='create').
 *  7. sources.content_hash / normalizer_version / first_seen_at / last_seen_at.
 *
 * Connection (first match wins), mirrors scripts/golden-dump.ts:
 *   --db file:/path/to/restored.db          explicit URL (no token for file:)
 *   --db libsql://host  --token <t>         explicit remote URL + token
 *   else                                    DATABASE_URL (+ DATABASE_AUTH_TOKEN)
 *
 * Flags: --dry-run (report counts, write nothing), --batch-size N (default 250),
 *        --limit N (process at most N not-yet-bootstrapped sources; for testing).
 *
 * Run:  bun run bootstrap
 *       DATABASE_URL=file:/tmp/p3.db bun run bootstrap --dry-run
 */
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { asc, eq, and } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as schema from '../src/lib/server/db/schema';
import {
	projectSource,
	hashProjection,
	canonicalStringify,
	type ProjectSourceInput
} from '../src/lib/server/golden';

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
const BATCH_SIZE = Math.max(1, Number(argValue('--batch-size') ?? '250') || 250);
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : Infinity;

const client = createClient({ url, authToken: authToken || undefined });
const db = drizzle(client, { schema });
type Tx = Parameters<Parameters<LibSQLDatabase<typeof schema>['transaction']>[0]>[0];

// ── constants ────────────────────────────────────────────────────────────────
const JOB = 'bootstrap-ledger';
const ORIGIN = 'bootstrap-current-db';
/** First normalizer version. The merge engine (Phase 4) will own this constant;
 *  the bootstrap stamps v1 so re-derivation is versioned from the start. */
const NORMALIZER_VERSION = 1;
const CURATED_CONF = 0.8;
const EDITORIAL_CONF = 0.95;
const BAND_CURATED = 800; // derivation band for 'curated_assertion'
const BAND_EDITORIAL = 900; // derivation band for 'editorial_decision'

/** The canonical fields that carry a field claim (§1.5 field-policy map):
 *  scalar_ranked ∪ controlled_scalar_ranked ∪ set_union ∪ append_or_ranked ∪
 *  editorial_only. System/identity columns (id, slug, provenance*, externalIds,
 *  audit, status, drift, hash, *SeenAt) are NEVER claimed. */
const CLAIMABLE_FIELDS = [
	'title',
	'titleEn',
	'titleAin',
	'altTitles',
	'category',
	'type',
	'author',
	'yearText',
	'yearStart',
	'yearEnd',
	'yearCertainty',
	'dialect',
	'region',
	'languages',
	'scripts',
	'holdingInstitution',
	'callNumber',
	'entryCount',
	'entryCountLabel',
	'license',
	'summary',
	'notes',
	'reliability',
	'featured'
] as const;

/** externalIds key → (identifier kind, strength). Keys not listed are skipped
 *  (e.g. researchmap is a person id; togo/irdb/… are out of the v1 id set). */
const ID_KIND_MAP: Record<string, { kind: string; strength: string }> = {
	doi: { kind: 'doi', strength: 'strong' },
	crossref: { kind: 'doi', strength: 'strong' }, // crossref externalId IS the DOI
	openalex: { kind: 'openalex_work', strength: 'strong' },
	cinii: { kind: 'cinii', strength: 'strong' },
	'cinii-books': { kind: 'cinii', strength: 'strong' },
	ndl: { kind: 'ndl', strength: 'strong' },
	jstage: { kind: 'jstage', strength: 'strong' }
};

// ── helpers ──────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const canon = (v: unknown) => canonicalStringify(v ?? null);
const hashValue = (v: unknown) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const rankScore = (confidence: number, evidence: number) =>
	100 /* default origin weight */ + Math.round(confidence * 100) + Math.min(25, evidence * 5);

function normId(kind: string, raw: string): string {
	let v = raw.trim();
	if (kind === 'doi') {
		v = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
		return v.toLowerCase();
	}
	if (kind === 'openalex_work') {
		v = v.replace(/^https?:\/\/openalex\.org\//i, '');
		return v.toUpperCase();
	}
	return v.toLowerCase();
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const r of rows) {
		const k = key(r);
		const arr = m.get(k);
		if (arr) arr.push(r);
		else m.set(k, [r]);
	}
	return m;
}

/** Fields that genuinely changed from the source's OWN create-snapshot baseline
 *  (F5). Requires an action='create' revision; otherwise no editorial claims. */
function editedFieldsOf(
	revs: Array<{ action: string; snapshot: unknown }>,
	src: Record<string, unknown>
): Set<string> {
	const create = revs.find((r) => r.action === 'create');
	if (!create) return new Set();
	const base = ((create.snapshot as { source?: Record<string, unknown> })?.source ?? {}) as Record<
		string,
		unknown
	>;
	const out = new Set<string>();
	for (const f of CLAIMABLE_FIELDS) {
		if (canon(src[f]) !== canon(base[f])) out.add(f);
	}
	return out;
}

// ── counters ─────────────────────────────────────────────────────────────────
const counts = {
	sourcesTotal: 0,
	sourcesAlreadyDone: 0,
	sourcesProcessed: 0,
	observedRecords: 0,
	observations: 0,
	identifiers: 0,
	identifierConflicts: 0,
	identifiersByKind: {} as Record<string, number>,
	claimsCurated: 0,
	claimsEditorial: 0,
	provenanceRows: 0,
	lifecycleEvents: 0,
	sourcesStamped: 0,
	editedSources: 0,
	editedFieldsTotal: 0
};

async function main() {
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}bootstrap-ledger → ${url.split('?')[0]} (batch=${BATCH_SIZE}${LIMIT === Infinity ? '' : `, limit=${LIMIT}`})`
	);

	const {
		sources,
		sourceLinks,
		persons,
		sourcePersons,
		places,
		sourcePlaces,
		institutions,
		sourceInstitutions,
		sourceRelations,
		tags,
		sourceTags,
		sourceRevisions,
		sourceObservationRuns,
		sourceObservedRecords,
		sourceObservations,
		sourceIdentifiers,
		sourceFieldClaims,
		sourceFieldProvenance,
		sourceLifecycleEvents,
		migrationWatermarks
	} = schema;

	// ── bulk-load everything the projection needs (mirrors golden-dump) ─────────
	console.log('Loading catalogue …');
	const [
		allSources,
		links,
		personRows,
		placeRows,
		instRows,
		tagRows,
		relRows,
		revRows,
		existingIdRows
	] = await Promise.all([
		db.select().from(sources).orderBy(asc(sources.id)),
		db.select().from(sourceLinks),
		db
			.select({
				sourceId: sourcePersons.sourceId,
				slug: persons.slug,
				role: sourcePersons.role,
				sortOrder: sourcePersons.sortOrder
			})
			.from(sourcePersons)
			.innerJoin(persons, eq(sourcePersons.personId, persons.id)),
		db
			.select({
				sourceId: sourcePlaces.sourceId,
				slug: places.slug,
				role: sourcePlaces.role,
				notes: sourcePlaces.notes
			})
			.from(sourcePlaces)
			.innerJoin(places, eq(sourcePlaces.placeId, places.id)),
		db
			.select({
				sourceId: sourceInstitutions.sourceId,
				slug: institutions.slug,
				role: sourceInstitutions.role,
				callNumber: sourceInstitutions.callNumber,
				notes: sourceInstitutions.notes
			})
			.from(sourceInstitutions)
			.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id)),
		db
			.select({ sourceId: sourceTags.sourceId, name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id)),
		db
			.select({
				from: sourceRelations.fromSourceId,
				to: sourceRelations.toSourceId,
				type: sourceRelations.type
			})
			.from(sourceRelations),
		db
			.select({
				sourceId: sourceRevisions.sourceId,
				action: sourceRevisions.action,
				snapshot: sourceRevisions.snapshot,
				createdAt: sourceRevisions.createdAt
			})
			.from(sourceRevisions)
			.orderBy(asc(sourceRevisions.createdAt)),
		db
			.select({
				kind: sourceIdentifiers.kind,
				valueNorm: sourceIdentifiers.valueNorm,
				sourceId: sourceIdentifiers.sourceId
			})
			.from(sourceIdentifiers)
	]);

	const slugById = new Map<string, string>();
	for (const s of allSources) slugById.set(s.id, s.slug);
	const endpoint = (id: string) => slugById.get(id) ?? id;

	const linksBySrc = groupBy(links, (r) => r.sourceId);
	const personsBySrc = groupBy(personRows, (r) => r.sourceId);
	const placesBySrc = groupBy(placeRows, (r) => r.sourceId);
	const instBySrc = groupBy(instRows, (r) => r.sourceId);
	const tagsBySrc = groupBy(tagRows, (r) => r.sourceId);
	const relOutBySrc = groupBy(relRows, (r) => r.from);
	const relInBySrc = groupBy(relRows, (r) => r.to);
	const revsBySrc = groupBy(revRows, (r) => r.sourceId);

	// (kind\tvalueNorm) → sourceId that already holds it. Seeded from the DB
	// (populated on a re-run, empty on first run) and grown as we insert, so the
	// UNIQUE(kind,valueNorm) rule is honoured across batches AND within one run.
	const claimedIds = new Map<string, string>();
	for (const r of existingIdRows) {
		if (r.valueNorm && r.sourceId) claimedIds.set(`${r.kind}\t${r.valueNorm}`, r.sourceId);
	}

	counts.sourcesTotal = allSources.length;

	// ── find-or-create the single bootstrap run ─────────────────────────────────
	let runId: string | undefined;
	if (!DRY_RUN) {
		const [existingRun] = await db
			.select({ id: sourceObservationRuns.id })
			.from(sourceObservationRuns)
			.where(eq(sourceObservationRuns.origin, ORIGIN))
			.limit(1);
		if (existingRun) {
			runId = existingRun.id;
		} else {
			runId = uuid();
			await db.insert(sourceObservationRuns).values({
				id: runId,
				origin: ORIGIN,
				mode: 'full',
				status: 'running',
				collectorVersion: 'bootstrap-ledger@1',
				normalizerVersion: NORMALIZER_VERSION,
				startedAt: new Date()
			});
		}
	}

	// ── build the projection + content hash for every source (deterministic) ────
	function projectionFor(source: Record<string, unknown>) {
		const id = source.id as string;
		const relations = [
			...(relOutBySrc.get(id) ?? []).map((r) => ({
				type: r.type,
				toSlugOrId: endpoint(r.to),
				direction: 'out' as const
			})),
			...(relInBySrc.get(id) ?? []).map((r) => ({
				type: r.type,
				toSlugOrId: endpoint(r.from),
				direction: 'in' as const
			}))
		];
		const input: ProjectSourceInput = {
			source,
			links: linksBySrc.get(id) ?? [],
			tags: tagsBySrc.get(id) ?? [],
			persons: personsBySrc.get(id) ?? [],
			places: placesBySrc.get(id) ?? [],
			institutions: instBySrc.get(id) ?? [],
			relations
		};
		const projection = projectSource(input);
		return { projection, contentHash: hashProjection(projection) };
	}

	// ── per-source bootstrap (runs inside the batch transaction) ────────────────
	async function bootstrapSource(tx: Tx, source: Record<string, unknown>) {
		const sid = source.id as string;
		const { projection, contentHash } = projectionFor(source);
		const createdAt = (source.createdAt as Date) ?? new Date();
		const updatedAt = (source.updatedAt as Date) ?? createdAt;

		// 2. observed record (origin, originRecordId=source.id) — UNIQUE guarded.
		await tx
			.insert(sourceObservedRecords)
			.values({
				id: uuid(),
				origin: ORIGIN,
				originRecordId: sid,
				status: 'seen',
				lastContentHash: contentHash,
				normalizerVersion: NORMALIZER_VERSION,
				firstSeenAt: createdAt,
				lastSeenAt: updatedAt
			})
			.onConflictDoNothing();
		counts.observedRecords += 1;

		// 3. observation (curated assertion of the current canonical payload).
		const insertedObs = await tx
			.insert(sourceObservations)
			.values({
				id: uuid(),
				origin: ORIGIN,
				originRecordId: sid,
				contentHash,
				normalizerVersion: NORMALIZER_VERSION,
				runId: runId ?? null,
				derivation: 'curated_assertion',
				confidence: CURATED_CONF,
				evidence: 0,
				payload: projection as unknown as Record<string, unknown>,
				status: 'applied',
				matchDecision: 'bootstrap_self',
				actor: 'bootstrap',
				createdAt: new Date()
			})
			.onConflictDoNothing()
			.returning({ id: sourceObservations.id });
		let obsId = insertedObs[0]?.id;
		if (!obsId) {
			const [ex] = await tx
				.select({ id: sourceObservations.id })
				.from(sourceObservations)
				.where(
					and(
						eq(sourceObservations.origin, ORIGIN),
						eq(sourceObservations.originRecordId, sid),
						eq(sourceObservations.contentHash, contentHash)
					)
				)
				.limit(1);
			obsId = ex!.id;
		} else {
			counts.observations += 1;
		}

		// 4. identifiers from externalIds + provenance repo:path.
		const ext = (source.externalIds as Record<string, string> | null) ?? {};
		const idSpecs: Array<{ kind: string; strength: string; raw: string }> = [];
		for (const [key, rawVal] of Object.entries(ext)) {
			const map = ID_KIND_MAP[key];
			if (!map || !rawVal || !String(rawVal).trim()) continue;
			idSpecs.push({ kind: map.kind, strength: map.strength, raw: String(rawVal) });
		}
		const repo = source.provenanceRepo as string | null;
		const path = source.provenancePath as string | null;
		if (repo && path && String(path).trim()) {
			idSpecs.push({ kind: 'repo_path', strength: 'medium', raw: `${repo}:${path}` });
		}
		for (const spec of idSpecs) {
			const valueNorm = normId(spec.kind, spec.raw);
			if (!valueNorm) continue;
			const key = `${spec.kind}\t${valueNorm}`;
			const owner = claimedIds.get(key);
			if (owner === sid) continue; // already ours (idempotent)
			if (owner && owner !== sid) {
				counts.identifierConflicts += 1;
				console.warn(
					`  ! identifier conflict: (${spec.kind}, ${valueNorm}) held by ${owner}; skipping for ${sid}`
				);
				continue;
			}
			await tx
				.insert(sourceIdentifiers)
				.values({
					id: uuid(),
					sourceId: sid,
					kind: spec.kind,
					valueRaw: spec.raw,
					valueNorm,
					strength: spec.strength,
					status: 'active',
					origin: ORIGIN,
					confidence: CURATED_CONF,
					observationId: obsId,
					firstSeenAt: createdAt,
					lastSeenAt: updatedAt
				})
				.onConflictDoNothing();
			claimedIds.set(key, sid);
			counts.identifiers += 1;
			counts.identifiersByKind[spec.kind] = (counts.identifiersByKind[spec.kind] ?? 0) + 1;
		}

		// 5. field claims (one per non-null claimable field) + provenance winner.
		//    Edited-vs-create-baseline fields become editorial_decision@0.95.
		const edited = editedFieldsOf(revsBySrc.get(sid) ?? [], source);
		if (edited.size) {
			counts.editedSources += 1;
			counts.editedFieldsTotal += edited.size;
		}
		for (const field of CLAIMABLE_FIELDS) {
			const value = source[field];
			if (value === null || value === undefined) continue; // only NON-NULL fields
			const isEditorial = edited.has(field);
			const derivation = isEditorial ? 'editorial_decision' : 'curated_assertion';
			const confidence = isEditorial ? EDITORIAL_CONF : CURATED_CONF;
			const band = isEditorial ? BAND_EDITORIAL : BAND_CURATED;
			const evidence = isEditorial ? 1 : 0; // editorial: the revision is the evidence
			const score = rankScore(confidence, evidence);
			const valueHash = hashValue(value);
			const claimId = uuid();
			await tx
				.insert(sourceFieldClaims)
				.values({
					id: claimId,
					observationId: obsId,
					sourceId: sid,
					fieldName: field,
					value: value as unknown,
					valueHash,
					op: 'set',
					rankBand: band,
					rankScore: score,
					origin: ORIGIN,
					derivation,
					confidence,
					evidence,
					status: 'applied',
					createdAt: new Date()
				})
				.onConflictDoNothing();
			await tx
				.insert(sourceFieldProvenance)
				.values({
					id: uuid(),
					sourceId: sid,
					fieldName: field,
					currentClaimId: claimId,
					valueHash,
					rankBand: band,
					rankScore: score,
					origin: ORIGIN,
					derivation,
					confidence,
					evidence,
					updatedAt: new Date()
				})
				.onConflictDoNothing();
			if (isEditorial) counts.claimsEditorial += 1;
			else counts.claimsCurated += 1;
			counts.provenanceRows += 1;
		}

		// 6. lifecycle 'create' event (existence-guarded — append-only, no UNIQUE).
		const [existingLc] = await tx
			.select({ id: sourceLifecycleEvents.id })
			.from(sourceLifecycleEvents)
			.where(
				and(
					eq(sourceLifecycleEvents.sourceId, sid),
					eq(sourceLifecycleEvents.eventType, 'create'),
					eq(sourceLifecycleEvents.actor, 'bootstrap')
				)
			)
			.limit(1);
		if (!existingLc) {
			await tx.insert(sourceLifecycleEvents).values({
				id: uuid(),
				sourceId: sid,
				observationId: obsId,
				eventType: 'create',
				toStatus: (source.status as string) ?? 'active',
				reason: 'bootstrap import from current catalogue',
				actor: 'bootstrap',
				createdAt
			});
			counts.lifecycleEvents += 1;
		}

		// 7. stamp the EXCLUDED durability columns (never a projected column).
		//    This is the final write → content_hash set ⇔ this source committed.
		await tx
			.update(sources)
			.set({
				contentHash,
				normalizerVersion: NORMALIZER_VERSION,
				firstSeenAt: createdAt,
				lastSeenAt: updatedAt
			})
			.where(eq(sources.id, sid));
		counts.sourcesStamped += 1;
		counts.sourcesProcessed += 1;
	}

	// ── iterate sources in id order, in batched transactions ────────────────────
	const todo = allSources.filter((s) => {
		if (s.contentHash != null) {
			counts.sourcesAlreadyDone += 1;
			return false; // already bootstrapped in a prior committed run
		}
		return true;
	});
	const limited = todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT);

	if (DRY_RUN) {
		// Compute the full plan without writing (uses a throwaway counting pass).
		for (const source of limited) {
			const sid = source.id as string;
			const { contentHash } = projectionFor(source);
			counts.observedRecords += 1;
			counts.observations += 1;
			const ext = (source.externalIds as Record<string, string> | null) ?? {};
			const specs: Array<{ kind: string; raw: string }> = [];
			for (const [key, rawVal] of Object.entries(ext)) {
				const map = ID_KIND_MAP[key];
				if (map && rawVal && String(rawVal).trim()) specs.push({ kind: map.kind, raw: String(rawVal) });
			}
			const repo = source.provenanceRepo as string | null;
			const path = source.provenancePath as string | null;
			if (repo && path && String(path).trim()) specs.push({ kind: 'repo_path', raw: `${repo}:${path}` });
			for (const spec of specs) {
				const valueNorm = normId(spec.kind, spec.raw);
				if (!valueNorm) continue;
				const key = `${spec.kind}\t${valueNorm}`;
				const owner = claimedIds.get(key);
				if (owner === sid) continue;
				if (owner && owner !== sid) {
					counts.identifierConflicts += 1;
					continue;
				}
				claimedIds.set(key, sid);
				counts.identifiers += 1;
				counts.identifiersByKind[spec.kind] = (counts.identifiersByKind[spec.kind] ?? 0) + 1;
			}
			const edited = editedFieldsOf(revsBySrc.get(sid) ?? [], source);
			if (edited.size) {
				counts.editedSources += 1;
				counts.editedFieldsTotal += edited.size;
			}
			for (const field of CLAIMABLE_FIELDS) {
				const value = source[field];
				if (value === null || value === undefined) continue;
				if (edited.has(field)) counts.claimsEditorial += 1;
				else counts.claimsCurated += 1;
				counts.provenanceRows += 1;
			}
			counts.lifecycleEvents += 1;
			counts.sourcesStamped += 1;
			counts.sourcesProcessed += 1;
			void contentHash;
		}
	} else {
		for (let i = 0; i < limited.length; i += BATCH_SIZE) {
			const batch = limited.slice(i, i + BATCH_SIZE);
			await db.transaction(async (tx) => {
				for (const source of batch) await bootstrapSource(tx, source);
			});
			const lastId = batch[batch.length - 1]?.id ?? null;
			const done = Math.min(i + batch.length, limited.length);
			await db
				.insert(migrationWatermarks)
				.values({
					jobName: JOB,
					phase: 'sources',
					lastSourceId: lastId,
					status: 'running',
					summary: { processed: done, total: limited.length, alreadyDone: counts.sourcesAlreadyDone },
					updatedAt: new Date()
				})
				.onConflictDoUpdate({
					target: migrationWatermarks.jobName,
					set: {
						phase: 'sources',
						lastSourceId: lastId,
						status: 'running',
						summary: {
							processed: done,
							total: limited.length,
							alreadyDone: counts.sourcesAlreadyDone
						},
						updatedAt: new Date()
					}
				});
			process.stdout.write(`\r  processed ${done}/${limited.length} …`);
		}
		process.stdout.write('\n');

		// finalize run + watermark
		if (runId) {
			await db
				.update(sourceObservationRuns)
				.set({
					status: 'completed',
					finishedAt: new Date(),
					summary: { ...counts, identifiersByKind: counts.identifiersByKind }
				})
				.where(eq(sourceObservationRuns.id, runId));
		}
		await db
			.insert(migrationWatermarks)
			.values({
				jobName: JOB,
				phase: 'done',
				status: 'completed',
				summary: { ...counts },
				updatedAt: new Date()
			})
			.onConflictDoUpdate({
				target: migrationWatermarks.jobName,
				set: { phase: 'done', status: 'completed', summary: { ...counts }, updatedAt: new Date() }
			});
	}

	// ── report ──────────────────────────────────────────────────────────────────
	console.log(`\n${DRY_RUN ? '[DRY-RUN] would create' : 'Created'}:`);
	console.log(`  sources total            : ${counts.sourcesTotal}`);
	console.log(`  already bootstrapped     : ${counts.sourcesAlreadyDone} (skipped)`);
	console.log(`  sources processed        : ${counts.sourcesProcessed}`);
	console.log(`  observed_records         : ${counts.observedRecords}`);
	console.log(`  observations             : ${counts.observations}`);
	console.log(
		`  identifiers              : ${counts.identifiers}  ${JSON.stringify(counts.identifiersByKind)}`
	);
	console.log(`  identifier conflicts     : ${counts.identifierConflicts} (skipped, not moved)`);
	console.log(`  field claims (curated)   : ${counts.claimsCurated}`);
	console.log(`  field claims (editorial) : ${counts.claimsEditorial}`);
	console.log(`  field provenance rows    : ${counts.provenanceRows}`);
	console.log(`  lifecycle events         : ${counts.lifecycleEvents}`);
	console.log(`  sources stamped          : ${counts.sourcesStamped}`);
	console.log(
		`  edited sources / fields  : ${counts.editedSources} / ${counts.editedFieldsTotal} (editorial_decision replay)`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ bootstrap-ledger failed:', err);
		process.exit(1);
	});

/**
 * Compare-and-swap apply to `source_field_provenance` (§2 step 11 / F2).
 *
 * The provenance row is the current-winner projection per (source, field) and
 * is the CAS target. The protocol is two SINGLE statements — never an
 * interactive transaction (the Worker uses a stateless web client where tx
 * isolation does not hold):
 *
 *   1. INSERT ... ON CONFLICT(source_id, field_name) DO NOTHING   (first claim)
 *   2. conditional UPDATE ... WHERE current_claim_id IS <readClaimId>  (replace)
 *
 * The caller branches on rowsAffected and re-reads + retries (bounded) on a 0,
 * so a stale writer loses cleanly — it never clobbers a row another writer has
 * advanced underneath it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { sourceFieldProvenance } from '../db/schema';
import type { Db } from './types';

export interface ProvenanceRow {
	currentClaimId: string | null;
	valueHash: string | null;
	rankBand: number | null;
	rankScore: number | null;
	derivation: string | null;
}

export interface ProvenanceWrite {
	currentClaimId: string | null;
	valueHash: string;
	rankBand: number;
	rankScore: number;
	origin: string | null;
	derivation: string | null;
	confidence: number | null;
	evidence: number | null;
}

export async function readProvenance(
	db: Db,
	sourceId: string,
	fieldName: string
): Promise<ProvenanceRow | undefined> {
	const rows = await db
		.select({
			currentClaimId: sourceFieldProvenance.currentClaimId,
			valueHash: sourceFieldProvenance.valueHash,
			rankBand: sourceFieldProvenance.rankBand,
			rankScore: sourceFieldProvenance.rankScore,
			derivation: sourceFieldProvenance.derivation
		})
		.from(sourceFieldProvenance)
		.where(
			and(
				eq(sourceFieldProvenance.sourceId, sourceId),
				eq(sourceFieldProvenance.fieldName, fieldName)
			)
		)
		.limit(1);
	return rows[0];
}

function rowsAffected(res: unknown): number {
	return (res as { rowsAffected?: number })?.rowsAffected ?? 0;
}

/**
 * INSERT the first provenance row for (source, field). Returns true iff a row
 * was inserted (no prior winner existed). A 0 means another writer won the race
 * to create it — the caller re-reads and falls into the UPDATE path.
 */
export async function casInsertFirst(
	db: Db,
	sourceId: string,
	fieldName: string,
	w: ProvenanceWrite
): Promise<boolean> {
	const res = await db
		.insert(sourceFieldProvenance)
		.values({
			sourceId,
			fieldName,
			currentClaimId: w.currentClaimId,
			valueHash: w.valueHash,
			rankBand: w.rankBand,
			rankScore: w.rankScore,
			origin: w.origin,
			derivation: w.derivation,
			confidence: w.confidence,
			evidence: w.evidence,
			updatedAt: new Date()
		})
		.onConflictDoNothing();
	return rowsAffected(res) > 0;
}

/**
 * Conditional CAS replace. Updates the winner ONLY while it still references
 * `expectedClaimId`. Returns true iff exactly one row changed; false means the
 * row was advanced concurrently (stale writer loses cleanly — no clobber).
 */
export async function casUpdate(
	db: Db,
	sourceId: string,
	fieldName: string,
	expectedClaimId: string | null,
	w: ProvenanceWrite
): Promise<boolean> {
	const idMatch =
		expectedClaimId === null
			? isNull(sourceFieldProvenance.currentClaimId)
			: eq(sourceFieldProvenance.currentClaimId, expectedClaimId);
	const res = await db
		.update(sourceFieldProvenance)
		.set({
			currentClaimId: w.currentClaimId,
			valueHash: w.valueHash,
			rankBand: w.rankBand,
			rankScore: w.rankScore,
			origin: w.origin,
			derivation: w.derivation,
			confidence: w.confidence,
			evidence: w.evidence,
			updatedAt: new Date()
		})
		.where(
			and(
				eq(sourceFieldProvenance.sourceId, sourceId),
				eq(sourceFieldProvenance.fieldName, fieldName),
				idMatch
			)
		);
	return rowsAffected(res) === 1;
}

export const CAS_MAX_RETRY = 3;

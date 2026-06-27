/**
 * Stable canonical hashing for the merge engine.
 *
 * Reuses the golden module's `canonicalStringify` (recursive key-sort, compact)
 * so a value hashes identically regardless of object key order. Three distinct
 * hashes ride through the pipeline and are kept deliberately separate:
 *   1. observation payload hash  → `hashPayload`  (idempotency key component)
 *   2. per-field value hash      → `hashValue`    (claim dedupe / CAS compare)
 *   3. identity match hash       → `hashValue` over substantive fields only
 *      (rename rebind; computed by identity.ts, never includes id/slug/provenance)
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../golden';

export { canonicalStringify };

export function sha256Hex(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable hash of any value. `null` and `undefined` collapse to the same hash. */
export function hashValue(value: unknown): string {
	return sha256Hex(canonicalStringify(value ?? null));
}

/** Volatile keys excluded from the observation payload hash so re-fetching the
 *  SAME record (only the fetch timestamp/url changed) stays idempotent. */
const VOLATILE_KEYS = new Set([
	'fetchedAt',
	'retrievedAt',
	'runUrl',
	'runId',
	'collectorVersion',
	'timestamp',
	'_meta'
]);

/** Hash of an incoming observation payload, ignoring volatile transport fields. */
export function hashPayload(payload: Record<string, unknown>): string {
	const filtered: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (VOLATILE_KEYS.has(k)) continue;
		filtered[k] = v;
	}
	return hashValue(filtered);
}

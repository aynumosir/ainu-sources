/**
 * Merge-engine constants shared across the pipeline.
 */

/**
 * The current normalizer version. Bumped whenever identifier/text/array
 * normalization rules change so re-derivation is versioned. The Phase-3
 * bootstrap stamped v1; the engine continues from there.
 */
export const NORMALIZER_VERSION = 1;

/** Origins permitted to emit `derivation='editorial_decision'` (band 900).
 *  Harvesters / LLM feeds are FORBIDDEN from editorial assertions (§2, §3). */
export const EDITORIAL_ORIGINS = new Set(['website', 'manual']);

/** Identifier kinds that constitute a STRONG identity match (single ⇒ attach). */
export const STRONG_ID_KINDS = new Set([
	'doi',
	'openalex_work',
	'isbn',
	'issn',
	'cinii',
	'ndl',
	'jstage'
]);

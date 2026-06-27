/**
 * Band-first precedence (§2 step 10 / N4).
 *
 *   band   = derivationBand(field, derivation)
 *   score  = originWeight(field, origin)*100 + round(confidence*100) + min(25, evidence*5)
 *   winner = HIGHER band; tie-band → HIGHER score
 *
 * Precedence is a function of the DERIVATION POLICY and origin/confidence/
 * evidence — NEVER of the actor type. `editorial_decision` (band 900) therefore
 * outranks every machine band regardless of machine score, which is what makes
 * a deliberate human edit beat passive extraction.
 */

/** Derivation → precedence band. */
export const DERIVATION_BANDS: Record<string, number> = {
	editorial_decision: 900,
	curated_assertion: 800,
	observed: 700,
	transcribed: 680,
	extracted: 600,
	normalized: 500,
	llm_extraction: 400,
	inferred: 300,
	heuristic: 100
};

/** Fallback band for an unknown derivation (treated as the weakest tier). */
export const DEFAULT_BAND = 100;

/** Band of `editorial_decision`, the deliberate-curatorial floor. */
export const EDITORIAL_BAND = DERIVATION_BANDS.editorial_decision;

/**
 * Legacy-origin normalization. Live `provenanceRepo` values and historical
 * origin strings are mapped to a canonical origin BEFORE ranking so per-field
 * origin weights apply consistently across the bootstrap and live feeds.
 */
export const LEGACY_ORIGIN_MAP: Record<string, string> = {
	manual: 'manual',
	'ainu-dictionaries': 'ainu-dictionaries',
	'ainu-grammar': 'ainu-grammar',
	'ainu-corpora': 'ainu-corpora',
	'curated-makubetsu': 'curated',
	'bootstrap-current-db': 'bootstrap',
	crossref: 'crossref',
	openalex: 'openalex',
	'cinii-books': 'cinii',
	cinii: 'cinii',
	ndl: 'ndl',
	jstage: 'jstage',
	researchmap: 'researchmap',
	wikidata: 'wikidata',
	website: 'website'
};

export function normalizeOrigin(origin: string | null | undefined): string {
	const o = (origin ?? '').trim();
	return LEGACY_ORIGIN_MAP[o] ?? o;
}

/**
 * Per-field origin authority weight. A source that is authoritative for a field
 * gets a multiplier bump; everything else is weight 1. These only break ties
 * WITHIN a band — they never cross a band boundary.
 */
const ORIGIN_FIELD_WEIGHTS: Record<string, Record<string, number>> = {
	ndl: { holdingInstitution: 3, callNumber: 3 },
	cinii: { holdingInstitution: 3, callNumber: 3 },
	crossref: { title: 2, yearStart: 2, yearText: 2, author: 2 },
	openalex: { title: 2, yearStart: 2, yearText: 2 },
	'ainu-dictionaries': { dialect: 2, region: 2, entryCount: 2 },
	'ainu-corpora': { dialect: 2, region: 2, entryCount: 2 },
	'ainu-grammar': { dialect: 2, region: 2 },
	researchmap: { author: 2 },
	wikidata: { author: 2 }
};

const DEFAULT_ORIGIN_WEIGHT = 1;

export function originWeight(field: string, origin: string | null | undefined): number {
	const o = normalizeOrigin(origin);
	return ORIGIN_FIELD_WEIGHTS[o]?.[field] ?? DEFAULT_ORIGIN_WEIGHT;
}

export function derivationBand(_field: string, derivation: string): number {
	return DERIVATION_BANDS[derivation] ?? DEFAULT_BAND;
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function computeScore(
	field: string,
	origin: string | null | undefined,
	confidence: number,
	evidence: number
): number {
	return (
		originWeight(field, origin) * 100 +
		Math.round(clamp01(confidence) * 100) +
		Math.min(25, Math.max(0, evidence) * 5)
	);
}

export interface Rank {
	band: number;
	score: number;
}

export function rankOf(
	field: string,
	input: { derivation: string; origin?: string | null; confidence: number; evidence?: number }
): Rank {
	return {
		band: derivationBand(field, input.derivation),
		score: computeScore(field, input.origin, input.confidence, input.evidence ?? 0)
	};
}

/** >0 ⇒ a wins; <0 ⇒ b wins; 0 ⇒ exact tie. Band first, then score. */
export function compareRank(a: Rank, b: Rank): number {
	if (a.band !== b.band) return a.band - b.band;
	return a.score - b.score;
}

/** Same-band score window within which two materially-different values are a
 *  CONFLICT (held for review) rather than a clean win/loss. */
export const NEAR_SCORE_DELTA = 10;

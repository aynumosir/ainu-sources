/**
 * EXHAUSTIVE field-policy map over every `sources` scalar column plus the
 * lifecycle columns. Every column maps to exactly one policy — there is NO
 * unmapped column (the merge test asserts this against golden's
 * SOURCE_SCALAR_COLUMNS + the lifecycle set).
 *
 * Policy kinds (§1.5):
 *   scalar_ranked            ranked single value (band-first precedence)
 *   controlled_scalar_ranked ranked single value validated against an enum
 *   set_union                array merged by union; never drops a member
 *   append_or_ranked         notes — higher rank replaces, else appends (no loss)
 *   editorial_only           only `editorial_decision` may set it (featured)
 *   system_lifecycle         written ONLY via lifecycle events, never field claims
 *   system_identity          identity / engine-maintained — never claimed
 */

import { CATEGORY_LABELS, REGION_LABELS } from '$lib/constants';

export type PolicyKind =
	| 'scalar_ranked'
	| 'controlled_scalar_ranked'
	| 'set_union'
	| 'append_or_ranked'
	| 'editorial_only'
	| 'system_lifecycle'
	| 'system_identity';

export type ValueType = 'text' | 'int' | 'bool' | 'set' | 'enum';

export interface FieldPolicy {
	policy: PolicyKind;
	valueType: ValueType;
	/** allowed values for controlled (enum) fields */
	enum?: ReadonlySet<string>;
	/** whether the field carries a field claim (false for system_*) */
	claimable: boolean;
}

/**
 * Controlled vocabularies for the CLOSED scalar fields.
 *
 * `category` and `region` are closed taxonomies, so their allowlists are derived
 * directly from the canonical localized label maps in `$lib/constants`
 * (`CATEGORY_LABELS` / `REGION_LABELS`). Deriving — rather than hardcoding a
 * second copy — guarantees the merge allowlist can never drift from the values
 * the UI is built to render (the prior hardcoded copies were missing `tool` and
 * `other`, which rejected real prod values).
 *
 * `type` is deliberately NOT here: it is an OPEN-ENDED vocabulary (harvest mints
 * new document types, e.g. `web-article`, `model`, `valency-dataset`), so a
 * frozen enum is the wrong model and would reject genuine values. It is a
 * free-text `scalar_ranked` field instead — see `FIELD_POLICIES` below.
 * `TYPE_LABELS` in `$lib/constants` remains the best-effort *display* map and
 * falls back to the raw key for any type it does not yet label.
 */
export const ENUMS = {
	category: new Set(Object.keys(CATEGORY_LABELS)), // primary, secondary, corpus, tool
	region: new Set(Object.keys(REGION_LABELS)), // hokkaido, sakhalin, kuril, proto, other
	yearCertainty: new Set(['exact', 'range', 'estimated', 'unknown']),
	entryCountLabel: new Set(['entries', 'sentences', 'pages', 'lemmas'])
} as const;

const scalarText = (): FieldPolicy => ({
	policy: 'scalar_ranked',
	valueType: 'text',
	claimable: true
});
const scalarInt = (): FieldPolicy => ({
	policy: 'scalar_ranked',
	valueType: 'int',
	claimable: true
});
const controlled = (e: ReadonlySet<string>): FieldPolicy => ({
	policy: 'controlled_scalar_ranked',
	valueType: 'enum',
	enum: e,
	claimable: true
});
const setUnion = (): FieldPolicy => ({
	policy: 'set_union',
	valueType: 'set',
	claimable: true
});
const systemIdentity = (valueType: ValueType = 'text'): FieldPolicy => ({
	policy: 'system_identity',
	valueType,
	claimable: false
});
const systemLifecycle = (): FieldPolicy => ({
	policy: 'system_lifecycle',
	valueType: 'text',
	claimable: false
});

export const FIELD_POLICIES: Record<string, FieldPolicy> = {
	// --- scalar_ranked (text) ---
	title: scalarText(),
	titleEn: scalarText(),
	titleAin: scalarText(),
	author: scalarText(),
	summary: scalarText(),
	dialect: scalarText(),
	holdingInstitution: scalarText(),
	callNumber: scalarText(),
	license: scalarText(),
	reliability: scalarText(),
	yearText: scalarText(),
	// --- scalar_ranked (int) ---
	entryCount: scalarInt(),
	yearStart: scalarInt(),
	yearEnd: scalarInt(),
	// --- controlled_scalar_ranked ---
	category: controlled(ENUMS.category),
	// `type` is open-ended (harvest mints new document types) → free text, ranked
	// like author/title; validated non-empty, never rejected as an unknown enum.
	type: scalarText(),
	region: controlled(ENUMS.region),
	yearCertainty: controlled(ENUMS.yearCertainty),
	entryCountLabel: controlled(ENUMS.entryCountLabel),
	// --- set_union ---
	languages: setUnion(),
	scripts: setUnion(),
	altTitles: setUnion(),
	// --- append_or_ranked ---
	notes: { policy: 'append_or_ranked', valueType: 'text', claimable: true },
	// --- editorial_only ---
	featured: { policy: 'editorial_only', valueType: 'bool', claimable: true },
	// --- system_lifecycle (lifecycle events only) ---
	status: systemLifecycle(),
	mergedIntoSourceId: systemLifecycle(),
	driftStatus: systemLifecycle(),
	// --- system_identity (never claimed) ---
	id: systemIdentity(),
	slug: systemIdentity(),
	contentHash: systemIdentity(),
	normalizerVersion: systemIdentity('int'),
	firstSeenAt: systemIdentity('int'),
	lastSeenAt: systemIdentity('int'),
	contentChangedAt: systemIdentity('int'),
	createdAt: systemIdentity('int'),
	updatedAt: systemIdentity('int'),
	createdBy: systemIdentity(),
	updatedBy: systemIdentity(),
	provenanceRepo: systemIdentity(),
	provenancePath: systemIdentity(),
	externalIds: systemIdentity()
};

export function policyFor(field: string): FieldPolicy | undefined {
	return FIELD_POLICIES[field];
}

/** Every field that carries a claim, in a stable order. */
export const CLAIMABLE_FIELDS = Object.keys(FIELD_POLICIES).filter(
	(f) => FIELD_POLICIES[f].claimable
);

/** Substantive bibliographic fields used to compute the identity match hash
 *  (rename rebind). Excludes the editorial `featured` flag and all system cols. */
export const SUBSTANTIVE_FIELDS = CLAIMABLE_FIELDS.filter((f) => f !== 'featured');

/**
 * decideChangeGate predicate tests (§1).
 *
 * The gate is a PURE function of a MergePlan — no DB. Each case hand-builds the
 * minimal plan the predicate reads (input derivation/origin/confidence/presence/
 * lifecycle, identity action/matchDecision, audit.fatal, conflicts) and asserts
 * the {auto_apply | propose | reject} verdict + its kind.
 */
import { describe, it, expect } from 'vitest';
import { decideChangeGate, type MergePlan } from './decision';
import type { MergeInput, ConflictOutcome } from './types';
import type { IdentityDecision } from './identity';
import type { AuditFinding } from './audit-gate';

/** Minimal plan builder — only the fields the gate reads matter; the rest are
 *  inert placeholders so the predicate can be exercised without a DB. */
function makePlan(over: {
	input?: Partial<MergeInput>;
	identity?: Partial<IdentityDecision>;
	fatal?: AuditFinding[];
	conflicts?: ConflictOutcome[];
	predictedConflicts?: ConflictOutcome[];
}): MergePlan {
	const input: MergeInput = {
		origin: 'website',
		originRecordId: 'website:src-1',
		derivation: 'editorial_decision',
		confidence: 1,
		evidence: 1,
		...over.input
	};
	const identity: IdentityDecision = {
		action: 'attach',
		status: 'active',
		matchDecision: 'explicit_target',
		hasStrongId: false,
		hasTitle: true,
		...over.identity
	};
	return {
		input,
		normIds: [],
		cleanFields: {},
		safeLinks: [],
		unsafeLinks: [],
		payload: {},
		contentHash: 'h',
		audit: { fatal: over.fatal ?? [], llm: { rejectedFields: [], rejectStrongIds: false } },
		identity,
		beforeProjection: null,
		afterProjection: null,
		baseContentHash: null,
		resultContentHash: null,
		predictedFieldOutcomes: [],
		predictedConflicts: over.predictedConflicts ?? [],
		conflicts: over.conflicts ?? [],
		heldClaims: [],
		rejectedClaims: [],
		diff: null,
		gate: { mode: 'auto_apply', reason: 'pending', kind: 'field_update' }
	};
}

describe('decideChangeGate', () => {
	// ── the five required branches ────────────────────────────────────────────

	it('editorial edit on a known source ⇒ auto_apply', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'website', derivation: 'editorial_decision', confidence: 1 },
				identity: { action: 'attach', matchDecision: 'explicit_target' }
			})
		);
		expect(g.mode).toBe('auto_apply');
		expect(g.kind).toBe('field_update');
		expect(g.reason).toBe('editorial_edit');
	});

	it('brand-new source ⇒ propose', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'website', derivation: 'editorial_decision', confidence: 1 },
				identity: { action: 'create', matchDecision: 'none', hasTitle: true }
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('new_source');
	});

	it('llm_extraction attaching cleanly ⇒ propose (never auto-applies)', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'openalex', derivation: 'llm_extraction', confidence: 0.95, evidence: 2 },
				identity: { action: 'attach', matchDecision: 'strong_single', hasStrongId: true }
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('enrichment');
		expect(g.reason).toContain('low_trust');
	});

	it('fatal audit finding ⇒ reject', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'website', derivation: 'editorial_decision' },
				fatal: [{ scope: 'observation', reason: 'confidence_out_of_range:2' }]
			})
		);
		expect(g.mode).toBe('reject');
		expect(g.reason).toContain('confidence_out_of_range');
	});

	it('trusted harvest with a strong identity match ⇒ auto_apply', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', confidence: 0.9, evidence: 1 },
				identity: { action: 'attach', matchDecision: 'strong_single', hasStrongId: true }
			})
		);
		expect(g.mode).toBe('auto_apply');
		expect(g.reason).toBe('strong_match_harvest');
	});

	// ── ordering / special-case branches ──────────────────────────────────────

	it('fatal audit beats everything (even a clean editorial attach)', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'website', derivation: 'editorial_decision', confidence: 1 },
				identity: { action: 'attach', matchDecision: 'explicit_target' },
				fatal: [{ scope: 'observation', reason: 'malformed_identifier:doi:x' }]
			})
		);
		expect(g.mode).toBe('reject');
	});

	it('upstream missing + attached ⇒ auto_apply drift', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', presence: 'missing' },
				identity: { action: 'attach', matchDecision: 'strong_single' }
			})
		);
		expect(g.mode).toBe('auto_apply');
		expect(g.kind).toBe('drift');
	});

	it('upstream missing + unknown source ⇒ reject', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', presence: 'missing' },
				identity: { action: 'create', matchDecision: 'none' }
			})
		);
		expect(g.mode).toBe('reject');
		expect(g.reason).toBe('missing_unknown');
	});

	it('editorial lifecycle op on a known source ⇒ auto_apply', () => {
		const g = decideChangeGate(
			makePlan({
				input: {
					origin: 'website',
					derivation: 'editorial_decision',
					lifecycle: { op: 'soft_delete' }
				},
				identity: { action: 'attach', matchDecision: 'explicit_target' }
			})
		);
		expect(g.mode).toBe('auto_apply');
		expect(g.kind).toBe('lifecycle');
	});

	it('lifecycle op from a non-editorial origin ⇒ propose', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', lifecycle: { op: 'hide' } },
				identity: { action: 'attach', matchDecision: 'strong_single' }
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('lifecycle');
	});

	it('strong id pointing at MANY sources ⇒ propose (identity_conflict)', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed' },
				identity: { action: 'conflict', matchDecision: 'strong_multi' }
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('identity_conflict');
	});

	it('predicted same-band conflict ⇒ propose', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', confidence: 0.9 },
				identity: { action: 'attach', matchDecision: 'strong_single' },
				predictedConflicts: [{ kind: 'field_conflict', fieldName: 'title', detail: 'same-band' }]
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('identity_conflict');
		expect(g.reason).toBe('conflict');
	});

	it('trusted harvest but a WEAK (non-strong) match ⇒ propose', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'crossref', derivation: 'observed', confidence: 0.9 },
				identity: { action: 'attach', matchDecision: 'medium_corroborated' }
			})
		);
		expect(g.mode).toBe('propose');
		expect(g.kind).toBe('enrichment');
	});

	it('editorial edit BELOW the 0.99 confidence floor falls through to propose', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'website', derivation: 'editorial_decision', confidence: 0.5 },
				identity: { action: 'attach', matchDecision: 'explicit_target' }
			})
		);
		expect(g.mode).toBe('propose');
	});

	it('repo_path rename rebind editorial edit ⇒ auto_apply', () => {
		const g = decideChangeGate(
			makePlan({
				input: { origin: 'manual', derivation: 'editorial_decision', confidence: 1 },
				identity: { action: 'attach', matchDecision: 'repo_path_rename_rebind' }
			})
		);
		expect(g.mode).toBe('auto_apply');
	});
});

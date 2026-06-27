/**
 * Identity find-or-create (§2 step 7 / N5 / F4).
 *
 *   strong, single match        ⇒ attach
 *   strong, multiple matches     ⇒ conflict (candidate; NEVER auto-merge)
 *   repo_path exact match        ⇒ attach
 *   repo_path renamed            ⇒ rebind to the source whose substantive-field
 *                                  match-hash equals the incoming one
 *   medium (title+author+year)   ⇒ attach iff corroborated, else candidate
 *   weak (title only)            ⇒ candidate of a similar source, NEVER updates
 *                                  an active source
 *   none matched                 ⇒ create
 *
 * A find never moves an identifier off another source. A candidate source is
 * created (active data is preserved) with a reserved `cand-<shortid>-<slug>`
 * slug so it cannot collide with or pollute the public namespace.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { sources, sourceIdentifiers } from '../db/schema';
import type { Db } from './types';
import type { NormalizedIdentifier } from './normalize';
import { coreText } from './normalize';
import { hashValue } from './hash';
import { SUBSTANTIVE_FIELDS } from './field-policies';
import { STRONG_ID_KINDS } from './constants';

export interface IdentityDecision {
	action: 'attach' | 'create' | 'candidate' | 'conflict';
	/** attach target source id */
	sourceId?: string;
	/** status for a newly created source */
	status: 'active' | 'candidate';
	matchDecision: string;
	/** existing source this new one is a candidate duplicate of (relation written) */
	candidateOf?: string;
	/** conflicting source ids when a strong id pointed at multiple sources */
	conflictSourceIds?: string[];
	hasStrongId: boolean;
	hasTitle: boolean;
}

/** Columns with a NOT-NULL DB default. An incoming payload that OMITS one of
 *  these still ends up storing the default on the source row, so the match-hash
 *  fills the same default on both sides — otherwise a rename whose harvester
 *  never sends e.g. yearCertainty would fail to rebind. */
const SUBSTANTIVE_DEFAULTS: Record<string, unknown> = {
	category: 'primary',
	yearCertainty: 'exact'
};

const isEmpty = (v: unknown) =>
	v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Compute the identity match-hash from substantive (bibliographic) fields only.
 *  Excludes id/slug/provenance/audit so a repo_path rename — whose ONLY change
 *  is the path — still hashes identically and rebinds. */
export function matchHash(fields: Record<string, unknown>): string {
	const picked: Record<string, unknown> = {};
	for (const f of SUBSTANTIVE_FIELDS) {
		let v = fields[f];
		if (isEmpty(v) && f in SUBSTANTIVE_DEFAULTS) v = SUBSTANTIVE_DEFAULTS[f];
		if (!isEmpty(v)) picked[f] = v;
	}
	return hashValue(picked);
}

/** Lightweight candidate row used for fuzzy matching. */
interface CandidateRow {
	id: string;
	status: string;
	core: string;
	author: string;
	yearStart: number | null;
	yearText: string | null;
}

/** Bounded candidate search: sources whose core-title equals the incoming one.
 *  Scans the catalogue and filters in JS (v1; a persisted match-key index is a
 *  documented [later] optimization). */
async function similarByTitle(db: Db, core: string): Promise<CandidateRow[]> {
	if (!core) return [];
	const rows = await db
		.select({
			id: sources.id,
			status: sources.status,
			title: sources.title,
			author: sources.author,
			yearStart: sources.yearStart,
			yearText: sources.yearText
		})
		.from(sources);
	return rows
		.filter((r) => coreText(r.title) === core)
		.map((r) => ({
			id: r.id,
			status: r.status,
			core,
			author: coreText(r.author),
			yearStart: r.yearStart,
			yearText: r.yearText
		}));
}

/** Substantive-field match-hash of an EXISTING source row (for rename rebind). */
async function matchHashOfSource(db: Db, sourceId: string): Promise<string | undefined> {
	const [row] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
	if (!row) return undefined;
	const fields: Record<string, unknown> = {};
	for (const f of SUBSTANTIVE_FIELDS) fields[f] = (row as Record<string, unknown>)[f];
	return matchHash(fields);
}

export async function resolveIdentity(
	db: Db,
	args: {
		identifiers: NormalizedIdentifier[];
		fields: Record<string, unknown>;
	}
): Promise<IdentityDecision> {
	const ids = args.identifiers.filter((i) => i.valid);
	const strongIds = ids.filter((i) => STRONG_ID_KINDS.has(i.kind));
	const hasStrongId = strongIds.length > 0;
	const title = args.fields.title;
	const hasTitle = title !== null && title !== undefined && String(title).trim() !== '';
	const hasAuthor = !!coreText(args.fields.author);
	const hasYear = args.fields.yearStart != null || !!args.fields.yearText;
	const core = coreText(title);

	const base = { hasStrongId, hasTitle, status: 'active' as const };

	// ── 1. strong identifiers (include redirect targets in the lookup) ──────────
	if (hasStrongId) {
		const lookups = new Set<string>();
		for (const i of strongIds) {
			lookups.add(`${i.kind}\t${i.valueNorm}`);
			if (i.redirectsToNorm) lookups.add(`${i.kind}\t${i.redirectsToNorm}`);
		}
		const matched = await lookupSourcesByIds(db, lookups);
		const distinct = [...new Set(matched)];
		if (distinct.length === 1) {
			return { ...base, action: 'attach', sourceId: distinct[0], matchDecision: 'strong_single' };
		}
		if (distinct.length > 1) {
			return {
				...base,
				action: 'conflict',
				status: 'candidate',
				conflictSourceIds: distinct,
				matchDecision: 'strong_multi'
			};
		}
		// strong id present but unknown → fall through to repo_path/title, else create
	}

	// ── 2. repo_path: exact match, then rename-rebind by match-hash ─────────────
	const repoId = ids.find((i) => i.kind === 'repo_path');
	if (repoId) {
		const matched = await lookupSourcesByIds(db, new Set([`repo_path\t${repoId.valueNorm}`]));
		if (matched.length === 1) {
			return { ...base, action: 'attach', sourceId: matched[0], matchDecision: 'repo_path_exact' };
		}
		// not found → maybe a rename: a source with identical substantive content
		const incomingHash = matchHash(args.fields);
		const candidates = await similarByTitle(db, core);
		for (const c of candidates) {
			if (c.status === 'merged' || c.status === 'soft_deleted') continue;
			const h = await matchHashOfSource(db, c.id);
			if (h === incomingHash) {
				return { ...base, action: 'attach', sourceId: c.id, matchDecision: 'repo_path_rename_rebind' };
			}
		}
		// no rebind target → create a fresh source keyed by the new repo_path
		if (hasTitle || hasStrongId) {
			return { ...base, action: 'create', matchDecision: 'repo_path_new' };
		}
	}

	// strong id with no match and no repo_path handling → create
	if (hasStrongId) {
		return { ...base, action: 'create', matchDecision: 'strong_new' };
	}

	// ── 3. medium: title + author + year ────────────────────────────────────────
	if (hasTitle && hasAuthor && hasYear) {
		const candidates = (await similarByTitle(db, core)).filter(
			(c) => c.status !== 'merged' && c.status !== 'soft_deleted'
		);
		const incAuthor = coreText(args.fields.author);
		const incYear = args.fields.yearStart != null ? Number(args.fields.yearStart) : null;
		const incYearText = args.fields.yearText ? String(args.fields.yearText) : null;
		const corroborated = candidates.filter(
			(c) =>
				c.author === incAuthor &&
				((incYear != null && c.yearStart === incYear) ||
					(incYearText != null && c.yearText === incYearText))
		);
		if (corroborated.length === 1) {
			return {
				...base,
				action: 'attach',
				sourceId: corroborated[0].id,
				matchDecision: 'medium_corroborated'
			};
		}
		if (candidates.length >= 1) {
			return {
				...base,
				action: 'candidate',
				status: 'candidate',
				candidateOf: candidates[0].id,
				matchDecision: 'medium_uncorroborated'
			};
		}
		return { ...base, action: 'create', matchDecision: 'medium_new' };
	}

	// ── 4. weak: title only — NEVER updates an active source ─────────────────────
	if (hasTitle) {
		const candidates = (await similarByTitle(db, core)).filter(
			(c) => c.status !== 'merged' && c.status !== 'soft_deleted'
		);
		if (candidates.length >= 1) {
			return {
				...base,
				action: 'candidate',
				status: 'candidate',
				candidateOf: candidates[0].id,
				matchDecision: 'weak_title_candidate'
			};
		}
		return { ...base, action: 'create', matchDecision: 'weak_title_new' };
	}

	// ── 5. none ─────────────────────────────────────────────────────────────────
	return { ...base, action: 'create', matchDecision: 'none' };
}

/** Resolve a set of `kind\tvalueNorm` keys to the distinct source ids holding them. */
async function lookupSourcesByIds(db: Db, keys: Set<string>): Promise<string[]> {
	if (keys.size === 0) return [];
	const kinds = new Set<string>();
	const norms = new Set<string>();
	for (const k of keys) {
		const [kind, norm] = k.split('\t');
		kinds.add(kind);
		norms.add(norm);
	}
	const rows = await db
		.select({ kind: sourceIdentifiers.kind, valueNorm: sourceIdentifiers.valueNorm, sourceId: sourceIdentifiers.sourceId })
		.from(sourceIdentifiers)
		.where(
			and(inArray(sourceIdentifiers.kind, [...kinds]), inArray(sourceIdentifiers.valueNorm, [...norms]))
		);
	const out: string[] = [];
	for (const r of rows) {
		if (keys.has(`${r.kind}\t${r.valueNorm}`) && r.sourceId) out.push(r.sourceId);
	}
	return out;
}

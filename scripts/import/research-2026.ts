/** Curated 2026 research records. Preview by default; --apply writes through the merge ledger. */
import { and, eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import records from '../data/research-2026.json';
import { sources, sourceLinks, sourceIdentifiers } from '../../src/lib/server/db/schema';
import { mergeSourceObservation, planSourceObservation, normalizeIdentifier, type Db, type MergeInput } from '../../src/lib/server/merge';
import { explicitSlugError } from '../../src/lib/server/resolve-slug';
import { parseImporterCli } from './lib/run';
import { addPersons } from './lib/entities';

export type RecordEntry = {
	slug: string;
	title: string;
	existing: boolean;
	corrections?: Record<string, { from: unknown; to: unknown }>;
	fields: Record<string, unknown>;
	identifiers: { kind: string; value: string }[];
	links: { type: string; url: string; label: string }[];
};

export async function run(db: Db, entries: RecordEntry[] = records, apply = false) {
	const plans: { record: RecordEntry; input: MergeInput; missingLinks: number }[] = [];
	const slugs = new Set<string>();
	const identifierOwners = new Map<string, string>();
	// Check the entire batch before making any writes.
	for (const record of entries) {
		if (slugs.has(record.slug)) throw new Error(`Duplicate input slug: ${record.slug}`);
		slugs.add(record.slug);
		const [source] = await db.select().from(sources).where(eq(sources.slug, record.slug));
		if (record.existing && !source) throw new Error(`Missing reviewed source: ${record.slug}`);
		if (source && source.status !== 'active') throw new Error(`Inactive source: ${record.slug}`);
		if (!source) {
			const error = await explicitSlugError(db, record.slug);
			if (error) throw new Error(`${record.slug}: ${error}`);
		} else if (!record.existing && source.title !== record.fields.title) {
			throw new Error(`New-source slug already belongs to another title: ${record.slug}`);
		}
		// Explicit source targets bypass the merge engine's identifier resolution.
		// Check every identifier before any record in the batch can be written.
		for (const raw of [{ kind: 'repo_path', value: `research-2026:${record.slug}` }, ...record.identifiers]) {
			const id = normalizeIdentifier(raw);
			const key = `${id.kind}:${id.valueNorm}`;
			const owner = identifierOwners.get(key);
			if (owner && owner !== record.slug) throw new Error(`Duplicate batch identifier: ${key}`);
			identifierOwners.set(key, record.slug);
			const [stored] = await db.select().from(sourceIdentifiers).where(and(
				eq(sourceIdentifiers.kind, id.kind), eq(sourceIdentifiers.valueNorm, id.valueNorm)
			));
			if (stored && (stored.sourceId !== source?.id || stored.status !== 'active')) {
				throw new Error(`Identifier ownership needs review: ${record.slug}: ${key}`);
			}
		}
		for (const [key, correction] of Object.entries(record.corrections ?? {})) {
			const value = (source as unknown as Record<string, unknown>)?.[key];
			if (value !== correction.from && value !== correction.to) {
				throw new Error(`Correction needs review: ${record.slug}.${key}`);
			}
		}
		const links = source
			? await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, source.id)) : [];
		for (const link of record.links) {
			if (!['https:', 'http:'].includes(new URL(link.url).protocol)) throw new Error('Invalid link protocol');
		}
		// A later editorial value is preserved even if the curated file contains an older gap-fill.
		const fields = Object.fromEntries(Object.entries(record.fields).filter(([key, value]) => {
			if (record.corrections?.[key]) return false;
			if (!source) return true;
			if (key === 'languages' || key === 'scripts') return true; // set-union claims
			const present = (source as unknown as Record<string, unknown>)[key];
			return present == null || present === '' || (Array.isArray(present) && present.length === 0)
				|| JSON.stringify(present) === JSON.stringify(value);
		}));
		for (const key of ['languages', 'scripts'] as const) {
			if (Array.isArray(fields[key])) fields[key] = [...new Set([
				...(source?.[key] ?? []), ...(fields[key] as string[])
			])].sort();
		}
		plans.push({ record, missingLinks: record.links.filter((link) =>
			!links.some((stored) => stored.url === link.url && stored.type === link.type && stored.status === 'active')).length,
			input: {
				origin: 'research-2026', originRecordId: record.slug,
				derivation: 'curated_assertion', confidence: 0.8,
				targetSourceId: source?.id, slug: record.slug, fields,
				identifiers: [{ kind: 'repo_path', value: `research-2026:${record.slug}` }, ...record.identifiers],
				links: record.links, presence: 'seen', rawPayload: record
			}
		});
	}
	for (const { record, input } of plans) {
		const plan = await planSourceObservation(db, input, { simulate: true });
		if (plan.duplicate && !['applied', 'noop'].includes(plan.duplicate.status)) {
			throw new Error(`Earlier observation needs review: ${record.slug} (${plan.duplicate.status})`);
		}
		// The simulator can predict a rank conflict even for an identical scalar.
		// The writer treats that case as a no-op; only changed values can be blocked.
		const blocked = plan.predictedFieldOutcomes.filter((outcome) =>
			['conflict', 'held_below', 'rejected'].includes(outcome.status)
			&& JSON.stringify(outcome.before) !== JSON.stringify(outcome.after));
		if (!plan.duplicate && (plan.audit.fatal.length || plan.unsafeLinks.length || plan.conflicts.length
			|| blocked.length || plan.rejectedClaims.length || plan.gate.mode === 'reject'
			|| (env.SOURCES_ENABLE_PROPOSE === 'true' && plan.gate.mode === 'propose')
			|| !['attach', 'create'].includes(plan.identity.action)
			|| (plan.identity.action === 'attach' && plan.identity.sourceId !== input.targetSourceId))) {
			throw new Error(`Preflight needs review: ${record.slug} (${plan.identity.action}): ${JSON.stringify({ fatal: plan.audit.fatal, unsafe: plan.unsafeLinks, conflicts: plan.predictedConflicts, held: plan.heldClaims, rejected: plan.rejectedClaims, gate: plan.gate })}`);
		}
		if (record.corrections) {
			const correction = await planSourceObservation(db, {
				origin: 'manual', originRecordId: `research-2026:${record.slug}:corrections`,
				derivation: 'editorial_decision', confidence: 1, targetSourceId: input.targetSourceId,
				fields: Object.fromEntries(Object.entries(record.corrections).map(([key, change]) => [key, change.to])),
				rawPayload: { corrections: record.corrections, evidence: record.links }
			}, { simulate: true });
			if (correction.duplicate && !['applied', 'noop'].includes(correction.duplicate.status)) {
				throw new Error(`Earlier correction needs review: ${record.slug} (${correction.duplicate.status})`);
			}
			if (!correction.duplicate && (correction.audit.fatal.length || correction.predictedConflicts.length
				|| correction.heldClaims.length || correction.rejectedClaims.length || correction.gate.mode === 'reject'
				|| (env.SOURCES_ENABLE_PROPOSE === 'true' && correction.gate.mode === 'propose'))) {
				throw new Error(`Correction preflight needs review: ${record.slug}`);
			}
		}
	}
	const results = [];
	for (const { record, input, missingLinks } of plans) {
		if (!apply) {
			results.push({ slug: record.slug, action: input.targetSourceId ? 'enrich' : 'create',
				fields: input.fields, corrections: record.corrections ?? {}, missingLinks });
			continue;
		}
		const result = await mergeSourceObservation(db, input);
		const sourceId = result.sourceId ?? (result.status === 'noop' ? input.targetSourceId : undefined);
		if (!['applied', 'noop'].includes(result.status) || !sourceId
			|| result.conflicts.length || result.heldClaims.length || result.rejectedClaims.length) {
			throw new Error(`Import needs review: ${record.slug} (${result.status})`);
		}
		const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
		if (source.slug !== record.slug) throw new Error(`Unexpected identity: ${record.slug} -> ${source.slug}`);
		if (record.corrections) {
			const correction = await mergeSourceObservation(db, {
				origin: 'manual', originRecordId: `research-2026:${record.slug}:corrections`,
				derivation: 'editorial_decision', confidence: 1, targetSourceId: source.id,
				fields: Object.fromEntries(Object.entries(record.corrections).map(([key, change]) => [key, change.to])),
				rawPayload: { corrections: record.corrections, evidence: record.links }
			});
			if (!['applied', 'noop'].includes(correction.status) || correction.conflicts.length
				|| correction.heldClaims.length || correction.rejectedClaims.length) throw new Error(`Correction was not applied: ${record.slug}`);
			const [updated] = await db.select().from(sources).where(eq(sources.id, source.id));
			for (const [key, change] of Object.entries(record.corrections)) {
				if (JSON.stringify((updated as unknown as Record<string, unknown>)[key]) !== JSON.stringify(change.to)) {
					throw new Error(`Correction readback failed: ${record.slug}.${key}`);
				}
			}
		}
		const links = await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, source.id));
		for (const link of record.links) {
			if (!links.some((stored) => stored.url === link.url && stored.type === link.type && stored.status === 'active')) {
				throw new Error(`Link was not published: ${record.slug}: ${link.url}`);
			}
		}
		if (!record.existing) {
			await addPersons(db, sourceId, source.author ?? '', { origin: 'research-2026', confidence: 0.8 });
		}
		results.push({ slug: record.slug, status: result.status, sourceId });
	}
	return results;
}

if (import.meta.main) {
	const { db } = parseImporterCli();
	const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
	console.log(JSON.stringify(await run(db, records, apply), null, 2));
}

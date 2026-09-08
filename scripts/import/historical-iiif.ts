/** Curated historical facsimiles. Preview by default; --apply writes through the merge ledger. */
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import records from '../data/historical-iiif.json';
import { sources, sourceLinks } from '../../src/lib/server/db/schema';
import { mergeSourceObservation, planSourceObservation, type Db, type MergeInput } from '../../src/lib/server/merge';
import { explicitSlugError } from '../../src/lib/server/resolve-slug';
import { parseImporterCli } from './lib/run';

export type RecordEntry = {
	slug: string;
	title: string;
	existing: boolean;
	corrections?: Record<string, { from: unknown; to: unknown }>;
	fields: Record<string, unknown>;
	materials: { label: string; manifest: string; description: string; honkokuEntryId?: string }[];
	links: { type: string; url: string; label: string }[];
};

export async function run(db: Db, entries: RecordEntry[] = records, apply = false) {
	const plans: { record: RecordEntry; input: MergeInput; missingLinks: number }[] = [];
	const slugs = new Set<string>();
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
		for (const [key, correction] of Object.entries(record.corrections ?? {})) {
			const value = (source as unknown as Record<string, unknown>)?.[key];
			if (value !== correction.from && value !== correction.to) {
				throw new Error(`Correction needs review: ${record.slug}.${key}`);
			}
		}
		const links = source
			? await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, source.id)) : [];
		for (const material of record.materials) {
			if (!record.links.some((link) => link.type === 'iiif' && link.url === material.manifest)) {
				throw new Error(`Missing facsimile link: ${record.slug}`);
			}
			if (material.honkokuEntryId && !record.links.some((link) =>
				link.type === 'transcription' && link.url === `https://app.honkoku.org/reader/${material.honkokuEntryId}`)) {
				throw new Error(`Missing transcription link: ${record.slug}`);
			}
		}
		for (const link of record.links) {
			if (!['https:', 'http:'].includes(new URL(link.url).protocol)) throw new Error('Invalid link protocol');
		}
		// A later editorial value is preserved even if the curated file contains an older gap-fill.
		const fields = Object.fromEntries(Object.entries(record.fields).filter(([key, value]) => {
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
				origin: 'historical-iiif', originRecordId: record.slug,
				derivation: 'curated_assertion', confidence: 0.8,
				targetSourceId: source?.id, slug: record.slug, fields,
				identifiers: [{ kind: 'repo_path', value: `historical-iiif:${record.slug}` }],
				links: record.links, presence: 'seen', rawPayload: record
			}
		});
	}
	for (const { record, input } of plans) {
		const plan = await planSourceObservation(db, input, { simulate: env.SOURCES_ENABLE_PROPOSE === 'true' });
		if (plan.duplicate && input.targetSourceId) continue;
		if (plan.audit.fatal.length || plan.unsafeLinks.length || plan.gate.mode === 'reject'
			|| (env.SOURCES_ENABLE_PROPOSE === 'true' && plan.gate.mode === 'propose')
			|| !['attach', 'create'].includes(plan.identity.action)
			|| (plan.identity.action === 'attach' && plan.identity.sourceId !== input.targetSourceId)) {
			throw new Error(`Preflight needs review: ${record.slug} (${plan.identity.action})`);
		}
	}
	const results = [];
	for (const { record, input, missingLinks } of plans) {
		if (!apply) {
			results.push({ slug: record.slug, action: input.targetSourceId ? 'enrich' : 'create', missingLinks });
			continue;
		}
		const result = await mergeSourceObservation(db, input);
		const sourceId = result.sourceId ?? (result.status === 'noop' ? input.targetSourceId : undefined);
		if (!['applied', 'partial', 'noop'].includes(result.status) || !sourceId) {
			throw new Error(`Import needs review: ${record.slug} (${result.status})`);
		}
		const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
		if (source.slug !== record.slug) throw new Error(`Unexpected identity: ${record.slug} -> ${source.slug}`);
		if (record.corrections) {
			const correction = await mergeSourceObservation(db, {
				origin: 'manual', originRecordId: `historical-iiif:${record.slug}:corrections`,
				derivation: 'editorial_decision', confidence: 1, targetSourceId: source.id,
				fields: Object.fromEntries(Object.entries(record.corrections).map(([key, change]) => [key, change.to])),
				rawPayload: { corrections: record.corrections, evidence: record.links }
			});
			if (!['applied', 'noop'].includes(correction.status)) throw new Error(`Correction was not applied: ${record.slug}`);
		}
		const links = await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, source.id));
		for (const link of record.links) {
			if (!links.some((stored) => stored.url === link.url && stored.type === link.type && stored.status === 'active')) {
				throw new Error(`Link was not published: ${record.slug}: ${link.url}`);
			}
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

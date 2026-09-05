#!/usr/bin/env bun
import { eq } from 'drizzle-orm';
import { persons } from '../../src/lib/server/db/schema';
import type { Db } from './lib/entities';
import { parseImporterCli, type ImporterRunOptions, type ImporterSummary } from './lib/run';
import { planPersonReviews, type ReviewedPerson } from './lib/person-review';
import readings from '../data/person-readings.json';

export type PersonReading = ReviewedPerson & { sources: string[]; checkedAt: string; note: string };

/** Validate every reviewed value before writing; a changed identity needs another review. */
export async function run(db: Db, opts: ImporterRunOptions = {}, entries: PersonReading[] = readings): Promise<ImporterSummary> {
	return db.transaction(async (tx) => {
		const rows = await tx.select().from(persons);
		const seen = new Set<string>();
		for (const entry of entries) {
			if (!entry.sources.length || !entry.checkedAt || !entry.note)
				throw new Error(`Missing reading evidence: ${entry.name}`);
			for (const field of Object.keys(entry.corrected)) {
				if (!['name', 'nameEn', 'nameKana'].includes(field))
					throw new Error(`Invalid reading field: ${field}`);
			}
			for (const slug of entry.slugs) {
				if (seen.has(slug)) throw new Error(`Duplicate reading: ${slug}`);
				seen.add(slug);
				if (rows.some(r => r.slug === slug && r.status !== 'active'))
					throw new Error(`Reading target merged: ${slug}`);
			}
		}
		const plans = planPersonReviews(rows, entries);
		const missing = entries.filter(e => !rows.some(r => e.slugs.includes(r.slug))).map(e => e.slugs[0]);
		let applied = 0;
		const fields = { name: 0, nameEn: 0, nameKana: 0 };
		for (const row of rows) {
			const plan = plans.get(row.id);
			if (!plan) continue;
			const patch: Partial<Pick<typeof persons.$inferInsert, 'name' | 'nameEn' | 'nameKana'>> = {};
			for (const field of ['name', 'nameEn', 'nameKana'] as const) {
				if (field in plan && row[field] !== plan[field]) {
					patch[field] = plan[field] as never;
					fields[field]++;
				}
			}
			if (!Object.keys(patch).length) continue;
			applied++;
			if (!opts.dryRun && !opts.plan) await tx.update(persons).set(patch).where(eq(persons.id, row.id));
		}
		return { feed: 'person-readings', applied, noop: plans.size - applied, candidate: 0, conflict: 0, drifted: 0, other: missing.length, detail: { fields, missing } };
	});
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	console.log(JSON.stringify(await run(db, opts)));
}

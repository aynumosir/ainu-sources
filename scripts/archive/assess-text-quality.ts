#!/usr/bin/env bun
/**
 * Judge every text variant, record whether it is fit to quote, and point the
 * preferred flag at the best variant the evidence supports.
 *
 * Samples pages spread through each work rather than the first few, because the
 * front matter of a book is often typeset differently from its body.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { assessTextQuality, sampleVariantPages } from '../../src/lib/server/archive/text-quality';
import { pickPreferredVariant } from '../../src/lib/archive/ocr';

type Reliability = 'unassessed' | 'sound' | 'suspect';
type Variant = {
	revisionId: string;
	variant: string;
	slug: string;
	sourceKind: string;
	reliability: Reliability;
};
type CoverageRow = { variant: string; reliability: Reliability; preferred: number };

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const client = createClient({ url: requireEnv('DATABASE_URL'), authToken: process.env.DATABASE_AUTH_TOKEN });
	const db = drizzle(client);

	const variants = await db.all<Variant>(sql`
		select cov.revision_id as revisionId, cov.variant as variant,
			cov.source_kind as sourceKind, cov.reliability as reliability, src.slug as slug
		from revision_ocr_coverage cov
		join file_revisions fr on fr.id = cov.revision_id and fr.is_current = 1
		join source_files sf on sf.id = fr.source_file_id
		join sources src on src.id = sf.source_id
		order by src.slug, cov.variant
	`);
	console.log(`${variants.length} text variants to assess`);

	let unassessed = 0;
	let suspect = 0;
	const revisionIds: string[] = [];
	const slugByRevision = new Map<string, string>();
	const effectiveReliability = new Map<string, Reliability>();
	for (const variant of variants) {
		if (!slugByRevision.has(variant.revisionId)) {
			slugByRevision.set(variant.revisionId, variant.slug);
			revisionIds.push(variant.revisionId);
		}
		const samples = await sampleVariantPages(db, variant.revisionId, variant.variant);
		const verdict = assessTextQuality(samples);
		// Sound is human-certified; the automated assessor does not downgrade it.
		const effective: Reliability = variant.reliability === 'sound' ? 'sound' : verdict.reliability;
		effectiveReliability.set(`${variant.revisionId}:${variant.variant}`, effective);
		if (verdict.reliability === 'suspect') {
			suspect += 1;
			console.log(`  suspect  ${variant.slug} (${variant.variant}, ${variant.sourceKind}): ${verdict.note}`);
		} else {
			unassessed += 1;
		}
		if (dryRun) continue;
		if (verdict.reliability === 'suspect') {
			await db.run(sql`
				update revision_ocr_coverage
				set reliability = 'suspect', reliability_note = ${verdict.note}
				where revision_id = ${variant.revisionId} and variant = ${variant.variant}
					and reliability <> 'sound'
			`);
		} else {
			await db.run(sql`
				update revision_ocr_coverage
				set reliability = 'unassessed', reliability_note = null
				where revision_id = ${variant.revisionId} and variant = ${variant.variant}
					and reliability = 'suspect'
			`);
		}
	}
	console.log(`\nsuspect ${suspect}, left unassessed ${unassessed}`);

	let flips = 0;
	for (const revisionId of revisionIds) {
		const rows = await db.all<CoverageRow>(sql`
			select variant, reliability, preferred
			from revision_ocr_coverage
			where revision_id = ${revisionId}
			order by rowid
		`);
		const current = rows.find((row) => row.preferred)?.variant ?? null;
		const pick = pickPreferredVariant(
			rows.map((row) => ({
				variant: row.variant,
				reliability: effectiveReliability.get(`${revisionId}:${row.variant}`) ?? row.reliability
			})),
			current
		);
		if (!pick || pick === current) continue;
		flips += 1;
		const reliabilityOf = (variant: string) =>
			effectiveReliability.get(`${revisionId}:${variant}`) ??
			rows.find((row) => row.variant === variant)?.reliability ??
			'unknown';
		const from = current ? reliabilityOf(current) : 'none';
		const to = reliabilityOf(pick);
		console.log(`  preferred ${slugByRevision.get(revisionId)}: ${current ?? 'none'} → ${pick} (${to} outranks ${from})`);
		if (dryRun) continue;
		await db.run(sql`
			update revision_ocr_coverage set preferred = 0
			where revision_id = ${revisionId} and variant <> ${pick}
		`);
		await db.run(sql`
			update revision_ocr_coverage set preferred = 1
			where revision_id = ${revisionId} and variant = ${pick}
		`);
	}
	console.log(`preferred flips ${flips}${dryRun ? ' (dry run, nothing written)' : ''}`);
}

await main();

#!/usr/bin/env bun
/**
 * Score every active work by PageRank over the accepted cites graph and store
 * the score on sources.significance, so the archive library can sort by it.
 * Isolated works keep the uniform floor; a fresh run overwrites earlier scores.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/lib/server/db';
import { sources } from '../../src/lib/server/db/schema';
import { computeSourceSignificance } from '../../src/lib/server/network';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	requireEnv('DATABASE_URL');

	const scores = await computeSourceSignificance();
	console.log(`${scores.size} active sources scored`);

	const rows = await db
		.select({ id: sources.id, slug: sources.slug })
		.from(sources)
		.where(inArray(sources.id, [...scores.keys()]));
	const slugById = new Map(rows.map((r) => [r.id, r.slug]));
	const ranked = [...scores.entries()]
		.map(([id, score]) => ({ slug: slugById.get(id) ?? id, score }))
		.sort((a, b) => b.score - a.score);

	if (!dryRun) {
		// One atomic batch: per-row round trips against the remote database
		// would stretch a refresh into thousands of requests.
		await db.batch(
			[...scores.entries()].map(([id, score]) =>
				db.update(sources).set({ significance: score }).where(eq(sources.id, id))
			)
		);
	}
	console.log(`${dryRun ? 'would update' : 'updated'} ${scores.size} sources`);
	console.log('\ntop 10:');
	for (const { slug, score } of ranked.slice(0, 10)) {
		console.log(`  ${score.toFixed(4)}  ${slug}`);
	}
}

await main();

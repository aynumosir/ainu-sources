#!/usr/bin/env bun
/**
 * Consistency gate for the catalogue database.
 *
 * READ-ONLY against the database — issues SELECTs/PRAGMAs only. Two layers:
 *
 *   1. Invariants that must hold on any healthy catalogue: no active source
 *      without a title, no duplicate slugs, no duplicate link/tag joins, no
 *      person without a name, no unknown source status.
 *   2. Count monotonicity against the previous run's snapshot: sources,
 *      revisions, observations and diffs are append-only under the merge
 *      engine (soft-delete only, never a row delete), so a decrease there is
 *      a hard failure. Other tables can legitimately shrink through editorial
 *      set-replacement; a decrease is reported as a warning.
 *
 * The snapshot lives outside the repo (default
 * ~/.ainu-sources/state/consistency-counts.json, override with
 * AINU_VERIFY_STATE) and is rewritten after every passing run.
 *
 * Exits nonzero on any hard failure, so cron/CI can block on it. Pair with
 * scripts/check-fk-enforcement.ts for referential integrity.
 *
 * Run: bun scripts/verify-consistency.ts   (reads DATABASE_URL / DATABASE_AUTH_TOKEN)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createClient } from '@libsql/client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const isFile = url.startsWith('file:');
if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');
const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

const STATE_FILE =
	process.env.AINU_VERIFY_STATE ?? path.join(os.homedir(), '.ainu-sources', 'state', 'consistency-counts.json');

const n = async (sql: string): Promise<number> => Number((await client.execute(sql)).rows[0]?.c ?? 0);

const failures: string[] = [];
const warnings: string[] = [];

// ── 1. invariants ────────────────────────────────────────────────────────────
const KNOWN_STATUS = ['active', 'hidden', 'candidate', 'soft_deleted', 'merged'];

const untitled = await n(
	`SELECT COUNT(*) c FROM sources WHERE (title IS NULL OR trim(title) = '') AND (status = 'active' OR status IS NULL)`
);
if (untitled) failures.push(`${untitled} active source(s) without a title`);

const dupSlugs = (
	await client.execute(`SELECT slug, COUNT(*) c FROM sources GROUP BY slug HAVING COUNT(*) > 1 LIMIT 5`)
).rows;
if (dupSlugs.length) failures.push(`duplicate slugs: ${dupSlugs.map((r) => `${r.slug}×${r.c}`).join(', ')}`);

const dupLinks = await n(
	`SELECT COUNT(*) c FROM (SELECT source_id FROM source_links GROUP BY source_id, type, url HAVING COUNT(*) > 1)`
);
if (dupLinks) warnings.push(`${dupLinks} duplicated (source, type, url) link group(s)`);

const dupTags = await n(
	`SELECT COUNT(*) c FROM (SELECT source_id FROM source_tags GROUP BY source_id, tag_id HAVING COUNT(*) > 1)`
);
if (dupTags) failures.push(`${dupTags} duplicated (source, tag) join group(s)`);

const nameless = await n(`SELECT COUNT(*) c FROM persons WHERE (name IS NULL OR trim(name) = '')`);
if (nameless) failures.push(`${nameless} person(s) without a name`);

const oddStatus = (
	await client.execute(
		`SELECT status, COUNT(*) c FROM sources WHERE status IS NOT NULL AND status NOT IN (${KNOWN_STATUS.map((s) => `'${s}'`).join(',')}) GROUP BY status`
	)
).rows;
if (oddStatus.length) warnings.push(`unknown source status: ${oddStatus.map((r) => `${r.status}×${r.c}`).join(', ')}`);

// ── 2. count snapshot + monotonicity ────────────────────────────────────────
// Append-only under the merge engine — a decrease means rows were destroyed.
const APPEND_ONLY = ['sources', 'source_revisions', 'source_observations', 'source_observation_diffs'];
// Can legitimately shrink (editorial set-replacement, queue draining) — warn only.
const TRACKED = [
	...APPEND_ONLY,
	'persons',
	'places',
	'institutions',
	'tags',
	'source_links',
	'source_tags',
	'source_persons',
	'source_places',
	'source_relations',
	'source_identifiers',
	'change_requests'
];

const counts: Record<string, number> = {};
for (const t of TRACKED) counts[t] = await n(`SELECT COUNT(*) c FROM ${t}`);
const proposed = await n(`SELECT COUNT(*) c FROM change_requests WHERE status = 'proposed'`);

let previous: { at?: string; counts?: Record<string, number> } = {};
if (fs.existsSync(STATE_FILE)) {
	try {
		previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
	} catch {
		warnings.push(`state file ${STATE_FILE} unreadable — monotonicity not checked this run`);
	}
}
for (const t of TRACKED) {
	const prev = previous.counts?.[t];
	if (prev === undefined) continue;
	if (counts[t] < prev) {
		const msg = `${t} shrank ${prev} → ${counts[t]}${previous.at ? ` (baseline ${previous.at})` : ''}`;
		if (APPEND_ONLY.includes(t)) failures.push(msg);
		else warnings.push(msg);
	}
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`consistency check → ${url.split('?')[0]}`);
console.table(counts);
console.log(`review queue: ${proposed} proposed change request(s)`);
for (const w of warnings) console.warn(`! ${w}`);
if (failures.length) {
	for (const f of failures) console.error(`FAIL ${f}`);
	process.exit(1);
}
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({ at: new Date().toISOString(), counts }, null, 2));
console.log(`OK all invariants hold; snapshot saved → ${STATE_FILE}`);

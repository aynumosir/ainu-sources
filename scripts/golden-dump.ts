#!/usr/bin/env bun
/**
 * Golden dump — the no-loss baseline for the upcoming DB migration.
 *
 * Connects to a libSQL/Turso database (or a restored local backup), reads EVERY
 * source plus its related rows, runs each through the pure `projectSource`
 * canonicaliser (src/lib/server/golden.ts), and writes:
 *
 *   scripts/data/golden/projection.json  — array of full per-source projections
 *   scripts/data/golden/manifest.json    — { generatedFrom, sourceCount,
 *                                            rootHash, sources: [{id,slug,hash}] }
 *
 * After the migration, re-run this against the migrated DB and diff the
 * manifests: an identical `rootHash` proves the catalogue's user-facing
 * projection survived byte-for-byte; a per-source `hash` diff pinpoints exactly
 * which source drifted.
 *
 * READ-ONLY. Issues SELECTs only — it NEVER writes to the database. Safe to run
 * against production, but you will normally point it at a restored backup.
 *
 * Connection (first match wins):
 *   --db file:/path/to/restored.db   explicit URL arg (no auth token needed for file:)
 *   --db libsql://host  --token <t>  explicit remote URL + token
 *   else                             DATABASE_URL (+ DATABASE_AUTH_TOKEN if remote)
 *
 * Run:  bun run golden:dump
 *       bun run golden:dump --db file:/tmp/restored.db
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import {
	projectSource,
	hashProjection,
	rootHash,
	type ProjectSourceInput,
	type ManifestEntry
} from '../src/lib/server/golden';

// ── argv ────────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}

const url = argValue('--db') ?? process.env.DATABASE_URL;
if (!url) {
	console.error(
		'✗ No database specified. Pass --db file:/path/to/restored.db or set DATABASE_URL.'
	);
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}

// A SELECT-only client. We never call insert/update/delete on it.
const client = createClient({ url, authToken: authToken || undefined });
const db = drizzle(client, { schema });

const {
	sources,
	sourceLinks,
	persons,
	sourcePersons,
	places,
	sourcePlaces,
	institutions,
	sourceInstitutions,
	sourceRelations,
	tags,
	sourceTags
} = schema;

// ── group helpers ─────────────────────────────────────────────────────────────
function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const r of rows) {
		const k = key(r);
		const arr = m.get(k);
		if (arr) arr.push(r);
		else m.set(k, [r]);
	}
	return m;
}

async function main() {
	console.log(`Reading (read-only) from ${url} …`);

	// One bulk SELECT per relation, then group in memory — avoids N+1 across
	// thousands of sources. All reads, no writes.
	const [
		allSources,
		links,
		personRows,
		placeRows,
		instRows,
		tagRows,
		relRows
	] = await Promise.all([
		db.select().from(sources).orderBy(asc(sources.id)),
		db.select().from(sourceLinks),
		db
			.select({ sourceId: sourcePersons.sourceId, slug: persons.slug, role: sourcePersons.role, sortOrder: sourcePersons.sortOrder })
			.from(sourcePersons)
			.innerJoin(persons, eq(sourcePersons.personId, persons.id)),
		db
			.select({ sourceId: sourcePlaces.sourceId, slug: places.slug, role: sourcePlaces.role, notes: sourcePlaces.notes })
			.from(sourcePlaces)
			.innerJoin(places, eq(sourcePlaces.placeId, places.id)),
		db
			.select({
				sourceId: sourceInstitutions.sourceId,
				slug: institutions.slug,
				role: sourceInstitutions.role,
				callNumber: sourceInstitutions.callNumber,
				notes: sourceInstitutions.notes
			})
			.from(sourceInstitutions)
			.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id)),
		db
			.select({ sourceId: sourceTags.sourceId, name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id)),
		db
			.select({ from: sourceRelations.fromSourceId, to: sourceRelations.toSourceId, type: sourceRelations.type })
			.from(sourceRelations)
	]);

	// id → slug for resolving relation endpoints to stable keys.
	const slugById = new Map<string, string>();
	for (const s of allSources) slugById.set(s.id, s.slug);
	const endpoint = (id: string) => slugById.get(id) ?? id; // fall back to id ("toSlugOrId")

	const linksBySrc = groupBy(links, (r) => r.sourceId);
	const personsBySrc = groupBy(personRows, (r) => r.sourceId);
	const placesBySrc = groupBy(placeRows, (r) => r.sourceId);
	const instBySrc = groupBy(instRows, (r) => r.sourceId);
	const tagsBySrc = groupBy(tagRows, (r) => r.sourceId);
	const relOutBySrc = groupBy(relRows, (r) => r.from);
	const relInBySrc = groupBy(relRows, (r) => r.to);

	const projections: unknown[] = [];
	const manifest: ManifestEntry[] = [];

	for (const source of allSources) {
		const id = source.id;
		const relations = [
			...(relOutBySrc.get(id) ?? []).map((r) => ({
				type: r.type,
				toSlugOrId: endpoint(r.to),
				direction: 'out' as const
			})),
			...(relInBySrc.get(id) ?? []).map((r) => ({
				type: r.type,
				toSlugOrId: endpoint(r.from),
				direction: 'in' as const
			}))
		];

		const input: ProjectSourceInput = {
			source,
			links: linksBySrc.get(id) ?? [],
			tags: tagsBySrc.get(id) ?? [],
			persons: personsBySrc.get(id) ?? [],
			places: placesBySrc.get(id) ?? [],
			institutions: instBySrc.get(id) ?? [],
			relations
		};

		const projection = projectSource(input);
		const hash = hashProjection(projection);
		projections.push(projection);
		manifest.push({ id, slug: source.slug, hash });
	}

	const root = rootHash(manifest);

	// ── write outputs (gitignored, local) ────────────────────────────────────
	const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data/golden');
	mkdirSync(outDir, { recursive: true });
	writeFileSync(path.join(outDir, 'projection.json'), JSON.stringify(projections, null, 2));
	writeFileSync(
		path.join(outDir, 'manifest.json'),
		JSON.stringify(
			{
				generatedFrom: url.split('?')[0], // drop any ?authToken= query if present
				sourceCount: manifest.length,
				rootHash: root,
				sources: manifest
			},
			null,
			2
		)
	);

	console.log(`✓ sourceCount = ${manifest.length}`);
	console.log(`✓ rootHash    = ${root}`);
	console.log(`✓ wrote ${path.join(outDir, 'projection.json')}`);
	console.log(`✓ wrote ${path.join(outDir, 'manifest.json')}`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('✗ golden-dump failed:', err);
		process.exit(1);
	});

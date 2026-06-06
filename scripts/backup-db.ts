// Point-in-time backup of the live Turso DB → a timestamped SQL dump.
// The DB is the durable source of truth now, so snapshot it BEFORE any reseed
// or migration. Restore into a fresh db with:
//   turso db create ainu-sources-restore
//   turso db shell ainu-sources-restore < scripts/data/backups/prod-<ts>.sql
//
// Run: bun run backup   (uses the `turso` CLI; auth via your turso login)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const DB = process.env.TURSO_DB ?? 'ainu-sources';
const dir = 'scripts/data/backups';
mkdirSync(dir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const out = `${dir}/prod-${ts}.sql`;

console.log(`Dumping ${DB} via turso CLI…`);
// argv form (not a shell string) so DB can never be shell-interpolated.
const dump = execFileSync('turso', ['db', 'shell', DB, '.dump'], { maxBuffer: 1 << 30 }).toString();

// Sanity-check before trusting it as a backup — never write a truncated/empty dump.
if (!dump.includes('CREATE TABLE') || !/INSERT INTO ["']?sources/.test(dump)) {
	console.error('✗ Dump looks empty or invalid (no sources INSERTs) — aborting, not writing.');
	process.exit(1);
}

writeFileSync(out, dump);
const mb = (dump.length / 1e6).toFixed(1);
const lines = dump.split('\n').length;
console.log(`✓ Backup → ${out}  (${mb} MB, ${lines} lines)`);
console.log(`  Restore: turso db create <new>; turso db shell <new> < ${out}`);

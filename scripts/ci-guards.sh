#!/usr/bin/env bash
# Phase-0 CI guard: forbid DESTRUCTIVE catalog writes in application code (src/**).
#
# The durability model is: no hard deletes of domain data, and (eventually) one
# merge engine is the only writer. Three patterns are forbidden in src/**:
#   1. wipe()                                  — legacy full-table truncation
#   2. db.delete(schema.<domain table>)        — mass schema-level deletes (seed-only)
#   3. .delete(<domain table>).where(... sourceId ...)  — delete-ALL-rows-for-a-source
#
# Targeted row deletes — .delete(table).where(eq(table.id, ...)) — are ALLOWED:
# the edit reconcile legitimately removes the individual rows a user dropped.
# The one sanctioned mass-destructive path is the gated legacy seed
# (scripts/seed.ts, ALLOW_LEGACY_WIPE=1), which lives outside src/ and is not scanned.
#
# Test files (*.test.ts) are EXCLUDED: test setup/teardown legitimately wipes and
# bulk-deletes fixtures, and targeted delete-by-id in tests is allowed by design.
# The guard targets production application code only.
#
# Run locally: bash scripts/ci-guards.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TABLES='sources|sourceLinks|sourceTags|sourceRelations|sourcePersons|sourcePlaces|sourceInstitutions|sourceRevisions|tags'
PATTERN="\bwipe\s*\(|\.delete\(\s*schema\.($TABLES)\b|\.delete\(\s*($TABLES)\s*\)\.where\([^)]*\bsourceId\b"

if rg -n "$PATTERN" src/ --glob '!*.test.ts'; then
	echo ""
	echo "✗ CI guard FAILED: destructive catalog write found in src/**."
	echo "  Forbidden: wipe(), db.delete(schema.<table>), and .delete(<table>).where(... sourceId ...)."
	echo "  Use a targeted delete-by-id, a soft status, or the merge engine instead."
	echo "  The only sanctioned mass-destructive path is the gated legacy seed (ALLOW_LEGACY_WIPE=1)."
	exit 1
fi

echo "✓ CI guard: no destructive catalog writes in src/**."

#!/usr/bin/env bash
# CI guard: forbid DESTRUCTIVE catalog writes across the application + import path.
#
# The durability model is: no hard deletes of domain data, and one merge engine is
# the only writer of the catalogue. Three guards enforce it:
#
#   GUARD 1 — src/** (application code): forbid
#     1. wipe()                                  — legacy full-table truncation
#     2. db.delete(schema.<domain table>)        — mass schema-level deletes
#     3. .delete(<domain table>).where(... sourceId ...)  — delete-ALL-rows-for-a-source
#     Targeted row deletes — .delete(table).where(eq(table.id, ...)) — stay ALLOWED
#     (the edit reconcile legitimately removes the individual rows a user dropped).
#
#   GUARD 2 — no ungated wipe() OUTSIDE the retired legacy seed. The one sanctioned
#     mass-destructive path is scripts/seed-legacy-wipe.ts (ALLOW_LEGACY_WIPE=1),
#     which lives outside src/ and is intentionally the sole holder of wipe().
#
#   GUARD 3 — scripts/import/** + scripts/import-all.ts (the idempotent import path):
#     forbid wipe() AND any db.delete(<domain/entity table>). The importers are
#     additive/merge-only: they observe through the engine and re-observe upstream
#     disappearances as drift — they must NEVER delete a domain row.
#
# Test files (*.test.ts) are EXCLUDED throughout: test setup/teardown legitimately
# wipes and bulk-deletes fixtures. The guards target production + import code only.
#
# Run locally: bash scripts/ci-guards.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TABLES='sources|sourceLinks|sourceTags|sourceRelations|sourcePersons|sourcePlaces|sourceInstitutions|sourceRevisions|tags'
# Entity + join tables the import path touches (adds persons/places/institutions to
# the domain-table set so a delete of any of them in the importers is caught too).
IMPORT_TABLES="${TABLES}|persons|places|institutions"

fail=0

# ── GUARD 1: src/** application code ───────────────────────────────────────────
SRC_PATTERN="\bwipe\s*\(|\.delete\(\s*schema\.($TABLES)\b|\.delete\(\s*($TABLES)\s*\)\.where\([^)]*\bsourceId\b"
if rg -n "$SRC_PATTERN" src/ --glob '!*.test.ts'; then
	echo ""
	echo "✗ GUARD 1 FAILED: destructive catalog write found in src/**."
	echo "  Forbidden: wipe(), db.delete(schema.<table>), and .delete(<table>).where(... sourceId ...)."
	echo "  Use a targeted delete-by-id, a soft status, or the merge engine instead."
	fail=1
else
	echo "✓ GUARD 1: no destructive catalog writes in src/**."
fi

# ── GUARD 2: no ungated wipe() outside the retired legacy seed ─────────────────
# (scripts/seed-legacy-wipe.ts is the sole sanctioned holder; it is excluded. -a so a
#  file with an embedded NUL — like the legacy seed — can't silently hide a wipe().)
if rg -na "\bwipe\s*\(" src/ scripts/ --glob '*.ts' --glob '!*.test.ts' --glob '!scripts/seed-legacy-wipe.ts'; then
	echo ""
	echo "✗ GUARD 2 FAILED: wipe() found outside scripts/seed-legacy-wipe.ts."
	echo "  The full-table wipe is retired — it may live ONLY in the gated legacy seed"
	echo "  (ALLOW_LEGACY_WIPE=1). New code must go through the idempotent import path."
	fail=1
else
	echo "✓ GUARD 2: no ungated wipe() outside scripts/seed-legacy-wipe.ts."
fi

# ── GUARD 3: the import path deletes nothing ───────────────────────────────────
IMPORT_PATTERN="\bwipe\s*\(|\.delete\(\s*(schema\.)?($IMPORT_TABLES)\b"
if rg -na "$IMPORT_PATTERN" scripts/import/ scripts/import-all.ts --glob '*.ts' --glob '!*.test.ts'; then
	echo ""
	echo "✗ GUARD 3 FAILED: destructive write in the import path (scripts/import/** or import-all.ts)."
	echo "  The importers are additive/merge-only: no wipe(), no db.delete(<domain table>)."
	echo "  Re-observe an upstream disappearance as drift (presence:'missing') instead of deleting."
	fail=1
else
	echo "✓ GUARD 3: import path (scripts/import/** + import-all.ts) deletes nothing."
fi

if [ "$fail" -ne 0 ]; then
	echo ""
	echo "✗ CI guards FAILED."
	exit 1
fi
echo ""
echo "✓ CI guards passed."

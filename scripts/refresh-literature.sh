#!/usr/bin/env bash
# Periodic literature refresh for db.aynu.org.
#
# Re-collects the academic index from every open repository
# (`collect-academic.ts refresh` — union-merged, the index never shrinks), then
# feeds the catalogue through the merge engine (`import:all`). With
# SOURCES_ENABLE_PROPOSE on, new or uncertain records become review proposals
# in /admin/review; enrichments to already-known records apply directly.
# Nothing is wiped or deleted.
#
# Runs in its own disposable git worktree so no user checkout is touched, and
# opens a data PR when the index changed. Database credentials come from the
# main checkout's .env. Designed for crontab, e.g.:
#
#   23 5 * * 1 /home/mkpoli/projects/Ainu/ainu-sources/scripts/refresh-literature.sh >> /home/mkpoli/.ainu-sources/logs/refresh-literature.log 2>&1
set -euo pipefail

MAIN_REPO="${AINU_SOURCES_REPO:-$HOME/projects/Ainu/ainu-sources}"
WORKTREE="${AINU_SOURCES_CRON_WORKTREE:-$HOME/projects/Ainu/worktrees/ainu-sources-cron}"
STATE_DIR="$HOME/.ainu-sources"
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$STATE_DIR/logs"
exec 9>"$STATE_DIR/refresh-literature.lock"
flock -n 9 || { echo "another refresh is already running — exiting"; exit 0; }

echo "=== literature refresh $(date -Is) ==="

git -C "$MAIN_REPO" fetch origin main
if [ ! -d "$WORKTREE" ]; then
	git -C "$MAIN_REPO" worktree add "$WORKTREE" --detach origin/main
fi
# The cron worktree holds only generated data; log anything a failed prior run
# left behind, then reset to the freshest main.
if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
	echo "discarding leftovers from a previous run:"
	git -C "$WORKTREE" status --short
fi
git -C "$WORKTREE" fetch origin main
git -C "$WORKTREE" checkout --detach origin/main
git -C "$WORKTREE" reset --hard origin/main
cd "$WORKTREE"
bun install --frozen-lockfile

# 1. Collect: every collector, union-merged with the committed index.
timeout -k 60 10800 bun scripts/collect-academic.ts refresh

# 2. Import through the merge engine. Credentials from the main checkout.
set -a
. "$MAIN_REPO/.env"
set +a
export SOURCES_ENABLE_PROPOSE=true
export AINU_ROOT="${AINU_ROOT:-$HOME/projects/Ainu}"
timeout -k 60 10800 bun run import:all

# 3. Data PR when the index moved.
if git diff --quiet -- scripts/data/academic-index.json scripts/data/citation-edges.json; then
	echo "index unchanged — no data PR"
	exit 0
fi
DAY="$(date +%Y-%m-%d)"
BRANCH="data/literature-refresh-$DAY"
git checkout -B "$BRANCH"
git add scripts/data/academic-index.json scripts/data/citation-edges.json
git commit -m "feat(sources): refresh the academic literature index ($DAY)"
git push -fu origin "$BRANCH"
gh pr create --head "$BRANCH" \
	--title "feat(sources): refresh the academic literature index ($DAY)" \
	--body "Automated re-collect of the academic index (all collectors, union-merged) with refreshed citation edges. The records are already imported through the merge engine; new or uncertain ones are waiting in /admin/review." \
	|| echo "gh pr create failed (already open?) — branch pushed"
echo "=== refresh done $(date -Is) ==="

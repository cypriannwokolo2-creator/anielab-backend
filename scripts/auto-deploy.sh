#!/usr/bin/env bash
# auto-deploy.sh — poll GitHub and redeploy AnieLab when either repo's tracked
# branch moves. Runs every minute from cron; safe to run by hand too.
#
# Why this design (portability): the script lives INSIDE the anielab-backend
# repo, so it travels with the repo to any new VPS and updates itself whenever
# the backend repo is pulled. The installer (scripts/install-auto-deploy.sh)
# only needs to point cron at this file.
#
# Behavior:
#   1. If a previous deploy is still running, exit immediately (flock).
#   2. `git fetch` both repos; compare local HEAD with the tracking branch.
#   3. No changes  -> log a single line, exit 0.
#   4. Changes     -> run scripts/deploy.sh (it pulls, rebuilds, composes up;
#      the OLD containers keep serving during the build). Then restart Caddy
#      only if the Caddyfile changed, and prune dangling images.
#
# Environment overrides:
#   APP_DIR     — base directory holding anielab-backend + anielab-web
#                 (default: parent of this script's directory)
#   BACKEND_REPO / WEB_REPO — git URLs (defaults to the GitHub repos)
#   BRANCH      — tracking ref to watch; defaults to the branch's upstream (@{u})

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at $APP_DIR/anielab-backend/scripts/ → APP_DIR is two levels up.
APP_DIR="${APP_DIR:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
BACKEND_DIR="$APP_DIR/anielab-backend"
WEB_DIR="$APP_DIR/anielab-web"
BACKEND_REPO="${BACKEND_REPO:-https://github.com/cypriannwokolo2-creator/anielab-backend.git}"
WEB_REPO="${WEB_REPO:-https://github.com/cypriannwokolo2-creator/anielab-web.git}"

LOG="$APP_DIR/auto-deploy.log"
LOCK="$APP_DIR/deploy.lock"

ts() { date -u +%FT%TZ; }

# ─── Serialize: never run two deploys at once ──────────────────────────────
exec 9>"$LOCK"
if ! flock -n 9; then
    echo "$(ts) skipped: another deploy is already running" >> "$LOG"
    exit 0
fi

# ─── Require the repo checkouts ────────────────────────────────────────────
if [ ! -d "$BACKEND_DIR/.git" ] || [ ! -d "$WEB_DIR/.git" ]; then
    echo "$(ts) ERROR: repos missing in $APP_DIR. Run: bash $BACKEND_DIR/scripts/install-auto-deploy.sh" >> "$LOG"
    exit 1
fi

# ─── Detect changes ────────────────────────────────────────────────────────
changed=0
for repo_dir in "$BACKEND_DIR" "$WEB_DIR"; do
    if ! git -C "$repo_dir" fetch origin --quiet 2>>"$LOG"; then
        echo "$(ts) warn: git fetch failed for $(basename "$repo_dir") — will retry next minute" >> "$LOG"
        continue
    fi
    local_head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)
    remote_head=$(git -C "$repo_dir" rev-parse @{u} 2>/dev/null || true)
    if [ -z "$remote_head" ]; then
        echo "$(ts) warn: no upstream tracking branch in $(basename "$repo_dir") — deploy.sh needs it (git pull --ff-only)" >> "$LOG"
        continue
    fi
    if [ "$local_head" != "$remote_head" ]; then
        echo "$(ts) $(basename "$repo_dir"): ${local_head:0:7} -> ${remote_head:0:7}" >> "$LOG"
        changed=1
    fi
done

if [ "$changed" = "0" ]; then
    echo "$(ts) no changes" >> "$LOG"
    exit 0
fi

# ─── Deploy ────────────────────────────────────────────────────────────────
echo "$(ts) === deploy started ===" >> "$LOG"
CADDY_BEFORE=$(md5sum "$BACKEND_DIR/Caddyfile" 2>/dev/null | cut -d' ' -f1 || echo none)

BACKEND_REPO="$BACKEND_REPO" WEB_REPO="$WEB_REPO" \
    APP_DIR="$APP_DIR" bash "$BACKEND_DIR/scripts/deploy.sh" >> "$LOG" 2>&1
status=$?

CADDY_AFTER=$(md5sum "$BACKEND_DIR/Caddyfile" 2>/dev/null | cut -d' ' -f1 || echo none)
if [ "$status" = "0" ]; then
    if [ "$CADDY_BEFORE" != "$CADDY_AFTER" ]; then
        echo "$(ts) Caddyfile changed — restarting caddy" >> "$LOG"
        docker compose -f "$BACKEND_DIR/docker-compose.yml" restart caddy >> "$LOG" 2>&1 || true
    fi
    docker image prune -f >> "$LOG" 2>&1 || true
    echo "$(ts) === deploy OK ===" >> "$LOG"
else
    echo "$(ts) === deploy FAILED (exit $status) — check docker compose logs ===" >> "$LOG"
fi

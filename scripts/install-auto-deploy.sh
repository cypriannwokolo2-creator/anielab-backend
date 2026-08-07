#!/usr/bin/env bash
# install-auto-deploy.sh — set up automatic deploys on THIS machine.
#
# Idempotent: safe to re-run any time (e.g. after moving to a new VPS).
#   - ensures the anielab-web repo is cloned next to this repo
#   - adds a once-per-minute cron entry for scripts/auto-deploy.sh
#   - creates $APP_DIR/auto-deploy.log and $APP_DIR/deploy.lock
#
# Usage:
#   bash install-auto-deploy.sh            # install only
#   bash install-auto-deploy.sh --deploy-now   # install AND run a deploy
#
# Moving to a new VPS in 3 steps:
#   1. git clone https://github.com/cypriannwokolo2-creator/anielab-backend.git
#   2. bash anielab-backend/scripts/install-auto-deploy.sh --deploy-now
#   3. Point DNS at the new IP. That's it — every push deploys itself.

set -euo pipefail

C_RESET=$'\033[0m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
log()  { printf '%s[install]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }

DEPLOY_NOW=0
[ "${1:-}" = "--deploy-now" ] && DEPLOY_NOW=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
BACKEND_DIR="$APP_DIR/anielab-backend"
WEB_DIR="$APP_DIR/anielab-web"
WEB_REPO="${WEB_REPO:-https://github.com/cypriannwokolo2-creator/anielab-web.git}"

AUTO_SCRIPT="$BACKEND_DIR/scripts/auto-deploy.sh"
CRON_LINE="* * * * * $AUTO_SCRIPT >> $APP_DIR/auto-deploy-cron.log 2>&1"

# ─── 1. Web repo present? ──────────────────────────────────────────────────
if [ ! -d "$WEB_DIR/.git" ]; then
    log "Cloning web repo into $APP_DIR..."
    mkdir -p "$APP_DIR"
    git clone "$WEB_REPO" "$WEB_DIR"
else
    log "Web repo already present at $WEB_DIR"
fi

# ─── 2. .env present? (deploy.sh needs it; it creates it if missing) ───────
ENV_FILE="$BACKEND_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    warn "$ENV_FILE does not exist — deploy.sh will create it from .env.example"
    warn "and then FAIL until you fill in the secrets. Do that before the first"
    warn "auto-deploy triggers, or run install with --deploy-now to surface it."
else
    log ".env present at $ENV_FILE"
fi

# ─── 3. Cron entry (idempotent) ────────────────────────────────────────────
if ! command -v flock >/dev/null 2>&1; then
    warn "flock not found (util-linux). Install it: sudo apt install -y util-linux"
fi

CRON_EXISTS=0
if crontab -l 2>/dev/null | grep -Fq "$AUTO_SCRIPT"; then
    CRON_EXISTS=1
fi
if [ "$CRON_EXISTS" = "1" ]; then
    log "Cron entry already installed"
else
    ( crontab -l 2>/dev/null || true; echo "$CRON_LINE" ) | crontab -
    log "Installed cron entry: $CRON_LINE"
fi

# ─── 4. Log + lock files ───────────────────────────────────────────────────
touch "$APP_DIR/auto-deploy.log" "$APP_DIR/auto-deploy-cron.log" "$APP_DIR/deploy.lock"
log "Log file: $APP_DIR/auto-deploy.log"

# ─── 5. Run now? ───────────────────────────────────────────────────────────
if [ "$DEPLOY_NOW" = "1" ]; then
    log "Running one deploy now (this also builds images on a fresh VPS)..."
    bash "$AUTO_SCRIPT"
    log "Done. Watch the log: tail -f $APP_DIR/auto-deploy.log"
else
    log "Installed. Next deploy runs within 60 seconds of a push to either repo."
    log "Watch: tail -f $APP_DIR/auto-deploy.log"
fi

log "To uninstall: crontab -e and remove the auto-deploy line"
log "Migration note: this whole setup lives inside this repo — clone + re-run"
log "this script on any new VPS and you are done."

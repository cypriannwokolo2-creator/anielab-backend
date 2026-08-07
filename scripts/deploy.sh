#!/usr/bin/env bash
# deploy.sh — AnieLab application deployment script.
#
# Run as the deploy user (e.g. anielab) on the VM. Implements the
# application-deployment half of the "rebuild from scratch" runbook
# (runbook item 23). Idempotent: safe to re-run for redeploys.
#
# Usage:
#   BACKEND_REPO=<git-url> WEB_REPO=<git-url> ./scripts/deploy.sh
#
# Environment variables (with defaults):
#   BACKEND_REPO  — git URL of the anielab-backend repo  (required)
#   WEB_REPO      — git URL of the anielab-web repo      (required)
#   APP_DIR       — base directory                       (default: /opt/anielab)
#   IMAGE_TAG     — Docker image tag to deploy           (default: 0.1.0)
#   DOMAIN        — domain for the .env template         (default: anielab.app)
#   SKIP_SMOKE    — set to 1 to skip the post-deploy smoke test

set -euo pipefail

C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'
log()  { printf '%s[deploy]%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[fatal]%s  %s\n' "$C_RED"   "$C_RESET" "$*" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/anielab}"
IMAGE_TAG="${IMAGE_TAG:-0.1.0}"
DOMAIN="${DOMAIN:-anielab.app}"
BACKEND_REPO="${BACKEND_REPO:-}"
WEB_REPO="${WEB_REPO:-}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"

[ -n "$BACKEND_REPO" ] || die "BACKEND_REPO must be set (git URL of anielab-backend)"
[ -n "$WEB_REPO" ]     || die "WEB_REPO must be set (git URL of anielab-web)"

# ─── 1. Clone or pull repos ──────────────────────────────────────────────
log "1/5  Setting up $APP_DIR..."
mkdir -p "$APP_DIR"

clone_or_pull() {
    local url="$1" dir="$2"
    if [ -d "$dir/.git" ]; then
        log "      Pulling latest in $(basename "$dir")..."
        (cd "$dir" && git pull --ff-only)
    else
        log "      Cloning $(basename "$dir")..."
        git clone "$url" "$dir"
    fi
}

clone_or_pull "$BACKEND_REPO" "$APP_DIR/anielab-backend"
clone_or_pull "$WEB_REPO"     "$APP_DIR/anielab-web"

# ─── 2. Ensure .env exists ──────────────────────────────────────────────
ENV_FILE="$APP_DIR/anielab-backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    log "2/5  Creating .env from .env.example..."
    cp "$APP_DIR/anielab-backend/.env.example" "$ENV_FILE"
    warn ".env created. Fill in real secrets NOW:"
    warn "  nano $ENV_FILE"
    warn "Required: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,"
    warn "          MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, MINIO_ACCESS_KEY,"
    warn "          MINIO_SECRET_KEY, DEPLOYER_SECRET_KEY, PINATA_JWT"
    die "Fill in .env and re-run deploy.sh"
else
    log "2/5  .env exists"
fi

# ─── 3. Build images if missing locally ─────────────────────────────────
cd "$APP_DIR/anielab-backend"

# Source .env so the NEXT_PUBLIC_* build args below pick up real values.
# By this point step 2 has guaranteed the file exists.
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

BACKEND_IMAGE="ghcr.io/anielab/anielab-backend:$IMAGE_TAG"
WEB_IMAGE="ghcr.io/anielab/anielab-web:$IMAGE_TAG"

BUILD_ARGS=(
    --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL"
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY"
    --build-arg NEXT_PUBLIC_STELLAR_NETWORK="$NEXT_PUBLIC_STELLAR_NETWORK"
    --build-arg NEXT_PUBLIC_SOROBAN_RPC_URL="$NEXT_PUBLIC_SOROBAN_RPC_URL"
    --build-arg NEXT_PUBLIC_USDC_SAC_TESTNET="$NEXT_PUBLIC_USDC_SAC_TESTNET"
    --build-arg NEXT_PUBLIC_BACKEND_URL="$NEXT_PUBLIC_BACKEND_URL"
    --build-arg NEXT_PUBLIC_MEDIA_BASE_URL="$NEXT_PUBLIC_MEDIA_BASE_URL"
)

build_if_missing() {
    local image="$1" context="$2"
    if docker image inspect "$image" &>/dev/null; then
        log "3/5  Image $image already exists locally"
    else
        log "      Building $image from $context..."
        docker build "${BUILD_ARGS[@]}" -t "$image" "$context"
    fi
}

log "3/5  Ensuring images are present (tag=$IMAGE_TAG)..."
build_if_missing "$BACKEND_IMAGE" "$APP_DIR/anielab-backend"
build_if_missing "$WEB_IMAGE"     "$APP_DIR/anielab-web"

# ─── 4. Start docker compose ─────────────────────────────────────────────
log "4/5  Starting docker compose..."
docker compose up -d

# Give containers a moment to come up before the smoke probe
sleep 15
docker compose ps

# ─── 5. Smoke test ───────────────────────────────────────────────────────
if [ "$SKIP_SMOKE" = "1" ]; then
    warn "5/5  Skipping smoke (SKIP_SMOKE=1)"
else
    log "5/5  Running smoke test..."
    if docker compose run --rm smoke; then
        log "✓ Smoke test passed"
    else
        warn "Smoke test failed — inspect logs with: docker compose logs"
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────────
log "✓ Deployment complete."
echo ""
echo "Services:"
docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Commands:"
echo "  Logs     : docker compose logs -f"
echo "  Stop     : docker compose down"
echo "  Restart  : docker compose restart"
echo "  Smoke    : docker compose run --rm smoke"
echo "  First-run: ./scripts/first-run.sh   (creates the MinIO bucket)"

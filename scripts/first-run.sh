#!/usr/bin/env bash
# first-run.sh — One-time post-deploy setup.
#
# Run after the first successful deploy.sh to:
#   1. Create the MinIO bucket
#   2. Verify the stack is healthy
#
# Idempotent: safe to re-run.

set -euo pipefail

C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_RED=$'\033[1;31m'
log() { printf '%s[first-run]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
die() { printf '%s[fatal]%s      %s\n' "$C_RED"  "$C_RESET" "$*" >&2; exit 1; }

cd /opt/anielab/anielab-backend

# ─── Load env ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    die ".env not found. Run scripts/deploy.sh first."
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

[ -n "${MINIO_ROOT_USER:-}" ]     || die "MINIO_ROOT_USER not set in .env"
[ -n "${MINIO_ROOT_PASSWORD:-}" ] || die "MINIO_ROOT_PASSWORD not set in .env"
[ -n "${MINIO_BUCKET:-}" ]        || die "MINIO_BUCKET not set in .env"

# ─── 1. Create MinIO bucket ──────────────────────────────────────────────
log "Creating MinIO bucket '$MINIO_BUCKET'..."

# The compose project's network name is "anielab_anielab_net" (project name +
# network key). The minio service is reachable as "minio" inside that network.
docker run --rm --network anielab_anielab_net \
    minio/mc:latest \
    sh -c "
        mc alias set myminio http://minio:9000 '$MINIO_ROOT_USER' '$MINIO_ROOT_PASSWORD' >/dev/null && \
        mc mb --ignore-existing myminio/'$MINIO_BUCKET' && \
        echo 'Bucket ready: '\"$MINIO_BUCKET\"
    "

# ─── 2. Verify services ─────────────────────────────────────────────────
log "Verifying services..."
docker compose ps

# ─── Done ────────────────────────────────────────────────────────────────
log "✓ First-run setup complete."
echo ""
echo "Next steps:"
echo "  1. Configure DNS (Cloudflare or your registrar):"
echo "       A    app.${DOMAIN}    → <VM-public-IP>"
echo "       A    api.${DOMAIN}    → <VM-public-IP>"
echo "       A    minio.${DOMAIN}  → <VM-public-IP>"
echo ""
echo "  2. Wait ~60s for DNS to propagate, then:"
echo "       curl -I https://app.${DOMAIN}"
echo ""
echo "  3. Watch Caddy obtain the first Let's Encrypt certs:"
echo "       docker compose logs -f caddy"

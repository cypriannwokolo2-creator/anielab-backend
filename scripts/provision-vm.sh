#!/usr/bin/env bash
# provision-vm.sh — AnieLab VM provisioning script.
#
# Implements the "rebuild from scratch" requirement (runbook item 23) for
# the OS-hardening + Docker-install layer. Run as ROOT on a fresh Ubuntu
# 24.04 LTS VM. Does NOT deploy the app — run scripts/deploy.sh after.
#
# Usage:
#   sudo ./scripts/provision-vm.sh
#   sudo DEPLOY_SSH_PUBKEY="ssh-ed25519 AAAA..." ./scripts/provision-vm.sh
#
# Idempotent: safe to re-run.

set -euo pipefail

# ─── Helpers ─────────────────────────────────────────────────────────────
readonly C_RESET=$'\033[0m'
readonly C_BLUE=$'\033[1;34m'
readonly C_YELLOW=$'\033[1;33m'
readonly C_RED=$'\033[1;31m'
log()  { printf '%s[provision]%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s     %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[fatal]%s     %s\n' "$C_RED"   "$C_RESET" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (sudo $0)"

# ─── Config (override via env) ───────────────────────────────────────────
DEPLOY_USER="${DEPLOY_USER:-anielab}"
DEPLOY_SSH_PUBKEY="${DEPLOY_SSH_PUBKEY:-}"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-2048}"
TIMEZONE="${TIMEZONE:-Etc/UTC}"

log "Starting VM provisioning"
log "  deploy user : $DEPLOY_USER"
log "  swap        : ${SWAP_SIZE_MB} MB"
log "  timezone    : $TIMEZONE"

# ─── 1. System update ────────────────────────────────────────────────────
log "1/14  Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get autoremove -y

# ─── 2. Install essentials ───────────────────────────────────────────────
log "2/14  Installing essential packages..."
apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg lsb-release \
    ufw fail2ban \
    unattended-upgrades apt-listchanges \
    logrotate \
    sysstat \
    chrony \
    tree jq

# ─── 3. Install Docker Engine + Compose plugin ───────────────────────────
if ! command -v docker &>/dev/null; then
    log "3/14  Installing Docker..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
else
    log "3/14  Docker already installed: $(docker --version)"
fi

# ─── 4. Create non-root deploy user (item 19) ────────────────────────────
if ! id "$DEPLOY_USER" &>/dev/null; then
    log "4/14  Creating deploy user '$DEPLOY_USER'..."
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
else
    log "4/14  Deploy user '$DEPLOY_USER' already exists"
fi
usermod -aG docker "$DEPLOY_USER"

if [ -n "$DEPLOY_SSH_PUBKEY" ]; then
    SSH_DIR="/home/$DEPLOY_USER/.ssh"
    mkdir -p "$SSH_DIR"
    echo "$DEPLOY_SSH_PUBKEY" > "$SSH_DIR/authorized_keys"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    chmod 600 "$SSH_DIR/authorized_keys"
    log "      SSH public key installed for $DEPLOY_USER"
else
    warn "DEPLOY_SSH_PUBKEY not set — you'll need to add the deploy user's key manually"
fi

# ─── 5. SSH hardening (item 29) ──────────────────────────────────────────
log "5/14  Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'        "$SSHD_CONFIG"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"
systemctl restart sshd

# ─── 6. UFW firewall (item 30) ───────────────────────────────────────────
log "6/14  Configuring UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH"
# 80/443 opened here as belt-and-suspenders with the Azure NSG.
# Only Caddy actually publishes them; the others are filtered at Docker level.
ufw allow 80/tcp  comment "HTTP (Caddy)"
ufw allow 443/tcp comment "HTTPS (Caddy)"
ufw --force enable

# ─── 7. fail2ban (item 21) ───────────────────────────────────────────────
log "7/14  Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
EOF
systemctl enable --now fail2ban

# ─── 8. Automatic security updates (item 18) ─────────────────────────────
log "8/14  Enabling unattended-upgrades..."
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Download-Upgradeable-Packages "1";
Unattended-Upgrade::Remove-Unused-Dependencies "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
dpkg-reconfigure -plow unattended-upgrades

# ─── 9. Swap file (item 20) ──────────────────────────────────────────────
if [ "$SWAP_SIZE_MB" -gt 0 ] && [ ! -f /swapfile ]; then
    log "9/14  Creating ${SWAP_SIZE_MB} MB swap file..."
    fallocate -l "${SWAP_SIZE_MB}M" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
    log "9/14  Swap already configured"
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
sysctl -w vm.swappiness=10 >/dev/null

# ─── 10. Timezone + NTP (item 24) ────────────────────────────────────────
log "10/14 Setting timezone to $TIMEZONE..."
timedatectl set-timezone "$TIMEZONE"
systemctl enable --now chrony

# ─── 11. sysctl hardening (item 40) ──────────────────────────────────────
log "11/14 Applying sysctl hardening..."
cat > /etc/sysctl.d/99-anielab-hardening.conf <<'EOF'
# No ICMP redirects (spoofing mitigation)
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
# Sane TCP settings for a web-facing VM
net.core.somaxconn = 512
net.ipv4.tcp_max_syn_backlog = 512
net.ipv4.tcp_syncookies = 1
# Reboot 10s after kernel panic
kernel.panic = 10
EOF
sysctl --system >/dev/null

# ─── 12. Log rotation (item 34) ──────────────────────────────────────────
log "12/14 Configuring log rotation..."
mkdir -p /var/log/anielab
chown "$DEPLOY_USER:$DEPLOY_USER" /var/log/anielab
cat > /etc/logrotate.d/anielab <<'EOF'
/var/log/anielab/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 anielab anielab
    sharedscripts
}
EOF

# ─── 13. Docker log rotation daemon-level (item 52) ──────────────────────
log "13/14 Configuring Docker daemon..."
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true,
  "userland-proxy": false
}
EOF
systemctl restart docker

# ─── 14. App directory (item 23) ─────────────────────────────────────────
log "14/14 Creating /opt/anielab..."
mkdir -p /opt/anielab
chown -R "$DEPLOY_USER:$DEPLOY_USER" /opt/anielab

# ─── Done ────────────────────────────────────────────────────────────────
log "✓ VM provisioning complete."
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Next steps (as the $DEPLOY_USER user):"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  1. Log out and back in (or: su - $DEPLOY_USER)"
echo "     to pick up the new docker group membership."
echo ""
echo "  2. Clone the repos into /opt/anielab:"
echo "       git clone <backend-url> /opt/anielab/anielab-backend"
echo "       git clone <web-url>     /opt/anielab/anielab-web"
echo ""
echo "  3. Run the deploy script:"
echo "       cd /opt/anielab/anielab-backend"
echo "       chmod +x scripts/*.sh"
echo "       BACKEND_REPO=<url> WEB_REPO=<url> ./scripts/deploy.sh"
echo ""

#!/usr/bin/env bash
# One-shot server installer for LendChain. Run from the project folder on the machine that will host it:
#     ./deploy/install.sh            # as your normal user (it uses sudo only where needed)
#
# Supports Linux on x86_64 and aarch64 (Oracle Ampere, Raspberry Pi 4/5, Graviton ...) with apt (Ubuntu/Debian)
# or dnf (Fedora/RHEL/Oracle Linux). It:
#   1. installs curl/tar + Node.js >= 22.13 if missing
#   2. adds a 2 GB swap file on small machines (< 3 GB RAM)
#   3. writes ~/.lendchain.env with freshly generated secrets (only if it does not exist)
#   4. installs + starts the systemd units (auto-start on boot, auto-heal every 3 min)
# It does NOT open any network port: expose the site afterwards with ./deploy/expose.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ME="$(id -un)"
log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -ne 0 ]] || die "run as a normal user, not root (the stack should not run as root)"
[[ "$(uname -s)" == Linux ]] || die "Linux only (on Windows use WSL2)"
case "$(uname -m)" in x86_64|amd64|aarch64|arm64) ;; *) die "unsupported CPU $(uname -m)";; esac
command -v sudo >/dev/null || die "sudo is required"
command -v systemctl >/dev/null || die "systemd is required for auto-start (or run ./lendchain.sh start by hand)"

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=13)?0:1)'; }

# ---- 1. packages
log "installing base packages"
if command -v apt-get >/dev/null; then
  sudo apt-get update -y && sudo apt-get install -y curl tar unzip ca-certificates util-linux
  node_ok || { sudo apt-get install -y nodejs npm || true; }
  node_ok || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs; }
elif command -v dnf >/dev/null; then
  sudo dnf install -y curl tar unzip ca-certificates util-linux
  node_ok || { sudo dnf install -y nodejs npm || true; }
  node_ok || { curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs; }
else die "need apt or dnf"; fi
node_ok || die "Node.js >= 22.13 is required (found: $(node -v 2>/dev/null || echo none)). Install it from https://nodejs.org or via nvm, then re-run."
log "node $(node -v) on $(uname -m)"

# ---- 2. swap on small machines (Fabric peers are Go processes that spike while committing blocks)
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( mem_mb < 3000 )) && [[ -z "$(swapon --show --noheadings)" ]]; then
  log "only ${mem_mb} MB RAM: adding a 2 GB swap file"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
(( mem_mb >= 2500 )) || log "WARNING: ${mem_mb} MB RAM is below the ~3 GB this stack is comfortable with (see docs/HOSTING.md)"

# ---- 3. secrets
ENVF="$HOME/.lendchain.env"
if [[ -f "$ENVF" ]]; then
  log "$ENVF already exists - keeping it"
else
  rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }
  ADMIN_PW="$(rnd 9)"
  umask 077
  cat > "$ENVF" <<EOF
# LendChain server settings (generated $(date -u +%FT%TZ)). Keep this file private and BACK IT UP:
# LENDCHAIN_PII_KEY encrypts personal data; without it existing PII cannot be decrypted.
LENDCHAIN_PUBLIC=1
LISTEN_HOST=127.0.0.1
DEMO_MODE=true
BANK_API_KEY=$(rnd 16)
BANK_AUDIT_KEY=$(rnd 16)
AUDITOR_UI_KEY=$(rnd 16)
LENDCHAIN_PII_KEY=$(rnd 32)
ADMIN_EMAIL=admin@lendchain.local
ADMIN_PASSWORD=$ADMIN_PW
# Set these only if you publish the bank console / auditor portal on their own URLs (not recommended):
#PUBLIC_BANK_URL=
#PUBLIC_AUDITOR_URL=
EOF
  chmod 600 "$ENVF"
  log "wrote $ENVF"
  printf '\n  operator login:  admin@lendchain.local / %s\n  bank key / auditor key: see %s  (shown once here, stored there)\n\n' "$ADMIN_PW" "$ENVF"
fi

# ---- 4. systemd
chmod +x "$ROOT/lendchain.sh" "$ROOT/network/network.sh" "$ROOT"/deploy/*.sh
for u in lendchain.service lendchain-heal.service lendchain-heal.timer; do
  sed -e "s|__USER__|$ME|g" -e "s|__DIR__|$ROOT|g" "$ROOT/deploy/$u" | sudo tee "/etc/systemd/system/$u" >/dev/null
done
sudo systemctl daemon-reload
log "starting LendChain (first run downloads Fabric binaries and deploys the chaincode: 2-5 minutes)"
sudo systemctl enable --now lendchain.service
sudo systemctl enable --now lendchain-heal.timer
log "done. check:  systemctl status lendchain   |   ./lendchain.sh status   |   curl -s localhost:4001/api/config"
log "next: make it reachable from the internet with  ./deploy/expose.sh quick   (or: caddy <your-domain>)"

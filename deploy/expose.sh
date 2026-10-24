#!/usr/bin/env bash
# Publish the platform (port 4001) to the internet, for free. The bank console and auditor portal are NEVER published:
# they stay on 127.0.0.1 and you reach them through an SSH tunnel (see docs/HOSTING.md).
#
#   ./deploy/expose.sh quick              Cloudflare "quick tunnel": no account, no domain, no open ports.
#                                         You get a https://<random>.trycloudflare.com URL. The URL CHANGES whenever the
#                                         tunnel restarts and Cloudflare gives no uptime guarantee: fine for demos/reviews.
#   ./deploy/expose.sh caddy <domain>     Stable https://<domain> with an auto-renewing Let's Encrypt certificate.
#                                         Needs a (free) DNS name pointing at this server, e.g. from duckdns.org, and
#                                         TCP 80 + 443 open in the cloud firewall.
#   ./deploy/expose.sh status | stop
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ME="$(id -un)"
log() { printf '\033[1;32m[expose]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[expose]\033[0m %s\n' "$*" >&2; exit 1; }
case "$(uname -m)" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; *) die "unsupported CPU";; esac
curl -fs localhost:4001/api/config >/dev/null || die "the platform is not answering on localhost:4001 - run ./lendchain.sh start (or: sudo systemctl start lendchain) first"

unit() { # name, body on stdin
  sudo tee "/etc/systemd/system/$1" >/dev/null; sudo systemctl daemon-reload
}

case "${1:-}" in
  quick)
    if ! command -v cloudflared >/dev/null; then
      log "downloading cloudflared ($A)"
      sudo curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A"
      sudo chmod +x /usr/local/bin/cloudflared
    fi
    unit lendchain-tunnel.service <<EOF
[Unit]
Description=LendChain public tunnel (Cloudflare quick tunnel)
After=network-online.target lendchain.service
Wants=network-online.target

[Service]
User=$ME
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl enable lendchain-tunnel >/dev/null 2>&1; sudo systemctl restart lendchain-tunnel
    log "waiting for the public URL ..."
    for _ in $(seq 1 40); do
      URL="$(sudo journalctl -u lendchain-tunnel --since '-2min' --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)"
      [[ -n "$URL" ]] && break; sleep 1.5
    done
    [[ -n "${URL:-}" ]] && log "LIVE:  $URL   (changes if the tunnel restarts; re-run '$0 status' to see the current one)" || die "no URL yet: sudo journalctl -u lendchain-tunnel -n 30"
    ;;
  caddy)
    DOMAIN="${2:-}"; [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "usage: $0 caddy <your.domain.name>"
    if [[ ! -x /usr/local/bin/caddy ]]; then
      log "downloading caddy ($A)"
      T="$(mktemp -d)"; curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_$A.tar.gz" | tar xz -C "$T" caddy
      sudo install -m 755 "$T/caddy" /usr/local/bin/caddy; rm -rf "$T"
    fi
    sudo mkdir -p /etc/caddy
    sed "s|lendchain.example.duckdns.org|$DOMAIN|" "$ROOT/deploy/Caddyfile.example" | sudo tee /etc/caddy/Caddyfile >/dev/null
    /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddyfile did not validate"
    unit lendchain-caddy.service <<EOF
[Unit]
Description=LendChain HTTPS reverse proxy (Caddy)
After=network-online.target lendchain.service
Wants=network-online.target

[Service]
User=$ME
StateDirectory=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl enable lendchain-caddy >/dev/null 2>&1; sudo systemctl restart lendchain-caddy
    cat <<EOF

  Caddy is running for https://$DOMAIN . For the certificate to be issued, ALL of these must be true:
   1. DNS: $DOMAIN points to this server's PUBLIC IP  (curl -s ifconfig.me  shows it)
   2. Cloud firewall: ingress TCP 80 and 443 allowed (Oracle: VCN > Security List > Add Ingress Rules, source 0.0.0.0/0)
   3. Host firewall allows 80/443:
        Ubuntu on Oracle:  sudo iptables -I INPUT 5 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save
        Fedora/Oracle Linux:  sudo firewall-cmd --permanent --add-service={http,https} && sudo firewall-cmd --reload
  Then:  curl -I https://$DOMAIN      (logs: sudo journalctl -u lendchain-caddy -n 40)
EOF
    ;;
  status)
    for s in lendchain lendchain-tunnel lendchain-caddy; do printf '%-18s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null || true)"; done
    sudo journalctl -u lendchain-tunnel --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 | sed 's/^/current quick-tunnel URL: /' || true ;;
  stop)
    for s in lendchain-tunnel lendchain-caddy; do sudo systemctl disable --now $s 2>/dev/null || true; done; log "public access removed (the site still runs on localhost)" ;;
  *) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

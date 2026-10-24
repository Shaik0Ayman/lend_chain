#!/usr/bin/env bash
# One-command control for the whole LendChain stack (Fabric network + chaincode + 3 services).
#   ./lendchain.sh start      bootstrap binaries, bring up network, deploy chaincode, start services
#   ./lendchain.sh stop       stop services and the Fabric network (data kept)
#   ./lendchain.sh restart-services   restart only bank / platform / auditor (e.g. after code changes)
#   ./lendchain.sh reset      wipe ALL data (ledger, crypto, databases) and start fresh
#   ./lendchain.sh heal       start anything that died (used by the systemd timer); no-op after a deliberate stop
#   ./lendchain.sh status | logs
set -euo pipefail
# optional settings file (keys, passwords, public-mode flags); the same file is used by the systemd unit
ENVFILE="${LENDCHAIN_ENV:-$HOME/.lendchain.env}"
if [[ -f "$ENVFILE" ]]; then set -a; . "$ENVFILE"; set +a; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="$ROOT/network/runtime"; PIDS="$RT/pids"; LOGS="$RT/logs"
SERVICES=(bank platform auditor)
declare -A PORTS=([bank]=4002 [platform]=4001 [auditor]=4003)
log() { printf '\033[1;32m[lendchain]\033[0m %s\n' "$*"; }

running() { # pid file present, process alive AND it really is our node service (guards against pid reuse after a reboot)
  [[ -f "$PIDS/svc-$1.pid" ]] || return 1
  local p; p="$(cat "$PIDS/svc-$1.pid")"; kill -0 "$p" 2>/dev/null || return 1
  [[ -r /proc/$p/cmdline ]] || return 0
  local c; c="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)"; [[ "$c" == *"services/$1/server.js"* ]]
}
start_svc() {
  local s=$1; mkdir -p "$PIDS" "$LOGS"
  running "$s" && return
  # NB: `&` must apply to node alone (not to `cd && node`) or $! is the subshell's pid, not node's
  (cd "$ROOT"; nohup setsid node "services/$s/server.js" > "$LOGS/$s.log" 2>&1 9>&- & echo $! > "$PIDS/svc-$s.pid")
}
stop_svc() { running "$1" && kill "$(cat "$PIDS/svc-$1.pid")" 2>/dev/null || true; rm -f "$PIDS/svc-$1.pid"; }
wait_http() { for _ in $(seq 1 60); do curl -fs "http://localhost:$1/$2" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "service on :$1 did not come up - see $LOGS" >&2; return 1; }

start_services() {
  # start the bank first: the platform and auditor call it
  for s in "${SERVICES[@]}"; do start_svc "$s"; done
  wait_http 4002 health; wait_http 4001 api/config; wait_http 4003 health
}

# one start/heal at a time (a reboot start and the heal timer must never overlap)
LOCKED=0
lock() { [[ $LOCKED == 1 ]] && return 0; command -v flock >/dev/null || return 0; mkdir -p "$RT"; exec 9>"$RT/lock"; flock -n 9 || { log "another start/heal is already running"; exit 0; }; LOCKED=1; }

case "${1:-}" in
  heal) # cron/systemd-timer entry point: start whatever is down, do nothing if all is up
    [[ -f "$PIDS/svc-platform.pid" ]] || exit 0            # never started, or stopped on purpose: leave it alone
    lock; st="$("$ROOT/network/network.sh" status)"; grep -q DOWN <<<"$st" || exit 0   # (not a pipe: grep -q + pipefail = SIGPIPE false negative)
    log "something is down - restoring"; ;&
  start)
    lock
    command -v node >/dev/null || { echo "Node.js >= 22.13 required"; exit 1; }
    "$ROOT/network/network.sh" bootstrap
    [[ -d "$ROOT/node_modules" ]] || (cd "$ROOT" && npm install --no-audit --no-fund)
    [[ -d "$ROOT/chaincode/lendchain/node_modules" ]] || (cd "$ROOT/chaincode/lendchain" && npm install --omit=dev --no-audit --no-fund)
    "$ROOT/network/network.sh" up
    # first run: install + commit the chaincode. Every later start: just restart its servers (no redeploy)
    if "$ROOT/network/network.sh" committed; then "$ROOT/network/network.sh" resume; else "$ROOT/network/network.sh" deploy; fi
    "$ROOT/network/network.sh" ready
    start_services
    log "ready:"
    echo "   Platform (lenders / borrowers / operator)  http://localhost:4001"
    echo "   Trustee bank console (simulated money)     http://localhost:4002"
    echo "   Auditor portal (read-only ledger)          http://localhost:4003"
    if [[ "${LENDCHAIN_PUBLIC:-0}" == 1 ]]; then echo "   operator login: ${ADMIN_EMAIL:-admin@lendchain.local} / (password: see $ENVFILE)"
    else echo "   operator login: admin@lendchain.local / ${ADMIN_PASSWORD:-admin12345}"; fi ;;
  stop) for s in "${SERVICES[@]}"; do stop_svc "$s"; done; "$ROOT/network/network.sh" down ;;
  restart-services) for s in "${SERVICES[@]}"; do stop_svc "$s"; done; sleep 1; start_services; log "services restarted" ;;
  reset) for s in "${SERVICES[@]}"; do stop_svc "$s"; done; "$ROOT/network/network.sh" clean; rm -rf "$ROOT/data"; log "wiped. run ./lendchain.sh start" ;;
  status) "$ROOT/network/network.sh" status ;;
  logs) tail -n 40 "$LOGS"/*.log ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

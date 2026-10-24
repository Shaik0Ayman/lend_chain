#!/usr/bin/env bash
# LendChain Hyperledger Fabric network, run natively (no Docker, no cloud, no licence fees).
#   ./network.sh bootstrap   download the official Fabric binaries (v2.5 LTS) for this OS/arch
#   ./network.sh up          crypto + genesis + 3 Raft orderers + 3 peers + channel "lendchain"
#   ./network.sh deploy      package/install/approve/commit chaincode, start chaincode servers
#   ./network.sh down        stop everything (ledger data kept)
#   ./network.sh clean       stop and wipe all ledger data and crypto
#   ./network.sh status
set -euo pipefail

NET="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$NET")"
RUNTIME="$NET/runtime"; CRYPTO="$RUNTIME/crypto"; LOGS="$RUNTIME/logs"; PIDS="$RUNTIME/pids"
export PATH="$NET/bin:$PATH"

FABRIC_VERSION="${FABRIC_VERSION:-2.5.10}"
CHANNEL=lendchain
CC_NAME=lendchain
CC_VERSION="${CC_VERSION:-}"   # default: 1.<sequence>
CC_SEQ="${CC_SEQ:-}"           # default: committed sequence + 1 (so re-running deploy upgrades the chaincode)
CC_POLICY="AND('PlatformMSP.peer','TrusteeMSP.peer')"
D=lendchain.local

# org -> peer port, ops port, chaincode-server port, MSP id, gossip bootstrap port
declare -A PEER_PORT=([platform]=7051 [trustee]=8051 [auditor]=9051)
declare -A OPS_PORT=([platform]=9443 [trustee]=9444 [auditor]=9445)
declare -A CC_PORT=([platform]=7999 [trustee]=8999 [auditor]=9999)
declare -A MSPID=([platform]=PlatformMSP [trustee]=TrusteeMSP [auditor]=AuditorMSP)
declare -A BOOT=([platform]=8051 [trustee]=7051 [auditor]=7051)
ORGS=(platform trustee auditor)
ORDERERS=(1 2 3)

log() { printf '\033[1;36m[lendchain]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[lendchain] %s\033[0m\n' "$*" >&2; exit 1; }
ordd() { echo "$CRYPTO/ordererOrganizations/orderer.$D/orderers/orderer$1.orderer.$D"; }
peerd() { echo "$CRYPTO/peerOrganizations/$1.$D/peers/peer0.$1.$D"; }
ORDERER_CA() { echo "$(ordd 1)/tls/ca.crt"; }

need_bins() { [[ -x "$NET/bin/peer" ]] || die "Fabric binaries missing - run: ./network.sh bootstrap"; }

bootstrap() {
  local os arch
  case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) die "Use Linux, macOS or WSL2";; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) die "unsupported CPU $(uname -m)";; esac
  [[ -x "$NET/bin/peer" ]] && { log "binaries already present: $("$NET/bin/peer" version | sed -n 2p)"; return; }
  local url="https://github.com/hyperledger/fabric/releases/download/v${FABRIC_VERSION}/hyperledger-fabric-${os}-${arch}-${FABRIC_VERSION}.tar.gz"
  log "downloading $url"
  curl -fSL "$url" -o "$NET/fabric.tgz"
  tar xzf "$NET/fabric.tgz" -C "$NET" && rm "$NET/fabric.tgz"
  log "installed Fabric $(peer version | sed -n 2p)"
}

wait_port() { for _ in $(seq 1 60); do (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.5; done; die "port $1 did not open (see $LOGS)"; }

# Is this pid really OUR process? After a reboot or container restart a stale pid file can point at an unrelated
# program (pids get reused): never treat such a pid as ours, and never kill it.
proc_matches() { # pid, text that must appear in its command line
  [[ -r /proc/$1/cmdline ]] || return 0          # no /proc (macOS): fall back to trusting kill -0
  local c; c="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true)"; [[ "$c" == *"$2"* ]]
}
is_running() {
  [[ -f "$PIDS/$1.pid" ]] || return 1
  local p; p="$(cat "$PIDS/$1.pid")"
  kill -0 "$p" 2>/dev/null || return 1
  case "$1" in
    peer-*)  proc_matches "$p" "peer" ;;
    orderer*) proc_matches "$p" "orderer" ;;
    cc-*)    proc_matches "$p" "fabric-chaincode-node" ;;
    svc-*)   proc_matches "$p" "services/${1#svc-}/server.js" ;;
    *)       return 0 ;;
  esac
}
spawn() { # name, then command with env already exported by caller via `env`
  local name="$1"; shift
  is_running "$name" && { log "$name already running"; return; }
  nohup setsid "$@" > "$LOGS/$name.log" 2>&1 9>&- &
  echo $! > "$PIDS/$name.pid"
}

gen_crypto() {
  [[ -d "$CRYPTO/peerOrganizations" ]] && { log "crypto exists"; return; }
  log "generating identities (cryptogen)"
  cryptogen generate --config="$NET/templates/crypto-config.yaml" --output="$CRYPTO"
  mkdir -p "$RUNTIME/cfg"
  sed "s#__CRYPTO__#$CRYPTO#g" "$NET/templates/configtx.yaml" > "$RUNTIME/cfg/configtx.yaml"
  log "creating channel genesis block"
  FABRIC_CFG_PATH="$RUNTIME/cfg" configtxgen -profile LendChainChannel -outputBlock "$RUNTIME/$CHANNEL.block" -channelID "$CHANNEL"
}

start_orderer() {
  local i=$1 d port; d="$(ordd "$i")"; port=$((7050 + (i-1)*100))
  mkdir -p "$RUNTIME/orderers/orderer$i"
  spawn "orderer$i" env FABRIC_CFG_PATH="$NET/config" \
    ORDERER_GENERAL_LISTENADDRESS=127.0.0.1 ORDERER_GENERAL_LISTENPORT=$port \
    ORDERER_GENERAL_LOCALMSPDIR="$d/msp" ORDERER_GENERAL_LOCALMSPID=OrdererMSP ORDERER_GENERAL_BOOTSTRAPMETHOD=none \
    ORDERER_GENERAL_TLS_ENABLED=true ORDERER_GENERAL_TLS_PRIVATEKEY="$d/tls/server.key" ORDERER_GENERAL_TLS_CERTIFICATE="$d/tls/server.crt" ORDERER_GENERAL_TLS_ROOTCAS="[$d/tls/ca.crt]" \
    ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE="$d/tls/server.crt" ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY="$d/tls/server.key" ORDERER_GENERAL_CLUSTER_ROOTCAS="[$d/tls/ca.crt]" \
    ORDERER_ADMIN_TLS_ENABLED=true ORDERER_ADMIN_TLS_CERTIFICATE="$d/tls/server.crt" ORDERER_ADMIN_TLS_PRIVATEKEY="$d/tls/server.key" ORDERER_ADMIN_TLS_ROOTCAS="[$d/tls/ca.crt]" ORDERER_ADMIN_TLS_CLIENTROOTCAS="[$d/tls/ca.crt]" ORDERER_ADMIN_TLS_CLIENTAUTHREQUIRED=true \
    ORDERER_ADMIN_LISTENADDRESS="127.0.0.1:$((port+3))" ORDERER_CHANNELPARTICIPATION_ENABLED=true \
    ORDERER_FILELEDGER_LOCATION="$RUNTIME/orderers/orderer$i/ledger" \
    ORDERER_CONSENSUS_WALDIR="$RUNTIME/orderers/orderer$i/etcdraft/wal" ORDERER_CONSENSUS_SNAPDIR="$RUNTIME/orderers/orderer$i/etcdraft/snapshot" \
    ORDERER_OPERATIONS_LISTENADDRESS="127.0.0.1:$((8443 + (i-1)*100))" \
    orderer
}

join_orderer() {
  local i=$1 d port; d="$(ordd "$i")"; port=$((7050 + (i-1)*100))
  if osnadmin channel list -o "127.0.0.1:$((port+3))" --ca-file "$d/tls/ca.crt" --client-cert "$d/tls/server.crt" --client-key "$d/tls/server.key" 2>/dev/null | grep -q "\"$CHANNEL\""; then return; fi
  osnadmin channel join --channelID "$CHANNEL" --config-block "$RUNTIME/$CHANNEL.block" -o "127.0.0.1:$((port+3))" \
    --ca-file "$d/tls/ca.crt" --client-cert "$d/tls/server.crt" --client-key "$d/tls/server.key" >/dev/null
}

start_peer() {
  local org=$1 d port; d="$(peerd "$org")"; port=${PEER_PORT[$org]}
  mkdir -p "$RUNTIME/peers/$org"
  spawn "peer-$org" env FABRIC_CFG_PATH="$NET/config" \
    CORE_PEER_ID="peer0.$org.$D" CORE_PEER_ADDRESS="localhost:$port" CORE_PEER_LISTENADDRESS="127.0.0.1:$port" CORE_PEER_CHAINCODELISTENADDRESS="127.0.0.1:$((port+1))" \
    CORE_PEER_GOSSIP_BOOTSTRAP="localhost:${BOOT[$org]}" CORE_PEER_GOSSIP_EXTERNALENDPOINT="localhost:$port" CORE_PEER_GOSSIP_USELEADERELECTION=false CORE_PEER_GOSSIP_ORGLEADER=true \
    CORE_PEER_LOCALMSPID="${MSPID[$org]}" CORE_PEER_MSPCONFIGPATH="$d/msp" \
    CORE_PEER_TLS_ENABLED=true CORE_PEER_TLS_CERT_FILE="$d/tls/server.crt" CORE_PEER_TLS_KEY_FILE="$d/tls/server.key" CORE_PEER_TLS_ROOTCERT_FILE="$d/tls/ca.crt" \
    CORE_PEER_FILESYSTEMPATH="$RUNTIME/peers/$org" CORE_LEDGER_SNAPSHOTS_ROOTDIR="$RUNTIME/peers/$org/snapshots" CORE_OPERATIONS_LISTENADDRESS="127.0.0.1:${OPS_PORT[$org]}" CORE_METRICS_PROVIDER=prometheus \
    CORE_LEDGER_STATE_STATEDATABASE=goleveldb \
    CORE_CHAINCODE_EXTERNALBUILDERS="[{name: ccaas_builder, path: $NET/builders/ccaas}]" \
    peer node start
}

# Export CORE_PEER_* so the `peer` CLI acts as <org>'s admin
admin_env() {
  local org=$1 d; d="$(peerd "$org")"
  export FABRIC_CFG_PATH="$NET/config" CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID="${MSPID[$org]}" \
    CORE_PEER_TLS_ROOTCERT_FILE="$d/tls/ca.crt" CORE_PEER_ADDRESS="localhost:${PEER_PORT[$org]}" \
    CORE_PEER_MSPCONFIGPATH="$CRYPTO/peerOrganizations/$org.$D/users/Admin@$org.$D/msp"
}

join_peer() {
  local org=$1; admin_env "$org"
  for _ in $(seq 1 30); do peer channel list >/dev/null 2>&1 && break; sleep 1; done
  if peer channel list 2>/dev/null | grep -q "^$CHANNEL$"; then return; fi
  peer channel join -b "$RUNTIME/$CHANNEL.block" >/dev/null 2>&1 || peer channel join -b "$RUNTIME/$CHANNEL.block"
}

write_profile() {
  # connection profile consumed by the platform backend, bank and auditor services
  local out="$RUNTIME/profile.json"
  {
    echo "{ \"channel\": \"$CHANNEL\", \"chaincode\": \"$CC_NAME\", \"orgs\": {"
    local first=1
    for org in "${ORGS[@]}"; do
      local d u; d="$(peerd "$org")"; u="$CRYPTO/peerOrganizations/$org.$D/users/User1@$org.$D/msp"
      [[ $first == 1 ]] || echo ","; first=0
      echo "  \"$org\": { \"mspId\": \"${MSPID[$org]}\", \"peerEndpoint\": \"localhost:${PEER_PORT[$org]}\","
      echo "    \"tlsCaCert\": \"$d/tls/ca.crt\", \"certPath\": \"$(ls "$u"/signcerts/*.pem | head -1)\", \"keyPath\": \"$(ls "$u"/keystore/* | head -1)\" }"
    done
    echo "} }"
  } > "$out"
}

up() {
  need_bins; mkdir -p "$LOGS" "$PIDS"
  gen_crypto
  log "starting ${#ORDERERS[@]} Raft orderers"
  for i in "${ORDERERS[@]}"; do start_orderer "$i"; done
  for i in "${ORDERERS[@]}"; do wait_port $((7053 + (i-1)*100)); done
  for i in "${ORDERERS[@]}"; do join_orderer "$i"; done
  log "starting peers"
  for org in "${ORGS[@]}"; do start_peer "$org"; done
  for org in "${ORGS[@]}"; do wait_port "${PEER_PORT[$org]}"; done
  for org in "${ORGS[@]}"; do join_peer "$org"; done
  write_profile
  log "network is up: channel '$CHANNEL' joined by Platform, Trustee, Auditor peers"
}

pkg_for() { # org -> path to package tarball
  local org=$1 t="$RUNTIME/pkg/$org"; mkdir -p "$t"
  cat > "$t/connection.json" <<EOF
{ "address": "127.0.0.1:${CC_PORT[$org]}", "dial_timeout": "10s", "tls_required": false }
EOF
  echo "{\"type\":\"ccaas\",\"label\":\"${CC_NAME}_${CC_VERSION}\"}" > "$t/metadata.json"
  (cd "$t" && tar czf code.tar.gz connection.json && tar czf "$org.tar.gz" metadata.json code.tar.gz)
  echo "$t/$org.tar.gz"
}

start_cc_server() { # org pkgid
  local org=$1 id=$2
  if is_running "cc-$org"; then
    local old; old="$(cat "$PIDS/cc-$org.pid")"; kill "$old" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$old" 2>/dev/null || break; sleep 0.2; done   # wait for it to really exit
    kill -9 "$old" 2>/dev/null || true; rm -f "$PIDS/cc-$org.pid"
  fi
  (cd "$ROOT/chaincode/lendchain" && spawn "cc-$org" env CHAINCODE_SERVER_ADDRESS="127.0.0.1:${CC_PORT[$org]}" CHAINCODE_ID="$id" \
    node node_modules/.bin/fabric-chaincode-node server --chaincode-address="127.0.0.1:${CC_PORT[$org]}" --chaincode-id="$id")
}

next_seq() {
  admin_env platform
  local s; s="$(peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" 2>/dev/null | sed -n 's/.*Sequence: \([0-9]*\),.*/\1/p' | head -1)"
  echo $(( ${s:-0} + 1 ))
}

deploy() {
  need_bins
  [[ -n "$CC_SEQ" ]] || CC_SEQ="$(next_seq)"
  [[ -n "$CC_VERSION" ]] || CC_VERSION="1.$CC_SEQ"
  [[ -d "$ROOT/chaincode/lendchain/node_modules" ]] || (cd "$ROOT/chaincode/lendchain" && npm install --omit=dev --no-audit --no-fund)
  log "installing chaincode '$CC_NAME' v$CC_VERSION (seq $CC_SEQ) on every peer"
  declare -A PKGID
  for org in "${ORGS[@]}"; do
    admin_env "$org"
    local pkg; pkg="$(pkg_for "$org")"
    PKGID[$org]="$(peer lifecycle chaincode calculatepackageid "$pkg")"
    peer lifecycle chaincode install "$pkg" >/dev/null 2>&1 || peer lifecycle chaincode queryinstalled | grep -q "${PKGID[$org]}" || die "install failed for $org"
    start_cc_server "$org" "${PKGID[$org]}"
  done
  for org in "${ORGS[@]}"; do wait_port "${CC_PORT[$org]}"; done
  for org in "${ORGS[@]}"; do
    admin_env "$org"
    peer lifecycle chaincode approveformyorg -o localhost:7050 --tls --cafile "$(ORDERER_CA)" \
      --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" --package-id "${PKGID[$org]}" --sequence "$CC_SEQ" \
      --signature-policy "$CC_POLICY" --collections-config "$NET/collections_config.json" >/dev/null
    log "  $org approved"
  done
  admin_env platform
  for _ in $(seq 1 20); do
    peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQ" \
      --signature-policy "$CC_POLICY" --collections-config "$NET/collections_config.json" -o localhost:7050 --tls --cafile "$(ORDERER_CA)" 2>/dev/null | grep -c true | grep -q 3 && break; sleep 1
  done
  peer lifecycle chaincode commit -o localhost:7050 --tls --cafile "$(ORDERER_CA)" \
    --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQ" \
    --signature-policy "$CC_POLICY" --collections-config "$NET/collections_config.json" \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$(peerd platform)/tls/ca.crt" \
    --peerAddresses localhost:8051 --tlsRootCertFiles "$(peerd trustee)/tls/ca.crt" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$(peerd auditor)/tls/ca.crt" >/dev/null
  sleep 2
  peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" 2>&1 | sed 's/^/  /'
  log "chaincode committed. endorsement policy: $CC_POLICY"
}

committed_seq() { # prints the committed chaincode sequence, or nothing if the chaincode is not committed yet
  admin_env platform
  peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" 2>/dev/null | sed -n 's/.*Sequence: \([0-9]*\),.*/\1/p' | head -1
}

# Restart the chaincode servers for the ALREADY committed definition (what a reboot / plain `start` needs).
# Unlike `deploy` it does not install, approve or commit anything, so the ledger's chaincode sequence stays put.
resume() {
  need_bins
  local seq; seq="$(committed_seq)"; [[ -n "$seq" ]] || die "no committed chaincode - run: ./network.sh deploy"
  local label="${CC_NAME}_${CC_VERSION:-1.$seq}"
  log "resuming chaincode '$label' on every peer (no redeploy)"
  for org in "${ORGS[@]}"; do
    admin_env "$org"
    local id; id="$(peer lifecycle chaincode queryinstalled 2>/dev/null | sed -n "s/^Package ID: \(.*\), Label: ${label}\$/\1/p" | head -1)"
    [[ -n "$id" ]] || die "package $label is not installed on $org - run: ./network.sh deploy"
    is_running "cc-$org" || start_cc_server "$org" "$id"
  done
  for org in "${ORGS[@]}"; do wait_port "${CC_PORT[$org]}"; done
  log "chaincode servers up"
}

# Block until Fabric service discovery can build an endorsement plan. After any peer / chaincode restart, gossip needs
# up to ~a minute to converge; until then the Gateway answers 409 "no peer combination can satisfy the endorsement policy".
ready() {
  need_bins
  local d u out; d="$(peerd platform)"; u="$CRYPTO/peerOrganizations/platform.$D/users/Admin@platform.$D/msp"
  for _ in $(seq 1 120); do
    out="$("$NET/bin/discover" --peerTLSCA "$d/tls/ca.crt" --userKey "$u/keystore/priv_sk" --userCert "$u/signcerts/Admin@platform.$D-cert.pem" \
      --MSP PlatformMSP endorsers --channel "$CHANNEL" --chaincode "$CC_NAME" --server "localhost:${PEER_PORT[platform]}" 2>/dev/null || true)"
    grep -q EndorsersByGroups <<<"$out" && { log "endorsement discovery ready"; return 0; }
    sleep 1
  done
  log "WARNING: endorsement discovery not ready after 120 s - early requests may fail (see $LOGS)"
}

stop_all() {
  [[ -d "$PIDS" ]] || return 0
  for f in "$PIDS"/*.pid; do
    [[ -f "$f" ]] || continue
    n="$(basename "$f" .pid)"
    if is_running "$n"; then kill "$(cat "$f")" 2>/dev/null || true; fi   # only ever kill a pid that is verifiably ours
    rm -f "$f"
  done
  sleep 1
}

status() {
  for f in "$PIDS"/*.pid; do [[ -f "$f" ]] || continue; n="$(basename "$f" .pid)"; is_running "$n" && echo "  up    $n" || echo "  DOWN  $n"; done
}

case "${1:-}" in
  bootstrap) bootstrap ;;
  up) up ;;
  deploy) deploy ;;
  resume) resume ;;
  ready) ready ;;
  committed) for _ in 1 2 3 4 5; do [[ -n "$(committed_seq)" ]] && exit 0; sleep 1; done; exit 1 ;;   # retry: peers may still be warming up
  down) log "stopping"; stop_all ;;
  clean) log "wiping runtime"; stop_all; rm -rf "$RUNTIME" ;;
  status) status ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac

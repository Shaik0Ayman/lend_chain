#!/usr/bin/env bash
# Read-only ledger explorer with formatted output.
#   ./scripts/ledger.sh info                  channel height + chaincode
#   ./scripts/ledger.sh loans [STATUS]        table of loans (STATUS e.g. CLOSED, NPA, REPAYING)
#   ./scripts/ledger.sh loan <id>             full loan record
#   ./scripts/ledger.sh history <id>          every state change of a loan
#   ./scripts/ledger.sh bids <id>             bids on a loan
#   ./scripts/ledger.sh payouts <id>          lender payouts for a loan
#   ./scripts/ledger.sh verify <id>           re-check money invariants for a loan
#   ./scripts/ledger.sh lenders | borrowers   registered participants
#   ORG=auditor ./scripts/ledger.sh loans     query as another org (platform|trustee|auditor)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORG="${ORG:-platform}"
case "$ORG" in platform) MSP=PlatformMSP; PORT=7051;; trustee) MSP=TrusteeMSP; PORT=8051;; auditor) MSP=AuditorMSP; PORT=9051;; *) echo "ORG must be platform|trustee|auditor"; exit 1;; esac
export PATH="$ROOT/network/bin:$PATH" FABRIC_CFG_PATH="$ROOT/network/config"
R="$ROOT/network/runtime/crypto/peerOrganizations/$ORG.lendchain.local"
export CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID=$MSP CORE_PEER_ADDRESS=localhost:$PORT
export CORE_PEER_TLS_ROOTCERT_FILE="$R/peers/peer0.$ORG.lendchain.local/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$R/users/Admin@$ORG.lendchain.local/msp"

q() { # q <function> [args...]  -> raw JSON on stdout
  local fn=$1; shift
  local args; args=$(python3 -c 'import json,sys;print(json.dumps({"function":sys.argv[1],"Args":sys.argv[2:]}))' "$fn" "$@")
  peer chaincode query -C lendchain -n lendchain -c "$args"
}
pretty() { python3 -m json.tool --indent 2; }
need() { [[ -n "${1:-}" ]] || { echo "usage: $0 $2 <loanId>"; exit 1; }; }

case "${1:-help}" in
  info)
    peer channel getinfo -c lendchain 2>&1 | sed 's/^Blockchain info: //' | grep -v INFO | pretty
    peer lifecycle chaincode querycommitted -C lendchain -n lendchain 2>&1 | grep -v INFO ;;
  loans)
    q loan:list "${2:-}" | python3 -c '
import json,sys
rows=json.load(sys.stdin)
if not rows: print("no loans"); sys.exit()
def rs(p): return "Rs {:>12,.2f}".format(int(p)/100)
cols=["id","status","amount","apr","lenders","grade","dpd"]
print("{:<26} {:<11} {:>16} {:>6} {:>7} {:>5} {:>4}".format("LOAN","STATUS","AMOUNT","APR%","LENDERS","GRADE","DPD"))
print("-"*82)
for l in sorted(rows,key=lambda x:x.get("id","")):
    amt=l.get("principalPaise") or l.get("amountPaise") or 0
    apr=l.get("clearingAprBps") or l.get("maxAprBps") or 0
    print("{:<26} {:<11} {:>16} {:>6.2f} {:>7} {:>5} {:>4}".format(str(l.get("id",l.get("loanId","")))[:26],l.get("status",""),rs(amt),int(apr)/100,len(l.get("allocations") or []),l.get("riskGrade",""),l.get("dpd",0)))
print("\n{} loan(s)".format(len(rows)))' ;;
  loan)      need "${2:-}" loan;     q loan:get "$2" | pretty ;;
  history)   need "${2:-}" history;  q loan:history "$2" | pretty ;;
  bids)      need "${2:-}" bids;     q bid:listByLoan "$2" | pretty ;;
  payouts)   need "${2:-}" payouts;  q repay:listPayouts "$2" | pretty ;;
  verify)    need "${2:-}" verify;   q repay:verifyLoan "$2" | pretty ;;
  lenders)   q registry:list LENDER | pretty ;;
  borrowers) q registry:list BORROWER | pretty ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac

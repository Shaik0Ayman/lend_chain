# LendChain — P2P lending on Hyperledger Fabric (free, runs natively, no Docker)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/shaik0ayman/lend_chain)

A working implementation of the *LendChain* proposal architecture: a permissioned Hyperledger Fabric 2.5 ledger as the
single source of truth for loan state, bids, matching, repayments and compliance, with an off-chain platform, a trustee
bank holding escrow, and a read-only auditor.

> **This is a reference implementation / research prototype.** Bank, KYC and credit bureau are mocks; keys are
> `cryptogen` dev keys. It is not licensed or hardened for real money (see *Production gap* below).

## Quickstart

Requirements: Linux/macOS/WSL2, Node.js ≥ 22.13 (uses built-in `node:sqlite`), Java not needed, internet for the first run
(downloads Fabric 2.5.10 release binaries from GitHub; everything is Apache-2.0).

```bash
./lendchain.sh start      # binaries → crypto → 3 Raft orderers + 3 peers → chaincode → services
./lendchain.sh status
node scripts/e2e.js       # 49-check full-lifecycle test against the live network
(cd chaincode/lendchain && npm test)   # 26 chaincode unit tests (strict mock ledger, fuzz)
node scripts/bench.js 60 1,4,8,16      # latency / throughput → docs/benchmark-latest.md
./lendchain.sh stop | reset | logs | heal
./scripts/ledger.sh loans              # formatted ledger explorer (info, loan <id>, history <id>, verify <id> ...)
```

**Try it with no install:** push the repo to GitHub and open it in a Codespace (each visitor gets their own copy): [`docs/CODESPACES.md`](docs/CODESPACES.md).

**Hosting it publicly for free** (Oracle Always Free VM, or your own machine plus a free tunnel): `./deploy/install.sh`, then
`./deploy/expose.sh quick`. Full guide, sizing, compatibility matrix and security notes: [`docs/HOSTING.md`](docs/HOSTING.md).

| Component | URL | Notes |
|---|---|---|
| Platform (borrower / lender / operator UI) | http://localhost:4001 | sign up with OTP `123456`; operator `admin@lendchain.local` / `admin12345` (override with `ADMIN_PASSWORD`) |
| Trustee bank (mock, escrow) | http://localhost:4002 | escrow accounts, UTR statements, simulated clock |
| Auditor portal (read-only) | http://localhost:4003 | header `x-auditor-key: auditor-demo`; 10 ledger invariants + bank↔ledger reconciliation |
| Fabric | orderers 7050/7150/7250, peers 7051 (Platform) 8051 (Trustee) 9051 (Auditor) | channel `lendchain` |

## Architecture → code map

| Proposal component | Where | How |
|---|---|---|
| Fabric network, 3 orgs + ordering | `network/` | Platform, Trustee, Auditor MSPs; 3-node Raft; channel participation (`osnadmin`), no system channel |
| Registry module | `chaincode/lendchain/src/registry.js` | participants, KYC status, CA certificate flag, **private data** bank-account tokens (`platformTrusteeBank`; Auditor sees only the hash; erasable for DPDP) |
| Loan state machine | `src/loan.js` | LISTED→FUNDING→COMMITTED→SIGNED→DISBURSED→REPAYING→CLOSED, or NPA→RECOVERED/WRITTEN_OFF, CANCELLED |
| Bid / match engine | `src/bid.js`, `src/lib/match.js` | uniform-price auction: cheapest first, earlier bid wins ties, clearing rate = highest accepted ask, partial fill only with borrower consent |
| Repayment ledger | `src/repay.js` | EMI receipts, per-lender payouts, T+1 breach flag, outstanding-weighted principal split, UTR single-use guard |
| Compliance guard | `src/lib/compliance.js` | ₹50k/lender/borrower, ₹10L/borrower, ₹50L/lender (CA certificate above ₹10L), tenure ≤ 36 mo, min ₹5,000, max APR 36%; NPA at >90 DPD |
| Off-chain platform | `services/platform/` | e-KYC (mock; real PAN + Aadhaar-Verhoeff checks), scorecard + Shapley reason codes, fraud rules, agreement hash anchored on-chain, AES-256-GCM PII, HMAC pseudonymous IDs |
| Trustee bank | `services/bank/` | escrow accounts, autopay, disbursal, T+1 payouts, transactional outbox → chain |
| Auditor | `services/auditor/` | uses an Auditor-org identity (cannot submit); verify-all, reconcile, event stream |

**Endorsement:** `AND('PlatformMSP.peer','TrusteeMSP.peer')` plus MSP-role checks inside the chaincode. Chaincode runs as an
external service (ccaas), one process per org.

## Design decisions and trade-offs

- **Money is integer paise / basis points with BigInt**, splits via largest-remainder, so allocations always sum exactly
  (fuzz-tested). Trade-off: no floating-point surprises, but every formula must be written by hand.
- **Why both peers endorse:** Platform alone could rewrite history; Trustee alone could ignore the marketplace. The cost
  is that either org being down halts writes (no availability without both). Acceptable for a regulated flow; revisit with
  `OutOf(2, …)` if a 4th org joins.
- **Private data vs. off-chain DB for bank tokens:** PDC keeps an on-chain hash for audit while letting the data be purged
  (DPDP right-to-erasure). Trade-off: extra gossip config and the hash still exists on-chain.
- **Uniform price vs. pay-as-bid:** uniform price removes the incentive to shade bids and gives the borrower a single
  rate; pay-as-bid could raise interest income but invites strategic bidding.
- **Raft, not BFT:** Fabric 2.5 has no production BFT orderer. Raft tolerates crash faults (1 of 3), not malicious
  orderers. Fine for a consortium with legal recourse; not for adversarial participants.
- **Exposure counters live in world state** (per lender, per borrower, per pair). Correct and cheap to check, but concurrent
  bids on the same borrower serialize via MVCC conflicts; the Gateway client retries.
- **Latency floor ≈ BatchTimeout (500 ms).** See the benchmark: ~550 ms p50 at concurrency 1. Lower it for latency, raise it
  for throughput.

## Assumptions (please challenge)

1. The platform signs on behalf of users (users hold no Fabric identities). This is the biggest trust assumption: the
   Trustee's co-endorsement and the Auditor's independent verification are what bound it. A stronger design gives
   lenders/borrowers their own signing keys (e.g., wallet-signed bids verified in chaincode).
2. The scorecard weights are **heuristic, not trained**. Grades/APR bands are plausible but uncalibrated; do not infer real
   default rates from them.
3. A single cap view: caps are enforced per platform. Across platforms, the RBI limits need a bureau-side exposure
   check (not modelled).
4. RBI Master Direction numbers were encoded from the proposal; verify against the current circular before any pilot.
5. The simulated clock (`/sim/advance`) stands in for real time so delinquency/NPA can be demonstrated in seconds.

## Known limitations

- `loan:list` and a few queries scan world state — fine for demos, needs CouchDB rich queries / indexes at scale.
- No real e-sign, NACH/e-mandate, bureau or Account Aggregator integrations (mocked).
- No BFT; single-host network (the three orgs share a machine, so no real network faults are tested).
- Dev crypto from `cryptogen`; no Fabric CA, no HSM, no TLS client-cert rotation.
- Auditor API key is a static demo value.
- The UI is a demo SPA, not accessibility- or security-reviewed.

## Evaluation

See [`docs/EVALUATION.md`](docs/EVALUATION.md) for KPIs, how to read the benchmark, a Caliper porting guide, and recommended
papers and datasets. Latest measured numbers: [`docs/benchmark-latest.md`](docs/benchmark-latest.md).

## Production gap (what a real launch needs)

RBI NBFC-P2P licence and escrow arrangement with a scheduled bank; KMS/HSM-held keys and Fabric CA; multi-host
deployment across independent organisations with TLS everywhere; BFT or a consortium governance model for orderers;
real KYC/e-sign/NACH vendors; a trained and validated credit model with fairness testing and RBI model-risk review; DPDP
consent management; pen-test and chaincode audit; disaster recovery (ledger snapshots, orderer quorum runbook).

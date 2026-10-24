# Evaluation guide

## 1. KPIs to track

**Ledger / systems**
| KPI | Why | How measured here |
|---|---|---|
| Submit→commit latency p50/p95/p99 | user-visible delay for bids, signatures | `scripts/bench.js` |
| Throughput (tx/s) at target latency | capacity of the channel | `scripts/bench.js` (concurrency sweep) |
| MVCC conflict / retry rate | contention from exposure counters | `ChainError` retries in `common/fabric.js` (add a counter) |
| Peer height skew between orgs | endorsement availability | `syncPeers()` wait time |
| Bank↔ledger reconciliation breaks | integrity | Auditor `/api/reconcile` (expect 0) |
| Invariants passing | integrity | Auditor `/api/verify-all` (10/10) |

**Marketplace / business**
Fill rate (loans reaching COMMITTED / listed), time-to-fill, clearing-rate spread vs. the borrower's ceiling,
funded-to-disbursed conversion, 30/60/90+ DPD buckets, NPA rate, loss given default after write-off, T+1 payout breach
rate, lender concentration (HHI), grade-wise realised vs. predicted PD.

**Model (when a trained model replaces the heuristic)**
AUC/KS, calibration (Brier, reliability curve), stability (PSI), fairness gaps across protected-proxy groups,
reason-code stability.

## 2. Reading the benchmark honestly

Numbers in `docs/benchmark-latest.md` come from **one small host** running 3 orderers, 3 peers and 3 chaincode servers
plus the client. Therefore:
- Latency ≈ endorsement (two peers) + 500 ms batch timeout + commit; the timeout dominates at low load.
- Throughput rising with concurrency (≈2 → ≈20 tx/s from 1 to 16 workers) shows the system is **latency-bound, not
  CPU-bound** at these levels; the knee was not reached. Run higher concurrency before quoting capacity.
- The workload is conflict-free by construction (distinct lenders and loans). Real traffic where many lenders bid on one
  loan or one borrower will see MVCC retries; benchmark that separately.
- Network RTT is ~0. Multi-host numbers will be worse; do not extrapolate.

## 3. Porting to Hyperledger Caliper (formal benchmark)

1. `npm i @hyperledger/caliper-cli` and bind with `caliper bind --caliper-bind-sut fabric:2.5`.
2. Network config: use `network/runtime/profile.json` for peer endpoints and the Platform org's cryptogen MSP/TLS paths.
3. Workload modules: port the two closures in `bench.js` (`loan:createListing`, `bid:place`) to `WorkloadModuleBase`
   subclasses; keep unique IDs per worker.
4. Rounds: fixed-rate rounds at 5, 10, 20, 40 tps for 60 s each; record success rate and latency percentiles; add a
   hot-key round (all workers bid on one loan) to expose MVCC.
5. Pair with Prometheus on the peers/orderers' operations ports (9443–9445, 8443+) for CPU, block-cut and gossip metrics.

## 4. Suggested experiments

- BatchTimeout 100/250/500/1000 ms × concurrency: latency/throughput frontier.
- Hot-key contention: 1, 10, 100 lenders bidding on a single loan; compare retry rate with sharded exposure counters.
- Endorsement policy `AND` vs `OutOf(2,…)` with a third endorser: availability when one org is down.
- Fault injection: kill one orderer (should continue), kill two (should halt), kill Trustee peer (writes halt).
- Scorecard ablation once trained: heuristic vs. logistic vs. gradient boosting under the same Shapley reason-code API.

## 5. Recommended reading and datasets

**Fabric / blockchain systems**
- Androulaki et al., *Hyperledger Fabric: A Distributed Operating System for Permissioned Blockchains*, EuroSys 2018.
- Thakkar et al., *Performance Benchmarking and Optimizing Hyperledger Fabric Blockchain Platform*, MASCOTS 2018.
- Gorenflo et al., *FastFabric: Scaling Hyperledger Fabric to 20,000 Transactions per Second*, ICBC 2019.
- Ongaro & Ousterhout, *In Search of an Understandable Consensus Algorithm (Raft)*, USENIX ATC 2014.
- Hyperledger Caliper documentation and Fabric 2.5 docs on private data and channel participation.

**Credit scoring / explainability / fairness**
- Lundberg & Lee, *A Unified Approach to Interpreting Model Predictions (SHAP)*, NeurIPS 2017.
- Lessmann et al., *Benchmarking state-of-the-art classification algorithms for credit scoring*, EJOR 2015.
- Hardt, Price & Srebro, *Equality of Opportunity in Supervised Learning*, NeurIPS 2016.
- Bartlett et al., *Consumer-lending discrimination in the FinTech era*, JFE 2022.

**P2P lending / auctions**
- Lin, Prabhala & Viswanathan, *Judging borrowers by the company they keep: friendship networks and information
  asymmetry in online P2P lending*, Management Science 2013.
- Milgrom, *Putting Auction Theory to Work* (uniform-price vs pay-as-bid).

**Datasets (verify licences before use)**
- LendingClub accepted/rejected loans (public mirrors on Kaggle).
- Home Credit Default Risk (Kaggle).
- Give Me Some Credit (Kaggle), UCI Statlog German and Taiwan default datasets.
- Prosper Marketplace historical data.
None is Indian-market data; treat any transferred model as a baseline only, and calibrate on local bureau data.

## 6. Challenges to the proposal's assumptions

- *"The ledger is the source of truth"* holds for state transitions, but money moves in the bank. Reconciliation is
  therefore the key control; the Auditor runs it, but it is only as independent as its bank-statement feed.
- *"Both orgs endorse"* protects integrity, not confidentiality of PII — hence PII stays off-chain.
- *Uniform-price clearing* assumes lenders understand it; UI must show the clearing rate before bids lock.
- *T+1 payout* is checked on-chain only if the bank reports the payout; a silent bank is caught by the auditor's
  pending-payout view, not by the chaincode itself.

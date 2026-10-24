# Benchmark (generated 2026-10-21T17:42:14.658Z)

Host: 2 vCPU, 8 GiB RAM, all 3 orgs + 3 Raft orderers on ONE machine. Orderer BatchTimeout 500 ms. N=60 tx per level.
Latency is submit→commit as seen by the client (endorse on Platform+Trustee peers, order, commit-status on Platform peer, plus the wait for the Trustee peer to reach the same block).

| operation | concurrency | tx | failed | p50 ms | p95 ms | p99 ms | tx/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| loan:createListing | 1 | 60 | 0 | 552 | 566 | 568 | 1.8 |
| loan:createListing | 4 | 60 | 0 | 603 | 627 | 634 | 6.7 |
| loan:createListing | 8 | 60 | 0 | 638 | 700 | 715 | 11.7 |
| loan:createListing | 16 | 60 | 0 | 707 | 845 | 856 | 20.8 |
| bid:place | 1 | 60 | 0 | 559 | 586 | 603 | 1.8 |
| bid:place | 4 | 60 | 0 | 589 | 637 | 653 | 6.8 |
| bid:place | 8 | 60 | 0 | 654 | 722 | 731 | 11.4 |
| bid:place | 16 | 60 | 0 | 783 | 849 | 876 | 19.3 |
| loan:get (evaluate) | 1 | 200 | 0 | 7 | 11 | 14 | 137.6 |
| bid:closeAndMatch (1 loan, 1 bid) | 1 | 1 | 0 | 557 | 557 | 557 | - |

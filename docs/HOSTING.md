# Hosting LendChain for free

This system is **not a web app that can go on a "free web hosting" plan**. It is a 3-organisation Hyperledger Fabric
network (3 orderers, 3 peers, 3 chaincode servers) plus three Node services, ~12 long-running processes that need a
real Linux machine with ~3 GB of RAM. That rules out most free tiers and leaves two honest options.

| Option | Cost | Uptime | Stable URL | Best for |
|---|---|---|---|---|
| **A. Oracle Cloud "Always Free" Ampere A1 VM + a tunnel/Caddy** | free (card needed for sign-up verification) | 24/7 if the VM is not reclaimed | yes with Caddy + a free DuckDNS name | a link you can put in a report/CV |
| **B. Your own PC / laptop / Raspberry Pi 4-5 + Cloudflare quick tunnel** | free, no account | only while the machine is on | no (random URL per tunnel start) | live demo, viva, review meeting |

Not viable (not re-verified today; check current terms): free tiers of Render, Railway, Fly.io, Heroku-style PaaS,
Vercel, Netlify (static/serverless, or well under 1 GB RAM, single process, sleep when idle, no multi-process Fabric
network); and 1 GB VMs (Oracle AMD Micro, Google e2-micro), which are below the measured footprint.

## 0. What it needs (measured)

Measured on x86_64 Linux after the complete 49-check lifecycle test, public mode, all components running:

| Component | RAM |
|---|---|
| 3 × Fabric peer | ≈ 233 MB |
| 3 × chaincode server (Node) | ≈ 237 MB |
| 3 × orderer | ≈ 104 MB |
| bank + platform + auditor (Node) | ≈ 251 MB |
| **Total** | **≈ 825 MB** resident |

Peaks while blocks commit and while a client connects are higher, and the OS needs headroom, so plan **2 vCPU / 3-4 GB RAM /
20 GB disk** (runtime ≈ 370 MB, grows with the ledger). Latency numbers: `docs/benchmark-latest.md`
(≈ 0.55 s p50 submit-to-commit, dominated by the 500 ms orderer batch timeout).

## 1. Compatibility

| Item | Status |
|---|---|
| Linux x86_64 | **Run and tested** in a sandbox (all tests, public mode); on your Fedora machine the network, chaincode and services started successfully (e2e not run there) |
| Linux aarch64 / ARM64 (Oracle Ampere, Pi 4/5) | **Checked statically, not executed**: Fabric 2.5.10 publishes `linux-arm64` binaries (peer, orderer, cryptogen, configtxgen, osnadmin and the `ccaas` builder are all aarch64 ELF files, verified from the release archive); the project has no native Node add-ons; `network.sh` picks the right archive from `uname -m`. First ARM run is the one thing to watch |
| Ubuntu 22.04/24.04, Debian 12, Fedora 40+, Oracle Linux 8/9 | installer supports apt and dnf; only Fedora was actually run |
| Node.js | ≥ 22.13 (built-in `node:sqlite`). `install.sh` uses the distro package and falls back to NodeSource (that fallback could not be tested from the sandbox) |
| Windows | WSL2 only |
| macOS | works in principle (script handles darwin), not tested, no systemd units |
| Docker | not used or needed |

Verify any host in two minutes: `node scripts/e2e.js` (49 checks) and `./scripts/ledger.sh info`.

## 2. Option A: Oracle Cloud Always Free (24/7)

**Know the current limits first.** Oracle's own docs now state the Always Free Ampere A1 allowance as **2 OCPU and 12 GB
total** (1,500 OCPU-hours and 9,000 GB-hours/month), 200 GB total block+boot storage, 10 TB/month outbound.
Older guides quoting 4 OCPU / 24 GB are out of date ([Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm),
[news report of the cut](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/)). 2 OCPU / 4-6 GB is
plenty for this project.

**Reclamation risk.** Oracle may reclaim *idle* Always Free instances: idle means that over 7 days CPU (95th percentile)
< 20% **and** network < 20% **and** (A1 only) memory < 20%. This stack is CPU- and network-idle most of the time, so
the only lever is memory: a **smaller VM (e.g. 2 OCPU / 4 GB)** keeps utilisation above the 20% line more
reliably than 12 GB (825 MB is ≈ 7% of 12 GB, ≈ 21% of 4 GB). This is my inference from the stated rule, not an Oracle
guarantee, so treat the VM as disposable: keep a backup (section 6) and remember `install.sh` rebuilds everything in minutes.
Also expect "Out of host capacity" errors when creating A1 instances in busy regions; retry later or try another
availability domain.

**Steps**

1. Create an Oracle Cloud account (home region cannot be changed later; card verification required).
2. Compute → Create instance → image **Ubuntu 24.04 (aarch64)**, shape **VM.Standard.A1.Flex**, 2 OCPU / 4-6 GB, boot
   volume 50 GB, upload your SSH public key. Do not add extra ingress rules yet.
3. Copy the project and install:
   ```bash
   scp lendchain.zip ubuntu@<server-ip>:~ && ssh ubuntu@<server-ip>
   unzip lendchain.zip && cd lendchain
   ./deploy/install.sh          # packages, Node 22, secrets in ~/.lendchain.env, systemd units, starts everything
   ```
   It prints the generated operator password once; the file `~/.lendchain.env` keeps all secrets.
4. Publish the platform, pick one:
   ```bash
   ./deploy/expose.sh quick               # random https://....trycloudflare.com URL, zero setup
   ./deploy/expose.sh caddy mylend.duckdns.org   # stable HTTPS URL (needs DNS + ports 80/443, see below)
   ```
   For Caddy: create a free name at duckdns.org pointing to the VM's public IP, add ingress rules for TCP 80/443 in the
   VCN security list, and open the host firewall (the script prints the exact commands). Ubuntu images on Oracle ship
   restrictive iptables rules, so skip this step at your peril.
5. Smoke test from your laptop: open the URL, sign up with a demo identity, run a loan.

## 3. Option B: your own machine, free, in 3 commands

```bash
./lendchain.sh start
# in another terminal; cloudflared prints https://<random>.trycloudflare.com
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4001
```

Quick tunnels need no account but are documented by Cloudflare as testing-grade: the hostname changes on every start,
there is no uptime guarantee, 200 concurrent in-flight requests per tunnel, and no Server-Sent Events
([Cloudflare docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/index.md)). The platform UI uses plain
request/response calls, so none of that affects it. For a stable name on your own machine use `deploy/expose.sh caddy`, or a
named Cloudflare Tunnel (needs a domain on Cloudflare).

## 4. Security model: read before sharing the link

The deployment kit makes the *infrastructure* safe to expose; the *application* is still a prototype.

| Control | Where |
|---|---|
| All services and all Fabric ports bind to `127.0.0.1`; only the tunnel/Caddy reaches port 4001 | `LISTEN_HOST` default (verified with a socket listing) |
| Public mode refuses demo-default or short keys/passwords and exits | `LENDCHAIN_PUBLIC=1`, `common/config.js` |
| Bank console and auditor portal are **never** published; reach them via SSH tunnel: `ssh -L 4002:localhost:4002 -L 4003:localhost:4003 user@server`, then browse `localhost:4002` / `4003` and enter the keys from `~/.lendchain.env` | by design |
| `/internal/*` (bank → platform clock hook) returns 404 for anything that came through a proxy | `server.js` + Caddyfile |
| Login 20/min and signup 60/10 min per client IP, then HTTP 429 | `RATE_LOGIN`, `RATE_SIGNUP` |
| Operator password, bank/audit/auditor keys, PII encryption key generated randomly per install | `deploy/install.sh` |

Still true, and worth saying to anyone you show it to:
- **Everything is simulated**: bank, KYC, bureau, e-sign. `DEMO_MODE=true` shows the OTP on screen and gives test funds.
  Tell visitors to use the built-in demo identities, **not their real PAN/Aadhaar**: the form accepts real-format numbers and
  stores them (encrypted) on your server, which makes *you* a data fiduciary under the DPDP Act for real data.
- Fabric identities are `cryptogen` development keys on one host; the platform signs on users' behalf (see README assumptions).
- The operator login is a single password; there is no 2FA or audit of operator actions beyond the ledger itself.
- Not an investment product and not licensed: do not present it as a live lending service.

## 5. Operations

```bash
systemctl status lendchain            # boot service; `sudo systemctl restart lendchain` = full restart
./lendchain.sh status | logs          # component state / last log lines
journalctl -u lendchain-heal -n 20    # self-heal runs every 3 min and restarts anything that died
node scripts/e2e.js                   # full acceptance run (creates test users/loans; run it before demos, not on stage)
./scripts/ledger.sh loans             # formatted ledger view
```

- **Reboot / restart**: `start` resumes the already committed chaincode (the ledger's chaincode sequence does not grow)
  and waits until Fabric service discovery can plan endorsements (≈ 10-60 s) before it reports ready. Measured here: stop → start →
  immediate e2e run, 49/49 pass.
- **Self-heal**: the timer restarts any dead component and does nothing after a deliberate `systemctl stop lendchain`.
- **Update the code**: replace files, then `./lendchain.sh restart-services`. Chaincode changes: `./network/network.sh deploy`
  (bumps the sequence and upgrades with the Fabric lifecycle).
- **Wipe and start over**: `sudo systemctl stop lendchain && ./lendchain.sh reset && sudo systemctl start lendchain`.

## 6. Backup and restore (cold backup; the ledger and the off-chain databases must match)

```bash
sudo systemctl stop lendchain
tar czf ~/lendchain-backup-$(date +%F).tgz ~/.lendchain.env data network/runtime
sudo systemctl start lendchain
```

Restore on a fresh VM: run `install.sh`, `sudo systemctl stop lendchain`, unpack the archive over the project folder and the
home directory (this replaces the generated env file and the Fabric state), then start. Losing `LENDCHAIN_PII_KEY` makes the
encrypted personal data unreadable; losing `network/runtime/crypto` loses the Fabric identities.

## 7. Hosting KPIs worth tracking

| KPI | How | Expectation from this setup |
|---|---|---|
| Availability | external ping of `/api/config` (e.g. a free uptime monitor) | Oracle: ≈ the VM's; quick tunnel: no guarantee |
| Recovery time after reboot | time from boot to `/api/config` and a successful bid | measured here: a stop → start cycle returned in ≈ 7 s with discovery ready; on slower hardware expect longer (timeout 120 s) |
| Write latency p50/p95 | `node scripts/bench.js 60 1,4` | ≈ 0.55 / 0.6 s on one host |
| Memory headroom | `free -m` while e2e runs | 825 MB resident measured after a full run (peaks not captured) |
| Reconciliation breaks / invariants | auditor portal | 0 and 10/10 |
| Reclamation signals (Oracle) | OCI console notifications/e-mail | act within the notice window: restore from backup |

## 8. Where this stops being "free"

A real launch needs everything in the README's *Production gap* list plus: orderers/peers run by independent
organisations on separate hosts, an HSM/KMS, Fabric CA, TLS between components, and Fabric 3.x SmartBFT instead of Raft if
participants do not trust each other. Free tiers cannot give you that; this document is for a demo/portfolio deployment.

# CLAUDE.md: LendChain handoff (read this first)

You are picking up a finished, tested project. **Your job: publish it to GitHub and verify that it runs in GitHub Codespaces.**
Don't redesign it. Only change code if a real Codespace run shows a bug, and keep any fix minimal.

## 1. What this is

**LendChain** is a P2P lending prototype (an Indian NBFC-P2P model). It follows an academic proposal and is built on
**Hyperledger Fabric 2.5.10**, run **natively with no Docker**.

- **Fabric network** (`network/network.sh`):
  - 3 orgs (Platform, Trustee, Auditor) plus an Orderer org.
  - 3 Raft orderers on 7050/7150/7250 and 3 peers on 7051/8051/9051, on channel `lendchain`.
  - Chaincode runs as a service (ccaas): one Node chaincode server per org, on 7999/8999/9999.
  - Endorsement policy: `AND('PlatformMSP.peer','TrusteeMSP.peer')`. There is a private data collection for bank tokens.
- **Chaincode** (`chaincode/lendchain/src`) covers:
  - Registry and loan state machine.
  - Uniform-price bid matching.
  - Repayments.
  - RBI compliance caps.
  - All money is BigInt paise.
- **Services** (Node ≥ 22.13, built-in `node:sqlite`):

  | Port | Service | Access |
  |---|---|---|
  | 4001 | Platform UI/API (borrower, lender, operator) | operator `admin@lendchain.local` / `admin12345` |
  | 4002 | Mock trustee bank | header `x-api-key`, default `dev-bank-key` |
  | 4003 | Read-only auditor | header `x-auditor-key`, default `auditor-demo` |

- **Entry point:** `./lendchain.sh start|stop|status|logs|heal|reset|restart-services`.
  - On the first run, `start` downloads the Fabric binaries from GitHub releases into `network/bin`, generates crypto, and creates the channel.
  - It then deploys the chaincode, waits for service discovery (`network.sh ready`), and starts the services.
  - On later runs it **resumes** the committed chaincode instead of redeploying it.
- **Tests:**
  - `node scripts/e2e.js` runs 49 full-lifecycle checks against the live network.
  - `cd chaincode/lendchain && npm test` runs 26 unit tests.
  - `./scripts/ledger.sh loans|info|loan <id>|history <id>` is a formatted ledger explorer.

Docs: `README.md`, `docs/CODESPACES.md` (the Codespaces guide), `docs/HOSTING.md` (VM/tunnel hosting), `docs/EVALUATION.md`.

## 2. Verified state (sandbox, x86_64 Linux, 2026-10-24)

- **Fresh `git clone`, run as a non-root user with no env file:**
  - `./lendchain.sh start` brought up all 12 components in about 42 s.
  - The e2e run passed **49/49**.
  - Nothing was written to `/var/hyperledger`.
- **Simulated Codespace stop** (`pkill -9` of every process, leaving stale pid files):
  - `./lendchain.sh start` was ready again in **6 s**.
  - The ledger data survived.
  - The e2e run passed **49/49** again.
- **The user's Fedora machine:** the stack runs there. SELinux blocks systemd from executing scripts under `~/Downloads`. This matters for `deploy/install.sh` only, not for Codespaces.
- **NOT yet verified:** a real GitHub Codespace. That is your task.

## 3. Codespaces design (already in the repo)

The config is `.devcontainer/devcontainer.json`:
- Image: `mcr.microsoft.com/devcontainers/javascript-node:22-bookworm`. The container user is `node`, which is non-root.
- `hostRequirements`: 2 CPU, 4 GB RAM, 16 GB storage.
- `forwardPorts`: 4001, 4002 and 4003, with labels.
- `postStartCommand`: `./lendchain.sh start`. It runs on every create and on every resume.

Background processes are launched with `nohup setsid … 9>&-`, so they should survive after the lifecycle command exits.
**Confirm this in the real Codespace.**

The model: **every visitor opens their own Codespace** using `https://codespaces.new/<user>/lendchain`.
- Forwarded ports are private to the owner, which is why the demo default keys are acceptable.
- Do **not** set ports to public while the defaults are in use.
- If a public port is ever needed, set `LENDCHAIN_PUBLIC=1` with strong keys. See `common/config.js` and `deploy/install.sh` for the variable names.

The platform UI (`services/platform/public/index.html`, function `svcLink`) rewrites `<name>-4001.app.github.dev` to `-4002`/`-4003`. This makes the in-app bank and auditor links work inside Codespaces.

`.gitignore` excludes `network/bin`, `network/config`, `network/builders`, `network/runtime`, `data/`, `node_modules`, `*.log`, `.env` and `.lendchain.env`.
**Never commit any of these.** `network/runtime` holds the generated Fabric private keys.

## 4. Your task, step by step

1. **Pre-flight.**
   - Run `git --version`.
   - Run `gh --version && gh auth status`. If `gh` is missing, install it (Fedora: `sudo dnf install gh`), then run `gh auth login`. Ask the user to complete the browser login.
   - The user needs the `codespace` scope: `gh auth refresh -h github.com -s codespace`.
2. **Clean check.**
   - From the project root, run `git status` (after init) and inspect what will be committed.
   - Expect about 58 files and under 1 MB.
   - Abort if any `*.pem`, `*_sk`, `network/runtime`, `data/*.db` or `node_modules` would be included.
3. **Publish** (the repo must be **public** so other people can open Codespaces from it):
   ```bash
   git init -b main && git add . && git commit -m "LendChain: P2P lending on Hyperledger Fabric"
   gh repo create lendchain --public --source=. --remote=origin --push
   ```
   - If the name is taken, ask the user for a different one.
   - End commit messages with the attribution lines your environment specifies, if any.
4. **Add the badge.**
   - Replace `<your-user>` in `docs/CODESPACES.md` with the real GitHub username: `gh api user -q .login`.
   - Add the "Open in GitHub Codespaces" badge near the top of `README.md`:
     `[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/<user>/lendchain)`
   - Commit and push.
5. **Real Codespace test.** This uses the user's free quota, so delete the codespace at the end.
   ```bash
   gh codespace create -R <user>/lendchain -b main        # pick the 2-core machine if prompted
   gh codespace list                                       # note the name
   gh codespace logs -c <name>                             # creation + postStartCommand output; wait for "ready:"
   gh codespace ssh -c <name> -- 'cd /workspaces/lendchain && ./lendchain.sh status'
   gh codespace ssh -c <name> -- 'cd /workspaces/lendchain && node scripts/e2e.js'   # expect "49 passed, 0 failed"
   gh codespace ports -c <name>                            # 4001-4003 forwarded, visibility private
   ```
   - **Resume test:** run `gh codespace stop -c <name>`. Then start it again, either with an ssh command (which starts it) or from the web. Check `./lendchain.sh status` again: all 12 should be up and the data should be intact (`./scripts/ledger.sh loans`).
   - **Browser check:** ask the user to open the codespace in the browser, click port 4001 in the Ports tab, sign up with a demo identity and the on-screen OTP `123456`, and confirm the bank and auditor links in the UI open.
   - **Clean up:** `gh codespace delete -c <name>`. Ask the user first if they want to keep it.
6. **Report to the user:**
   - The repo URL.
   - The shareable link `https://codespaces.new/<user>/lendchain`.
   - The e2e result inside the Codespace.
   - The cold-start time.
   - Any fixes you made.

## 5. If something fails in the Codespace

- **Services die after `postStartCommand` finishes:**
  - Move the start into `postAttachCommand`, or wrap it as `bash -lc './lendchain.sh start'`.
  - Alternatively, keep `postStartCommand` and add `"waitFor": "postStartCommand"`.
  - Re-test the resume path.
- **`ready` times out (discovery):** check the peer logs with `./lendchain.sh logs` and `network/runtime/logs/*`. It is usually a slow first start. The timeout is in `network.sh ready`.
- **Fabric download blocked or slow:** the binaries come from `github.com/hyperledger/fabric/releases` (v2.5.10). The architecture is picked from `uname -m`.
- **Port links wrong:** check `svcLink` in `services/platform/public/index.html` against the actual forwarded hostname.
- **Out of memory:** raise `hostRequirements.memory` to `8gb`. The measured resident footprint is about 825 MB.
- After any fix: re-run the e2e inside the Codespace, commit, and push.

## 6. Don't

- Don't commit secrets, generated crypto, databases or binaries.
- Don't make ports public with the demo keys.
- Don't redeploy the chaincode on every start. `start` intentionally resumes; `network.sh deploy` bumps the sequence.
- Don't present this as a real lending service. The bank, KYC, bureau and e-sign are all mocks (see the README's *Production gap*).

## 7. Context on the user's broader goal

Ayman wants a free link that is always on. Codespaces gives a free "try it yourself" link, with one independent copy per visitor that sleeps when idle. It does **not** give one shared 24/7 instance. Options looked at so far:

| Option | Status |
|---|---|
| Oracle Always Free A1 | Out of capacity on the user's attempt |
| Cloudflare quick tunnel and localhost.run | Blocked on the user's network |
| Pinggy | Works, but the free plan has a 60-minute limit |
| The user's own always-on computer in Tailscale | Untried. Plan: run `deploy/install.sh` there and publish with Tailscale Funnel. Needs that machine's OS and SSH username |

Treat this table as background only; it is not part of this task unless the user asks.

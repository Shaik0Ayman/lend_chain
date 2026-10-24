# Run LendChain in GitHub Codespaces (free, no server, no card needed)

Instead of hosting one shared copy, anyone with a GitHub account can open this repository in a Codespace and get **their
own complete, running LendChain** (Fabric network + platform + bank + auditor) in a few minutes. You host nothing.

## For you (one time): put the project on GitHub

```bash
cd lend_chain
git init -b main && git add . && git commit -m "LendChain: P2P lending on Hyperledger Fabric"
# create an EMPTY public repository on github.com first, then:
git remote add origin https://github.com/shaik0ayman/lend_chain.git
git push -u origin main
```

`.gitignore` keeps out the downloaded Fabric binaries, generated keys, databases and `node_modules`.
The repository must be **public** for other people to open it in their own Codespaces (a private repo only works for
collaborators). Nothing secret is in it: keys and data are generated at runtime and ignored by git.

Share this link:
`https://codespaces.new/shaik0ayman/lend_chain`
(or add the badge to the README: `[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/shaik0ayman/lend_chain)`)

## For anyone opening it

1. Open the link, click **Create codespace**. (Needs a free GitHub account.)
2. Wait 3-5 minutes. The terminal shows progress: it downloads Fabric, creates the network and deploys the chaincode.
   Wait for `ready:` and `endorsement discovery ready`.
3. Open the **Ports** tab, click the globe next to **4001** (LendChain platform). Sign up with the demo identity and the
   OTP shown on screen. Operator login: `admin@lendchain.local` / `admin12345`.
4. Ports **4002** (bank console) and **4003** (auditor portal) open the same way. Their keys are `dev-bank-key` and
   `auditor-demo`.
5. Optional checks in the terminal: `node scripts/e2e.js` (49 checks, ~2 min), `./scripts/ledger.sh loans`.

Forwarded ports are **private** to the person who owns the Codespace. That is what makes the demo-default keys acceptable
here. Do not make these ports public.

## What to expect

- **Quota.** Each person's own free quota applies. GitHub's billing page lists 120 core-hours/month on a free personal
  account, i.e. about 60 hours of a 2-core Codespace, and 15 GB-month of storage. A 2-core Codespace is the default;
  this project asks for at least 2 cores / 4 GB.
- **It sleeps.** An idle Codespace stops (30 minutes by default, adjustable by its owner). Files persist; on restart the
  `postStartCommand` runs `./lendchain.sh start`, which resumes the existing chaincode and waits for the network to be
  ready (about a minute). Ledger data and accounts survive a stop.
- **Not shared.** Every visitor has an independent network and database. Two people cannot see each other's loans. For one
  shared always-on instance, see `docs/HOSTING.md`.
- **Not tested from here.** I could validate the configuration file and the scripts, but I could not start a real
  Codespace from my environment. The first run is the real test; the tag `22-bookworm` of the base image is confirmed on
  the image's Docker Hub page.

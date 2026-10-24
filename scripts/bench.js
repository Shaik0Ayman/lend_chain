'use strict';
/**
 * Ledger benchmark: submit-to-commit latency (p50/p95/p99) and throughput, measured through the real
 * Fabric Gateway against the running network, as the Platform org (so every tx is endorsed by BOTH the
 * Platform and Trustee peers, ordered by the 3-node Raft cluster, and committed on the Platform peer).
 *
 *   node scripts/bench.js [txPerLevel=60] [levels=1,4,8,16]
 *
 * Workload = the platform's hot path: createListing then bid:place. Each worker uses its own lender and its
 * own loan, so there is no artificial key contention (MVCC retries are counted anyway). Reads (evaluate)
 * are timed separately. This is a pragmatic stand-in for Hyperledger Caliper; see docs/EVALUATION.md for
 * how to port it, and for what the numbers do and do not mean (single host, 500 ms batch timeout).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { connectOrg } = require('../common/fabric');

const N = Number(process.argv[2] || 60);
const LEVELS = (process.argv[3] || '1,4,8,16').split(',').map(Number);
const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const run = process.hrtime.bigint().toString(36).slice(-6).toUpperCase();

async function pool(items, concurrency, fn) {
    const lat = []; let i = 0, retries = 0, failed = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (i < items.length) {
            const it = items[i++];
            const s = performance.now();
            try { await fn(it); lat.push(performance.now() - s); } catch (e) { failed++; if (failed < 3) console.error('   tx failed:', e.message); }
        }
    }));
    return { lat, wall: (Date.now() - t0) / 1000, failed, retries };
}

(async () => {
    const plat = await connectOrg('platform');
    const rows = [];
    console.log(`Benchmark run ${run}: ${N} tx per level, levels ${LEVELS.join(',')}`);

    // setup: borrowers + lenders (not timed)
    const need = Math.max(...LEVELS) * 0 + N;
    const borrowers = Array.from({ length: N }, (_, i) => `BRW-B${run}${String(i).padStart(5, '0')}`);
    const lenders = Array.from({ length: N }, (_, i) => `LND-B${run}${String(i).padStart(5, '0')}`);
    await pool(borrowers.map((b) => ['BORROWER', b]).concat(lenders.map((l) => ['LENDER', l])), 8, ([role, id]) =>
        plat.submit('registry:register', [id, role, 'VERIFIED', h(id), role === 'LENDER' ? h('d' + id) : '']));
    console.log(`  registered ${2 * N} participants`);

    let loanSeq = 0;
    const loanIds = [];
    for (const conc of LEVELS) {
        const ids = Array.from({ length: N }, (_, i) => ({ loan: `LN-B${run}${conc}x${i}`, b: borrowers[(loanSeq++) % N] }));
        const r = await pool(ids, conc, (x) => plat.submit('loan:createListing', [x.loan, x.b, 20000000, 12, 'PERSONAL', 1800, 'B', 'bench', 1000, 1300, '2030-01-01'])
            .then(() => { loanIds.push(x); }));
        // each createListing of Rs 2 lakh counts against the borrower's Rs 10 lakh cap, so N borrowers are reused <=5 times
        rows.push({ op: 'loan:createListing', conc, n: r.lat.length, failed: r.failed, wall: r.wall, tps: r.lat.length / r.wall, p50: pctl(r.lat, 50), p95: pctl(r.lat, 95), p99: pctl(r.lat, 99) });
    }
    // bids: every worker bids as a distinct lender on a distinct loan
    for (const conc of LEVELS) {
        const work = loanIds.slice(0, N).map((x, i) => ({ loan: x.loan, lender: lenders[i % N], i }));
        // reuse the same loans across levels with fresh lenders so each (lender,borrower) stays under its cap
        const shift = LEVELS.indexOf(conc);
        const items = work.map((w) => ({ ...w, lender: lenders[(w.i + shift) % N] })).filter((w) => true);
        const r = await pool(items, conc, (w) => plat.submit('bid:place', [w.loan, w.lender, 500000, 1300 + (w.i % 200)]));
        rows.push({ op: 'bid:place', conc, n: r.lat.length, failed: r.failed, wall: r.wall, tps: r.lat.length / r.wall, p50: pctl(r.lat, 50), p95: pctl(r.lat, 95), p99: pctl(r.lat, 99) });
    }
    // reads
    const ev = [];
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) { const s = performance.now(); await plat.evaluate('loan:get', loanIds[i % loanIds.length].loan); ev.push(performance.now() - s); }
    rows.push({ op: 'loan:get (evaluate)', conc: 1, n: ev.length, failed: 0, wall: (Date.now() - t0) / 1000, tps: ev.length / ((Date.now() - t0) / 1000), p50: pctl(ev, 50), p95: pctl(ev, 95), p99: pctl(ev, 99) });
    // match cost: closeAndMatch with 1 bid (state-heavy tx)
    const one = loanIds[0];
    const ms = performance.now(); await plat.submit('bid:closeAndMatch', [one.loan, 'true']); rows.push({ op: 'bid:closeAndMatch (1 loan, 1 bid)', conc: 1, n: 1, failed: 0, wall: (performance.now() - ms) / 1000, tps: 0, p50: performance.now() - ms, p95: performance.now() - ms, p99: performance.now() - ms });

    const f = (x) => x.toFixed(0);
    const table = ['| operation | concurrency | tx | failed | p50 ms | p95 ms | p99 ms | tx/s |', '|---|---:|---:|---:|---:|---:|---:|---:|']
        .concat(rows.map((r) => `| ${r.op} | ${r.conc} | ${r.n} | ${r.failed} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${r.tps ? r.tps.toFixed(1) : '-'} |`)).join('\n');
    console.log('\n' + table + '\n');
    const out = path.join(__dirname, '..', 'docs', 'benchmark-latest.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `# Benchmark (generated ${new Date().toISOString()})\n\nHost: ${require('os').cpus().length} vCPU, ${(require('os').totalmem() / 2 ** 30).toFixed(0)} GiB RAM, all 3 orgs + 3 Raft orderers on ONE machine. Orderer BatchTimeout 500 ms. N=${N} tx per level.\nLatency is submit→commit as seen by the client (endorse on Platform+Trustee peers, order, commit-status on Platform peer, plus the wait for the Trustee peer to reach the same block).\n\n${table}\n`);
    console.log(`written ${out}`);
    plat.close();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * AUDITOR PORTAL (read-only)  -  runs as AuditorMSP against the Auditor org's OWN peer and ledger copy.
 *   - re-derives the money invariants from raw on-chain records (repay:verifyLoan)
 *   - reconciles the trustee bank's statement against on-chain UTRs (the "oracle problem" mitigation)
 *   - streams chaincode events
 * It cannot write: the chaincode rejects every write from AuditorMSP, and the Auditor peer is not a member
 * of the private bank-account collection (it sees only a hash).
 */
const path = require('node:path');
const express = require('express');
const { connectOrg } = require('../../common/fabric');
const { route } = require('../../common/util');
const { HOST, requireStrong } = require('../../common/config');
requireStrong(['BANK_AUDIT_KEY', 'AUDITOR_UI_KEY']);

const PORT = Number(process.env.AUDITOR_PORT || 4003);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const AUDIT_KEY = process.env.BANK_AUDIT_KEY || 'dev-audit-key';
const UI_KEY = process.env.AUDITOR_UI_KEY || 'auditor-demo';

let chain;
const events = [];

async function followEvents() {
    for (;;) {
        try {
            const stream = await chain.events({ startBlock: 0n });
            for await (const ev of stream) {
                events.push({ block: Number(ev.blockNumber), txId: ev.transactionId, name: ev.eventName, payload: Buffer.from(ev.payload).toString() });
                if (events.length > 500) events.shift();
            }
        } catch (e) { console.error('[auditor] event stream:', e.message); await new Promise((r) => setTimeout(r, 3000)); }
    }
}

async function reconcile() {
    const r = await fetch(`${BANK_URL}/api/audit/statement`, { headers: { 'x-audit-key': AUDIT_KEY } });
    if (!r.ok) throw new Error(`bank statement unavailable (${r.status})`);
    const stmt = await r.json();
    const loans = await chain.evaluate('loan:list', '');
    // everything the chain says moved: utr -> {kind, amount}
    const onChain = new Map();
    let lendersEscrow = 0, borrowersEscrow = 0;
    for (const l of loans) {
        for (const e of Object.values(l.escrow)) {
            onChain.set(e.utr, { kind: 'ESCROW_IN', amount: e.amountPaise, loanId: l.id }); lendersEscrow += e.amountPaise;
            if (e.refundUtr) { onChain.set(e.refundUtr, { kind: 'ESCROW_REFUND', amount: e.amountPaise, loanId: l.id }); lendersEscrow -= e.amountPaise; }
        }
        if (l.disbursal) { onChain.set(l.disbursal.utr, { kind: 'DISBURSEMENT', amount: l.disbursal.amountPaise, loanId: l.id }); lendersEscrow -= l.disbursal.amountPaise; }
        if (l.receiptCount) {
            for (const rc of await chain.evaluate('repay:listReceipts', l.id)) { onChain.set(rc.utr, { kind: 'EMI', amount: rc.amountPaise, loanId: l.id }); borrowersEscrow += rc.amountPaise; }
            for (const p of await chain.evaluate('repay:listPayouts', l.id)) if (p.payoutUtr) { onChain.set(p.payoutUtr, { kind: 'PAYOUT', amount: p.amountPaise, loanId: l.id }); borrowersEscrow -= p.amountPaise; }
        }
    }
    const bankTx = new Map(stmt.transactions.map((t) => [t.utr, t]));
    const issues = [];
    let matched = 0;
    for (const t of stmt.transactions) {
        const c = onChain.get(t.utr);
        if (!c) { issues.push({ type: 'BANK_ONLY', utr: t.utr, detail: `${t.kind} ${t.amount / 100} on ${t.value_date} (${t.loan_id}) has no on-chain record` }); continue; }
        if (c.amount !== t.amount || c.kind !== t.kind) issues.push({ type: 'MISMATCH', utr: t.utr, detail: `bank ${t.kind} ${t.amount} vs chain ${c.kind} ${c.amount}` });
        else matched++;
    }
    for (const [utr, c] of onChain) if (!bankTx.has(utr)) issues.push({ type: 'CHAIN_ONLY', utr, detail: `${c.kind} ${c.amount / 100} on ${c.loanId} is not in the bank statement` });
    const bal = Object.fromEntries(stmt.escrowBalances.map((b) => [b.id, b.balance]));
    const balances = [
        { account: 'ESCROW-LENDERS', bankPaise: bal['ESCROW-LENDERS'], chainImpliedPaise: lendersEscrow },
        { account: 'ESCROW-BORROWERS', bankPaise: bal['ESCROW-BORROWERS'], chainImpliedPaise: borrowersEscrow },
    ].map((b) => ({ ...b, ok: b.bankPaise === b.chainImpliedPaise }));
    return { bankDate: stmt.simDate, bankTransactions: stmt.transactions.length, onChainRecords: onChain.size, matched, issues, balances, ok: !issues.length && balances.every((b) => b.ok) };
}

const app = express();
app.use((req, res, next) => (req.path.startsWith('/api/') && req.get('x-auditor-key') !== UI_KEY ? res.status(401).json({ error: 'auditor key required' }) : next()));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/loans', route(async (req, res) => {
    const loans = await chain.evaluate('loan:list', '');
    res.json(loans.map((l) => ({ id: l.id, status: l.status, borrowerId: l.borrowerId, amountPaise: l.amountPaise, aprBps: l.clearingAprBps, tenureMonths: l.tenureMonths, grade: l.riskGrade, lenders: l.allocations.length, dpd: l.dpd, flags: l.flags.length, createdAt: l.createdAt, agreementHash: l.agreementHash })));
}));
app.get('/api/loans/:id', route(async (req, res) => {
    const [loan, receipts, payouts, verify, history] = await Promise.all([chain.evaluate('loan:get', req.params.id), chain.evaluate('repay:listReceipts', req.params.id), chain.evaluate('repay:listPayouts', req.params.id), chain.evaluate('repay:verifyLoan', req.params.id), chain.evaluate('loan:history', req.params.id)]);
    res.json({ loan, receipts, payouts, verify, history });
}));
app.get('/api/verify-all', route(async (req, res) => {
    const loans = await chain.evaluate('loan:list', '');
    const out = [];
    for (const l of loans) { const v = await chain.evaluate('repay:verifyLoan', l.id); out.push({ loanId: l.id, status: l.status, ok: v.ok, failed: v.checks.filter((c) => !c.ok), checks: v.checks.length }); }
    res.json(out);
}));
app.get('/api/reconcile', route(async (req, res) => res.json(await reconcile())));
app.get('/api/events', (req, res) => res.json(events.slice(-120).reverse()));
app.get('/api/pdc-hash/:id', route(async (req, res) => {
    let plain = 'blocked';
    try { await chain.evaluate('registry:getBankAccountRef', req.params.id); plain = 'READABLE (should never happen)'; } catch (e) { plain = `blocked: ${e.code || e.message}`; }
    res.json({ participantId: req.params.id, privateRead: plain, publicHash: await chain.evaluate('registry:getBankAccountRefHash', req.params.id) });
}));

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'common', 'public')));
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
    chain = await connectOrg('auditor');
    followEvents();
    app.listen(PORT, HOST, () => console.log(`[auditor] read-only portal on http://${HOST}:${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });

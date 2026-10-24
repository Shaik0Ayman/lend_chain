'use strict';
/**
 * MOCK TRUSTEE BANK  (stands in for the bank-promoted trustee that runs both escrow accounts)
 *
 *   Lender accounts --(after signing)--> Lenders' Escrow --(T+1)--> Borrower account
 *   Borrower account --(autopay EMI)--> Borrowers' Escrow --(T+1, pro-rata)--> Lender accounts
 *
 * The bank is the ONLY party that moves rupees. After each movement it asserts the fact on the
 * Fabric ledger under the TrusteeMSP identity, carrying its own UTR. Chain recording goes through a
 * transactional outbox: the DB transfer and the pending on-chain assertion commit together, and a
 * retry is safe because the chaincode refuses to book the same UTR twice.
 *
 * It also owns a simulated clock so months of EMIs, defaults and T+1 breaches can be demoed.
 */
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { connectOrg } = require('../../common/fabric');
const { dataDir, route, HttpError, today, addDays, diffDays } = require('../../common/util');
const { HOST, requireStrong } = require('../../common/config');
requireStrong(['BANK_API_KEY', 'BANK_AUDIT_KEY']);

const PORT = Number(process.env.BANK_PORT || 4002);
const API_KEY = process.env.BANK_API_KEY || 'dev-bank-key'; // platform -> bank service key
const AUDIT_KEY = process.env.BANK_AUDIT_KEY || 'dev-audit-key'; // auditor read-only key
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4001';
const ESC_L = 'ESCROW-LENDERS';
const ESC_B = 'ESCROW-BORROWERS';
const ACTIVE = ['DISBURSED', 'REPAYING', 'NPA'];

const db = new DatabaseSync(path.join(dataDir('bank'), 'bank.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, owner TEXT, kind TEXT, token TEXT UNIQUE, ifsc TEXT, balance INTEGER NOT NULL DEFAULT 0, opened TEXT);
  CREATE TABLE IF NOT EXISTS txns(seq INTEGER PRIMARY KEY AUTOINCREMENT, utr TEXT UNIQUE, from_acc TEXT, to_acc TEXT, amount INTEGER NOT NULL, value_date TEXT,
    kind TEXT, loan_id TEXT, ref TEXT, memo TEXT, chain_fqn TEXT, chain_args TEXT, recorded INTEGER NOT NULL DEFAULT 1, chain_tx TEXT, last_error TEXT);
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS autopay_log(loan_id TEXT, installment INTEGER, date TEXT, status TEXT, detail TEXT, PRIMARY KEY(loan_id, installment, status));
`);
for (const [id, kind] of [[ESC_L, 'ESCROW_LENDERS'], [ESC_B, 'ESCROW_BORROWERS']]) {
    db.prepare('INSERT OR IGNORE INTO accounts(id, owner, kind, balance, opened) VALUES(?,?,?,0,?)').run(id, 'TRUSTEE', kind, today());
}
const kvGet = (k, d) => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
const cfg = () => ({ payoutDelayDays: kvGet('payoutDelayDays', 0), disburseDelayDays: kvGet('disburseDelayDays', 0), autoProcess: kvGet('autoProcess', true) });
const simDate = () => kvGet('simDate', today());

let chain; // Fabric connection (TrusteeMSP)

// ---------------------------------------------------------------- ledger primitives
const acct = (id) => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
const acctByOwner = (owner) => db.prepare("SELECT * FROM accounts WHERE owner=? AND kind IN ('LENDER','BORROWER')").get(owner);
const acctByToken = (t) => db.prepare('SELECT * FROM accounts WHERE token=?').get(t);

function nextUtr(date) {
    const n = (kvGet('utrSeq', 0)) + 1;
    kvSet('utrSeq', n);
    return `UTR${date.replace(/-/g, '')}${String(n).padStart(8, '0')}`;
}

/** Atomic double-entry transfer + outbox row (the chain assertion to make once committed). */
function transfer({ from, to, amount, kind, loanId, ref, memo, chain: call }) {
    const date = simDate();
    db.exec('BEGIN IMMEDIATE');
    try {
        const a = acct(from), b = acct(to);
        if (!a || !b) throw new HttpError(404, `unknown account ${!a ? from : to}`, 'NO_ACCOUNT');
        if (a.balance < amount) throw new HttpError(402, `insufficient funds in ${from}: have ${a.balance / 100}, need ${amount / 100}`, 'INSUFFICIENT_FUNDS');
        const utr = nextUtr(date);
        db.prepare('UPDATE accounts SET balance=balance-? WHERE id=?').run(amount, from);
        db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(amount, to);
        db.prepare(`INSERT INTO txns(utr, from_acc, to_acc, amount, value_date, kind, loan_id, ref, memo, chain_fqn, chain_args, recorded)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(utr, from, to, amount, date, kind, loanId || null, ref || null, memo || '',
            call ? call.fqn : null, call ? JSON.stringify(call.args.map((x) => (x === '{utr}' ? utr : x))) : null, call ? 0 : 1);
        db.exec('COMMIT');
        return { utr, date };
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

let flushing = null;
/** Push every unrecorded transfer to the ledger, in order. Stops at the first hard failure. */
function flushOutbox() {
    if (flushing) return flushing;
    flushing = (async () => {
        const rows = db.prepare('SELECT * FROM txns WHERE recorded=0 ORDER BY seq').all();
        for (const r of rows) {
            try {
                const out = await chain.submit(r.chain_fqn, JSON.parse(r.chain_args));
                db.prepare('UPDATE txns SET recorded=1, chain_tx=?, last_error=NULL WHERE seq=?').run(out.__txId, r.seq);
            } catch (e) {
                if (e.code === 'DUPLICATE_UTR') { // committed earlier, we just crashed before marking it
                    db.prepare('UPDATE txns SET recorded=1, last_error=NULL WHERE seq=?').run(r.seq);
                    continue;
                }
                db.prepare('UPDATE txns SET last_error=? WHERE seq=?').run(String(e.message).slice(0, 300), r.seq);
                console.error(`[bank] chain record failed for ${r.utr}: ${e.message}`);
                break;
            }
        }
    })().finally(() => { flushing = null; });
    return flushing;
}

const pending = (kind, loanId, ref) => !!db.prepare('SELECT 1 FROM txns WHERE kind=? AND loan_id=? AND COALESCE(ref,\'\')=COALESCE(?,\'\')').get(kind, loanId, ref ?? null);

// ---------------------------------------------------------------- scheduled work
async function stepDisburse(date) {
    for (const l of await chain.evaluate('loan:list', 'SIGNED')) {
        if (!l.fundedOn || pending('DISBURSEMENT', l.id)) continue;
        if (diffDays(l.fundedOn, date) < cfg().disburseDelayDays) continue;
        const b = acctByOwner(l.borrowerId);
        if (!b) continue;
        transfer({ from: ESC_L, to: b.id, amount: l.amountPaise, kind: 'DISBURSEMENT', loanId: l.id, memo: `Loan ${l.id} disbursal`, chain: { fqn: 'loan:recordDisbursement', args: [l.id, l.amountPaise, '{utr}', date] } });
    }
    await flushOutbox();
}

async function stepAutopay(date) {
    const loans = [];
    for (const s of ACTIVE) loans.push(...await chain.evaluate('loan:list', s));
    for (const l of loans) {
        const b = acctByOwner(l.borrowerId);
        if (!b) continue;
        for (const r of l.schedule) {
            if (r.status === 'PAID' || r.dueDate > date) continue;
            const remaining = r.interestPaise + r.principalPaise - r.paidInterestPaise - r.paidPrincipalPaise;
            if (pending('EMI', l.id, String(r.no))) break;
            const fresh = acct(b.id);
            if (fresh.balance < remaining) {
                db.prepare('INSERT OR IGNORE INTO autopay_log VALUES(?,?,?,?,?)').run(l.id, r.no, date, 'BOUNCED', `balance ${fresh.balance / 100} < EMI ${remaining / 100}`);
                break; // oldest first: later instalments cannot be collected ahead of an unpaid one
            }
            transfer({ from: b.id, to: ESC_B, amount: remaining, kind: 'EMI', loanId: l.id, ref: String(r.no), memo: `Autopay EMI ${r.no}/${l.tenureMonths}`, chain: { fqn: 'repay:recordEmiReceived', args: [l.id, remaining, date, '{utr}'] } });
            await flushOutbox(); // keep the chain's schedule in step before the next instalment
        }
    }
}

async function stepPayouts(date) {
    for (const p of await chain.evaluate('repay:pendingPayouts')) {
        if (pending('PAYOUT', p.loanId, p.payoutId)) continue;
        if (date < addDays(p.receiptValueDate, cfg().payoutDelayDays)) continue;
        let ref;
        try { ref = await chain.evaluate('registry:getBankAccountRef', p.lenderId); } catch (e) { console.error(`[bank] no beneficiary for ${p.lenderId}: ${e.message}`); continue; }
        const dest = acctByToken(ref.accountToken);
        if (!dest) continue;
        transfer({ from: ESC_B, to: dest.id, amount: p.amountPaise, kind: 'PAYOUT', loanId: p.loanId, ref: p.payoutId, memo: `Share of EMI (receipt ${p.receiptSeq})`, chain: { fqn: 'repay:recordPayout', args: [p.loanId, p.payoutId, '{utr}', date] } });
    }
    await flushOutbox();
}

let running = null;
async function processAll() {
    if (running) return running;
    running = (async () => {
        const date = simDate();
        await flushOutbox();
        await stepDisburse(date);
        await stepAutopay(date);
        await stepPayouts(date);
        await flushOutbox();
    })().catch((e) => console.error('[bank] process error:', e.message)).finally(() => { running = null; });
    return running;
}

async function notifyPlatform(date) {
    try {
        await fetch(`${PLATFORM_URL}/internal/clock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-key': API_KEY }, body: JSON.stringify({ date }), signal: AbortSignal.timeout(60000) });
    } catch (e) { console.error(`[bank] platform clock notify failed: ${e.message}`); }
}

async function advance(days) {
    for (let i = 0; i < days; i++) {
        kvSet('simDate', addDays(simDate(), 1));
        await processAll();
    }
    await notifyPlatform(simDate());
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.use(express.json());
const needKey = (req, res, next) => (req.get('x-api-key') === API_KEY ? next() : res.status(401).json({ error: 'bad api key' }));
const needAudit = (req, res, next) => (req.get('x-audit-key') === AUDIT_KEY || req.get('x-api-key') === API_KEY ? next() : res.status(401).json({ error: 'bad audit key' }));

app.get('/health', (req, res) => res.json({ ok: true, simDate: simDate() }));

// Account opening with "penny drop" verification, called by the platform at KYC time
app.post('/api/accounts', needKey, route(async (req, res) => {
    const { owner, kind, ifsc } = req.body;
    if (!owner || !['LENDER', 'BORROWER'].includes(kind) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc || '')) throw new HttpError(400, 'owner, kind and a valid IFSC are required', 'INVALID_INPUT');
    const ex = acctByOwner(owner);
    if (ex) return res.json({ accountId: ex.id, token: ex.token, balancePaise: ex.balance, existing: true });
    const id = `AC${String(db.prepare('SELECT COUNT(*) c FROM accounts').get().c + 1000).padStart(6, '0')}`;
    const token = `tok_${require('node:crypto').randomBytes(12).toString('hex')}`;
    db.prepare('INSERT INTO accounts(id, owner, kind, token, ifsc, balance, opened) VALUES(?,?,?,?,?,0,?)').run(id, owner, kind, token, ifsc, simDate());
    res.json({ accountId: id, token, balancePaise: 0, pennyDrop: 'VERIFIED' });
}));

// Demo only: money arriving from outside (salary credit / deposit). A real bank has no such endpoint.
app.post('/api/demo/topup', needKey, route(async (req, res) => {
    const { owner, amountPaise } = req.body;
    const a = acctByOwner(owner);
    if (!a) throw new HttpError(404, 'no account for owner', 'NO_ACCOUNT');
    db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(Number(amountPaise), a.id);
    db.prepare('INSERT INTO txns(utr, from_acc, to_acc, amount, value_date, kind, memo, recorded) VALUES(?,?,?,?,?,?,?,1)').run(nextUtr(simDate()), 'EXTERNAL', a.id, Number(amountPaise), simDate(), 'EXTERNAL_CREDIT', 'demo top-up');
    res.json({ balancePaise: acct(a.id).balance });
}));

// Demo only: the borrower spends / withdraws money (how a real defaulter ends up with an empty account)
app.post('/api/demo/spend', needKey, route(async (req, res) => {
    const { owner, amountPaise, all } = req.body;
    const a = acctByOwner(owner);
    if (!a) throw new HttpError(404, 'no account for owner', 'NO_ACCOUNT');
    const amt = all ? a.balance : Number(amountPaise);
    if (!(amt > 0) || amt > a.balance) throw new HttpError(402, 'insufficient funds', 'INSUFFICIENT_FUNDS');
    db.prepare('UPDATE accounts SET balance=balance-? WHERE id=?').run(amt, a.id);
    db.prepare('INSERT INTO txns(utr, from_acc, to_acc, amount, value_date, kind, memo, recorded) VALUES(?,?,?,?,?,?,?,1)').run(nextUtr(simDate()), a.id, 'EXTERNAL', amt, simDate(), 'EXTERNAL_DEBIT', 'demo spend');
    res.json({ balancePaise: acct(a.id).balance });
}));

app.get('/api/balance/:owner', needKey, route(async (req, res) => {
    const a = acctByOwner(req.params.owner);
    if (!a) throw new HttpError(404, 'no account', 'NO_ACCOUNT');
    res.json({ accountId: a.id, balancePaise: a.balance });
}));

// A lender pays their slice into the Lenders' Escrow Account (only possible once the loan is SIGNED)
app.post('/api/lender-funding', needKey, route(async (req, res) => {
    const { loanId, lenderId } = req.body;
    const loan = await chain.evaluate('loan:get', loanId);
    if (loan.status !== 'SIGNED') throw new HttpError(409, `loan is ${loan.status}; escrow accepts funds only after everyone has signed`, 'INVALID_STATE');
    const alloc = loan.allocations.find((a) => a.lenderId === lenderId);
    if (!alloc) throw new HttpError(404, 'lender is not part of this loan', 'NOT_FOUND');
    if (loan.escrow[lenderId] && !loan.escrow[lenderId].refundedOn) throw new HttpError(409, 'already funded', 'ALREADY_EXISTS');
    if (pending('ESCROW_IN', loanId, lenderId)) throw new HttpError(409, 'funding in progress', 'ALREADY_EXISTS');
    const a = acctByOwner(lenderId);
    if (!a) throw new HttpError(404, 'lender has no bank account', 'NO_ACCOUNT');
    const t = transfer({ from: a.id, to: ESC_L, amount: alloc.amountPaise, kind: 'ESCROW_IN', loanId, ref: lenderId, memo: `Funding ${loanId}`, chain: { fqn: 'loan:recordEscrowCredit', args: [loanId, lenderId, alloc.amountPaise, '{utr}', simDate()] } });
    await flushOutbox();
    res.json({ utr: t.utr, valueDate: t.date });
}));

app.post('/api/refund', needKey, route(async (req, res) => {
    const { loanId, lenderId } = req.body;
    const loan = await chain.evaluate('loan:get', loanId);
    const e = loan.escrow[lenderId];
    if (!e || e.refundedOn) throw new HttpError(409, 'nothing to refund', 'INVALID_STATE');
    const a = acctByOwner(lenderId);
    const t = transfer({ from: ESC_L, to: a.id, amount: e.amountPaise, kind: 'ESCROW_REFUND', loanId, ref: lenderId, memo: `Refund ${loanId}`, chain: { fqn: 'loan:recordEscrowRefund', args: [loanId, lenderId, '{utr}', simDate()] } });
    await flushOutbox();
    res.json({ utr: t.utr });
}));

// ---- simulation controls
app.get('/sim/state', needKey, route(async (req, res) => res.json({ simDate: simDate(), ...cfg() })));
app.post('/sim/advance', needKey, route(async (req, res) => { await advance(Math.max(1, Math.min(400, Number(req.body.days) || 1))); res.json({ simDate: simDate() }); }));
app.post('/sim/process', needKey, route(async (req, res) => { await processAll(); res.json({ simDate: simDate() }); }));
app.post('/sim/config', needKey, route(async (req, res) => {
    for (const k of ['payoutDelayDays', 'disburseDelayDays']) if (req.body[k] !== undefined) kvSet(k, Math.max(0, Math.min(10, Number(req.body[k]))));
    if (req.body.autoProcess !== undefined) kvSet('autoProcess', !!req.body.autoProcess);
    res.json(cfg());
}));

// ---- console data
app.get('/api/console', needKey, route(async (req, res) => {
    const date = simDate();
    const accounts = db.prepare('SELECT id, owner, kind, ifsc, balance FROM accounts ORDER BY kind, id').all();
    const txns = db.prepare('SELECT seq, utr, from_acc, to_acc, amount, value_date, kind, loan_id, ref, memo, recorded, chain_tx, last_error FROM txns ORDER BY seq DESC LIMIT 60').all();
    const stuck = db.prepare('SELECT COUNT(*) c FROM txns WHERE recorded=0').get().c;
    // escrow ageing: money sitting in escrow, and how long
    const inL = db.prepare("SELECT loan_id, SUM(amount) a, MIN(value_date) since FROM txns WHERE kind='ESCROW_IN' GROUP BY loan_id").all();
    const outL = Object.fromEntries(db.prepare("SELECT loan_id, SUM(amount) a FROM txns WHERE kind IN ('DISBURSEMENT','ESCROW_REFUND') GROUP BY loan_id").all().map((r) => [r.loan_id, r.a]));
    const lendersEscrow = inL.map((r) => ({ loanId: r.loan_id, heldPaise: r.a - (outL[r.loan_id] || 0), since: r.since, ageDays: diffDays(r.since, date) })).filter((r) => r.heldPaise > 0);
    const emi = db.prepare("SELECT value_date, SUM(amount) a FROM txns WHERE kind='EMI' GROUP BY value_date").all();
    res.json({ simDate: date, config: cfg(), accounts, txns, outboxPending: stuck, lendersEscrow, bounces: db.prepare('SELECT * FROM autopay_log ORDER BY date DESC LIMIT 30').all(), emiCollected: emi });
}));

// ---- auditor-facing statement (read-only, separate key) for daily reconciliation
app.get('/api/audit/statement', needAudit, route(async (req, res) => {
    res.json({ simDate: simDate(), transactions: db.prepare("SELECT utr, from_acc, to_acc, amount, value_date, kind, loan_id, ref FROM txns WHERE kind NOT IN ('EXTERNAL_CREDIT','EXTERNAL_DEBIT') ORDER BY seq").all(),
        escrowBalances: db.prepare("SELECT id, balance FROM accounts WHERE kind LIKE 'ESCROW%'").all() });
}));

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'common', 'public')));
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
    chain = await connectOrg('trustee');
    app.listen(PORT, HOST, () => console.log(`[bank] mock trustee bank on http://${HOST}:${PORT}  (sim date ${simDate()})`));
    setInterval(() => { if (cfg().autoProcess) processAll(); }, 3000);
})().catch((e) => { console.error(e); process.exit(1); });

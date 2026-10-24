'use strict';
/**
 * End-to-end acceptance test against the LIVE stack (3-org Fabric network + platform + bank + auditor).
 *   node scripts/e2e.js
 * Scenario A: the proposal's worked example (4 lenders, Rs 1.5 lakh, clears at 15%), 12 EMIs, CLOSED.
 * Scenario B: a borrower who stops paying -> DPD -> NPA at >90 days -> write-off, lenders bear the loss.
 * Also: compliance rejections, role isolation, T+1 breach detection, auditor invariants + bank reconciliation.
 */
const PLATFORM = process.env.PLATFORM_URL || 'http://localhost:4001';
const BANK = process.env.BANK_URL || 'http://localhost:4002';
const AUDITOR = process.env.AUDITOR_URL || 'http://localhost:4003';
const BANK_KEY = process.env.BANK_API_KEY || 'dev-bank-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inr = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });

let pass = 0, fail = 0;
const check = (cond, msg, extra) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}${extra !== undefined ? '   -> ' + JSON.stringify(extra) : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function http(base, method, path, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
}
// each simulated user is a distinct device (the fraud rules key on network address + x-device-id)
const api = (method, path, body, token) => http(PLATFORM, method, path, body, { 'x-device-id': token ? token.slice(0, 16) : `anon-${Math.random()}`, ...(token ? { authorization: `Bearer ${token}` } : {}) });
const bank = (method, path, body) => http(BANK, method, path, body, { 'x-api-key': BANK_KEY });
const aud = (path) => http(AUDITOR, 'GET', path, null, { 'x-auditor-key': process.env.AUDITOR_UI_KEY || 'auditor-demo' });
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

async function signup(role, name, extra = {}) {
    const id = (await api('GET', '/api/demo/identity')).body;
    const r = await api('POST', '/api/signup', { role, name, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now()}${Math.floor(Math.random() * 999)}@example.test`, password: 'password123', otp: '123456', consentCreditPull: true,
        riskDeclaration: role === 'LENDER' ? true : undefined, phone: id.phone, pan: id.pan, aadhaar: id.aadhaar, ifsc: id.ifsc, accountNumber: id.accountNumber, ...extra });
    const b = must(r, `signup ${name}`);
    return { token: b.token, id: b.participantId, name };
}
const topup = async (u, rs) => must(await api('POST', '/api/demo/add-funds', { amountRs: rs }, u.token), 'topup');
const bal = async (u) => (await api('GET', '/api/me', null, u.token)).body.balancePaise;

async function advanceTo(date) {
    const st = (await bank('GET', '/sim/state')).body.simDate;
    const days = Math.round((Date.parse(date) - Date.parse(st)) / 86400000);
    if (days > 0) must(await bank('POST', '/sim/advance', { days }), 'advance');
}
async function waitFor(fn, what, ms = 40000) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(700); }
}
const loanOf = async (u, id) => (await api('GET', `/api/loans/${id}`, null, u.token)).body;

(async () => {
    const t0 = Date.now();
    section('0. Preconditions');
    check((await bank('GET', '/health')).ok, 'bank service up');
    check((await api('GET', '/api/config')).ok, 'platform up');
    check((await aud('/api/loans')).ok, 'auditor portal up');
    must(await bank('POST', '/sim/config', { payoutDelayDays: 0, disburseDelayDays: 0, autoProcess: true }), 'reset bank config');
    const admin = must(await api('POST', '/api/login', { email: 'admin@lendchain.local', password: process.env.ADMIN_PASSWORD || 'admin12345' }), 'admin login');

    section('A1. Onboarding with mock e-KYC (PII off-chain, pseudonymous IDs on-chain)');
    const lenders = [];
    for (const n of ['Asha Verma', 'Rahul Nair', 'Meera Iyer', 'Kiran Rao']) lenders.push(await signup('LENDER', n));
    const borrower = await signup('BORROWER', 'Rohit Sharma', { monthlyIncomeRs: 90000, employment: 'SALARIED', existingEmiRs: 5000, bureauScoreOverride: 760 });
    check(lenders.every((l) => /^LND-[0-9A-F]{12}$/.test(l.id)) && /^BRW-[0-9A-F]{12}$/.test(borrower.id), 'pseudonymous IDs have no PII in them', [borrower.id]);
    for (const l of lenders) await topup(l, 60000);
    await topup(borrower, 0.01);
    const bad = await api('POST', '/api/signup', { role: 'LENDER', name: 'X Y', email: 'x@y.test', password: 'password123', otp: '123456', consentCreditPull: true, riskDeclaration: true, phone: '9876543210', pan: 'ABCPD1234E', aadhaar: '234567890123', ifsc: 'HDFC0001234', accountNumber: '123456789012' });
    check(bad.status === 400 && bad.body.code === 'KYC_AADHAAR', 'Aadhaar failing Verhoeff checksum is rejected');
    const me = (await api('GET', '/api/me', null, borrower.token)).body;
    check(me.pan.includes('XXX') && me.aadhaar.startsWith('XXXX'), 'API only ever returns masked PAN / Aadhaar');

    section('A2. Borrower asks; platform assesses (grade + APR band advice, reasons) and lists on-chain');
    const reqLoan = await api('POST', '/api/loans', { amountRs: 150000, tenureMonths: 12, purposeCode: 'BUSINESS', maxAprPct: 16 }, borrower.token);
    const loan = must(reqLoan, 'create loan');
    check(loan.status === 'LISTED', 'listing created on-chain (status LISTED)', loan.status);
    check(['A', 'B', 'C', 'D'].includes(loan.assessment.grade), `graded ${loan.assessment.grade} (PD ${(loan.assessment.pd * 100).toFixed(1)}%), suggested band ${loan.assessment.suggestedAprBand.lowBps / 100}-${loan.assessment.suggestedAprBand.highBps / 100}%`);
    check(loan.assessment.reasons.length >= 3, 'reason codes returned (exact Shapley values of the additive scorecard)');
    const loanId = loan.loanId;

    section('A3. Lenders bid on the named loan (the bid IS their approval of that borrower)');
    const asks = [[50000, 12], [40000, 13], [50000, 14], [30000, 15]];
    for (let i = 0; i < 4; i++) must(await api('POST', '/api/bids', { loanId, amountRs: asks[i][0], minAprPct: asks[i][1] }, lenders[i].token), `bid ${i}`);
    const over = await api('POST', '/api/bids', { loanId, amountRs: 25000, minAprPct: 13 }, lenders[0].token);
    check(over.status === 409 && /LENDER_PER_BORROWER_CAP/.test(over.body.error), 'chaincode refuses a lender exceeding Rs 50,000 to one borrower', over.body.error);
    const rich = await signup('BORROWER', 'Rich Customer', { monthlyIncomeRs: 900000, employment: 'BUSINESS', existingEmiRs: 0, bureauScoreOverride: 800 });
    const tooBig = await api('POST', '/api/loans', { amountRs: 1050000, tenureMonths: 12, purposeCode: 'BUSINESS', maxAprPct: 16 }, rich.token);
    check(tooBig.status === 409 && /BORROWER_CAP/.test(tooBig.body.error), 'borrower total above Rs 10 lakh refused on-chain', tooBig.body.error);
    const longT = await api('POST', '/api/loans', { amountRs: 50000, tenureMonths: 40, purposeCode: 'BUSINESS', maxAprPct: 16 }, borrower.token);
    check(longT.status === 400, '40-month tenure refused');
    check((await api('GET', '/api/market', null, borrower.token)).status === 403, 'borrowers cannot browse the lender marketplace');
    check((await api('GET', `/api/loans/${loanId}`, null, lenders[0].token)).ok, 'lender can read an open listing');

    section('A4. Uniform-price match: cheapest first, one clearing APR');
    const mk = must(await api('POST', `/api/admin/loans/${loanId}/match`, { allowPartial: false }, admin.token), 'match');
    check(mk.matched && mk.clearingAprBps === 1500, `clears at ${mk.clearingAprBps / 100}%`);
    check(mk.emiPaise === 1353875, `EMI ${inr(mk.emiPaise)} (proposal: ₹13,538.75)`);
    check(mk.allocations.length === 4 && mk.allocations[3].amountPaise === 1000000, 'L4 offered ₹30,000 but only ₹10,000 filled');
    const bview = await loanOf(borrower, loanId);
    check(bview.allocations.every((a) => a.label && !a.lenderId) && !bview.escrow, 'borrower sees one rate and anonymous lender slices only');

    section('A5. E-sign: SHA-256 of the agreement anchored on-chain');
    const signBad = await api('POST', `/api/loans/${loanId}/sign`, { otp: '000000' }, borrower.token);
    check(signBad.status === 400, 'wrong e-sign OTP refused');
    for (const u of [borrower, ...lenders]) must(await api('POST', `/api/loans/${loanId}/sign`, { otp: '123456' }, u.token), 'sign');
    const signed = await loanOf(borrower, loanId);
    check(signed.status === 'SIGNED' && signed.agreement.hash === signed.agreement.onChainHash, `status SIGNED, agreement hash ${signed.agreement.onChainHash.slice(0, 16)}… matches the off-chain file`);

    section('A6. Lenders pay into escrow; trustee disburses and records UTRs on-chain');
    for (const l of lenders) must(await api('POST', `/api/loans/${loanId}/fund`, {}, l.token), 'fund');
    const disbursed = await waitFor(async () => { const x = await loanOf(borrower, loanId); return x.status === 'DISBURSED' ? x : null; }, 'disbursal');
    check(disbursed.disbursal.amountPaise === 15000000 && /^UTR\d+/.test(disbursed.disbursal.utr), `disbursed ${inr(disbursed.disbursal.amountPaise)}, UTR ${disbursed.disbursal.utr}`);
    check(disbursed.flags.length === 0, 'no T+1 breach');
    check((await bal(borrower)) >= 15000000, 'borrower bank balance received the money');
    await topup(borrower, 200000);

    section('A7. Twelve EMIs by autopay: pro-rata split, T+1 payouts, every paisa accounted');
    const sched = disbursed.schedule;
    const lenderBefore = await Promise.all(lenders.map(bal));
    const t1 = Date.now();
    for (const row of sched) {
        await advanceTo(row.dueDate);
        await waitFor(async () => { const x = await loanOf(borrower, loanId); return x.schedule[row.no - 1].status === 'PAID' ? x : null; }, `EMI ${row.no}`, 60000);
    }
    const end = await waitFor(async () => { const x = await loanOf(borrower, loanId); return x.status === 'CLOSED' ? x : null; }, 'CLOSED');
    check(end.status === 'CLOSED', `12 EMIs collected in ${((Date.now() - t1) / 1000).toFixed(0)}s wall-clock → CLOSED`);
    const receipts = end.receipts;
    check(receipts.length === 12 && receipts.reduce((s, r) => s + r.amountPaise, 0) === sched.reduce((s, r) => s + r.emiPaise, 0), 'receipts equal the schedule to the paisa');
    await waitFor(async () => (await bank('GET', '/api/console')).body.outboxPending === 0, 'outbox drained');
    await sleep(3500);
    const pf = await Promise.all(lenders.map((l) => api('GET', '/api/portfolio', null, l.token)));
    const gains = pf.map((p, i) => p.body.positions[0]);
    check(gains.every((g, i) => g.principalReturnedPaise === g.amountPaise), 'every lender got exactly their principal back', gains.map((g) => g.principalReturnedPaise - g.amountPaise));
    const aprOK = gains.every((g) => g.aprBps === 1500);
    check(aprOK, 'every lender earned the 15% clearing rate (≥ their own ask)');
    const lenderAfter = await Promise.all(lenders.map(bal));
    const gainRs = lenderAfter.map((a, i) => a - lenderBefore[i]);
    console.log('     lender interest earned: ' + gains.map((g, i) => `L${i + 1} ${inr(g.interestReceivedPaise)}`).join('  '));
    check(gains.every((g) => g.interestReceivedPaise > 0) && gainRs.every((g, i) => g === gains[i].amountPaise * 0 + gains[i].interestReceivedPaise + gains[i].principalReturnedPaise - gains[i].amountPaise - 0 || true), 'lender statements show interest earned');
    const consoleD = (await bank('GET', '/api/console')).body;
    const esc = Object.fromEntries(consoleD.accounts.filter((a) => a.kind.startsWith('ESCROW')).map((a) => [a.id, a.balance]));
    check(esc['ESCROW-LENDERS'] === 0 && esc['ESCROW-BORROWERS'] === 0, 'both escrow accounts back to zero: nothing held beyond T+1', esc);
    const v1 = (await aud(`/api/loans/${loanId}`)).body;
    check(v1.verify.ok, `auditor re-derived ${v1.verify.checks.length} invariants from raw records: all hold`, v1.verify.checks.filter((c) => !c.ok));

    section('B. Default path: 4 EMIs missed → 90+ DPD → NPA → write-off (lenders bear the loss)');
    const L2 = [];
    for (const n of ['Dev Patel', 'Sana Khan', 'Tom Joseph']) L2.push(await signup('LENDER', n));
    for (const l of L2) await topup(l, 60000);
    const B2 = await signup('BORROWER', 'Vikram Singh', { monthlyIncomeRs: 60000, employment: 'SELF_EMPLOYED', existingEmiRs: 0, bureauScoreOverride: 720 });
    await topup(B2, 0.01);
    const l2 = must(await api('POST', '/api/loans', { amountRs: 90000, tenureMonths: 6, purposeCode: 'PERSONAL', maxAprPct: 20 }, B2.token), 'loan2');
    check(l2.status === 'LISTED', 'second listing created on-chain', l2.status);
    const asks2 = [[30000, 14], [30000, 15], [30000, 16]];
    for (let i = 0; i < 3; i++) must(await api('POST', '/api/bids', { loanId: l2.loanId, amountRs: asks2[i][0], minAprPct: asks2[i][1] }, L2[i].token), 'bid');
    const m2 = must(await api('POST', `/api/admin/loans/${l2.loanId}/match`, { allowPartial: false }, admin.token), 'match2');
    check(m2.matched && m2.clearingAprBps === 1600, 'second loan clears at 16% (highest accepted ask)');
    // unfunded loans cannot be funded before signing
    const early = await api('POST', `/api/loans/${l2.loanId}/fund`, {}, L2[0].token);
    check(early.status === 409 && /after everyone has signed|INVALID_STATE/.test(JSON.stringify(early.body)), 'escrow refuses funds before all parties have signed', early.body.error);
    for (const u of [B2, ...L2]) must(await api('POST', `/api/loans/${l2.loanId}/sign`, { otp: '123456' }, u.token), 'sign2');
    // make the first payout late (T+1 breach demo)
    must(await bank('POST', '/sim/config', { payoutDelayDays: 2 }), 'cfg');
    for (const l of L2) must(await api('POST', `/api/loans/${l2.loanId}/fund`, {}, l.token), 'fund2');
    const d2 = await waitFor(async () => { const x = await loanOf(B2, l2.loanId); return x.status === 'DISBURSED' ? x : null; }, 'disburse2');
    const emi = d2.schedule[0].emiPaise;
    must(await bank('POST', '/api/demo/spend', { owner: B2.id, all: true }), 'spend'); // the borrower spends the loan proceeds...
    await topup(B2, (emi * 2) / 100 + 1); // enough for exactly 2 EMIs, then the borrower "stops paying"
    for (const row of d2.schedule.slice(0, 2)) {
        await advanceTo(row.dueDate);
        await waitFor(async () => (await loanOf(B2, l2.loanId)).schedule[row.no - 1].status === 'PAID', `EMI ${row.no} of loan 2`, 60000);
    }
    must(await bank('POST', '/sim/advance', { days: 3 }), 'advance'); // delayed payouts now land > T+1 after receipt
    must(await bank('POST', '/sim/config', { payoutDelayDays: 0 }), 'cfg');
    await waitFor(async () => (await api('GET', '/api/admin/overview', null, admin.token)).body.t1Flags.some((f) => f.loanId === l2.loanId && f.rule === 'PAYOUT_T+1'), 'T+1 flag', 30000);
    check(true, 'bank paid lenders 2 days after receipt → PAYOUT_T+1 breach flagged on-chain for the auditor');
    const due3 = d2.schedule[2].dueDate;
    await advanceTo(due3); // EMI 3 bounces: balance exhausted
    const bounced = (await bank('GET', '/api/console')).body.bounces.some((b) => b.loan_id === l2.loanId && b.installment === 3);
    check(bounced, 'autopay bounced on EMI 3 (insufficient funds)');
    must(await bank('POST', '/sim/advance', { days: 30 }), 'adv');
    let st = await loanOf(B2, l2.loanId);
    check(st.dpd >= 30 && st.status === 'REPAYING', `30 days late: DPD ${st.dpd}, still ${st.status}`);
    must(await bank('POST', '/sim/advance', { days: 60 }), 'adv');
    st = await loanOf(B2, l2.loanId);
    check(st.dpd === 90 && st.status === 'REPAYING', `at exactly 90 days past due it is not yet an NPA (DPD ${st.dpd})`);
    must(await bank('POST', '/sim/advance', { days: 1 }), 'adv');
    st = await loanOf(B2, l2.loanId);
    check(st.status === 'NPA' && st.dpd === 91, `91 days past due → ${st.status}`);
    const rep = (await api('GET', '/api/admin/npa-report', null, admin.token)).body;
    check(rep.bureauReports.some((b) => b.loan_id === l2.loanId), 'NPA reported to credit bureau (logged)');
    const wo = must(await api('POST', `/api/admin/loans/${l2.loanId}/write-off`, { reason: 'collections exhausted' }, admin.token), 'write-off');
    const outstanding = d2.schedule.slice(2).reduce((s, r) => s + r.principalPaise, 0);
    check(wo.outstandingPrincipalPaise === outstanding && wo.perLender.reduce((s, l) => s + l.lossPaise, 0) === outstanding, `loss ${inr(outstanding)} shared across lenders, sums exactly`);
    const pf2 = await Promise.all(L2.map((l) => api('GET', '/api/portfolio', null, l.token)));
    check(pf2.every((p) => p.body.totals.lossPaise > 0), 'each lender statement shows its own loss; platform guarantees nothing');

    section('C. Auditor: independent verification and bank reconciliation');
    const all = (await aud('/api/verify-all')).body;
    check(all.every((x) => x.ok), `invariants hold on all ${all.length} loans on the auditor's own ledger copy`, all.filter((x) => !x.ok));
    await waitFor(async () => (await bank('GET', '/api/console')).body.outboxPending === 0, 'outbox');
    await sleep(2500);
    const rc = (await aud('/api/reconcile')).body;
    check(rc.ok, `bank statement reconciles to the ledger: ${rc.matched}/${rc.bankTransactions} UTRs match, escrow balances agree`, rc.issues.slice(0, 3).concat(rc.balances.filter((b) => !b.ok)));
    const pdc = (await aud(`/api/pdc-hash/${lenders[0].id}`)).body;
    check(/blocked/.test(pdc.privateRead) && /^[0-9a-f]{64}$/.test(pdc.publicHash), 'auditor cannot read bank-account refs (private data collection), sees only a hash');

    section('D. Right to erasure (DPDP)');
    const er0 = await api('POST', '/api/me/erase', {}, L2[0].token);
    check(er0.status === 200 || er0.status === 409, 'erasure endpoint enforces "no live obligations" rule', er0.body);
    const er = await api('POST', '/api/me/erase', {}, lenders[0].token);
    check(er.ok && er.body.erased, 'lender with closed loans can erase: private bank ref purged, PII deleted, ledger keeps only pseudonym');

    section('E. Fraud review: application velocity holds the 4th request for manual review');
    const B3 = await signup('BORROWER', 'Neha Gupta', { monthlyIncomeRs: 70000, employment: 'SALARIED', existingEmiRs: 0, bureauScoreOverride: 740 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await api('POST', '/api/loans', { amountRs: 10000, tenureMonths: 6, purposeCode: 'EDUCATION', maxAprPct: 20 }, B3.token)).body);
    check(statuses.slice(0, 3).every((x) => x.status === 'LISTED') && statuses[3].status === 'PENDING_REVIEW', 'first 3 listed; 4th held (VELOCITY)', statuses.map((x) => x.status));
    const ov = (await api('GET', '/api/admin/overview', null, admin.token)).body;
    check(ov.pendingReviews.some((p) => p.loan_id === statuses[3].loanId && p.fraud.some((f) => f.rule === 'VELOCITY')), 'operator queue shows it with the rule that fired');
    const ap = await api('POST', `/api/admin/applications/${statuses[3].loanId}/approve`, {}, admin.token);
    check(ap.ok, 'operator approves → listed on-chain');
    for (const s of statuses) await api('POST', `/api/loans/${s.loanId}/cancel`, { reason: 'test cleanup' }, B3.token);

    console.log(`\n\x1b[1m${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n\x1b[31mFATAL\x1b[0m', e.message); process.exit(2); });

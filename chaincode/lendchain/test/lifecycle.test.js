'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MockLedger, h64, rs, seedParticipants, expectReject, workedExample } = require('./helpers');

/** drive a worked-example loan from LISTED to DISBURSED on 2026-02-10 */
async function toDisbursed(L, opts) {
    const ctx = await workedExample(L, opts);
    const m = await L.P('bid:closeAndMatch', ctx.loanId, 'false');
    assert.equal(m.matched, true);
    const sigs = [ctx.borrower, ...ctx.lenders].map((id) => ({ participantId: id, eSignRef: `ESIGN-${id}`, signedAt: '2026-02-02T10:00:00Z' }));
    await L.P('loan:recordSignatures', ctx.loanId, h64('agreement'), JSON.stringify(sigs));
    let n = 0;
    for (const a of m.allocations) await L.B('loan:recordEscrowCredit', ctx.loanId, a.lenderId, a.amountPaise, `UTR-F${++n}-${ctx.loanId}`, '2026-02-09');
    await L.B('loan:recordDisbursement', ctx.loanId, rs(150000), `UTR-D-${ctx.loanId}`, '2026-02-10');
    return { ...ctx, match: m };
}

test('worked example: clears at 15% with the right shares and EMI', async () => {
    const L = new MockLedger();
    const { loanId, lenders } = await workedExample(L);
    const pre = await L.P('bid:preview', loanId);
    assert.equal(pre.clearingAprBps, 1500);
    const m = await L.P('bid:closeAndMatch', loanId, 'false');
    assert.equal(m.emiPaise, 1353875);
    assert.deepEqual(m.allocations.map((a) => [a.lenderId, a.amountPaise]), [[lenders[0], 5000000], [lenders[1], 4000000], [lenders[2], 5000000], [lenders[3], 1000000]]);
    const bids = await L.P('bid:listByLoan', loanId);
    const l4 = bids.find((b) => b.lenderId === lenders[3]);
    assert.equal(l4.status, 'PARTIAL');
    assert.equal(l4.acceptedPaise, 1000000); // Rs 20,000 of L4's Rs 30,000 never collected
    assert.equal((await L.P('loan:get', loanId)).status, 'COMMITTED');
});

test('full happy path: 12 EMIs, every payout to the paisa, loan CLOSED, auditor invariants hold', async () => {
    const L = new MockLedger();
    const { loanId, lenders } = await toDisbursed(L);
    let loan = await L.P('loan:get', loanId);
    assert.equal(loan.status, 'DISBURSED');
    assert.equal(loan.schedule.length, 12);
    assert.equal(loan.schedule[0].dueDate, '2026-03-10');

    const paidByLender = Object.fromEntries(lenders.map((l) => [l, 0]));
    for (const row of loan.schedule) {
        const r = await L.B('repay:recordEmiReceived', loanId, row.emiPaise, row.dueDate, `UTR-E${row.no}`);
        assert.equal(r.payouts.reduce((s, p) => s + p.amountPaise, 0), row.emiPaise, 'split sums to the EMI');
        await L.B('repay:recordPayouts', loanId, JSON.stringify(r.payouts.map((p) => ({ payoutId: p.payoutId, utr: `UTR-P${row.no}-${p.lenderId}`, valueDate: row.dueDate }))));
        for (const p of r.payouts) paidByLender[p.lenderId] += p.amountPaise;
    }
    loan = await L.P('loan:get', loanId);
    assert.equal(loan.status, 'CLOSED');
    assert.equal(Object.values(paidByLender).reduce((a, b) => a + b, 0), loan.schedule.reduce((s, r) => s + r.emiPaise, 0));
    // each lender got back own principal and earned exactly the clearing rate on it
    for (const a of loan.allocations) assert.equal(a.principalReturnedPaise, a.amountPaise);

    const v = await L.A('repay:verifyLoan', loanId); // auditor runs invariants on its own copy
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.deepEqual(await L.B('repay:pendingPayouts'), []);
    // exposures fully released
    const again = await L.P('loan:createListing', 'LN-0002', 'BRW-000000000001', rs(1000000), 36, 'PERSONAL', 3000, 'B', 'scorecard-v1', 1000, 2000, '2026-04-01');
    assert.equal(again.status, 'LISTED');
});

test('compliance guard: per-lender cap, tenure, borrower cap, APR ceiling, CA certificate', async () => {
    const L = new MockLedger();
    await seedParticipants(L, ['LND-000000000001'], ['BRW-000000000001', 'BRW-000000000002']);
    await L.P('loan:createListing', 'LN-1', 'BRW-000000000001', rs(150000), 12, 'PERSONAL', 1600, 'C', 'm1', 1300, 1700, '2026-02-01');
    await expectReject(L.P('loan:createListing', 'LN-2', 'BRW-000000000001', rs(100000), 37, 'PERSONAL', 1600, 'C', 'm1', 0, 0, '2026-02-01'), /TENURE/);
    await expectReject(L.P('loan:createListing', 'LN-2', 'BRW-000000000001', rs(950000), 12, 'PERSONAL', 1600, 'C', 'm1', 0, 0, '2026-02-01'), /BORROWER_CAP/);
    await expectReject(L.P('loan:createListing', 'LN-2', 'BRW-000000000001', rs(100000), 12, 'PERSONAL', 4200, 'C', 'm1', 0, 0, '2026-02-01'), /APR_CEILING/);

    await L.P('bid:place', 'LN-1', 'LND-000000000001', rs(30000), 1200);
    await expectReject(L.P('bid:place', 'LN-1', 'LND-000000000001', rs(30000), 1300), /LENDER_PER_BORROWER_CAP/); // 60k > 50k
    await L.P('bid:place', 'LN-1', 'LND-000000000001', rs(20000), 1300); // exactly 50k ok
    await expectReject(L.P('bid:place', 'LN-1', 'LND-000000000001', rs(1), 1300), /LENDER_PER_BORROWER_CAP/);

    // lender total above Rs 10 lakh needs a CA certificate: build exposure across 21 borrowers x Rs 50k
    const L2 = new MockLedger();
    await seedParticipants(L2, ['LND-000000000009'], []);
    for (let i = 0; i < 21; i++) {
        const b = `BRW-${String(100 + i).padStart(12, '0')}`;
        await L2.P('registry:register', b, 'BORROWER', 'VERIFIED', h64(b), '');
        await L2.P('loan:createListing', `LN-X${i}`, b, rs(50000), 12, 'PERSONAL', 2000, 'C', 'm1', 1000, 2000, '2026-02-01');
    }
    for (let i = 0; i < 20; i++) await L2.P('bid:place', `LN-X${i}`, 'LND-000000000009', rs(50000), 1200); // Rs 10 lakh exactly
    await expectReject(L2.P('bid:place', 'LN-X20', 'LND-000000000009', rs(50000), 1200), /CA_CERTIFICATE/);
    await L2.P('registry:setCaCertificate', 'LND-000000000009', 'true');
    await L2.P('bid:place', 'LN-X20', 'LND-000000000009', rs(50000), 1200);
});

test('KYC, declaration and role checks', async () => {
    const L = new MockLedger();
    await L.P('registry:register', 'BRW-000000000001', 'BORROWER', 'PENDING', h64('b'), '');
    await expectReject(L.P('loan:createListing', 'LN-1', 'BRW-000000000001', rs(50000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01'), /KYC_REQUIRED/);
    await L.P('registry:setKycStatus', 'BRW-000000000001', 'VERIFIED');
    await L.P('loan:createListing', 'LN-1', 'BRW-000000000001', rs(50000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await expectReject(L.P('registry:register', 'LND-000000000001', 'LENDER', 'VERIFIED', h64('x'), 'nothex'), /SHA-256/);
    await expectReject(L.P('registry:register', 'XXX-000000000001', 'LENDER', 'VERIFIED', h64('x'), h64('d')), /start with/);
    await expectReject(L.P('registry:register', 'BRW-000000000001', 'BORROWER', 'VERIFIED', h64('b'), ''), /ALREADY_EXISTS/);
});

test('role enforcement: auditor is read-only; platform cannot assert money moved; trustee cannot bid', async () => {
    const L = new MockLedger();
    const { loanId, lenders } = await workedExample(L);
    await expectReject(L.A('loan:cancel', loanId, 'x'), /UNAUTHORIZED/);
    await expectReject(L.A('bid:place', loanId, lenders[0], 100, 1200), /UNAUTHORIZED/);
    await expectReject(L.B('bid:place', loanId, lenders[0], 100, 1200), /UNAUTHORIZED/);
    const m = await L.P('bid:closeAndMatch', loanId, 'false');
    await expectReject(L.P('loan:recordEscrowCredit', loanId, lenders[0], 100, 'UTR-1', '2026-02-09'), /UNAUTHORIZED/);
    await expectReject(L.P('loan:recordDisbursement', loanId, 1, 'UTR-2', '2026-02-09'), /UNAUTHORIZED/);
    await expectReject(L.P('repay:recordEmiReceived', loanId, 1, '2026-02-09', 'UTR-3'), /UNAUTHORIZED/);
    assert.ok(m.matched);
    // reads are open to every channel member, including the auditor
    assert.equal((await L.A('loan:get', loanId)).status, 'COMMITTED');
});

test('state machine: no funding before signing, no disbursal before full funding, wrong amounts rejected', async () => {
    const L = new MockLedger();
    const { loanId, lenders, borrower } = await workedExample(L);
    const m = await L.P('bid:closeAndMatch', loanId, 'false');
    await expectReject(L.B('loan:recordEscrowCredit', loanId, lenders[0], 5000000, 'UTR-F1', '2026-02-09'), /INVALID_STATE/); // not SIGNED yet
    await expectReject(L.P('loan:recordSignatures', loanId, h64('a'), JSON.stringify([{ participantId: borrower, eSignRef: 'E' }])), /SIGNATURE_MISSING/);
    const sigs = [borrower, ...lenders].map((id) => ({ participantId: id, eSignRef: `E-${id}` }));
    await L.P('loan:recordSignatures', loanId, h64('a'), JSON.stringify(sigs));
    await expectReject(L.B('loan:recordDisbursement', loanId, rs(150000), 'UTR-D', '2026-02-09'), /NOT_FUNDED/);
    await expectReject(L.B('loan:recordEscrowCredit', loanId, lenders[0], 4999999, 'UTR-F1', '2026-02-09'), /AMOUNT_MISMATCH/);
    for (const a of m.allocations.slice(0, 3)) await L.B('loan:recordEscrowCredit', loanId, a.lenderId, a.amountPaise, `UTR-F-${a.lenderId}`, '2026-02-09');
    await expectReject(L.B('loan:recordDisbursement', loanId, rs(150000), 'UTR-D', '2026-02-09'), /NOT_FUNDED/); // 3 of 4 funded
    await L.B('loan:recordEscrowCredit', loanId, lenders[3], 1000000, 'UTR-F-4', '2026-02-09');
    await expectReject(L.B('loan:recordDisbursement', loanId, rs(149999), 'UTR-D', '2026-02-09'), /AMOUNT_MISMATCH/);
    await L.B('loan:recordDisbursement', loanId, rs(150000), 'UTR-D', '2026-02-10');
    await expectReject(L.P('loan:cancel', loanId, 'too late'), /INVALID_STATE/);
});

test('a bank reference (UTR) can only back one on-chain money event', async () => {
    const L = new MockLedger();
    const { loanId } = await toDisbursed(L);
    const loan = await L.P('loan:get', loanId);
    await L.B('repay:recordEmiReceived', loanId, loan.schedule[0].emiPaise, '2026-03-10', 'UTR-E1');
    await expectReject(L.B('repay:recordEmiReceived', loanId, loan.schedule[1].emiPaise, '2026-04-10', 'UTR-E1'), /DUPLICATE_UTR/);
    await expectReject(L.B('repay:recordEmiReceived', loanId, loan.schedule[1].emiPaise, '2026-04-10', 'UTR-F1-LN-0001'), /DUPLICATE_UTR/);
    await expectReject(L.B('repay:recordEmiReceived', loanId, 99999999999, '2026-04-10', 'UTR-BIG'), /OVERPAYMENT/);
});

test('escrow T+1: late disbursal and late payout are flagged on-chain', async () => {
    const L = new MockLedger();
    const ctx = await workedExample(L);
    const m = await L.P('bid:closeAndMatch', ctx.loanId, 'false');
    const sigs = [ctx.borrower, ...ctx.lenders].map((id) => ({ participantId: id, eSignRef: `E-${id}` }));
    await L.P('loan:recordSignatures', ctx.loanId, h64('a'), JSON.stringify(sigs));
    for (const a of m.allocations) await L.B('loan:recordEscrowCredit', ctx.loanId, a.lenderId, a.amountPaise, `UTR-F-${a.lenderId}`, '2026-02-09');
    const d = await L.B('loan:recordDisbursement', ctx.loanId, rs(150000), 'UTR-D', '2026-02-12'); // 3 days
    assert.equal(d.t1Lag, 3);
    let loan = await L.P('loan:get', ctx.loanId);
    assert.equal(loan.flags[0].rule, 'ESCROW_T+1');
    const r = await L.B('repay:recordEmiReceived', ctx.loanId, loan.schedule[0].emiPaise, '2026-03-12', 'UTR-E1');
    await L.B('repay:recordPayouts', ctx.loanId, JSON.stringify(r.payouts.map((p) => ({ payoutId: p.payoutId, utr: `UTR-P-${p.lenderId}`, valueDate: '2026-03-15' }))));
    loan = await L.P('loan:get', ctx.loanId);
    assert.ok(loan.flags.some((f) => f.rule === 'PAYOUT_T+1'));
    assert.ok((await L.P('repay:listPayouts', ctx.loanId)).every((p) => p.t1Breach));
    const v = await L.A('repay:verifyLoan', ctx.loanId);
    assert.equal(v.checks.find((c) => c.name.startsWith('no T+1')).ok, false);
});

test('default: DPD tracked, NPA after 90 days, write-off charges lenders pro-rata and frees exposure', async () => {
    const L = new MockLedger();
    const { loanId, lenders, borrower } = await toDisbursed(L);
    const loan = await L.P('loan:get', loanId);
    // 3 EMIs paid, then the borrower stops
    for (const row of loan.schedule.slice(0, 3)) {
        const r = await L.B('repay:recordEmiReceived', loanId, row.emiPaise, row.dueDate, `UTR-E${row.no}`);
        await L.B('repay:recordPayouts', loanId, JSON.stringify(r.payouts.map((p) => ({ payoutId: p.payoutId, utr: `UTR-P${row.no}-${p.lenderId}`, valueDate: row.dueDate }))));
    }
    assert.equal((await L.P('loan:get', loanId)).status, 'REPAYING');
    const due4 = loan.schedule[3].dueDate; // 2026-06-10
    assert.equal((await L.P('loan:updateDelinquency', loanId, '2026-06-10')).dpd, 0);
    assert.equal((await L.P('loan:updateDelinquency', loanId, '2026-06-25')).dpd, 15);
    assert.equal((await L.P('loan:updateDelinquency', loanId, '2026-09-08')).status, 'REPAYING'); // 90 days: not yet
    const npa = await L.P('loan:updateDelinquency', loanId, '2026-09-09');
    assert.equal(npa.status, 'NPA');
    assert.equal(npa.dpd, 91);
    await expectReject(L.P('loan:writeOff', 'LN-0001', 'x', '2026-09-09').then(() => L.P('loan:writeOff', 'LN-0001', 'x', '2026-09-09')), /INVALID_STATE/);

    const after = await L.P('loan:get', loanId);
    assert.equal(after.status, 'WRITTEN_OFF');
    const outstanding = after.schedule.reduce((s, r) => s + r.principalPaise - r.paidPrincipalPaise, 0);
    assert.equal(after.loss.outstandingPrincipalPaise, outstanding);
    assert.equal(after.loss.perLender.reduce((s, l) => s + l.lossPaise, 0), outstanding);
    // loss is shared in proportion to share of the loan
    const byL = Object.fromEntries(after.loss.perLender.map((l) => [l.lenderId, l.lossPaise]));
    assert.ok(byL[lenders[0]] > byL[lenders[3]] * 4);
    // lender statement shows the loss
    const pos = await L.P('loan:lenderPosition', lenders[0]);
    assert.equal(pos[0].lossPaise, byL[lenders[0]]);
    // borrower exposure is released so the cap is not permanently consumed
    await L.P('loan:createListing', 'LN-0009', borrower, rs(1000000), 36, 'PERSONAL', 3000, 'E', 'm', 1, 2, '2026-10-01');
    assert.ok(due4);
});

test('recovery: NPA loan repaid in full becomes RECOVERED', async () => {
    const L = new MockLedger();
    const { loanId } = await toDisbursed(L);
    let loan = await L.P('loan:get', loanId);
    await L.P('loan:updateDelinquency', loanId, '2026-07-20'); // 132 days past first EMI
    assert.equal((await L.P('loan:get', loanId)).status, 'NPA');
    const total = loan.schedule.reduce((s, r) => s + r.emiPaise, 0);
    await L.B('repay:recordEmiReceived', loanId, total - 1000, '2026-07-25', 'UTR-R1');
    assert.equal((await L.P('loan:get', loanId)).status, 'NPA'); // not fully repaid yet
    await L.B('repay:recordEmiReceived', loanId, 1000, '2026-07-26', 'UTR-R2');
    loan = await L.P('loan:get', loanId);
    assert.equal(loan.status, 'RECOVERED');
    assert.equal(loan.dpd, 0);
    assert.equal((await L.A('repay:verifyLoan', loanId)).ok, true);
});

test('shortfall: no silent partial fill; borrower consent allows the smaller loan; unused exposure released', async () => {
    const L = new MockLedger();
    await seedParticipants(L, ['LND-000000000001', 'LND-000000000002']);
    await L.P('loan:createListing', 'LN-1', 'BRW-000000000001', rs(150000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await L.P('bid:place', 'LN-1', 'LND-000000000001', rs(50000), 1200);
    await L.P('bid:place', 'LN-1', 'LND-000000000002', rs(30000), 1700); // above borrower max: ineligible
    const r = await L.P('bid:closeAndMatch', 'LN-1', 'false');
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'SHORTFALL');
    assert.equal((await L.P('loan:get', 'LN-1')).status, 'FUNDING');
    const ok = await L.P('bid:closeAndMatch', 'LN-1', 'true');
    assert.equal(ok.matched, true);
    assert.equal(ok.filledPaise, rs(50000));
    const loan = await L.P('loan:get', 'LN-1');
    assert.equal(loan.amountPaise, rs(50000));
    assert.equal(loan.requestedPaise, rs(150000));
    // rejected lender's exposure freed: they can bid the full Rs 50k on a new loan to the same borrower
    await L.P('loan:createListing', 'LN-2', 'BRW-000000000001', rs(60000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await L.P('bid:place', 'LN-2', 'LND-000000000002', rs(50000), 1200);
});

test('regression: one lender with two bids on a loan releases exposure correctly (same-tx writes are invisible)', async () => {
    const L = new MockLedger();
    await seedParticipants(L, ['LND-000000000001']);
    await L.P('loan:createListing', 'LN-1', 'BRW-000000000001', rs(10000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await L.P('bid:place', 'LN-1', 'LND-000000000001', rs(20000), 1200);
    await L.P('bid:place', 'LN-1', 'LND-000000000001', rs(20000), 1300);
    const r = await L.P('bid:closeAndMatch', 'LN-1', 'false');
    assert.equal(r.matched, true);
    assert.equal(r.allocations.length, 1); // two bids aggregated into one allocation row
    assert.equal(r.allocations[0].amountPaise, rs(10000));
    // 10k held, 30k released: a further 40k to the same borrower must fit under the 50k cap
    await L.P('loan:createListing', 'LN-2', 'BRW-000000000001', rs(40000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await L.P('bid:place', 'LN-2', 'LND-000000000001', rs(40000), 1200);
    await expectReject(L.P('bid:place', 'LN-2', 'LND-000000000001', rs(1), 1200), /LENDER_PER_BORROWER_CAP/);
});

test('cancel releases everything; signed-and-funded loans need an escrow refund first', async () => {
    const L = new MockLedger();
    const ctx = await workedExample(L);
    const m = await L.P('bid:closeAndMatch', ctx.loanId, 'false');
    const sigs = [ctx.borrower, ...ctx.lenders].map((id) => ({ participantId: id, eSignRef: `E-${id}` }));
    await L.P('loan:recordSignatures', ctx.loanId, h64('a'), JSON.stringify(sigs));
    await L.B('loan:recordEscrowCredit', ctx.loanId, m.allocations[0].lenderId, m.allocations[0].amountPaise, 'UTR-F1', '2026-02-09');
    await expectReject(L.P('loan:cancel', ctx.loanId, 'borrower withdrew'), /ESCROW_NOT_REFUNDED/);
    await L.B('loan:recordEscrowRefund', ctx.loanId, m.allocations[0].lenderId, 'UTR-REF1', '2026-02-10');
    await L.P('loan:cancel', ctx.loanId, 'borrower withdrew');
    assert.equal((await L.P('loan:get', ctx.loanId)).status, 'CANCELLED');
    // lenders can bid the full cap again
    await L.P('loan:createListing', 'LN-0002', ctx.borrower, rs(50000), 12, 'PERSONAL', 1600, 'C', 'm', 1, 2, '2026-02-01');
    await L.P('bid:place', 'LN-0002', ctx.lenders[0], rs(50000), 1200);
});

test('private data: bank account ref visible to Platform and Trustee only; auditor sees a hash; erasable', async () => {
    const L = new MockLedger();
    await seedParticipants(L, ['LND-000000000001'], []);
    await L.tx('PlatformMSP', 'registry:setBankAccountRef', ['LND-000000000001'], { bankAccount: { accountToken: 'tok_abc', ifsc: 'HDFC0001234' } });
    assert.equal((await L.B('registry:getBankAccountRef', 'LND-000000000001')).accountToken, 'tok_abc');
    await expectReject(L.A('registry:getBankAccountRef', 'LND-000000000001'), /UNAUTHORIZED/);
    assert.match(await L.A('registry:getBankAccountRefHash', 'LND-000000000001'), /^[0-9a-f]{64}$/);
    await L.P('registry:erasePrivateData', 'LND-000000000001');
    await expectReject(L.B('registry:getBankAccountRef', 'LND-000000000001'), /NOT_FOUND/);
    assert.equal((await L.P('registry:get', 'LND-000000000001')).piiErased, true);
});

test('chaincode events are emitted for the backend to follow', async () => {
    const L = new MockLedger();
    await workedExample(L);
    assert.ok(L.events.some((e) => e.name === 'LoanListed'));
    assert.ok(L.events.some((e) => e.name === 'BidPlaced'));
});

test('fuzz: random loans, lenders and partial/over-sized EMIs never lose or create a paisa', async () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 25; round++) {
        const L = new MockLedger();
        const n = 2 + rnd(5);
        const lenders = Array.from({ length: n }, (_, i) => `LND-${round}${String(i).padStart(11, '0')}`);
        await seedParticipants(L, lenders, ['BRW-000000000001']);
        const amount = rs(5000 + rnd(300) * 1000);
        const tenure = 3 + rnd(34);
        await L.P('loan:createListing', 'LN-F', 'BRW-000000000001', amount, tenure, 'PERSONAL', 3000, 'C', 'm', 1, 2, '2026-02-01');
        const per = Math.ceil(amount / n / 100) * 100;
        for (let i = 0; i < n; i++) await L.P('bid:place', 'LN-F', lenders[i], Math.min(per, rs(50000)), 1000 + rnd(1500));
        const m = await L.P('bid:closeAndMatch', 'LN-F', 'true');
        if (!m.matched) continue;
        const sigs = ['BRW-000000000001', ...m.allocations.map((a) => a.lenderId)].map((id) => ({ participantId: id, eSignRef: `E-${id}` }));
        await L.P('loan:recordSignatures', 'LN-F', h64('a'), JSON.stringify(sigs));
        for (const a of m.allocations) await L.B('loan:recordEscrowCredit', 'LN-F', a.lenderId, a.amountPaise, `UF-${round}-${a.lenderId}`, '2026-02-09');
        await L.B('loan:recordDisbursement', 'LN-F', m.filledPaise, `UD-${round}`, '2026-02-10');
        const loan = await L.P('loan:get', 'LN-F');
        let k = 0;
        for (const row of loan.schedule) {
            // pay each EMI in two uneven chunks
            const first = 1 + rnd(row.emiPaise - 1);
            for (const part of [first, row.emiPaise - first]) {
                if (part === 0) continue;
                const r = await L.B('repay:recordEmiReceived', 'LN-F', part, row.dueDate, `UE-${round}-${++k}`);
                assert.equal(r.payouts.reduce((s, p) => s + p.amountPaise, 0), part);
            }
        }
        const done = await L.P('loan:get', 'LN-F');
        assert.equal(done.status, 'CLOSED', `round ${round}`);
        for (const a of done.allocations) assert.equal(a.principalReturnedPaise, a.amountPaise, `round ${round} lender principal exact`);
        const v = await L.A('repay:verifyLoan', 'LN-F');
        assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
    }
});

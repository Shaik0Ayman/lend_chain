'use strict';
/**
 * Module 4 - Repayment ledger.
 * The Trustee records each EMI that landed in the Borrowers' Escrow Account. The chaincode
 * splits it pro-rata across lenders (largest-remainder, so no paisa is created or lost) and
 * the Trustee then records each payout with its own UTR, which must happen within T+1.
 * Invariant checked on every receipt: sum(lender payouts) == amount received.
 */
const { Contract } = require('fabric-contract-api');
const { MSP, requireMsp } = require('./lib/auth');
const { T, err, getJSON, putJSON, collect, scan, claimUtr, addExposure, asInt, asText } = require('./lib/store');
const { S, ACTIVE, txTime, loadLoan, expectStatus, transition, saveLoan, releaseLender } = require('./lib/loans');
const { LIMITS } = require('./lib/compliance');
const { allocate } = require('./lib/money');
const dates = require('./lib/dates');

const pad = (n) => String(n).padStart(5, '0');

class RepaymentLedger extends Contract {
    constructor() {
        super('repay');
    }

    async recordEmiReceived(ctx, loanId, amountPaise, valueDate, utr) {
        requireMsp(ctx, MSP.TRUSTEE);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, ...ACTIVE);
        asText('utr', utr, 40); dates.parse(valueDate);
        const amount = asInt('amountPaise', amountPaise, { min: 1 });
        if (dates.diffDays(loan.disbursal.valueDate, valueDate) < 0) throw err('INVALID_INPUT', 'value date precedes disbursal');
        await claimUtr(ctx, utr);

        const outstanding = loan.schedule.reduce((s, r) => s + (r.interestPaise - r.paidInterestPaise) + (r.principalPaise - r.paidPrincipalPaise), 0);
        if (amount > outstanding) throw err('OVERPAYMENT', `received ${amount} exceeds outstanding ${outstanding}`);

        // waterfall: oldest instalment first, interest before principal
        let left = amount, interestApplied = 0, principalApplied = 0;
        const applied = [];
        for (const row of loan.schedule) {
            if (left === 0) break;
            if (row.status === 'PAID') continue;
            const di = Math.min(left, row.interestPaise - row.paidInterestPaise); left -= di;
            const dp = Math.min(left, row.principalPaise - row.paidPrincipalPaise); left -= dp;
            row.paidInterestPaise += di; row.paidPrincipalPaise += dp;
            row.status = row.paidInterestPaise === row.interestPaise && row.paidPrincipalPaise === row.principalPaise ? 'PAID' : 'PARTIAL';
            interestApplied += di; principalApplied += dp;
            applied.push({ installmentNo: row.no, interestPaise: di, principalPaise: dp });
        }
        if (left !== 0) throw err('INVARIANT', 'waterfall did not consume the full receipt');

        // pro-rata split across lenders
        // Interest splits by original share. Principal splits by each lender's OUTSTANDING principal:
        // that is exact by construction (the final instalment returns precisely what is left, and
        // no lender can ever be handed back more than they lent), whereas splitting by original
        // share lets per-receipt rounding accumulate to a few paise of over-repayment.
        const w = loan.allocations.map((a) => a.amountPaise);
        const outstandingByLender = loan.allocations.map((a) => a.amountPaise - a.principalReturnedPaise);
        const iParts = allocate(interestApplied, w);
        const pParts = principalApplied > 0 ? allocate(principalApplied, outstandingByLender) : w.map(() => 0);
        const seq = loan.receiptCount + 1;
        loan.receiptCount = seq;
        const payouts = [];
        let paySum = 0;
        for (let i = 0; i < loan.allocations.length; i++) {
            const a = loan.allocations[i];
            const amt = iParts[i] + pParts[i];
            a.interestReceivedPaise += iParts[i];
            a.principalReturnedPaise += pParts[i];
            if (pParts[i] > 0) await releaseLender(ctx, a.lenderId, loan.borrowerId, pParts[i]);
            if (amt === 0) continue;
            const p = {
                payoutId: `${pad(seq)}-${a.lenderId}`, loanId, receiptSeq: seq, lenderId: a.lenderId,
                interestPaise: iParts[i], principalPaise: pParts[i], amountPaise: amt,
                receiptValueDate: valueDate, dueBy: dates.addDays(valueDate, LIMITS.T_PLUS_DAYS),
                status: 'PENDING', payoutUtr: null, paidOn: null, t1Breach: false,
            };
            payouts.push(p); paySum += amt;
            await putJSON(ctx, T.PAYOUT, [loanId, p.payoutId], p);
        }
        if (paySum !== amount) throw err('INVARIANT', `payout split ${paySum} != received ${amount}`);
        if (principalApplied > 0) await addExposure(ctx, -principalApplied, 'B', loan.borrowerId);

        const receipt = { loanId, seq, utr, valueDate, amountPaise: amount, interestPaise: interestApplied, principalPaise: principalApplied, applied, payoutIds: payouts.map((p) => p.payoutId), recordedAt: txTime(ctx) };
        await putJSON(ctx, T.RECEIPT, [loanId, pad(seq)], receipt);

        // delinquency as of the value date, then status
        const overdue = loan.schedule.find((r) => r.status !== 'PAID' && r.dueDate < valueDate);
        loan.dpd = overdue ? dates.diffDays(overdue.dueDate, valueDate) : 0;
        const allPaid = loan.schedule.every((r) => r.status === 'PAID');
        if (allPaid) {
            transition(ctx, loan, loan.status === S.NPA ? S.RECOVERED : S.CLOSED, 'final instalment split');
        } else if (loan.status === S.DISBURSED) {
            transition(ctx, loan, S.REPAYING, 'first repayment received');
        }
        await saveLoan(ctx, loan, 'EmiReceived');
        return JSON.stringify({ receiptSeq: seq, payouts, status: loan.status });
    }

    async recordPayout(ctx, loanId, payoutId, utr, valueDate) {
        return this.recordPayouts(ctx, loanId, JSON.stringify([{ payoutId, utr, valueDate }]));
    }

    /** Batch: [{payoutId, utr, valueDate}] - each a separate bank transfer to a lender. */
    async recordPayouts(ctx, loanId, itemsJson) {
        requireMsp(ctx, MSP.TRUSTEE);
        const loan = await loadLoan(ctx, loanId);
        const items = JSON.parse(itemsJson);
        const done = [];
        let flagged = false;
        for (const it of items) {
            asText('utr', it.utr, 40); dates.parse(it.valueDate);
            const p = await getJSON(ctx, T.PAYOUT, [loanId, it.payoutId], 'payout');
            if (p.status !== 'PENDING') throw err('INVALID_STATE', `payout ${p.payoutId} already ${p.status}`);
            if (dates.diffDays(p.receiptValueDate, it.valueDate) < 0) throw err('INVALID_INPUT', 'payout precedes receipt');
            await claimUtr(ctx, it.utr);
            p.status = 'PAID'; p.payoutUtr = it.utr; p.paidOn = it.valueDate;
            if (it.valueDate > p.dueBy) {
                p.t1Breach = true; flagged = true;
                loan.flags.push({ rule: 'PAYOUT_T+1', detail: `${p.payoutId} paid ${it.valueDate}, due by ${p.dueBy}`, at: txTime(ctx), utr: it.utr });
            }
            await putJSON(ctx, T.PAYOUT, [loanId, p.payoutId], p);
            done.push(p.payoutId);
        }
        // only rewrite the loan record when a breach was flagged: keeps payout txs from MVCC-conflicting with EMI txs
        if (flagged) await saveLoan(ctx, loan, 'PayoutsRecorded');
        else ctx.stub.setEvent('PayoutsRecorded', Buffer.from(JSON.stringify({ loanId, status: loan.status })));
        return JSON.stringify({ paid: done });
    }

    async listPayouts(ctx, loanId) {
        return JSON.stringify((await collect(ctx, T.PAYOUT, [loanId])).map((r) => r.value));
    }

    async listReceipts(ctx, loanId) {
        return JSON.stringify((await collect(ctx, T.RECEIPT, [loanId])).map((r) => r.value));
    }

    /** Everything the Trustee still owes lenders (work queue for the bank). */
    async pendingPayouts(ctx) {
        const out = [];
        for await (const r of scan(ctx, T.PAYOUT)) if (r.value.status === 'PENDING') out.push(r.value);
        return JSON.stringify(out);
    }

    /** Lender statement: every payout across all loans. */
    async lenderStatement(ctx, lenderId) {
        const out = [];
        for await (const r of scan(ctx, T.LOAN_BY_PARTY, [lenderId])) {
            for (const row of await collect(ctx, T.PAYOUT, [r.attrs[1]])) if (row.value.lenderId === lenderId) out.push(row.value);
        }
        return JSON.stringify(out);
    }

    /**
     * Audit helper: re-derive the invariants from raw records. The Auditor peer runs this
     * against its own copy of the ledger.
     */
    async verifyLoan(ctx, loanId) {
        const loan = await loadLoan(ctx, loanId);
        const receipts = (await collect(ctx, T.RECEIPT, [loanId])).map((r) => r.value);
        const payouts = (await collect(ctx, T.PAYOUT, [loanId])).map((r) => r.value);
        const bids = (await collect(ctx, T.BID, [loanId])).map((r) => r.value);
        const checks = [];
        const add = (name, ok, detail) => checks.push({ name, ok, detail });

        const sch = loan.schedule;
        const paidTotal = sch.reduce((s, r) => s + r.paidInterestPaise + r.paidPrincipalPaise, 0);
        const rcvTotal = receipts.reduce((s, r) => s + r.amountPaise, 0);
        add('receipts == schedule paid', paidTotal === rcvTotal, `${rcvTotal} vs ${paidTotal}`);

        let splitOk = true;
        for (const r of receipts) {
            const s = payouts.filter((p) => p.receiptSeq === r.seq).reduce((t, p) => t + p.amountPaise, 0);
            if (s !== r.amountPaise) splitOk = false;
        }
        add('every receipt fully split to lenders (to the paisa)', splitOk, `${receipts.length} receipts`);

        add('allocations sum to loan amount', loan.allocations.reduce((s, a) => s + a.amountPaise, 0) === loan.amountPaise || loan.allocations.length === 0, `${loan.amountPaise}`);
        const ret = loan.allocations.reduce((s, a) => s + a.principalReturnedPaise, 0);
        const pr = sch.reduce((s, r) => s + r.paidPrincipalPaise, 0);
        add('lender principal returned == borrower principal paid', ret === pr, `${ret} vs ${pr}`);

        if (loan.clearingAprBps != null) {
            const accepted = bids.filter((b) => b.acceptedPaise > 0);
            add('every accepted lender earns >= own ask', accepted.every((b) => loan.clearingAprBps >= b.minAprBps), `clearing ${loan.clearingAprBps}bps`);
            add('borrower APR within borrower maximum', loan.clearingAprBps <= loan.maxAprBps, `${loan.clearingAprBps} <= ${loan.maxAprBps}`);
        }
        if (loan.disbursal) {
            add('disbursal equals loan amount', loan.disbursal.amountPaise === loan.amountPaise, `${loan.disbursal.amountPaise}`);
            add('escrow credits cover every allocation', loan.allocations.every((a) => loan.escrow[a.lenderId] && loan.escrow[a.lenderId].amountPaise === a.amountPaise), '');
        }
        add('tenure within cap', loan.tenureMonths <= LIMITS.MAX_TENURE_MONTHS, `${loan.tenureMonths}m`);
        add('no lender above per-borrower cap', loan.allocations.every((a) => a.amountPaise <= LIMITS.MAX_LENDER_PER_BORROWER_PAISE), '');
        add('no T+1 breach recorded', loan.flags.length === 0, loan.flags.map((f) => f.rule).join(',') || 'clean');
        return JSON.stringify({ loanId, status: loan.status, ok: checks.every((c) => c.ok || c.name.startsWith('no T+1')), checks });
    }
}

module.exports = RepaymentLedger;

'use strict';
/**
 * Module 2 - Loan contract (state machine).
 * LISTED -> FUNDING -> COMMITTED -> SIGNED -> DISBURSED -> REPAYING -> CLOSED
 *                                                      \-> NPA -> RECOVERED | WRITTEN_OFF
 * The chaincode NEVER holds or moves money. Trustee-bank transactions (escrow credit,
 * disbursal, refunds) are assertions that rupees moved, carrying the bank's UTR, and are
 * only accepted from the TrusteeMSP identity.
 */
const { Contract } = require('fabric-contract-api');
const { MSP, requireMsp } = require('./lib/auth');
const { T, err, getJSON, putJSON, drain, collect, scan, claimUtr, addExposure, getExposure, asInt, asId, asText, asHash } = require('./lib/store');
const { S, ACTIVE, txTime, loadLoan, expectStatus, transition, saveLoan, indexParty, releaseLender } = require('./lib/loans');
const { LIMITS, assertListing } = require('./lib/compliance');
const { buildSchedule, allocate } = require('./lib/money');
const dates = require('./lib/dates');

const GRADES = ['A', 'B', 'C', 'D', 'E'];
const PURPOSES = ['EDUCATION', 'MEDICAL', 'HOME_IMPROVEMENT', 'BUSINESS', 'DEBT_CONSOLIDATION', 'VEHICLE', 'PERSONAL', 'OTHER'];

class LoanContract extends Contract {
    constructor() {
        super('loan');
    }

    async createListing(ctx, loanId, borrowerId, amountPaise, tenureMonths, purposeCode, maxAprBps, riskGrade, modelVersion, suggLowBps, suggHighBps, biddingClosesOn) {
        requireMsp(ctx, MSP.PLATFORM);
        asId('loanId', loanId);
        const amount = asInt('amountPaise', amountPaise, { min: 1 });
        const tenure = asInt('tenureMonths', tenureMonths, { min: 1 });
        const maxApr = asInt('maxAprBps', maxAprBps, { min: 1 });
        if (!PURPOSES.includes(purposeCode)) throw err('INVALID_INPUT', `purposeCode must be one of ${PURPOSES}`);
        if (!GRADES.includes(riskGrade)) throw err('INVALID_INPUT', `riskGrade must be one of ${GRADES}`);
        asText('modelVersion', modelVersion, 40);
        const low = asInt('suggLowBps', suggLowBps, { min: 0 });
        const high = asInt('suggHighBps', suggHighBps, { min: low });
        dates.parse(biddingClosesOn);

        if (await getJSON(ctx, T.LOAN, [loanId])) throw err('ALREADY_EXISTS', `loan ${loanId} exists`);
        const borrower = await getJSON(ctx, T.PARTICIPANT, [borrowerId], 'borrower');
        if (borrower.role !== 'BORROWER') throw err('INVALID_INPUT', `${borrowerId} is not a borrower`);
        if (borrower.kycStatus !== 'VERIFIED') throw err('KYC_REQUIRED', `borrower ${borrowerId} is not KYC-verified`);

        const exposure = await getExposure(ctx, 'B', borrowerId);
        assertListing({ amountPaise: amount, tenureMonths: tenure, maxAprBps: maxApr, borrowerExposurePaise: exposure });
        await addExposure(ctx, amount, 'B', borrowerId);

        const loan = {
            id: loanId, borrowerId,
            requestedPaise: amount, amountPaise: amount, tenureMonths: tenure, purposeCode, maxAprBps: maxApr,
            riskGrade, modelVersion, suggestedAprBand: { lowBps: low, highBps: high }, biddingClosesOn,
            status: S.LISTED, createdAt: txTime(ctx),
            clearingAprBps: null, emiPaise: null, allocations: [], borrowerConsentToPartial: false,
            agreementHash: null, signatures: [], escrow: {}, fundedOn: null, disbursal: null,
            schedule: [], receiptCount: 0, dpd: 0, npaOn: null, loss: null, flags: [], history: [],
        };
        loan.history.push({ from: null, to: S.LISTED, txId: ctx.stub.getTxID(), at: loan.createdAt, msp: MSP.PLATFORM, note: 'listing created' });
        await saveLoan(ctx, loan, 'LoanListed');
        await indexParty(ctx, borrowerId, loanId);
        return JSON.stringify(loan);
    }

    async get(ctx, loanId) {
        return JSON.stringify(await loadLoan(ctx, loanId));
    }

    async list(ctx, status) {
        const rows = await collect(ctx, T.LOAN);
        return JSON.stringify(rows.map((r) => r.value).filter((l) => !status || l.status === status));
    }

    async listForParty(ctx, partyId) {
        const out = [];
        for await (const r of scan(ctx, T.LOAN_BY_PARTY, [partyId])) out.push(await loadLoan(ctx, r.attrs[1]));
        return JSON.stringify(out);
    }

    /** Full on-chain history of the loan record (every committed version, with tx ids). */
    async history(ctx, loanId) {
        const it = await ctx.stub.getHistoryForKey(ctx.stub.createCompositeKey(T.LOAN, [loanId]));
        const out = [];
        for await (const h of drain(it)) {
            out.push({ txId: h.txId, isDelete: h.isDelete, timestamp: h.timestamp ? new Date(Number(h.timestamp.seconds) * 1000).toISOString() : null, status: h.value && h.value.length ? JSON.parse(Buffer.from(h.value).toString()).status : null });
        }
        return JSON.stringify(out);
    }

    // ---- COMMITTED -> SIGNED ---------------------------------------------------------------
    async recordSignatures(ctx, loanId, agreementHash, signaturesJson) {
        requireMsp(ctx, MSP.PLATFORM);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.COMMITTED);
        asHash('agreementHash', agreementHash);
        const sigs = JSON.parse(signaturesJson);
        const need = new Set([loan.borrowerId, ...loan.allocations.map((a) => a.lenderId)]);
        const have = new Set(sigs.map((s) => s.participantId));
        if (have.size !== sigs.length) throw err('INVALID_INPUT', 'duplicate signatory');
        for (const id of need) if (!have.has(id)) throw err('SIGNATURE_MISSING', `no e-signature from ${id}`);
        for (const id of have) if (!need.has(id)) throw err('INVALID_INPUT', `${id} is not a party to loan ${loanId}`);
        for (const s of sigs) { asText('eSignRef', s.eSignRef, 80); }
        loan.agreementHash = agreementHash;
        loan.signatures = sigs.map((s) => ({ participantId: s.participantId, eSignRef: s.eSignRef, signedAt: s.signedAt || null }));
        transition(ctx, loan, S.SIGNED, `agreement ${agreementHash.slice(0, 12)}...`);
        await saveLoan(ctx, loan);
        return JSON.stringify(loan);
    }

    // ---- Trustee: lenders pay their slice into the Lenders' Escrow Account -------------------
    async recordEscrowCredit(ctx, loanId, lenderId, amountPaise, utr, valueDate) {
        requireMsp(ctx, MSP.TRUSTEE);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.SIGNED); // money may only be pulled in AFTER everyone signed
        asText('utr', utr, 40); dates.parse(valueDate);
        await claimUtr(ctx, utr);
        const alloc = loan.allocations.find((a) => a.lenderId === lenderId);
        if (!alloc) throw err('INVALID_INPUT', `${lenderId} has no allocation in ${loanId}`);
        const amt = asInt('amountPaise', amountPaise, { min: 1 });
        if (amt !== alloc.amountPaise) throw err('AMOUNT_MISMATCH', `escrow credit ${amt} != allocation ${alloc.amountPaise}`);
        if (loan.escrow[lenderId] && !loan.escrow[lenderId].refundedOn) throw err('ALREADY_EXISTS', `${lenderId} already funded ${loanId}`);
        loan.escrow[lenderId] = { amountPaise: amt, utr, valueDate, refundedOn: null, refundUtr: null };
        const all = loan.allocations.every((a) => loan.escrow[a.lenderId] && !loan.escrow[a.lenderId].refundedOn);
        if (all) loan.fundedOn = Object.values(loan.escrow).map((e) => e.valueDate).sort().pop();
        await saveLoan(ctx, loan, 'EscrowCredited');
        return JSON.stringify({ loanId, lenderId, fullyFunded: all, fundedOn: loan.fundedOn });
    }

    async recordEscrowRefund(ctx, loanId, lenderId, utr, valueDate) {
        requireMsp(ctx, MSP.TRUSTEE);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.SIGNED, S.CANCELLED);
        asText('utr', utr, 40); dates.parse(valueDate);
        await claimUtr(ctx, utr);
        const e = loan.escrow[lenderId];
        if (!e || e.refundedOn) throw err('INVALID_STATE', `no refundable escrow for ${lenderId} on ${loanId}`);
        e.refundedOn = valueDate; e.refundUtr = utr;
        loan.fundedOn = null;
        await saveLoan(ctx, loan, 'EscrowRefunded');
        return JSON.stringify({ loanId, lenderId, refunded: true });
    }

    // ---- Trustee: SIGNED -> DISBURSED --------------------------------------------------------
    async recordDisbursement(ctx, loanId, amountPaise, utr, valueDate) {
        requireMsp(ctx, MSP.TRUSTEE);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.SIGNED);
        asText('utr', utr, 40); dates.parse(valueDate);
        await claimUtr(ctx, utr);
        if (!loan.fundedOn) throw err('NOT_FUNDED', `loan ${loanId} is not fully funded in escrow`);
        const amt = asInt('amountPaise', amountPaise, { min: 1 });
        if (amt !== loan.amountPaise) throw err('AMOUNT_MISMATCH', `disbursal ${amt} != loan ${loan.amountPaise}`);
        const lag = dates.diffDays(loan.fundedOn, valueDate);
        if (lag < 0) throw err('INVALID_INPUT', 'disbursal value date precedes funding date');
        if (lag > LIMITS.T_PLUS_DAYS) {
            loan.flags.push({ rule: 'ESCROW_T+1', detail: `disbursal ${lag}d after funding`, at: txTime(ctx), utr });
        }
        loan.disbursal = { amountPaise: amt, utr, valueDate, lagDays: lag };
        loan.schedule = buildSchedule(loan.amountPaise, loan.clearingAprBps, loan.tenureMonths, valueDate, dates.addMonths);
        loan.emiPaise = loan.schedule[0].emiPaise;
        transition(ctx, loan, S.DISBURSED, `UTR ${utr}`);
        await saveLoan(ctx, loan, 'LoanDisbursed');
        return JSON.stringify({ loanId, status: loan.status, firstDue: loan.schedule[0].dueDate, emiPaise: loan.emiPaise, t1Lag: lag });
    }

    async cancel(ctx, loanId, reason) {
        requireMsp(ctx, MSP.PLATFORM);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.LISTED, S.FUNDING, S.COMMITTED, S.SIGNED);
        const stuck = Object.entries(loan.escrow).filter(([, e]) => !e.refundedOn);
        if (stuck.length) throw err('ESCROW_NOT_REFUNDED', `refund escrow for ${stuck.map(([id]) => id).join(', ')} first`);
        await releaseReservations(ctx, loan);
        transition(ctx, loan, S.CANCELLED, asText('reason', reason, 200));
        await saveLoan(ctx, loan, 'LoanCancelled');
        return JSON.stringify(loan);
    }

    // ---- Platform: delinquency tracking and NPA classification --------------------------------
    async updateDelinquency(ctx, loanId, asOfDate) {
        requireMsp(ctx, MSP.PLATFORM);
        dates.parse(asOfDate);
        const loan = await loadLoan(ctx, loanId);
        if (!ACTIVE.includes(loan.status)) return JSON.stringify({ loanId, changed: false, status: loan.status });
        const overdue = loan.schedule.find((r) => r.status !== 'PAID' && r.dueDate < asOfDate);
        const dpd = overdue ? dates.diffDays(overdue.dueDate, asOfDate) : 0;
        let changed = false;
        if (dpd !== loan.dpd) { loan.dpd = dpd; changed = true; }
        if (dpd > LIMITS.NPA_DPD && loan.status !== S.NPA) {
            transition(ctx, loan, S.NPA, `${dpd} days past due as of ${asOfDate}`);
            loan.npaOn = asOfDate; changed = true;
        }
        if (changed) await saveLoan(ctx, loan, loan.status === S.NPA ? 'LoanNPA' : 'LoanUpdated');
        return JSON.stringify({ loanId, changed, status: loan.status, dpd });
    }

    /** NPA -> WRITTEN_OFF. Lenders bear the loss pro-rata; the platform guarantees nothing. */
    async writeOff(ctx, loanId, reason, asOfDate) {
        requireMsp(ctx, MSP.PLATFORM);
        dates.parse(asOfDate);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.NPA);
        const outstanding = loan.schedule.reduce((s, r) => s + r.principalPaise - r.paidPrincipalPaise, 0);
        const losses = loan.allocations.map((a) => ({ lenderId: a.lenderId, lossPaise: a.amountPaise - a.principalReturnedPaise }));
        const sum = losses.reduce((s, l) => s + l.lossPaise, 0);
        if (sum !== outstanding) throw err('INVARIANT', `loss ${sum} != outstanding principal ${outstanding}`);
        for (const l of losses) await releaseLender(ctx, l.lenderId, loan.borrowerId, l.lossPaise);
        await addExposure(ctx, -outstanding, 'B', loan.borrowerId);
        loan.loss = { outstandingPrincipalPaise: outstanding, perLender: losses, writtenOffOn: asOfDate };
        transition(ctx, loan, S.WRITTEN_OFF, asText('reason', reason, 200));
        await saveLoan(ctx, loan, 'LoanWrittenOff');
        return JSON.stringify(loan.loss);
    }

    /** Lender's view: every loan they are in, share, receipts so far and loss (if any). */
    async lenderPosition(ctx, lenderId) {
        const out = [];
        for await (const r of scan(ctx, T.LOAN_BY_PARTY, [lenderId])) {
            const loan = await loadLoan(ctx, r.attrs[1]);
            const a = loan.allocations.find((x) => x.lenderId === lenderId);
            if (!a) continue;
            out.push({
                loanId: loan.id, status: loan.status, amountPaise: a.amountPaise, shareBps: Math.round((a.amountPaise * 10000) / loan.amountPaise),
                aprBps: loan.clearingAprBps, tenureMonths: loan.tenureMonths, riskGrade: loan.riskGrade,
                principalReturnedPaise: a.principalReturnedPaise, interestReceivedPaise: a.interestReceivedPaise, dpd: loan.dpd,
                lossPaise: loan.loss ? (loan.loss.perLender.find((l) => l.lenderId === lenderId) || {}).lossPaise || 0 : 0,
            });
        }
        return JSON.stringify(out);
    }
}

/** Free every exposure counter a not-yet-disbursed loan was holding. */
async function releaseReservations(ctx, loan) {
    const bids = await collect(ctx, T.BID, [loan.id]);
    for (const { value: b } of bids) {
        const held = b.status === 'OPEN' ? b.amountPaise : b.status === 'ACCEPTED' || b.status === 'PARTIAL' ? b.acceptedPaise : 0;
        if (held > 0) await releaseLender(ctx, b.lenderId, loan.borrowerId, held);
        if (b.status !== 'REJECTED' && b.status !== 'WITHDRAWN' && b.status !== 'RELEASED') {
            b.status = 'RELEASED';
            await putJSON(ctx, T.BID, [loan.id, b.id], b);
        }
    }
    await addExposure(ctx, -loan.amountPaise, 'B', loan.borrowerId);
}

module.exports = LoanContract;
module.exports.releaseReservations = releaseReservations;

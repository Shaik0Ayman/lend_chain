'use strict';
/**
 * Module 3 - Bid and match.
 * A bid names a specific borrower's loan, an amount and the lowest APR the lender accepts.
 * Bidding on a named borrower is the lender's explicit approval of that borrower (RBI rule),
 * so there is deliberately no auto-invest and no blind pool.
 */
const { Contract } = require('fabric-contract-api');
const { MSP, requireMsp } = require('./lib/auth');
const { T, err, getJSON, putJSON, putIndex, collect, scan, addExposure, getExposure, asInt, asId } = require('./lib/store');
const { S, txTime, loadLoan, expectStatus, transition, saveLoan, indexParty, releaseLender } = require('./lib/loans');
const { LIMITS, assertBid } = require('./lib/compliance');
const { computeMatch, aggregateAllocations } = require('./lib/match');
const { monthlyEmi } = require('./lib/money');

class BidMatch extends Contract {
    constructor() {
        super('bid');
    }

    async place(ctx, loanId, lenderId, amountPaise, minAprBps) {
        requireMsp(ctx, MSP.PLATFORM);
        asId('lenderId', lenderId);
        const amount = asInt('amountPaise', amountPaise, { min: 1 });
        const apr = asInt('minAprBps', minAprBps, { min: 1 });
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.LISTED, S.FUNDING);
        const lender = await getJSON(ctx, T.PARTICIPANT, [lenderId], 'lender');
        if (lender.role !== 'LENDER') throw err('INVALID_INPUT', `${lenderId} is not a lender`);
        if (lender.kycStatus !== 'VERIFIED') throw err('KYC_REQUIRED', `lender ${lenderId} is not KYC-verified`);
        if (!lender.riskDeclarationHash) throw err('DECLARATION_REQUIRED', `lender ${lenderId} has not signed the loss-of-principal declaration`);

        assertBid({
            amountPaise: amount, minAprBps: apr,
            pairExposurePaise: await getExposure(ctx, 'LB', lenderId, loan.borrowerId),
            lenderExposurePaise: await getExposure(ctx, 'L', lenderId),
            caCertificateOnFile: lender.caCertificateOnFile,
        });

        const bidId = `B${ctx.stub.getTxID().slice(0, 12)}`;
        const bid = { id: bidId, loanId, lenderId, amountPaise: amount, minAprBps: apr, status: 'OPEN', acceptedPaise: 0, createdAt: txTime(ctx) };
        await putJSON(ctx, T.BID, [loanId, bidId], bid);
        await putIndex(ctx, T.BID_BY_LENDER, [lenderId, loanId, bidId]);
        await indexParty(ctx, lenderId, loanId);
        await addExposure(ctx, amount, 'LB', lenderId, loan.borrowerId);
        await addExposure(ctx, amount, 'L', lenderId);
        if (loan.status === S.LISTED) {
            transition(ctx, loan, S.FUNDING, 'first bid received');
            await saveLoan(ctx, loan, 'BidPlaced');
        } else {
            // loan record untouched: concurrent bids on one loan do not MVCC-conflict on it
            ctx.stub.setEvent('BidPlaced', Buffer.from(JSON.stringify({ loanId, status: loan.status })));
        }
        return JSON.stringify(bid);
    }

    async withdraw(ctx, loanId, bidId) {
        requireMsp(ctx, MSP.PLATFORM);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.LISTED, S.FUNDING);
        const bid = await getJSON(ctx, T.BID, [loanId, bidId], 'bid');
        if (bid.status !== 'OPEN') throw err('INVALID_STATE', `bid ${bidId} is ${bid.status}`);
        bid.status = 'WITHDRAWN';
        await putJSON(ctx, T.BID, [loanId, bidId], bid);
        await releaseLender(ctx, bid.lenderId, loan.borrowerId, bid.amountPaise);
        ctx.stub.setEvent('BidWithdrawn', Buffer.from(JSON.stringify({ loanId, bidId })));
        return JSON.stringify(bid);
    }

    async listByLoan(ctx, loanId) {
        const rows = await collect(ctx, T.BID, [loanId]);
        return JSON.stringify(rows.map((r) => r.value));
    }

    async listByLender(ctx, lenderId) {
        const out = [];
        for await (const r of scan(ctx, T.BID_BY_LENDER, [lenderId])) {
            out.push(await getJSON(ctx, T.BID, [r.attrs[1], r.attrs[2]], 'bid'));
        }
        return JSON.stringify(out);
    }

    /** Evaluate-only dry run of the uniform-price fill (does not change state). */
    async preview(ctx, loanId) {
        const loan = await loadLoan(ctx, loanId);
        const bids = (await collect(ctx, T.BID, [loanId])).map((r) => r.value);
        const m = computeMatch(loan.amountPaise, loan.maxAprBps, bids);
        const emi = m.filledPaise > 0 ? monthlyEmi(m.filledPaise, m.clearingAprBps, loan.tenureMonths) : null;
        return JSON.stringify({ ...m, emiPaise: emi, allocations: aggregateAllocations(m.accepted) });
    }

    /**
     * Close bidding and run the uniform-price fill. If bids fall short the call changes nothing
     * (matched=false) unless `allowPartial` is 'true', which the platform sets only after the
     * borrower has agreed to take the smaller amount.
     */
    async closeAndMatch(ctx, loanId, allowPartial) {
        requireMsp(ctx, MSP.PLATFORM);
        const loan = await loadLoan(ctx, loanId);
        expectStatus(loan, S.LISTED, S.FUNDING);
        const bids = (await collect(ctx, T.BID, [loanId])).map((r) => r.value);
        const m = computeMatch(loan.amountPaise, loan.maxAprBps, bids);

        if (m.filledPaise === 0) return JSON.stringify({ matched: false, reason: 'NO_ELIGIBLE_BIDS', ...m });
        if (m.shortfallPaise > 0) {
            if (allowPartial !== 'true') return JSON.stringify({ matched: false, reason: 'SHORTFALL', ...m });
            if (m.filledPaise < LIMITS.MIN_LOAN_PAISE) throw err('MIN_LOAN', 'partial fill is below the platform minimum loan');
            loan.borrowerConsentToPartial = true;
        }

        // settle each bid and release whatever exposure it will not actually hold
        const acceptedById = new Map(m.accepted.map((a) => [a.bidId, a]));
        for (const bid of bids) {
            if (bid.status !== 'OPEN') continue;
            const a = acceptedById.get(bid.id);
            const take = a ? a.amountPaise : 0;
            bid.acceptedPaise = take;
            bid.status = take === 0 ? 'REJECTED' : take === bid.amountPaise ? 'ACCEPTED' : 'PARTIAL';
            if (bid.amountPaise - take > 0) await releaseLender(ctx, bid.lenderId, loan.borrowerId, bid.amountPaise - take);
            await putJSON(ctx, T.BID, [loanId, bid.id], bid);
        }
        if (m.shortfallPaise > 0) await addExposure(ctx, -m.shortfallPaise, 'B', loan.borrowerId);

        loan.requestedPaise = loan.requestedPaise || loan.amountPaise;
        loan.amountPaise = m.filledPaise;
        loan.clearingAprBps = m.clearingAprBps;
        loan.emiPaise = monthlyEmi(m.filledPaise, m.clearingAprBps, loan.tenureMonths);
        loan.allocations = aggregateAllocations(m.accepted).map((a) => ({ ...a, principalReturnedPaise: 0, interestReceivedPaise: 0 }));
        transition(ctx, loan, S.COMMITTED, `cleared at ${m.clearingAprBps / 100}% with ${loan.allocations.length} lender(s)`);
        await saveLoan(ctx, loan, 'LoanMatched');
        return JSON.stringify({ matched: true, clearingAprBps: m.clearingAprBps, emiPaise: loan.emiPaise, filledPaise: m.filledPaise, allocations: loan.allocations });
    }
}

module.exports = BidMatch;

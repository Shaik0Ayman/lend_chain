'use strict';
/** Loan state machine and shared helpers used by every contract module. */
const { T, err, getJSON, putJSON, putIndex, addExposure } = require('./store');

const S = Object.freeze({
    LISTED: 'LISTED',
    FUNDING: 'FUNDING',
    COMMITTED: 'COMMITTED',
    SIGNED: 'SIGNED',
    DISBURSED: 'DISBURSED',
    REPAYING: 'REPAYING',
    CLOSED: 'CLOSED',
    NPA: 'NPA',
    RECOVERED: 'RECOVERED',
    WRITTEN_OFF: 'WRITTEN_OFF',
    CANCELLED: 'CANCELLED',
});

const TRANSITIONS = Object.freeze({
    [S.LISTED]: [S.FUNDING, S.COMMITTED, S.CANCELLED],
    [S.FUNDING]: [S.COMMITTED, S.CANCELLED],
    [S.COMMITTED]: [S.SIGNED, S.CANCELLED],
    [S.SIGNED]: [S.DISBURSED, S.CANCELLED],
    [S.DISBURSED]: [S.REPAYING, S.NPA, S.CLOSED],
    [S.REPAYING]: [S.CLOSED, S.NPA],
    [S.NPA]: [S.RECOVERED, S.WRITTEN_OFF],
    [S.CLOSED]: [],
    [S.RECOVERED]: [],
    [S.WRITTEN_OFF]: [],
    [S.CANCELLED]: [],
});

const ACTIVE = [S.DISBURSED, S.REPAYING, S.NPA];

function txTime(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    const ms = Number(ts.seconds) * 1000 + Math.floor(Number(ts.nanos || 0) / 1e6);
    return new Date(ms).toISOString();
}

async function loadLoan(ctx, loanId) {
    return getJSON(ctx, T.LOAN, [loanId], 'loan');
}

function expectStatus(loan, ...allowed) {
    if (!allowed.includes(loan.status)) {
        throw err('INVALID_STATE', `loan ${loan.id} is ${loan.status}; this action needs ${allowed.join(' or ')}`);
    }
}

/** Move a loan to a new status, enforcing the state machine and writing an audit entry. */
function transition(ctx, loan, to, note) {
    if (!TRANSITIONS[loan.status] || !TRANSITIONS[loan.status].includes(to)) {
        throw err('INVALID_STATE', `illegal transition ${loan.status} -> ${to} for loan ${loan.id}`);
    }
    loan.history.push({ from: loan.status, to, txId: ctx.stub.getTxID(), at: txTime(ctx), msp: ctx.clientIdentity.getMSPID(), note: note || '' });
    loan.status = to;
}

async function saveLoan(ctx, loan, eventName = 'LoanUpdated') {
    await putJSON(ctx, T.LOAN, [loan.id], loan);
    ctx.stub.setEvent(eventName, Buffer.from(JSON.stringify({ loanId: loan.id, status: loan.status })));
}

/** index a participant (lender or borrower) against a loan for fast "my loans" queries */
const indexParty = (ctx, partyId, loanId) => putIndex(ctx, T.LOAN_BY_PARTY, [partyId, loanId]);

/** Release exposure held for a loan (used on cancel / write-off / partial repay). */
async function releaseLender(ctx, lenderId, borrowerId, paise) {
    if (paise <= 0) return;
    await addExposure(ctx, -paise, 'LB', lenderId, borrowerId);
    await addExposure(ctx, -paise, 'L', lenderId);
}

module.exports = { S, TRANSITIONS, ACTIVE, txTime, loadLoan, expectStatus, transition, saveLoan, indexParty, releaseLender };

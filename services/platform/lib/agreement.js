'use strict';
/** Builds the loan agreement text. Its SHA-256 goes on-chain; the document stays off-chain. */
const { sha256 } = require('../../../common/util');

const inr = (p) => 'INR ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function build(loan, pubBorrowerName) {
    const lines = [];
    lines.push('LENDCHAIN P2P LOAN AGREEMENT (PROTOTYPE - SIMULATED, NOT A LEGAL INSTRUMENT)');
    lines.push('');
    lines.push(`Loan reference : ${loan.id}`);
    lines.push(`Borrower       : ${loan.borrowerId} (${pubBorrowerName})`);
    lines.push(`Principal      : ${inr(loan.amountPaise)}`);
    lines.push(`Interest (APR) : ${(loan.clearingAprBps / 100).toFixed(2)}% p.a., single clearing rate for all lenders`);
    lines.push(`Tenure         : ${loan.tenureMonths} monthly instalments`);
    lines.push(`Instalment     : ${inr(loan.emiPaise)} (final instalment adjusts for rounding)`);
    lines.push(`Purpose        : ${loan.purposeCode}`);
    lines.push(`Risk grade     : ${loan.riskGrade} (${loan.modelVersion})`);
    lines.push('');
    lines.push('LENDERS (each approved this borrower by bidding on this named loan):');
    for (const a of loan.allocations) {
        lines.push(`  ${a.lenderId}  ${inr(a.amountPaise)}  share ${((a.amountPaise * 100) / loan.amountPaise).toFixed(4)}%`);
    }
    lines.push('');
    lines.push('TERMS');
    lines.push('1. Funds move only between bank accounts via the trustee bank\'s escrow accounts. The blockchain records, and never holds, money.');
    lines.push('2. Lenders pay into the Lenders\' Escrow Account only after all parties have signed; the trustee disburses within T+1.');
    lines.push('3. Each instalment is collected by autopay into the Borrowers\' Escrow Account and paid to lenders pro-rata within T+1.');
    lines.push('4. An account more than 90 days past due is a non-performing asset, is reported to credit bureaus and is recovered under fair-practice rules.');
    lines.push('5. LENDERS BEAR THE ENTIRE CREDIT RISK. The platform does not guarantee principal, interest or liquidity. A lender may lose all principal lent.');
    lines.push('6. No early-exit or secondary market is offered.');
    const text = lines.join('\n');
    return { text, hash: sha256(text) };
}

module.exports = { build };

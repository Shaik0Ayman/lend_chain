'use strict';
/**
 * Deterministic money maths. Everything is integer paise / basis points and
 * BigInt fixed-point, so every endorsing peer computes bit-identical results
 * (floating point pow() is not guaranteed identical across CPUs / V8 builds).
 *
 *   1 rupee = 100 paise;  1% APR = 100 bps
 */

const SCALE = 10n ** 30n;

/** round-half-up integer division for non-negative operands */
function roundDiv(n, d) {
    return (2n * n + d) / (2n * d);
}

/** Level monthly instalment (paise) for principal P at APR (bps) over n months. */
function monthlyEmi(principalPaise, aprBps, months) {
    const P = BigInt(principalPaise);
    if (aprBps === 0) return Number(roundDiv(P, BigInt(months)));
    const rNum = BigInt(aprBps);
    const rDen = 120000n; // monthly rate = aprBps / 10000 / 12
    const g = SCALE + (SCALE * rNum) / rDen;
    let pow = SCALE;
    for (let i = 0; i < months; i++) pow = (pow * g) / SCALE;
    // EMI = P * r * (1+r)^n / ((1+r)^n - 1)
    return Number(roundDiv(P * rNum * pow, rDen * (pow - SCALE)));
}

/** Interest for one month on a balance, rounded to the paisa. */
function monthlyInterest(balancePaise, aprBps) {
    return Number(roundDiv(BigInt(balancePaise) * BigInt(aprBps), 120000n));
}

/**
 * Split `total` across `weights` pro-rata using the largest-remainder method,
 * so the parts always sum to exactly `total` (no paisa created or destroyed).
 * Ties on the remainder are broken by lower index, which keeps it deterministic.
 */
function allocate(total, weights) {
    const T = BigInt(total);
    const W = weights.map((w) => BigInt(w));
    const sumW = W.reduce((a, b) => a + b, 0n);
    if (sumW <= 0n) throw new Error('allocate: weights must be positive');
    const parts = W.map((w) => (T * w) / sumW);
    const rems = W.map((w, i) => ({ i, r: (T * w) % sumW }));
    let left = T - parts.reduce((a, b) => a + b, 0n);
    rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
    for (let k = 0; left > 0n; k++, left--) parts[rems[k % rems.length].i] += 1n;
    return parts.map(Number);
}

/**
 * Amortisation schedule. First instalment is one month after `disbursalDate`.
 * The final instalment absorbs rounding so the principal clears exactly.
 */
function buildSchedule(principalPaise, aprBps, months, disbursalDate, addMonths) {
    const emi = monthlyEmi(principalPaise, aprBps, months);
    let balance = principalPaise;
    const rows = [];
    for (let k = 1; k <= months; k++) {
        const interest = monthlyInterest(balance, aprBps);
        let principal = emi - interest;
        if (k === months || principal > balance) principal = balance;
        rows.push({
            no: k,
            dueDate: addMonths(disbursalDate, k),
            emiPaise: principal + interest,
            interestPaise: interest,
            principalPaise: principal,
            paidInterestPaise: 0,
            paidPrincipalPaise: 0,
            status: 'DUE',
        });
        balance -= principal;
    }
    return rows;
}

const rupees = (r) => Math.round(Number(r) * 100);

module.exports = { monthlyEmi, monthlyInterest, allocate, buildSchedule, roundDiv, rupees };

'use strict';
/**
 * Uniform-price (single clearing rate) fill.
 *   1. Drop bids whose ask is above the borrower's maximum APR.
 *   2. Cheapest ask first; ties broken by earlier bid, then by id (fully deterministic).
 *   3. Fill until the requested amount is covered; the last bid may be partly filled.
 *   4. Everyone accepted earns ONE rate: the highest accepted ask.
 */
function computeMatch(amountPaise, maxAprBps, bids) {
    const eligible = bids
        .filter((b) => b.status === 'OPEN' && b.minAprBps <= maxAprBps)
        .sort((a, b) => a.minAprBps - b.minAprBps || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.id < b.id ? -1 : 1));

    let remaining = amountPaise;
    const accepted = [];
    for (const b of eligible) {
        if (remaining === 0) break;
        const take = Math.min(b.amountPaise, remaining);
        accepted.push({ bidId: b.id, lenderId: b.lenderId, amountPaise: take, bidAmountPaise: b.amountPaise, minAprBps: b.minAprBps });
        remaining -= take;
    }
    return {
        accepted,
        filledPaise: amountPaise - remaining,
        shortfallPaise: remaining,
        clearingAprBps: accepted.length ? accepted[accepted.length - 1].minAprBps : null,
        eligibleBids: eligible.length,
    };
}

/** merge several accepted bids from the same lender into one allocation row */
function aggregateAllocations(accepted) {
    const by = new Map();
    for (const a of accepted) {
        const row = by.get(a.lenderId) || { lenderId: a.lenderId, amountPaise: 0, bidIds: [] };
        row.amountPaise += a.amountPaise;
        row.bidIds.push(a.bidId);
        by.set(a.lenderId, row);
    }
    return [...by.values()];
}

module.exports = { computeMatch, aggregateAllocations };

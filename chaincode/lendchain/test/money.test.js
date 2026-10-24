'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { monthlyEmi, allocate, buildSchedule, monthlyInterest } = require('../src/lib/money');
const { addMonths, diffDays } = require('../src/lib/dates');
const { computeMatch } = require('../src/lib/match');

test('EMI reproduces the proposal worked example (Rs 1.5 lakh, 15%, 12m = Rs 13,538.75)', () => {
    assert.equal(monthlyEmi(15000000, 1500, 12), 1353875);
});

test('lender shares of the EMI match the proposal table to the paisa', () => {
    const parts = allocate(1353875, [5000000, 4000000, 5000000, 1000000]);
    assert.deepEqual(parts, [451292, 361033, 451292, 90258]); // 4,512.92 / 3,610.33 / 4,512.92 / 902.58
    assert.equal(parts.reduce((a, b) => a + b), 1353875);
});

test('allocate always sums exactly (fuzz, 20k random splits)', () => {
    let seed = 42;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 20000; i++) {
        const k = 1 + rnd(6);
        const w = Array.from({ length: k }, () => 1 + rnd(5_000_000));
        const total = rnd(200_000_00);
        assert.equal(allocate(total, w).reduce((a, b) => a + b, 0), total);
    }
});

test('schedule clears principal exactly and EMI is level except for the last row', () => {
    for (const [p, apr, n] of [[15000000, 1500, 12], [123457, 2399, 7], [100000000, 3600, 36], [500000, 1, 3]]) {
        const rows = buildSchedule(p, apr, n, '2026-01-31', addMonths);
        assert.equal(rows.reduce((s, r) => s + r.principalPaise, 0), p);
        assert.ok(Math.abs(rows[0].emiPaise - rows[n - 2 >= 0 ? Math.max(0, n - 2) : 0].emiPaise) <= 1 || n < 3);
        assert.equal(rows.length, n);
    }
});

test('total interest on the worked example is within a rupee of the proposal figure (Rs 12,464.96)', () => {
    const rows = buildSchedule(15000000, 1500, 12, '2026-01-01', addMonths);
    const interest = rows.reduce((s, r) => s + r.interestPaise, 0);
    assert.ok(Math.abs(interest - 1246496) <= 100, `interest ${interest}`);
});

test('0% APR splits evenly; interest helper rounds half up', () => {
    assert.equal(monthlyEmi(1200000, 0, 12), 100000);
    assert.equal(monthlyInterest(1000000, 1200), 10000);
});

test('addMonths clamps to month end and anchors on the original day', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
    assert.equal(diffDays('2026-01-01', '2026-04-01'), 90);
});

test('uniform-price fill: cheapest first, one clearing rate = highest accepted ask', () => {
    const mk = (id, lender, amt, apr, t) => ({ id, lenderId: lender, amountPaise: amt, minAprBps: apr, status: 'OPEN', createdAt: t });
    const bids = [mk('b4', 'L4', 3000000, 1500, 't4'), mk('b1', 'L1', 5000000, 1200, 't1'), mk('b3', 'L3', 5000000, 1400, 't3'), mk('b2', 'L2', 4000000, 1300, 't2')];
    const m = computeMatch(15000000, 1600, bids);
    assert.equal(m.filledPaise, 15000000);
    assert.equal(m.clearingAprBps, 1500);
    assert.deepEqual(m.accepted.map((a) => [a.lenderId, a.amountPaise]), [['L1', 5000000], ['L2', 4000000], ['L3', 5000000], ['L4', 1000000]]);
    assert.ok(m.accepted.every((a) => m.clearingAprBps >= a.minAprBps), 'every lender earns at or above their ask');
});

test('fill ignores asks above the borrower maximum and reports shortfall', () => {
    const mk = (id, amt, apr) => ({ id, lenderId: id, amountPaise: amt, minAprBps: apr, status: 'OPEN', createdAt: id });
    const m = computeMatch(10000000, 1400, [mk('a', 4000000, 1200), mk('b', 4000000, 1500)]);
    assert.equal(m.filledPaise, 4000000);
    assert.equal(m.shortfallPaise, 6000000);
    assert.equal(m.clearingAprBps, 1200);
});

test('ties at the margin go to the earlier bid', () => {
    const mk = (id, t) => ({ id, lenderId: id, amountPaise: 3000000, minAprBps: 1300, status: 'OPEN', createdAt: t });
    const m = computeMatch(3000000, 1600, [mk('late', '2026-01-01T00:00:02Z'), mk('early', '2026-01-01T00:00:01Z')]);
    assert.deepEqual(m.accepted.map((a) => a.bidId), ['early']);
});

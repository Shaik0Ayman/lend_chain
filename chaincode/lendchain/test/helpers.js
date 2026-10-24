'use strict';
/**
 * Minimal in-memory Fabric stub with the semantics that matter for correctness:
 *  - reads see COMMITTED state only (a tx never sees its own writes)
 *  - writes apply atomically when the tx succeeds and are discarded if it throws
 *  - composite keys / range scans use the same \u0000-delimited encoding as Fabric
 */
const crypto = require('crypto');
const Registry = require('../src/registry');
const Loan = require('../src/loan');
const Bid = require('../src/bid');
const Repay = require('../src/repay');

const SEP = '\u0000';

class MockLedger {
    constructor() {
        this.state = new Map();
        this.priv = new Map();
        this.clock = Date.parse('2026-01-01T00:00:00.000Z');
        this.txCount = 0;
        this.events = [];
        this.contracts = { registry: new Registry(), loan: new Loan(), bid: new Bid(), repay: new Repay() };
    }

    /** invoke a transaction as `msp`; returns parsed JSON (or raw string) */
    async tx(msp, fqn, args = [], transient = {}) {
        const [ns, fn] = fqn.split(':');
        const writes = new Map();
        const privWrites = new Map();
        let event = null;
        this.txCount++;
        this.clock += 1000;
        const txId = crypto.createHash('sha256').update(`tx${this.txCount}`).digest('hex');
        const ledger = this;
        const stub = {
            createCompositeKey: (t, attrs) => SEP + t + SEP + attrs.map((a) => a + SEP).join(''),
            splitCompositeKey: (k) => { const p = k.split(SEP); return { objectType: p[1], attributes: p.slice(2, -1) }; },
            getState: async (k) => (ledger.state.has(k) ? ledger.state.get(k) : Buffer.alloc(0)),
            putState: async (k, v) => { writes.set(k, Buffer.from(v)); },
            delState: async (k) => { writes.set(k, null); },
            getStateByPartialCompositeKey: async (t, attrs) => {
                const prefix = SEP + t + SEP + attrs.map((a) => a + SEP).join('');
                const keys = [...ledger.state.keys()].filter((k) => k.startsWith(prefix)).sort();
                let i = 0;
                // real fabric-shim 2.5 iterators are next()/close() only - NOT AsyncIterable
                return { close: async () => {}, next: async () => (i < keys.length ? { value: { key: keys[i], value: ledger.state.get(keys[i++]) }, done: false } : { value: undefined, done: true }) };
            },
            getHistoryForKey: async () => ({ close: async () => {}, next: async () => ({ value: undefined, done: true }) }),
            getTxID: () => txId,
            getTxTimestamp: () => ({ seconds: Math.floor(ledger.clock / 1000), nanos: (ledger.clock % 1000) * 1e6 }),
            setEvent: (n, p) => { event = { name: n, payload: p.toString() }; },
            getTransient: () => new Map(Object.entries(transient).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))])),
            putPrivateData: async (c, k, v) => { privWrites.set(`${c}/${k}`, Buffer.from(v)); },
            getPrivateData: async (c, k) => ledger.priv.get(`${c}/${k}`) || Buffer.alloc(0),
            getPrivateDataHash: async (c, k) => (ledger.priv.has(`${c}/${k}`) ? crypto.createHash('sha256').update(ledger.priv.get(`${c}/${k}`)).digest() : Buffer.alloc(0)),
            purgePrivateData: async (c, k) => { privWrites.set(`${c}/${k}`, null); },
        };
        const ctx = { stub, clientIdentity: { getMSPID: () => msp, getID: () => `x509::${msp}` } };
        const out = await this.contracts[ns][fn](ctx, ...args.map(String));
        for (const [k, v] of writes) (v === null ? this.state.delete(k) : this.state.set(k, v));
        for (const [k, v] of privWrites) (v === null ? this.priv.delete(k) : this.priv.set(k, v));
        if (event) this.events.push(event);
        try { return JSON.parse(out); } catch { return out; }
    }

    P(fqn, ...a) { return this.tx('PlatformMSP', fqn, a); }
    B(fqn, ...a) { return this.tx('TrusteeMSP', fqn, a); }
    A(fqn, ...a) { return this.tx('AuditorMSP', fqn, a); }
}

const h64 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rs = (r) => Math.round(r * 100);

async function seedParticipants(L, lenders, borrowers = ['BRW-000000000001']) {
    for (const id of lenders) await L.P('registry:register', id, 'LENDER', 'VERIFIED', h64(id), h64('decl' + id));
    for (const id of borrowers) await L.P('registry:register', id, 'BORROWER', 'VERIFIED', h64(id), '');
}

async function expectReject(promise, re) {
    try { await promise; } catch (e) { if (!re.test(e.message)) throw new Error(`rejected with wrong error: ${e.message} (wanted ${re})`); return e; }
    throw new Error(`expected rejection matching ${re}`);
}

/** The worked example from the proposal: Rs 1.5 lakh, 12m, max 16%, four lenders. */
async function workedExample(L, { loanId = 'LN-0001', borrower = 'BRW-000000000001' } = {}) {
    const lenders = ['LND-000000000001', 'LND-000000000002', 'LND-000000000003', 'LND-000000000004'];
    await seedParticipants(L, lenders, [borrower]);
    await L.P('loan:createListing', loanId, borrower, rs(150000), 12, 'BUSINESS', 1600, 'C', 'scorecard-v1', 1300, 1700, '2026-02-01');
    const asks = [[50000, 1200], [40000, 1300], [50000, 1400], [30000, 1500]];
    for (let i = 0; i < 4; i++) await L.P('bid:place', loanId, lenders[i], rs(asks[i][0]), asks[i][1]);
    return { lenders, loanId, borrower };
}

module.exports = { MockLedger, h64, rs, seedParticipants, expectReject, workedExample };

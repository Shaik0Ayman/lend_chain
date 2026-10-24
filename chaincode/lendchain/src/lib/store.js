'use strict';
/** Thin typed wrappers over the world state. Keys are composite so range scans are cheap. */

const T = Object.freeze({
    PARTICIPANT: 'participant',
    LOAN: 'loan',
    BID: 'bid', // [loanId, bidId]
    BID_BY_LENDER: 'bidByLender', // [lenderId, loanId, bidId] -> '' (index)
    LOAN_BY_PARTY: 'loanByParty', // [participantId, loanId] -> '' (index)
    RECEIPT: 'receipt', // [loanId, seq]
    PAYOUT: 'payout', // [loanId, payoutId]
    EXPOSURE: 'exposure', // [kind, ids...]
    UTR: 'utr', // [utr] -> bank reference already booked (replay / double-booking guard)
});

const err = (code, msg) => new Error(`${code}: ${msg}`);

function key(ctx, type, ...attrs) {
    return ctx.stub.createCompositeKey(type, attrs.map(String));
}

async function getJSON(ctx, type, attrs, what) {
    const buf = await ctx.stub.getState(key(ctx, type, ...attrs));
    if (!buf || buf.length === 0) {
        if (what) throw err('NOT_FOUND', `${what} '${attrs.join('/')}' does not exist`);
        return null;
    }
    return JSON.parse(buf.toString());
}

async function putJSON(ctx, type, attrs, obj) {
    await ctx.stub.putState(key(ctx, type, ...attrs), Buffer.from(JSON.stringify(obj)));
}

async function putIndex(ctx, type, attrs) {
    await ctx.stub.putState(key(ctx, type, ...attrs), Buffer.from('1'));
}

/**
 * Drain a Fabric state iterator. fabric-shim 2.5 iterators expose next()/close() (they are NOT
 * AsyncIterable), so this wraps them as an async generator and always closes the iterator.
 */
async function* drain(it) {
    try {
        while (true) {
            const r = await it.next();
            if (r.value && r.value.key !== undefined) yield r.value;
            else if (r.value && r.value.txId !== undefined) yield r.value; // history entries have no key
            if (r.done) return;
        }
    } finally {
        await it.close();
    }
}

/** async-iterate every record whose composite key starts with `attrs` */
async function* scan(ctx, type, attrs = []) {
    const it = await ctx.stub.getStateByPartialCompositeKey(type, attrs.map(String));
    for await (const kv of drain(it)) {
        const { attributes } = ctx.stub.splitCompositeKey(kv.key);
        const raw = Buffer.from(kv.value).toString();
        yield { attrs: attributes, value: raw === '1' ? null : JSON.parse(raw) };
    }
}

async function collect(ctx, type, attrs = []) {
    const out = [];
    for await (const r of scan(ctx, type, attrs)) out.push(r);
    return out;
}

/**
 * NOTE: Fabric reads inside a transaction never see that same transaction's own writes.
 * Anything that may be updated twice in one tx (exposure counters, UTR claims) therefore goes
 * through a per-transaction cache on `ctx`, otherwise the second update would be lost.
 */

/** A bank reference (UTR) can back exactly one on-chain money event. */
async function claimUtr(ctx, utr) {
    ctx._utrs = ctx._utrs || new Set();
    if (ctx._utrs.has(utr)) throw err('DUPLICATE_UTR', `bank reference ${utr} used twice in one transaction`);
    const k = key(ctx, T.UTR, utr);
    const cur = await ctx.stub.getState(k);
    if (cur && cur.length) throw err('DUPLICATE_UTR', `bank reference ${utr} has already been recorded`);
    ctx._utrs.add(utr);
    await ctx.stub.putState(k, Buffer.from(ctx.stub.getTxID()));
}

// ---- running exposure counters (paise) -------------------------------------------
async function getExposure(ctx, kind, ...ids) {
    const ck = [kind, ...ids].join('/');
    if (ctx._exp && ctx._exp.has(ck)) return ctx._exp.get(ck);
    const v = await getJSON(ctx, T.EXPOSURE, [kind, ...ids]);
    return v ? v.paise : 0;
}
async function addExposure(ctx, delta, kind, ...ids) {
    const cur = await getExposure(ctx, kind, ...ids);
    const next = cur + delta;
    if (next < 0) throw err('INVARIANT', `exposure ${kind}/${ids.join('/')} would go negative (${cur} ${delta})`);
    ctx._exp = ctx._exp || new Map();
    ctx._exp.set([kind, ...ids].join('/'), next);
    await putJSON(ctx, T.EXPOSURE, [kind, ...ids], { paise: next });
    return next;
}

// ---- input parsing ------------------------------------------------------------------
function asInt(name, v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof v === 'number' && Number.isInteger(v)) {
        /* ok */
    } else if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) {
        throw err('INVALID_INPUT', `${name} must be an integer, got '${v}'`);
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw err('INVALID_INPUT', `${name} out of range [${min}, ${max}]: ${v}`);
    return n;
}
function asId(name, v) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(v)) throw err('INVALID_INPUT', `${name} malformed: '${v}'`);
    return v;
}
function asText(name, v, max = 120) {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw err('INVALID_INPUT', `${name} must be 1-${max} chars`);
    return v;
}
function asHash(name, v) {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw err('INVALID_INPUT', `${name} must be a lowercase hex SHA-256`);
    return v;
}

module.exports = { T, err, key, getJSON, putJSON, putIndex, drain, scan, collect, claimUtr, getExposure, addExposure, asInt, asId, asText, asHash };

'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** deterministic JSON (sorted keys) so a document hashes identically wherever it is rebuilt */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

const dataDir = (sub) => {
    const d = path.resolve(process.env.LENDCHAIN_DATA || path.join(__dirname, '..', 'data'), sub || '');
    fs.mkdirSync(d, { recursive: true });
    return d;
};

/** wrap an async express handler so thrown errors become JSON responses */
const route = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (e) {
        const status = e.status || (e.code === 'UNAUTHORIZED' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code && /^[A-Z_]+$/.test(e.code) ? 409 : 500);
        if (status === 500) console.error(e);
        res.status(status).json({ error: e.message, code: e.code || 'ERROR' });
    }
};

class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

module.exports = { sha256, canonical, dataDir, route, HttpError, today, addDays, diffDays };

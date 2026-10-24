'use strict';
/**
 * Off-chain private data store protection.
 *  - PII (name, PAN, Aadhaar, phone, bank account, income) is AES-256-GCM encrypted at field-group level.
 *  - The ledger only ever sees a pseudonymous ID = prefix + HMAC(pepper, PAN).
 *  - Passwords use scrypt.
 * DEV KEY HANDLING: keys are generated into data/platform/keys.json on first run. In production load them
 * from a KMS/HSM (e.g. an India-region cloud KMS) and rotate; never keep them beside the database.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../../../common/util');

function loadKeys() {
    if (process.env.LENDCHAIN_PII_KEY) {
        const k = Buffer.from(process.env.LENDCHAIN_PII_KEY, 'hex');
        if (k.length !== 32) throw new Error('LENDCHAIN_PII_KEY must be 64 hex chars');
        return { pii: k, pepper: crypto.createHmac('sha256', k).update('pseudonym-pepper').digest() };
    }
    const f = path.join(dataDir('platform'), 'keys.json');
    if (!fs.existsSync(f)) {
        fs.writeFileSync(f, JSON.stringify({ pii: crypto.randomBytes(32).toString('hex'), pepper: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 });
    }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { pii: Buffer.from(j.pii, 'hex'), pepper: Buffer.from(j.pepper, 'hex') };
}
const KEYS = loadKeys();

function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEYS.pii, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(b64) {
    const buf = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEYS.pii, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

const hmac = (label, v) => crypto.createHmac('sha256', KEYS.pepper).update(`${label}:${v}`).digest('hex');
const pseudonym = (role, pan) => `${role === 'LENDER' ? 'LND' : 'BRW'}-${hmac('pan', pan).slice(0, 12).toUpperCase()}`;

function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
    const [s, h] = stored.split(':');
    const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32);
    return crypto.timingSafeEqual(a, Buffer.from(h, 'hex'));
}
const token = () => crypto.randomBytes(24).toString('hex');

module.exports = { encrypt, decrypt, hmac, pseudonym, hashPassword, verifyPassword, token };

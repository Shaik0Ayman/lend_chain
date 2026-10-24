'use strict';
/**
 * MOCK e-KYC. Format and checksum validation is real (PAN structure, Aadhaar Verhoeff checksum, IFSC);
 * the identity lookup, bank "penny drop" and bureau pull are simulated. Swap these for licensed
 * KUA/KSA (Aadhaar e-KYC), NSDL PAN verification, bank penny-drop and CIBIL/Experian APIs.
 */
const crypto = require('node:crypto');

// Verhoeff tables (dihedral group D5) - the checksum Aadhaar numbers use
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const INV = [0,4,3,2,1,5,6,7,8,9];

function verhoeffValid(num) {
    let c = 0;
    const d = String(num).split('').reverse().map(Number);
    for (let i = 0; i < d.length; i++) c = D[c][P[i % 8][d[i]]];
    return c === 0;
}
function verhoeffCheckDigit(partial) {
    let c = 0;
    const d = String(partial).split('').reverse().map(Number);
    for (let i = 0; i < d.length; i++) c = D[c][P[(i + 1) % 8][d[i]]];
    return INV[c];
}

const validPan = (p) => /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/.test(p); // 4th letter P = individual
const validAadhaar = (a) => /^[2-9][0-9]{11}$/.test(a) && verhoeffValid(a);
const validIfsc = (i) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(i);
const validPhone = (p) => /^[6-9][0-9]{9}$/.test(p);
const maskPan = (p) => p.slice(0, 2) + 'XXX' + p.slice(5, 6) + 'XXX' + p.slice(-1);
const maskAadhaar = (a) => 'XXXX XXXX ' + a.slice(-4);
const maskName = (n) => n.split(/\s+/).map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ');

/** deterministic mock bureau score (300-900) so the same PAN always gets the same score */
function mockBureauScore(pan) {
    const h = parseInt(crypto.createHash('sha256').update('bureau:' + pan).digest('hex').slice(0, 8), 16);
    return 540 + (h % 330);
}

const verifyOtp = (otp) => String(otp) === (process.env.MOCK_OTP || '123456');

/** random but valid demo identity for the sign-up form */
function demoIdentity() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const r = (n, s) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
    const pan = `${r(3, L)}P${r(1, L)}${r(4, '0123456789')}${r(1, L)}`;
    const base = r(1, '23456789') + r(10, '0123456789');
    return {
        pan, aadhaar: base + verhoeffCheckDigit(base), phone: r(1, '6789') + r(9, '0123456789'),
        ifsc: `${['HDFC', 'ICIC', 'SBIN', 'UTIB'][crypto.randomInt(4)]}0${r(6, '0123456789')}`, accountNumber: r(12, '0123456789'),
    };
}

module.exports = { verhoeffValid, validPan, validAadhaar, validIfsc, validPhone, maskPan, maskAadhaar, maskName, mockBureauScore, verifyOtp, demoIdentity };

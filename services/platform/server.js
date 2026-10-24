'use strict';
/**
 * LENDCHAIN PLATFORM BACKEND (off-chain)   -   KYC & onboarding | credit & APR advice | matching | private data store
 *
 * Talks to the Fabric network through the Gateway client AS the PlatformMSP identity, and to the
 * (mock) trustee bank over HTTP. It never moves money: money movement is the bank's job and the
 * chain only records that it happened.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { connectOrg } = require('../../common/fabric');
const { sha256, dataDir, route, HttpError, today, addDays } = require('../../common/util');
const sec = require('./lib/security');
const kyc = require('./lib/kyc');
const credit = require('./lib/credit');
const fraud = require('./lib/fraud');
const agreement = require('./lib/agreement');

const { HOST, PUBLIC, requireStrong } = require('../../common/config');
requireStrong(['BANK_API_KEY', 'ADMIN_PASSWORD', 'LENDCHAIN_PII_KEY']);

const PORT = Number(process.env.PLATFORM_PORT || 4001);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const BANK_KEY = process.env.BANK_API_KEY || 'dev-bank-key';
const DEMO = process.env.DEMO_MODE !== 'false';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@lendchain.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const PURPOSES = ['EDUCATION', 'MEDICAL', 'HOME_IMPROVEMENT', 'BUSINESS', 'DEBT_CONSOLIDATION', 'VEHICLE', 'PERSONAL', 'OTHER'];
const ACTIVE = ['DISBURSED', 'REPAYING', 'NPA'];
const BIDDING_WINDOW_DAYS = 7;

const db = new DatabaseSync(path.join(dataDir('platform'), 'platform.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, pw TEXT, role TEXT, participant_id TEXT UNIQUE, pan_hash TEXT UNIQUE, bank_hash TEXT UNIQUE, pii TEXT, disabled INTEGER DEFAULT 0, created TEXT);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
  CREATE TABLE IF NOT EXISTS applications(loan_id TEXT PRIMARY KEY, borrower_id TEXT, amount_paise INTEGER, tenure INTEGER, purpose TEXT, max_apr_bps INTEGER, status TEXT, grade TEXT, pd REAL,
    model_version TEXT, band_low INTEGER, band_high INTEGER, reasons TEXT, fraud TEXT, public TEXT, partial_consent INTEGER DEFAULT 0, note TEXT, created TEXT);
  CREATE TABLE IF NOT EXISTS agreements(loan_id TEXT PRIMARY KEY, text TEXT, hash TEXT, created TEXT);
  CREATE TABLE IF NOT EXISTS signatures(loan_id TEXT, participant_id TEXT, esign_ref TEXT, signed_at TEXT, PRIMARY KEY(loan_id, participant_id));
  CREATE TABLE IF NOT EXISTS signals(participant_id TEXT, ip_hash TEXT, kind TEXT, at INTEGER);
  CREATE TABLE IF NOT EXISTS bureau_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT, kind TEXT, as_of TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);

let chain;

// ---------------------------------------------------------------- helpers
async function bank(pathname, body, method) {
    let r;
    try {
        r = await fetch(`${BANK_URL}${pathname}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-api-key': BANK_KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (e) { throw new HttpError(503, `bank service unreachable (${e.message})`, 'BANK_DOWN'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, j.error || 'bank error', j.code || 'BANK_ERROR');
    return j;
}

let simCache = { at: 0, date: today() };
async function simDate() {
    if (Date.now() - simCache.at < 2000) return simCache.date;
    try { simCache = { at: Date.now(), date: (await bank('/sim/state')).simDate }; } catch { /* bank offline: keep last */ }
    return simCache.date;
}

const kvGet = (k, d) => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
const rupees = (n, what) => { const v = Number(n); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${what} must be a non-negative number`, 'INVALID_INPUT'); return Math.round(v * 100); };
const ipHash = (req) => sha256(`${req.ip}|${req.get('x-device-id') || ''}`).slice(0, 16);
const incomeBand = (paise) => { const r = paise / 100; return r < 25000 ? 'under ₹25k/mo' : r < 50000 ? '₹25–50k/mo' : r < 100000 ? '₹50k–1L/mo' : r < 200000 ? '₹1–2L/mo' : '₹2L+/mo'; };
const getPii = (user) => sec.decrypt(user.pii);

// ---------------------------------------------------------------- auth
const authed = (...roles) => route(async (req, res, next) => {
    const t = (req.get('authorization') || '').replace(/^Bearer /, '');
    const s = t && db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
    if (!s || Date.now() - s.created > 12 * 3600 * 1000) throw new HttpError(401, 'sign in required', 'AUTH');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
    if (!user || user.disabled) throw new HttpError(401, 'account disabled', 'AUTH');
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, `this action is for ${roles.join('/')}`, 'FORBIDDEN');
    req.user = user;
    next();
});
const newSession = (userId) => { const t = sec.token(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, userId, Date.now()); return t; };

// ---------------------------------------------------------------- chain helpers
const loanOr404 = (id) => chain.evaluate('loan:get', id);

/** What each role is allowed to see of a loan record. Borrowers never see lender identities. */
function redact(user, loan, bids) {
    const out = { ...loan };
    const mine = user.participant_id;
    if (user.role === 'BORROWER') {
        out.allocations = loan.allocations.map((a, i) => ({ label: `Lender ${i + 1}`, amountPaise: a.amountPaise, sharePct: +((a.amountPaise * 100) / loan.amountPaise).toFixed(2) }));
        delete out.escrow; delete out.loss;
        out.signatures = loan.signatures.map((s) => ({ you: s.participantId === mine, signedAt: s.signedAt }));
    } else if (user.role === 'LENDER') {
        out.allocations = loan.allocations.filter((a) => a.lenderId === mine);
        out.escrow = loan.escrow[mine] ? { [mine]: loan.escrow[mine] } : {};
        out.signatures = loan.signatures.map((s) => ({ you: s.participantId === mine, signedAt: s.signedAt }));
        if (loan.loss) out.loss = { ...loan.loss, perLender: loan.loss.perLender.filter((l) => l.lenderId === mine) };
    }
    if (bids) out.bids = user.role === 'ADMIN' ? bids : bids.filter((b) => b.lenderId === mine);
    return out;
}

function appInfo(loanId) {
    const a = db.prepare('SELECT * FROM applications WHERE loan_id=?').get(loanId);
    if (!a) return null;
    return { reasons: JSON.parse(a.reasons), fraud: JSON.parse(a.fraud), borrower: JSON.parse(a.public), pd: a.pd, status: a.status, partialConsent: !!a.partial_consent, note: a.note };
}

async function listOnChain(app) {
    const sd = await simDate();
    try {
        await chain.submit('loan:createListing', [app.loan_id, app.borrower_id, app.amount_paise, app.tenure, app.purpose, app.max_apr_bps, app.grade, app.model_version, app.band_low, app.band_high, addDays(sd, BIDDING_WINDOW_DAYS)]);
        db.prepare("UPDATE applications SET status='LISTED', note=NULL WHERE loan_id=?").run(app.loan_id);
    } catch (e) {
        if (e.code === 'COMPLIANCE_VIOLATION' || e.code === 'KYC_REQUIRED') {
            db.prepare("UPDATE applications SET status='REJECTED_COMPLIANCE', note=? WHERE loan_id=?").run(e.message, app.loan_id);
        }
        throw e;
    }
}

function buildAgreement(loan) {
    const app = appInfo(loan.id);
    const { text, hash } = agreement.build(loan, app ? app.borrower.name : 'borrower');
    db.prepare('INSERT OR REPLACE INTO agreements VALUES(?,?,?,?)').run(loan.id, text, hash, new Date().toISOString());
    return { text, hash };
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 'loopback'); // honour X-Forwarded-For only from a proxy/tunnel on this machine
app.use(express.json({ limit: '100kb' }));

// /internal/* is for the bank service on this host only: anything that arrived through a proxy/tunnel is refused
app.use('/internal', (req, res, next) => (req.get('x-forwarded-for') || req.get('cf-connecting-ip') ? res.status(404).end() : next()));

// abuse limits per client IP (on in public mode, or with RATE_LIMIT=1); tunable via RATE_LOGIN / RATE_SIGNUP
const hits = new Map();
function limit(name, max, windowMs) {
    return (req, res, next) => {
        const k = `${name}:${req.ip}`, now = Date.now();
        let h = hits.get(k);
        if (!h || now - h.t0 > windowMs) h = { t0: now, n: 0 };
        h.n++; hits.set(k, h);
        if (h.n > max) { res.set('retry-after', String(Math.ceil((h.t0 + windowMs - now) / 1000))); return res.status(429).json({ error: 'too many requests, slow down', code: 'RATE_LIMITED' }); }
        next();
    };
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t0 > 3600e3) hits.delete(k); }, 600e3).unref();
if (PUBLIC || process.env.RATE_LIMIT === '1') {
    app.post('/api/login', limit('login', Number(process.env.RATE_LOGIN || 20), 60e3));
    app.post('/api/signup', limit('signup', Number(process.env.RATE_SIGNUP || 60), 600e3));
}
app.use((req, res, next) => { res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }); next(); });

app.get('/api/config', (req, res) => res.json({ links: { local: !PUBLIC, bank: process.env.PUBLIC_BANK_URL || null, auditor: process.env.PUBLIC_AUDITOR_URL || null }, demo: DEMO, otpHint: DEMO ? process.env.MOCK_OTP || '123456' : null, purposes: PURPOSES, limits: { lenderPerBorrowerRs: 50000, borrowerTotalRs: 1000000, maxTenure: 36 } }));
app.get('/api/demo/identity', (req, res) => (DEMO ? res.json(kyc.demoIdentity()) : res.status(404).end()));

// ---- sign up with mock e-KYC
app.post('/api/signup', route(async (req, res) => {
    const b = req.body || {};
    const role = b.role;
    if (!['LENDER', 'BORROWER'].includes(role)) throw new HttpError(400, 'role must be LENDER or BORROWER', 'INVALID_INPUT');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) throw new HttpError(400, 'valid email required', 'INVALID_INPUT');
    if (!b.password || b.password.length < 8) throw new HttpError(400, 'password must be at least 8 characters', 'INVALID_INPUT');
    if (!b.name || b.name.trim().length < 2) throw new HttpError(400, 'name required', 'INVALID_INPUT');
    const pan = String(b.pan || '').toUpperCase(), aadhaar = String(b.aadhaar || '').replace(/\s/g, ''), ifsc = String(b.ifsc || '').toUpperCase(), acct = String(b.accountNumber || '');
    if (!kyc.validPan(pan)) throw new HttpError(400, 'PAN is not a valid individual PAN (AAAPA9999A)', 'KYC_PAN');
    if (!kyc.validAadhaar(aadhaar)) throw new HttpError(400, 'Aadhaar number failed checksum validation', 'KYC_AADHAAR');
    if (!kyc.validPhone(b.phone || '')) throw new HttpError(400, 'valid 10-digit mobile required', 'INVALID_INPUT');
    if (!kyc.validIfsc(ifsc) || !/^\d{9,18}$/.test(acct)) throw new HttpError(400, 'bank account / IFSC invalid', 'KYC_BANK');
    if (!kyc.verifyOtp(b.otp)) throw new HttpError(400, 'Aadhaar OTP incorrect', 'KYC_OTP');
    if (b.consentCreditPull !== true) throw new HttpError(400, 'consent to a credit-report pull is required', 'CONSENT');
    if (role === 'LENDER' && b.riskDeclaration !== true) throw new HttpError(400, 'lenders must declare they can lose their whole principal', 'DECLARATION');
    let borrowerFacts = null;
    if (role === 'BORROWER') {
        if (!(Number(b.monthlyIncomeRs) > 0)) throw new HttpError(400, 'monthly income required', 'INVALID_INPUT');
        if (!['SALARIED', 'SELF_EMPLOYED', 'BUSINESS'].includes(b.employment)) throw new HttpError(400, 'employment type required', 'INVALID_INPUT');
        borrowerFacts = { monthlyIncomePaise: rupees(b.monthlyIncomeRs, 'income'), existingEmiPaise: rupees(b.existingEmiRs || 0, 'existing EMI'), employment: b.employment };
    }
    const panHash = sec.hmac('pan', pan), bankHash = sec.hmac('bank', ifsc + acct);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(b.email.toLowerCase())) throw new HttpError(409, 'email already registered', 'DUPLICATE');
    if (db.prepare('SELECT 1 FROM users WHERE pan_hash=?').get(panHash)) throw new HttpError(409, 'this PAN is already registered (one identity, one role)', 'DUPLICATE_IDENTITY');
    if (db.prepare('SELECT 1 FROM users WHERE bank_hash=?').get(bankHash)) throw new HttpError(409, 'this bank account is linked to another identity', 'DUPLICATE_BANK');

    const participantId = sec.pseudonym(role, pan);
    const bureauScore = DEMO && Number(b.bureauScoreOverride) >= 300 ? Number(b.bureauScoreOverride) : kyc.mockBureauScore(pan);
    const now = new Date().toISOString();

    // 1) bank account with penny-drop  2) pseudonymous registration on chain  3) bank ref into the private data collection
    const acc = await bank('/api/accounts', { owner: participantId, kind: role, ifsc });
    const kycRef = sha256(JSON.stringify({ provider: 'MOCK-EKYC', panHash, verifiedAt: now }));
    const decl = role === 'LENDER' ? sha256(`I can lose my entire principal|${participantId}|${now}`) : '';
    try {
        await chain.submit('registry:register', [participantId, role, 'VERIFIED', kycRef, decl]);
    } catch (e) { if (e.code !== 'ALREADY_EXISTS') throw e; } // resume after a partial earlier attempt
    await chain.submit('registry:setBankAccountRef', [participantId], { transient: { bankAccount: { accountToken: acc.token, ifsc } } });

    const pii = sec.encrypt({ name: b.name.trim(), pan, aadhaar, phone: b.phone, ifsc, accountNumber: acct, email: b.email.toLowerCase(), bureauScore, consentCreditPullAt: now, declarationAt: role === 'LENDER' ? now : null, ...borrowerFacts });
    const r = db.prepare('INSERT INTO users(email, pw, role, participant_id, pan_hash, bank_hash, pii, created) VALUES(?,?,?,?,?,?,?,?)')
        .run(b.email.toLowerCase(), sec.hashPassword(b.password), role, participantId, panHash, bankHash, pii, now);
    db.prepare('INSERT INTO signals VALUES(?,?,?,?)').run(participantId, ipHash(req), 'SIGNUP', Date.now());
    res.json({ token: newSession(Number(r.lastInsertRowid)), role, participantId });
}));

app.post('/api/login', route(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').toLowerCase());
    if (!u || u.disabled || !sec.verifyPassword(String(req.body.password || ''), u.pw)) throw new HttpError(401, 'wrong email or password', 'AUTH');
    res.json({ token: newSession(u.id), role: u.role, participantId: u.participant_id });
}));

app.get('/api/me', authed(), route(async (req, res) => {
    const u = req.user;
    const base = { email: u.email, role: u.role, participantId: u.participant_id, simDate: await simDate() };
    if (u.role === 'ADMIN') return res.json(base);
    const p = getPii(u);
    let balancePaise = null;
    try { balancePaise = (await bank(`/api/balance/${u.participant_id}`)).balancePaise; } catch { /* bank offline */ }
    res.json({ ...base, name: p.name, pan: kyc.maskPan(p.pan), aadhaar: kyc.maskAadhaar(p.aadhaar), bureauScore: p.bureauScore, balancePaise, monthlyIncomePaise: p.monthlyIncomePaise, employment: p.employment });
}));

app.post('/api/demo/add-funds', authed('LENDER', 'BORROWER'), route(async (req, res) => {
    if (!DEMO) throw new HttpError(404, 'not available', 'NOT_FOUND');
    res.json(await bank('/api/demo/topup', { owner: req.user.participant_id, amountPaise: rupees(req.body.amountRs, 'amount') }));
}));

app.post('/api/demo/spend', authed('BORROWER', 'LENDER'), route(async (req, res) => {
    if (!DEMO) throw new HttpError(404, 'not available', 'NOT_FOUND');
    res.json(await bank('/api/demo/spend', { owner: req.user.participant_id, all: true }));
}));

// ---- borrower: request a loan
app.post('/api/loans', authed('BORROWER'), route(async (req, res) => {
    const b = req.body || {};
    const amount = rupees(b.amountRs, 'amount');
    const tenure = Number(b.tenureMonths);
    if (!Number.isInteger(tenure) || tenure < 1 || tenure > 36) throw new HttpError(400, 'tenure must be 1-36 months', 'INVALID_INPUT');
    if (!PURPOSES.includes(b.purposeCode)) throw new HttpError(400, `purpose must be one of ${PURPOSES.join(', ')}`, 'INVALID_INPUT');
    const maxAprBps = Math.round(Number(b.maxAprPct) * 100);
    if (!(maxAprBps > 0)) throw new HttpError(400, 'highest APR you will accept is required', 'INVALID_INPUT');

    const pii = getPii(req.user);
    const features = { bureauScore: pii.bureauScore, monthlyIncomePaise: pii.monthlyIncomePaise, existingEmiPaise: pii.existingEmiPaise, employment: pii.employment, amountPaise: amount, tenureMonths: tenure };
    const cs = credit.score(features);
    const since = Date.now() - 24 * 3600 * 1000;
    const recent = db.prepare("SELECT COUNT(*) c FROM applications WHERE borrower_id=? AND created > ?").get(req.user.participant_id, new Date(since).toISOString()).c;
    const sameIp = db.prepare('SELECT COUNT(DISTINCT participant_id) c FROM signals WHERE ip_hash=? AND at>?').get(ipHash(req), since).c;
    const fr = fraud.assess({ recentApps24h: recent, sameIpParticipants24h: sameIp, amountPaise: amount, monthlyIncomePaise: pii.monthlyIncomePaise, bureauScore: pii.bureauScore });
    const loanId = `LN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const pub = { name: kyc.maskName(pii.name), employment: pii.employment, incomeBand: incomeBand(pii.monthlyIncomePaise), bureauScore: pii.bureauScore };
    const status = cs.grade === 'E' ? 'DECLINED' : fr.reviewRequired ? 'PENDING_REVIEW' : 'LISTING';
    const note = status === 'DECLINED' ? 'Risk grade E is outside platform appetite (policy), not listed.' : status === 'PENDING_REVIEW' ? 'Held for manual fraud review.' : null;
    db.prepare('INSERT INTO applications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)').run(loanId, req.user.participant_id, amount, tenure, b.purposeCode, maxAprBps, status, cs.grade, cs.pd, cs.modelVersion,
        cs.suggestedAprBand.lowBps, cs.suggestedAprBand.highBps, JSON.stringify(cs.reasons), JSON.stringify(fr.flags), JSON.stringify(pub), note, new Date().toISOString());
    db.prepare('INSERT INTO signals VALUES(?,?,?,?)').run(req.user.participant_id, ipHash(req), 'APPLICATION', Date.now());
    const assessment = { grade: cs.grade, pd: cs.pd, suggestedAprBand: cs.suggestedAprBand, reasons: cs.reasons, modelVersion: cs.modelVersion, fraudFlags: fr.flags };
    if (status === 'DECLINED') return res.status(422).json({ error: note, code: 'DECLINED', loanId, assessment });
    if (status === 'PENDING_REVIEW') return res.json({ loanId, status, assessment });
    await listOnChain(db.prepare('SELECT * FROM applications WHERE loan_id=?').get(loanId));
    res.json({ loanId, status: 'LISTED', assessment });
}));

app.get('/api/loans/mine', authed('BORROWER', 'LENDER'), route(async (req, res) => {
    const id = req.user.participant_id;
    const loans = await chain.evaluate('loan:listForParty', id);
    const out = loans.map((l) => redact(req.user, l));
    if (req.user.role === 'BORROWER') {
        const pend = db.prepare("SELECT * FROM applications WHERE borrower_id=? AND status IN ('PENDING_REVIEW','DECLINED','REJECTED_COMPLIANCE')").all(id);
        return res.json({ loans: out, offChain: pend.map((a) => ({ id: a.loan_id, amountPaise: a.amount_paise, tenureMonths: a.tenure, status: a.status, grade: a.grade, note: a.note, createdAt: a.created })) });
    }
    res.json({ loans: out });
}));

app.get('/api/loans/:id', authed(), route(async (req, res) => {
    const loan = await loanOr404(req.params.id);
    const u = req.user;
    const bids = await chain.evaluate('bid:listByLoan', loan.id);
    const allowed = u.role === 'ADMIN' || (u.role === 'BORROWER' && loan.borrowerId === u.participant_id) || (u.role === 'LENDER' && (loan.status === 'LISTED' || loan.status === 'FUNDING' || bids.some((b) => b.lenderId === u.participant_id) || loan.allocations.some((a) => a.lenderId === u.participant_id)));
    if (!allowed) throw new HttpError(403, 'not your loan', 'FORBIDDEN');
    const info = appInfo(loan.id);
    const out = redact(u, loan, bids);
    out.info = info && { reasons: info.reasons, borrower: info.borrower, partialConsent: info.partialConsent, fraud: u.role === 'ADMIN' ? info.fraud : undefined };
    const ag = db.prepare('SELECT hash, created FROM agreements WHERE loan_id=?').get(loan.id);
    out.agreement = ag ? { hash: ag.hash, createdAt: ag.created, onChainHash: loan.agreementHash } : null;
    out.demandPaise = bids.filter((x) => x.status === 'OPEN').reduce((s, x) => s + x.amountPaise, 0);
    out.bidCount = bids.filter((x) => x.status === 'OPEN').length;
    if (u.role !== 'LENDER' || out.allocations.length) out.payouts = u.role === 'ADMIN' || u.role === 'BORROWER' ? undefined : (await chain.evaluate('repay:listPayouts', loan.id)).filter((p) => p.lenderId === u.participant_id);
    if (u.role === 'BORROWER' || u.role === 'ADMIN') out.receipts = await chain.evaluate('repay:listReceipts', loan.id);
    res.json(out);
}));

app.get('/api/loans/:id/agreement', authed(), route(async (req, res) => {
    const a = db.prepare('SELECT * FROM agreements WHERE loan_id=?').get(req.params.id);
    if (!a) throw new HttpError(404, 'no agreement yet', 'NOT_FOUND');
    const loan = await loanOr404(req.params.id);
    const u = req.user;
    if (u.role !== 'ADMIN' && loan.borrowerId !== u.participant_id && !loan.allocations.some((x) => x.lenderId === u.participant_id)) throw new HttpError(403, 'not a party', 'FORBIDDEN');
    res.json({ text: a.text, hash: a.hash, onChainHash: loan.agreementHash });
}));

// ---- lender: marketplace and bids
app.get('/api/market', authed('LENDER', 'ADMIN'), route(async (req, res) => {
    const loans = [...await chain.evaluate('loan:list', 'LISTED'), ...await chain.evaluate('loan:list', 'FUNDING')];
    const out = [];
    for (const l of loans) {
        const info = appInfo(l.id);
        const bids = await chain.evaluate('bid:listByLoan', l.id);
        const open = bids.filter((b) => b.status === 'OPEN');
        out.push({ id: l.id, status: l.status, amountPaise: l.amountPaise, tenureMonths: l.tenureMonths, purposeCode: l.purposeCode, maxAprBps: l.maxAprBps, riskGrade: l.riskGrade, modelVersion: l.modelVersion,
            suggestedAprBand: l.suggestedAprBand, biddingClosesOn: l.biddingClosesOn, bidCount: open.length, demandPaise: open.reduce((s, b) => s + b.amountPaise, 0),
            borrower: info && info.borrower, reasons: info && info.reasons.slice(0, 3), myBids: bids.filter((b) => b.lenderId === req.user.participant_id) });
    }
    res.json(out.sort((a, b) => (a.biddingClosesOn < b.biddingClosesOn ? -1 : 1)));
}));

app.post('/api/bids', authed('LENDER'), route(async (req, res) => {
    const amount = rupees(req.body.amountRs, 'amount');
    const apr = Math.round(Number(req.body.minAprPct) * 100);
    if (!(amount > 0) || !(apr > 0)) throw new HttpError(400, 'amount and lowest acceptable APR required', 'INVALID_INPUT');
    res.json(await chain.submit('bid:place', [req.body.loanId, req.user.participant_id, amount, apr]));
}));

app.get('/api/bids/mine', authed('LENDER'), route(async (req, res) => res.json(await chain.evaluate('bid:listByLender', req.user.participant_id))));

app.delete('/api/bids/:loanId/:bidId', authed('LENDER'), route(async (req, res) => {
    const bids = await chain.evaluate('bid:listByLoan', req.params.loanId);
    const b = bids.find((x) => x.id === req.params.bidId);
    if (!b || b.lenderId !== req.user.participant_id) throw new HttpError(404, 'bid not found', 'NOT_FOUND');
    res.json(await chain.submit('bid:withdraw', [req.params.loanId, req.params.bidId]));
}));

// ---- close bidding & match (platform operator)
app.post('/api/admin/loans/:id/match', authed('ADMIN'), route(async (req, res) => {
    const app0 = db.prepare('SELECT * FROM applications WHERE loan_id=?').get(req.params.id);
    const allowPartial = !!(req.body.allowPartial && app0 && app0.partial_consent);
    if (req.body.allowPartial && !allowPartial) throw new HttpError(409, 'borrower has not agreed to a smaller loan', 'CONSENT_REQUIRED');
    const r = await chain.submit('bid:closeAndMatch', [req.params.id, String(allowPartial)]);
    if (r.matched) buildAgreement(await loanOr404(req.params.id));
    res.json(r);
}));

app.post('/api/loans/:id/consent-partial', authed('BORROWER'), route(async (req, res) => {
    const loan = await loanOr404(req.params.id);
    if (loan.borrowerId !== req.user.participant_id) throw new HttpError(403, 'not your loan', 'FORBIDDEN');
    db.prepare('UPDATE applications SET partial_consent=1 WHERE loan_id=?').run(loan.id);
    res.json({ ok: true });
}));

app.post('/api/loans/:id/cancel', authed('BORROWER', 'ADMIN'), route(async (req, res) => {
    const loan = await loanOr404(req.params.id);
    if (req.user.role === 'BORROWER' && loan.borrowerId !== req.user.participant_id) throw new HttpError(403, 'not your loan', 'FORBIDDEN');
    if (loan.status === 'SIGNED') for (const [lenderId, e] of Object.entries(loan.escrow)) if (!e.refundedOn) await bank('/api/refund', { loanId: loan.id, lenderId });
    res.json(await chain.submit('loan:cancel', [loan.id, String(req.body.reason || `cancelled by ${req.user.role.toLowerCase()}`).slice(0, 150)]));
}));

// ---- e-sign (mock OTP) -> anchor agreement hash on chain
app.post('/api/loans/:id/sign', authed('BORROWER', 'LENDER'), route(async (req, res) => {
    const loan = await loanOr404(req.params.id);
    const me = req.user.participant_id;
    const parties = [loan.borrowerId, ...loan.allocations.map((a) => a.lenderId)];
    if (loan.status !== 'COMMITTED') throw new HttpError(409, `loan is ${loan.status}; signing opens once matched`, 'INVALID_STATE');
    if (!parties.includes(me)) throw new HttpError(403, 'not a party to this loan', 'FORBIDDEN');
    if (!kyc.verifyOtp(req.body.otp)) throw new HttpError(400, 'e-sign OTP incorrect', 'KYC_OTP');
    let ag = db.prepare('SELECT * FROM agreements WHERE loan_id=?').get(loan.id);
    if (!ag) ag = buildAgreement(loan);
    const at = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO signatures VALUES(?,?,?,?)').run(loan.id, me, `ESIGN-${sha256(`${me}|${ag.hash}|${at}`).slice(0, 20).toUpperCase()}`, at);
    const sigs = db.prepare('SELECT * FROM signatures WHERE loan_id=?').all(loan.id);
    if (parties.every((p) => sigs.some((s) => s.participant_id === p))) {
        await chain.submit('loan:recordSignatures', [loan.id, ag.hash, JSON.stringify(sigs.map((s) => ({ participantId: s.participant_id, eSignRef: s.esign_ref, signedAt: s.signed_at })))]);
        return res.json({ signed: true, allSigned: true });
    }
    res.json({ signed: true, allSigned: false, waitingFor: parties.length - sigs.length });
}));

// ---- lender pays slice into escrow (bank moves money, bank records it on chain)
app.post('/api/loans/:id/fund', authed('LENDER'), route(async (req, res) => {
    res.json(await bank('/api/lender-funding', { loanId: req.params.id, lenderId: req.user.participant_id }));
}));

app.get('/api/portfolio', authed('LENDER'), route(async (req, res) => {
    const id = req.user.participant_id;
    const [positions, payouts, bids] = await Promise.all([chain.evaluate('loan:lenderPosition', id), chain.evaluate('repay:lenderStatement', id), chain.evaluate('bid:listByLender', id)]);
    let balancePaise = null;
    try { balancePaise = (await bank(`/api/balance/${id}`)).balancePaise; } catch { /* offline */ }
    const sum = (k) => positions.reduce((s, p) => s + p[k], 0);
    res.json({ positions, payouts, bids, balancePaise, totals: { lentPaise: sum('amountPaise'), principalReturnedPaise: sum('principalReturnedPaise'), interestReceivedPaise: sum('interestReceivedPaise'), lossPaise: sum('lossPaise') } });
}));

// ---- admin
app.get('/api/admin/overview', authed('ADMIN'), route(async (req, res) => {
    const loans = await chain.evaluate('loan:list', '');
    const by = {};
    for (const l of loans) by[l.status] = (by[l.status] || 0) + 1;
    const out = (l) => l.schedule.reduce((s, r) => s + r.principalPaise - r.paidPrincipalPaise, 0);
    const active = loans.filter((l) => ACTIVE.includes(l.status));
    const npa = loans.filter((l) => l.status === 'NPA');
    const outstanding = active.reduce((s, l) => s + out(l), 0);
    const npaOut = npa.reduce((s, l) => s + out(l), 0);
    const flags = loans.flatMap((l) => l.flags.map((f) => ({ loanId: l.id, ...f })));
    const pending = db.prepare("SELECT loan_id, borrower_id, amount_paise, grade, fraud, created FROM applications WHERE status='PENDING_REVIEW'").all();
    res.json({ simDate: await simDate(), byStatus: by, outstandingPrincipalPaise: outstanding, npaPrincipalPaise: npaOut, gnpaPct: outstanding ? +((npaOut * 100) / outstanding).toFixed(2) : 0,
        t1Flags: flags, pendingReviews: pending.map((p) => ({ ...p, fraud: JSON.parse(p.fraud) })),
        loans: loans.map((l) => ({ id: l.id, borrowerId: l.borrowerId, status: l.status, amountPaise: l.amountPaise, aprBps: l.clearingAprBps, tenureMonths: l.tenureMonths, grade: l.riskGrade, dpd: l.dpd, lenders: l.allocations.length, createdAt: l.createdAt, partialConsent: !!(appInfo(l.id) || {}).partialConsent })) });
}));

app.post('/api/admin/applications/:id/approve', authed('ADMIN'), route(async (req, res) => {
    const a = db.prepare("SELECT * FROM applications WHERE loan_id=? AND status='PENDING_REVIEW'").get(req.params.id);
    if (!a) throw new HttpError(404, 'no application pending review', 'NOT_FOUND');
    await listOnChain(a);
    res.json({ listed: true });
}));
app.post('/api/admin/applications/:id/reject', authed('ADMIN'), route(async (req, res) => {
    db.prepare("UPDATE applications SET status='DECLINED', note='Rejected at manual review' WHERE loan_id=? AND status='PENDING_REVIEW'").run(req.params.id);
    res.json({ ok: true });
}));

// operator records that a lender's CA net-worth certificate is on file (needed once their exposure passes Rs 10 lakh)
app.post('/api/admin/lenders/:id/ca-certificate', authed('ADMIN'), route(async (req, res) => {
    res.json(await chain.submit('registry:setCaCertificate', [req.params.id, String(req.body.onFile !== false)]));
}));

app.post('/api/admin/loans/:id/write-off', authed('ADMIN'), route(async (req, res) => {
    res.json(await chain.submit('loan:writeOff', [req.params.id, String(req.body.reason || 'unrecoverable after collection efforts').slice(0, 150), await simDate()]));
}));

app.get('/api/admin/npa-report', authed('ADMIN'), route(async (req, res) => {
    const loans = [...await chain.evaluate('loan:list', 'NPA'), ...await chain.evaluate('loan:list', 'WRITTEN_OFF'), ...await chain.evaluate('loan:list', 'RECOVERED')];
    res.json({ asOf: await simDate(), rows: loans.map((l) => ({ loanId: l.id, status: l.status, grade: l.riskGrade, dpd: l.dpd, npaOn: l.npaOn, outstandingPrincipalPaise: l.schedule.reduce((s, r) => s + r.principalPaise - r.paidPrincipalPaise, 0), lenderLossPaise: l.loss ? l.loss.outstandingPrincipalPaise : 0, lenderLosses: l.loss ? l.loss.perLender : [] })),
        bureauReports: db.prepare('SELECT * FROM bureau_reports ORDER BY id DESC LIMIT 100').all() });
}));

// bank -> platform: the clock moved; refresh delinquency on every active loan (chain classifies NPA at >90 DPD)
app.post('/internal/clock', route(async (req, res) => {
    if (req.get('x-bank-key') !== BANK_KEY) throw new HttpError(401, 'bad key', 'AUTH');
    const date = req.body.date;
    simCache = { at: Date.now(), date };
    const results = [];
    for (const s of ACTIVE) {
        for (const l of await chain.evaluate('loan:list', s)) {
            const r = await chain.submit('loan:updateDelinquency', [l.id, date]);
            if (r.changed && r.status === 'NPA' && l.status !== 'NPA') {
                db.prepare('INSERT INTO bureau_reports(loan_id, kind, as_of, detail) VALUES(?,?,?,?)').run(l.id, 'NPA_REPORTED_TO_BUREAU', date, `DPD ${r.dpd}`);
            }
            if (r.changed) results.push({ loanId: l.id, status: r.status, dpd: r.dpd });
        }
    }
    res.json({ date, updated: results });
}));

// ---- DPDP right to erasure: purge private data on chain + encrypted PII off chain (only with no live loans)
app.post('/api/me/erase', authed('LENDER', 'BORROWER'), route(async (req, res) => {
    const loans = await chain.evaluate('loan:listForParty', req.user.participant_id);
    if (loans.some((l) => !['CLOSED', 'RECOVERED', 'WRITTEN_OFF', 'CANCELLED'].includes(l.status))) throw new HttpError(409, 'cannot erase while loans or bids are live (legal retention applies)', 'ACTIVE_OBLIGATIONS');
    await chain.submit('registry:erasePrivateData', [req.user.participant_id]);
    db.prepare("UPDATE users SET pii=?, disabled=1, email=? WHERE id=?").run(sec.encrypt({ erased: true }), `erased-${req.user.id}@erased.invalid`, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    res.json({ erased: true, note: 'Pseudonymous ledger records remain (they identify no one); the private bank reference was purged and PII deleted.' });
}));

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'common', 'public')));
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
    if (!db.prepare('SELECT 1 FROM users WHERE role=?').get('ADMIN')) {
        db.prepare("INSERT INTO users(email, pw, role, created) VALUES(?,?,'ADMIN',?)").run(ADMIN_EMAIL, sec.hashPassword(ADMIN_PASSWORD), new Date().toISOString());
        console.log(`[platform] created operator account ${ADMIN_EMAIL} (set ADMIN_PASSWORD to change)`);
    }
    chain = await connectOrg('platform');
    app.listen(PORT, HOST, () => console.log(`[platform] LendChain on http://${HOST}:${PORT}  (demo mode: ${DEMO})`));
})().catch((e) => { console.error(e); process.exit(1); });

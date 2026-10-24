'use strict';
/**
 * Module 1 - Participant registry.
 * Only pseudonymous IDs, KYC status and declaration hashes live on-chain.
 * Names, PAN, Aadhaar and documents stay in the platform's encrypted store in India.
 * Bank-account references go to a private data collection shared by Platform + Trustee only
 * (the Auditor peer sees just a hash) and can be purged to honour DPDP erasure requests.
 */
const { Contract } = require('fabric-contract-api');
const { MSP, requireMsp } = require('./lib/auth');
const { T, err, getJSON, putJSON, collect, asId, asHash } = require('./lib/store');
const { txTime } = require('./lib/loans');

const PDC = 'platformTrusteeBank';
const ROLES = ['LENDER', 'BORROWER'];
const KYC = ['PENDING', 'VERIFIED', 'REJECTED'];

class ParticipantRegistry extends Contract {
    constructor() {
        super('registry');
    }

    async register(ctx, id, role, kycStatus, kycRefHash, riskDeclarationHash) {
        requireMsp(ctx, MSP.PLATFORM);
        asId('id', id);
        if (!ROLES.includes(role)) throw err('INVALID_INPUT', `role must be one of ${ROLES}`);
        if (!KYC.includes(kycStatus)) throw err('INVALID_INPUT', `kycStatus must be one of ${KYC}`);
        const prefix = role === 'LENDER' ? 'LND-' : 'BRW-';
        if (!id.startsWith(prefix)) throw err('INVALID_INPUT', `${role} ids must start with ${prefix}`);
        asHash('kycRefHash', kycRefHash);
        if (role === 'LENDER') asHash('riskDeclarationHash', riskDeclarationHash);
        if (await getJSON(ctx, T.PARTICIPANT, [id])) throw err('ALREADY_EXISTS', `participant ${id} already registered`);

        const p = {
            id, role, kycStatus, kycRefHash,
            riskDeclarationHash: role === 'LENDER' ? riskDeclarationHash : null,
            caCertificateOnFile: false,
            piiErased: false,
            registeredAt: txTime(ctx),
        };
        await putJSON(ctx, T.PARTICIPANT, [id], p);
        ctx.stub.setEvent('ParticipantRegistered', Buffer.from(JSON.stringify({ id, role })));
        return JSON.stringify(p);
    }

    async setKycStatus(ctx, id, kycStatus) {
        requireMsp(ctx, MSP.PLATFORM);
        if (!KYC.includes(kycStatus)) throw err('INVALID_INPUT', `kycStatus must be one of ${KYC}`);
        const p = await getJSON(ctx, T.PARTICIPANT, [id], 'participant');
        p.kycStatus = kycStatus;
        await putJSON(ctx, T.PARTICIPANT, [id], p);
        return JSON.stringify(p);
    }

    /** Lender uploads a CA net-worth certificate; needed once exposure passes Rs 10 lakh. */
    async setCaCertificate(ctx, id, onFile) {
        requireMsp(ctx, MSP.PLATFORM);
        const p = await getJSON(ctx, T.PARTICIPANT, [id], 'participant');
        if (p.role !== 'LENDER') throw err('INVALID_INPUT', 'only lenders carry a CA certificate');
        p.caCertificateOnFile = onFile === 'true';
        await putJSON(ctx, T.PARTICIPANT, [id], p);
        return JSON.stringify(p);
    }

    async get(ctx, id) {
        return JSON.stringify(await getJSON(ctx, T.PARTICIPANT, [id], 'participant'));
    }

    async list(ctx, role) {
        const rows = await collect(ctx, T.PARTICIPANT);
        return JSON.stringify(rows.map((r) => r.value).filter((p) => !role || p.role === role));
    }

    // ---- private data: beneficiary bank account reference (Platform + Trustee only) ----------
    async setBankAccountRef(ctx, id) {
        requireMsp(ctx, MSP.PLATFORM);
        await getJSON(ctx, T.PARTICIPANT, [id], 'participant');
        const t = ctx.stub.getTransient();
        const raw = t.get('bankAccount');
        if (!raw) throw err('INVALID_INPUT', "transient field 'bankAccount' required");
        const obj = JSON.parse(Buffer.from(raw).toString());
        if (!obj.accountToken || !obj.ifsc) throw err('INVALID_INPUT', 'bankAccount needs accountToken and ifsc');
        await ctx.stub.putPrivateData(PDC, `acct~${id}`, Buffer.from(JSON.stringify({ accountToken: obj.accountToken, ifsc: obj.ifsc })));
        return 'ok';
    }

    async getBankAccountRef(ctx, id) {
        requireMsp(ctx, MSP.PLATFORM, MSP.TRUSTEE);
        const buf = await ctx.stub.getPrivateData(PDC, `acct~${id}`);
        if (!buf || buf.length === 0) throw err('NOT_FOUND', `no bank account reference for ${id}`);
        return buf.toString();
    }

    /** What the Auditor can see: only the hash of the private record. */
    async getBankAccountRefHash(ctx, id) {
        const h = await ctx.stub.getPrivateDataHash(PDC, `acct~${id}`);
        return h && h.length ? Buffer.from(h).toString('hex') : '';
    }

    /** DPDP right-to-erasure: purge the private record (Fabric >= 2.5) and flag the public record. */
    async erasePrivateData(ctx, id) {
        requireMsp(ctx, MSP.PLATFORM);
        const p = await getJSON(ctx, T.PARTICIPANT, [id], 'participant');
        if (typeof ctx.stub.purgePrivateData === 'function') await ctx.stub.purgePrivateData(PDC, `acct~${id}`);
        else await ctx.stub.deletePrivateData(PDC, `acct~${id}`);
        p.piiErased = true;
        await putJSON(ctx, T.PARTICIPANT, [id], p);
        return 'erased';
    }
}

module.exports = ParticipantRegistry;

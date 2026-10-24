'use strict';
/**
 * Fabric Gateway client shared by the platform backend, the (mock) trustee bank and the auditor.
 * Each organisation connects to ITS OWN peer with ITS OWN identity; the chaincode checks the
 * MSP of the caller, so a service can only do what its organisation is allowed to do.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { common } = require('@hyperledger/fabric-protos');

// Orgs whose peers must endorse transactions (see chaincode policy). After a commit we wait until the OTHER
// endorser has the block too, otherwise the next proposal can hit a peer that has not seen the previous write.
const ENDORSERS = ['platform', 'trustee'];

const PROFILE = process.env.LENDCHAIN_PROFILE || path.join(__dirname, '..', 'network', 'runtime', 'profile.json');

class ChainError extends Error {
    constructor(message, code, raw) {
        super(message);
        this.name = 'ChainError';
        this.code = code; // e.g. COMPLIANCE_VIOLATION, INVALID_STATE, UNAUTHORIZED ...
        this.raw = raw;
    }
}

function loadProfile() {
    if (!fs.existsSync(PROFILE)) throw new Error(`Fabric profile not found at ${PROFILE}. Run: network/network.sh up && network/network.sh deploy`);
    return JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
}

/** Pull the chaincode's own error text ("CODE[rule]: message") out of a gateway error. */
function normalise(err) {
    const texts = [];
    if (err && Array.isArray(err.details)) for (const d of err.details) if (d && d.message) texts.push(d.message);
    if (err && err.message) texts.push(err.message);
    for (const t of texts) {
        const m = /([A-Z][A-Z_]{3,}(?:\[[A-Z_]+\])?): ([^\n]*)/.exec(t);
        if (m && !/^(ENDORSE|COMMIT|SUBMIT)/.test(m[1])) return new ChainError(`${m[1]}: ${m[2]}`.replace(/\s+at\s.*$/, ''), m[1].replace(/\[.*$/, ''), err);
    }
    return err;
}

const isMvcc = (e) => e && (/MVCC_READ_CONFLICT|PHANTOM_READ_CONFLICT/.test(String(e.message)) || e.code === 11 || e.code === 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectOrg(org, { profile = loadProfile() } = {}) {
    const o = profile.orgs[org];
    if (!o) throw new Error(`unknown org '${org}'`);
    const tls = grpc.credentials.createSsl(fs.readFileSync(o.tlsCaCert));
    const client = new grpc.Client(o.peerEndpoint, tls, { 'grpc.max_receive_message_length': 32 * 1024 * 1024 });
    const privateKey = crypto.createPrivateKey(fs.readFileSync(o.keyPath));
    const gateway = connect({
        client,
        identity: { mspId: o.mspId, credentials: fs.readFileSync(o.certPath) },
        signer: signers.newPrivateKeySigner(privateKey),
        evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
        endorseOptions: () => ({ deadline: Date.now() + 20000 }),
        submitOptions: () => ({ deadline: Date.now() + 20000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    const network = gateway.getNetwork(profile.channel);

    // lightweight height probes to the other endorsing peers (same identity, qscc system chaincode)
    const probes = ENDORSERS.filter((n) => n !== org && profile.orgs[n]).map((n) => {
        const po = profile.orgs[n];
        const pc = new grpc.Client(po.peerEndpoint, grpc.credentials.createSsl(fs.readFileSync(po.tlsCaCert)));
        const pg = connect({ client: pc, identity: { mspId: o.mspId, credentials: fs.readFileSync(o.certPath) }, signer: signers.newPrivateKeySigner(privateKey), evaluateOptions: () => ({ deadline: Date.now() + 5000 }) });
        return { name: n, client: pc, gateway: pg, qscc: pg.getNetwork(profile.channel).getContract('qscc') };
    });
    async function peerHeight(p) {
        const raw = await p.qscc.evaluateTransaction('GetChainInfo', profile.channel);
        return Number(common.BlockchainInfo.deserializeBinary(raw).getHeight());
    }
    /** wait (bounded) until every other endorsing peer has committed `blockNumber` */
    async function syncPeers(blockNumber, timeoutMs = 8000) {
        const t0 = Date.now();
        for (const p of probes) {
            for (;;) {
                try { if ((await peerHeight(p)) > blockNumber) break; } catch { /* peer briefly unavailable: keep polling */ }
                if (Date.now() - t0 > timeoutMs) break;
                await sleep(25);
            }
        }
    }
    const contracts = new Map();
    const ns = (fqn) => {
        const [space, fn] = fqn.split(':');
        if (!contracts.has(space)) contracts.set(space, network.getContract(profile.chaincode, space));
        return [contracts.get(space), fn];
    };
    const parse = (buf) => {
        const s = Buffer.from(buf).toString('utf8');
        if (!s) return null;
        try { return JSON.parse(s); } catch { return s; }
    };

    return {
        org, mspId: o.mspId, network, profile,
        /** read-only query served by this org's own peer */
        async evaluate(fqn, ...args) {
            const [c, fn] = ns(fqn);
            try { return parse(await c.evaluateTransaction(fn, ...args.map(String))); } catch (e) { throw normalise(e); }
        },
        /** endorse (Platform + Trustee peers), order, wait for commit. Retries MVCC conflicts. */
        async submit(fqn, args = [], { transient, retries = 6 } = {}) {
            const [c, fn] = ns(fqn);
            let last;
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const proposal = c.newProposal(fn, {
                        arguments: args.map(String),
                        transientData: transient ? Object.fromEntries(Object.entries(transient).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))])) : undefined,
                    });
                    const tx = await proposal.endorse();
                    const submitted = await tx.submit();
                    const status = await submitted.getStatus();
                    if (!status.successful) {
                        const e = new Error(`transaction ${status.transactionId} failed to commit: code ${status.code}`);
                        e.code = status.code;
                        throw e;
                    }
                    const result = parse(tx.getResult());
                    await syncPeers(Number(status.blockNumber));
                    return Object.assign(Object(result) === result ? result : { value: result }, { __txId: status.transactionId, __block: Number(status.blockNumber) });
                } catch (e) {
                    last = e;
                    if (isMvcc(e) && attempt < retries) { await sleep(60 + Math.random() * 120 * (attempt + 1)); continue; }
                    throw normalise(e);
                }
            }
            throw normalise(last);
        },
        /** stream of chaincode events (loan status changes, ...) */
        events(opts = {}) { return network.getChaincodeEvents(profile.chaincode, opts); },
        close() { gateway.close(); client.close(); for (const p of probes) { p.gateway.close(); p.client.close(); } },
    };
}

/** convenience: rupees <-> paise */
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => paise / 100;

module.exports = { connectOrg, loadProfile, ChainError, toPaise, toRupees };

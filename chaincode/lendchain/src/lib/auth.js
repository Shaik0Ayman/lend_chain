'use strict';
/**
 * Role enforcement. The endorsement policy says WHO must sign a transaction;
 * these checks say WHO may even propose each kind of state change.
 *   Platform  : listings, bids, matching, contracts, delinquency
 *   Trustee   : anything that asserts a rupee actually moved (escrow credit, disbursal, EMI receipt, payout)
 *   Auditor   : read-only
 */
const { err } = require('./store');

const MSP = Object.freeze({ PLATFORM: 'PlatformMSP', TRUSTEE: 'TrusteeMSP', AUDITOR: 'AuditorMSP' });

function requireMsp(ctx, ...allowed) {
    const msp = ctx.clientIdentity.getMSPID();
    if (!allowed.includes(msp)) {
        throw err('UNAUTHORIZED', `${msp} may not perform this action (allowed: ${allowed.join(', ')})`);
    }
    return msp;
}

module.exports = { MSP, requireMsp };

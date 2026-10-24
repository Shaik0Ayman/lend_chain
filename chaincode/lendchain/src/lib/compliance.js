'use strict';
/**
 * Compliance guard. Hard limits drawn from the RBI NBFC-P2P Master Direction as
 * summarised in the LendChain proposal. All amounts in paise, rates in bps.
 * Cross-platform totals cannot be seen by one ledger; those rely on self-certificates
 * and bureau data off-chain (see README "Known limitations").
 */

const LIMITS = Object.freeze({
    MAX_LENDER_PER_BORROWER_PAISE: 50_000 * 100, // Rs 50,000 per lender -> borrower
    MAX_BORROWER_TOTAL_PAISE: 10_00_000 * 100, // Rs 10 lakh per borrower (this platform)
    MAX_LENDER_TOTAL_PAISE: 50_00_000 * 100, // Rs 50 lakh per lender (this platform)
    LENDER_CA_CERT_ABOVE_PAISE: 10_00_000 * 100, // net-worth certificate above Rs 10 lakh
    MAX_TENURE_MONTHS: 36,
    MIN_TENURE_MONTHS: 1,
    MIN_LOAN_PAISE: 5_000 * 100, // platform policy (not RBI): Rs 5,000 floor
    MAX_APR_BPS: 3600, // platform policy ceiling pending legal view on state usury laws
    T_PLUS_DAYS: 1, // escrow funds must leave within T+1
    NPA_DPD: 90,
});

class ComplianceError extends Error {
    constructor(rule, msg) {
        super(`COMPLIANCE_VIOLATION[${rule}]: ${msg}`);
        this.rule = rule;
    }
}
const inr = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;

function assertListing({ amountPaise, tenureMonths, maxAprBps, borrowerExposurePaise }) {
    if (tenureMonths > LIMITS.MAX_TENURE_MONTHS || tenureMonths < LIMITS.MIN_TENURE_MONTHS) {
        throw new ComplianceError('TENURE', `tenure ${tenureMonths}m outside ${LIMITS.MIN_TENURE_MONTHS}-${LIMITS.MAX_TENURE_MONTHS} months`);
    }
    if (amountPaise < LIMITS.MIN_LOAN_PAISE) {
        throw new ComplianceError('MIN_LOAN', `loan below platform minimum ${inr(LIMITS.MIN_LOAN_PAISE)}`);
    }
    if (borrowerExposurePaise + amountPaise > LIMITS.MAX_BORROWER_TOTAL_PAISE) {
        throw new ComplianceError('BORROWER_CAP',
            `borrower total would be ${inr(borrowerExposurePaise + amountPaise)}, cap ${inr(LIMITS.MAX_BORROWER_TOTAL_PAISE)}`);
    }
    if (maxAprBps <= 0 || maxAprBps > LIMITS.MAX_APR_BPS) {
        throw new ComplianceError('APR_CEILING', `max APR ${maxAprBps / 100}% outside (0, ${LIMITS.MAX_APR_BPS / 100}%]`);
    }
}

function assertBid({ amountPaise, minAprBps, pairExposurePaise, lenderExposurePaise, caCertificateOnFile }) {
    if (minAprBps <= 0 || minAprBps > LIMITS.MAX_APR_BPS) {
        throw new ComplianceError('APR_CEILING', `bid APR ${minAprBps / 100}% outside (0, ${LIMITS.MAX_APR_BPS / 100}%]`);
    }
    if (pairExposurePaise + amountPaise > LIMITS.MAX_LENDER_PER_BORROWER_PAISE) {
        throw new ComplianceError('LENDER_PER_BORROWER_CAP',
            `lender exposure to this borrower would be ${inr(pairExposurePaise + amountPaise)}, cap ${inr(LIMITS.MAX_LENDER_PER_BORROWER_PAISE)}`);
    }
    const total = lenderExposurePaise + amountPaise;
    if (total > LIMITS.MAX_LENDER_TOTAL_PAISE) {
        throw new ComplianceError('LENDER_TOTAL_CAP', `lender total would be ${inr(total)}, cap ${inr(LIMITS.MAX_LENDER_TOTAL_PAISE)}`);
    }
    if (total > LIMITS.LENDER_CA_CERT_ABOVE_PAISE && !caCertificateOnFile) {
        throw new ComplianceError('CA_CERTIFICATE', `lender total above ${inr(LIMITS.LENDER_CA_CERT_ABOVE_PAISE)} needs a CA net-worth certificate on file`);
    }
}

module.exports = { LIMITS, ComplianceError, assertListing, assertBid };

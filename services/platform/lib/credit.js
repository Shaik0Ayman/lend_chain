'use strict';
/**
 * Explainable credit scorecard + APR band advice.
 *
 * IMPORTANT - this is a hand-set, ILLUSTRATIVE logistic scorecard, not a trained model. It exists so the
 * pipeline (grade -> chain, reason codes -> lender screen, APR band -> advice only) works end to end.
 * Replace `score()` with a model trained on bureau + bank-statement data (see README "AI roadmap"),
 * keeping the same output contract. Because the model is additive in log-odds, the per-feature
 * contributions below ARE exact Shapley values (the SHAP of a linear model), so explanations are faithful.
 *
 * Guardrails from the proposal: it advises, the lender decides (suggestions never auto-place a bid), and
 * the method is simple enough to publish.
 */
const { monthlyEmi } = require('./money');

const MODEL_VERSION = 'scorecard-v0.1-heuristic';
const COST_OF_FUNDS_BPS = 700; // lender opportunity cost ~ fixed-deposit yield
const MARGIN_BPS = 150;
const LGD = 0.85; // unsecured, thin recovery
const BAND_WIDTH_BPS = 300;

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const EMP = { SALARIED: -0.3, SELF_EMPLOYED: 0.1, BUSINESS: 0.2 };

/**
 * features: { bureauScore, monthlyIncomePaise, existingEmiPaise, employment, amountPaise, tenureMonths }
 */
function score(f) {
    const income = Math.max(f.monthlyIncomePaise, 1);
    const midApr = 1500;
    const newEmi = monthlyEmi(f.amountPaise, midApr, f.tenureMonths);
    const foir = (f.existingEmiPaise + newEmi) / income; // fixed-obligation-to-income
    const loanToAnnualIncome = f.amountPaise / (income * 12);

    const terms = [
        ['Credit bureau score', -0.012 * (f.bureauScore - 700), f.bureauScore, 'points'],
        ['Obligations-to-income after this loan', 3.0 * (foir - 0.35), Math.round(foir * 100), '%'],
        ['Loan size vs annual income', 0.8 * (loanToAnnualIncome - 0.3), Math.round(loanToAnnualIncome * 100), '%'],
        ['Employment type', EMP[f.employment] ?? 0.2, f.employment, ''],
        ['Tenure', 0.01 * (f.tenureMonths - 12), f.tenureMonths, 'months'],
    ];
    const intercept = -2.9;
    const logit = intercept + terms.reduce((s, t) => s + t[1], 0);
    const pd = sigmoid(logit);
    const grade = pd < 0.03 ? 'A' : pd < 0.06 ? 'B' : pd < 0.10 ? 'C' : pd < 0.16 ? 'D' : 'E';
    const expectedLoss = pd * LGD;
    const baseBps = Math.round(COST_OF_FUNDS_BPS + expectedLoss * 10000 + MARGIN_BPS);
    const low = Math.round(baseBps / 50) * 50;
    const reasons = terms.map(([label, contrib, value, unit]) => ({ factor: label, value: `${value}${unit && unit !== '' ? ' ' + unit : ''}`.trim(), effectOnRisk: Math.round(contrib * 1000) / 1000, direction: contrib > 0.02 ? 'raises risk' : contrib < -0.02 ? 'lowers risk' : 'neutral' }))
        .sort((a, b) => Math.abs(b.effectOnRisk) - Math.abs(a.effectOnRisk));
    return {
        modelVersion: MODEL_VERSION, grade, pd: Math.round(pd * 10000) / 10000, expectedLoss: Math.round(expectedLoss * 10000) / 10000,
        suggestedAprBand: { lowBps: Math.min(low, 3500), highBps: Math.min(low + BAND_WIDTH_BPS, 3600) },
        foir: Math.round(foir * 1000) / 1000, reasons, assumptions: { costOfFundsBps: COST_OF_FUNDS_BPS, marginBps: MARGIN_BPS, lgd: LGD },
    };
}

module.exports = { score, MODEL_VERSION };

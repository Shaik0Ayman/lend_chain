'use strict';
/** Rule-based fraud / identity checks run before a listing reaches the chain. */

/**
 * ctx: { recentApps24h, sameIpParticipants24h, amountPaise, monthlyIncomePaise, bureauScore }
 * returns { flags: [{rule, detail, severity}], reviewRequired }
 */
function assess(ctx) {
    const flags = [];
    if (ctx.recentApps24h >= 3) flags.push({ rule: 'VELOCITY', detail: `${ctx.recentApps24h} applications in 24h`, severity: 'high' });
    // tiered: a family sharing one device/NAT is plausible (advisory); a ring of 5+ identities is not (blocks listing)
    if (ctx.sameIpParticipants24h >= 5) flags.push({ rule: 'SHARED_DEVICE', detail: `${ctx.sameIpParticipants24h} distinct identities from one device/network address in 24h`, severity: 'high' });
    else if (ctx.sameIpParticipants24h >= 3) flags.push({ rule: 'SHARED_DEVICE', detail: `${ctx.sameIpParticipants24h} distinct identities from one device/network address in 24h`, severity: 'medium' });
    if (ctx.amountPaise > ctx.monthlyIncomePaise * 36) flags.push({ rule: 'AMOUNT_VS_INCOME', detail: 'requested amount exceeds 3 years of stated income', severity: 'high' });
    if (ctx.bureauScore < 600) flags.push({ rule: 'THIN_OR_POOR_BUREAU', detail: `bureau score ${ctx.bureauScore}`, severity: 'medium' });
    return { flags, reviewRequired: flags.some((f) => f.severity === 'high') };
}

module.exports = { assess };

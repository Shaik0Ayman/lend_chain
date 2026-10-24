'use strict';
/** Business dates are ISO `YYYY-MM-DD` strings supplied by the caller (bank value dates),
 *  never wall-clock time, so endorsing peers stay deterministic. */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parse(d) {
    if (typeof d !== 'string' || !ISO.test(d)) throw new Error(`INVALID_INPUT: bad date '${d}', expected YYYY-MM-DD`);
    const [y, m, day] = d.split('-').map(Number);
    const t = Date.UTC(y, m - 1, day);
    const back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) {
        throw new Error(`INVALID_INPUT: impossible date '${d}'`);
    }
    return t;
}

const fmt = (t) => new Date(t).toISOString().slice(0, 10);

/** whole days from a to b (b - a) */
function diffDays(a, b) {
    return Math.round((parse(b) - parse(a)) / 86400000);
}

/** Add months, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
function addMonths(d, n) {
    const [y, m, day] = d.split('-').map(Number);
    const total = (m - 1) + n;
    const ty = y + Math.floor(total / 12);
    const tm = ((total % 12) + 12) % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return fmt(Date.UTC(ty, tm, Math.min(day, last)));
}

const addDays = (d, n) => fmt(parse(d) + n * 86400000);

module.exports = { parse, diffDays, addMonths, addDays };

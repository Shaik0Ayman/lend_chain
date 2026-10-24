'use strict';
/**
 * Deployment-mode settings shared by the three services.
 *
 *   LISTEN_HOST        interface to bind (default 127.0.0.1: nothing is reachable from the network unless a
 *                      reverse proxy / tunnel on the same machine forwards to it). Set 0.0.0.0 only on purpose.
 *   LENDCHAIN_PUBLIC=1 "internet-facing" mode: refuses to start with the demo default keys / admin password.
 */
const HOST = process.env.LISTEN_HOST || '127.0.0.1';
const PUBLIC = process.env.LENDCHAIN_PUBLIC === '1';
const WEAK = new Set(['dev-bank-key', 'dev-audit-key', 'auditor-demo', 'admin12345', 'password123']);

function requireStrong(names) {
    if (!PUBLIC) return;
    const bad = names.filter((n) => !process.env[n] || WEAK.has(process.env[n]) || process.env[n].length < 12);
    if (bad.length) {
        console.error(`[config] LENDCHAIN_PUBLIC=1 needs strong values (>= 12 chars, not the demo defaults) for: ${bad.join(', ')}\n` +
            '         run deploy/install.sh, which generates them, or set them in ~/.lendchain.env');
        process.exit(1);
    }
}

module.exports = { HOST, PUBLIC, requireStrong };

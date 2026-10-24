// tiny shared helpers for the three LendChain UIs
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inr = (paise, d = 2) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (bps) => (bps / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const statusClass = (s) => ({ LISTED: '', FUNDING: '', COMMITTED: 'warn', SIGNED: 'warn', DISBURSED: 'ok', REPAYING: 'ok', CLOSED: 'mut', RECOVERED: 'ok', NPA: 'bad', WRITTEN_OFF: 'bad', CANCELLED: 'mut' }[s] || '');
const pill = (s) => `<span class="pill ${statusClass(s)}">${esc(s)}</span>`;
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { return null; } }

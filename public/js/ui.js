export const paint = () => window.lucide?.createIcons();
export const ico = (n) => `<i data-lucide="${n}" aria-hidden="true"></i>`;
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toggleTheme() {
  const d = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('openframe_theme', d ? 'dark' : 'light'); } catch { /* preference only */ }
}

let toasts;
export function toast(msg, bad = false) {
  if (!toasts) { toasts = document.createElement('div'); toasts.className = 'toasts'; toasts.setAttribute('role', 'status'); document.body.append(toasts); }
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; toasts.append(t);
  setTimeout(() => t.remove(), 3600);
}

export function modal(html) {
  const o = document.createElement('div'); o.className = 'modal-backdrop';
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">${ico('x')}</button>${html}</div>`;
  const el = o.firstChild;
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  el.querySelector('.modal-close').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(o); paint();
  el.querySelector('input:not([type=radio]),textarea')?.focus();
  return { el, close };
}

export function confirmDialog(msg, label = 'Delete') {
  return new Promise((res) => {
    const m = modal(`<h2>Are you sure?</h2><p class="mut">${esc(msg)}</p><div class="row end"><button class="btn" data-n>Cancel</button><button class="btn danger solid" data-y>${esc(label)}</button></div>`);
    m.el.querySelector('[data-n]').onclick = () => { m.close(); res(false); };
    m.el.querySelector('[data-y]').onclick = () => { m.close(); res(true); };
    m.el.querySelector('.modal-close').addEventListener('click', () => res(false));
  });
}

export async function copyText(text, msg = 'Link copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove();
    if (!ok) { toast('Copy failed. Select the link manually.', true); return false; }
  }
  toast(msg); return true;
}

/* shell: header (brand, meta, theme) + main + optional footer */
export function shell(inner, { meta = '', room = false } = {}) {
  document.getElementById('app').innerHTML = `<div class="shell${room ? ' room' : ''}">
    <header class="head"><a class="brand" href="/" data-link aria-label="Openframe home"><img class="glyph" src="/favicon.svg" alt=""><span>Openframe</span></a>
      <div class="head-r">${meta || '<a class="plain" href="/about" data-link>About</a>'}<button class="sq" id="theme" aria-label="Toggle dark mode">${ico('sun-moon')}</button></div></header>
    ${inner}${room ? '' : '<footer class="foot"><span>Temporary pages for quick handoffs.</span><span>No account needed</span></footer>'}</div>`;
  document.getElementById('theme').onclick = toggleTheme;
  paint();
}

export const fmtTime = (ts) => ts ? ts.toDate().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
export const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
export function fmtLeft(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return d ? `${d}d ${h}h` : h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

export function qrPng(text, scale = 10, margin = 2) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), size = (n + margin * 2) * scale, c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#071635';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + margin) * scale, (r + margin) * scale, scale, scale);
  return c.toDataURL('image/png');
}

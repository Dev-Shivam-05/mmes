// Shared by app.js (the dashboard) and pnl.js (the daily paper P&L page): formatting, theme tokens, the header,
// the tooltip, data loading and the on-demand ECharts loader. No framework, no build step, every URL relative.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const UI_FONT = 'Inter, system-ui, sans-serif';
export const NUM_FONT = '"JetBrains Mono", Inter, ui-monospace, Consolas, monospace';

// ---------- Formatting (row 8: Indian grouping, + / − signs) ----------
export const MINUS = '−';
// Indian grouping (12,34,567.89) without Intl: building an 'en-IN' Intl.NumberFormat loads ICU locale data and
// cost about 280 ms of main thread on a throttled phone (row 10). Same output as Intl's en-IN, half-up rounding
// on the shortest decimal form of the number (2.675 -> 2.68), "-" for negatives; .format() keeps the call sites.
function groupIN(int) {
  if (int.length <= 3) return int;
  let head = int.slice(0, -3);
  const parts = [];
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) parts.unshift(head);
  return `${parts.join(',')},${int.slice(-3)}`;
}
function formatIN(v, dp) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : (n < 0 ? '-∞' : '∞');
  const a = Math.abs(n);
  if (a >= 1e15) return (n < 0 ? '-' : '') + groupIN(a.toFixed(0)) + (dp ? `.${'0'.repeat(dp)}` : '');
  // Below 1e-6 String() switches to exponent form; such a value rounds to 0 at 0 or 2 decimals anyway.
  const r = a < 1e-6 ? 0 : Math.round(Number(`${a}e${dp}`));
  const s = String(r).padStart(dp + 1, '0');
  const int = dp ? s.slice(0, -dp) : s;
  const out = groupIN(int) + (dp ? `.${s.slice(-dp)}` : '');
  // Like Intl: any negative input keeps its sign, even when it rounds to zero ("-0").
  return n < 0 || Object.is(n, -0) ? `-${out}` : out;
}
export const nf0 = { format: (v) => formatIN(v, 0) };
export const nf2 = { format: (v) => formatIN(v, 2) };
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rupees = (v) => '₹' + nf0.format(Math.abs(Math.round(v)));
export function signed(v) {
  const r = Math.round(v);
  if (r === 0) return '₹0';
  return (r > 0 ? '+' : MINUS) + '₹' + nf0.format(Math.abs(r));
}
export const signedPts = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + nf2.format(Math.abs(v));
// Keep a signed amount on one line inside a sentence ("−₹8,700" must not break after the sign).
export const nowrapMoney = (html) => html.replace(/([+−]?₹[0-9,]+)/g, '<span class="nw">$1</span>');
export const tone = (v) => (v == null ? '' : Math.round(v) > 0 ? 'pos' : Math.round(v) < 0 ? 'neg' : '');
export const p2 = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : nf2.format(Number(v)));
export const pct1 = (v) => `${Number(v).toFixed(1)}%`;

export function parseD(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d || 1));
}
export const fmtDate = (s) => { const d = parseD(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const fmtDateShort = (s) => { const d = parseD(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const fmtDateWd = (s) => `${WD[parseD(s).getUTCDay()]} ${fmtDate(s)}`;
export const fmtMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MON[m - 1]} ${y}`; };
// ECharts parses 'YYYY-MM-DD' as LOCAL midnight, so a time-axis value must be read back with local getters.
export const isoOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const localMs = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const dateOf = (v) => (typeof v === 'number' ? isoOf(v) : String(v).slice(0, 10));
export const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
export const addDays = (iso, n) => new Date(parseD(iso).getTime() + n * 864e5).toISOString().slice(0, 10);

// IST is UTC+05:30 all year (India has no daylight saving), so plain arithmetic replaces an Intl time-zone
// formatter, whose ICU time-zone data cost about 60 ms on a throttled phone (row 10).
const IST_MS = 330 * 60000;
export function todayIST() {
  return new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
}
export function fmtIST(iso) {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} IST`;
}
export function inDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}
// Axis labels in lakh / thousand, the way the owner reads money.
export function compactINR(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  if (a >= 1e5) return `${sign}₹${+(a / 1e5).toFixed(a % 1e5 === 0 ? 0 : 1)}L`;
  if (a >= 1e3) return `${sign}₹${+(a / 1e3).toFixed(0)}K`;
  return `${sign}₹${a}`;
}
// Option times arrive as "09:15", "0915" or 915; the charts use "09:15".
export function hm(t) {
  const s = String(t).trim();
  if (s.includes(':')) { const [h, m] = s.split(':'); return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`; }
  const p = s.padStart(4, '0');
  return `${p.slice(0, 2)}:${p.slice(2, 4)}`;
}
export const minutesOf = (t) => { const [h, m] = hm(t).split(':').map(Number); return h * 60 + m; };
export const hmOf = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// ---------- Theme tokens (rows 6 / 6a), read from CSS so the charts follow the toggle ----------
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function theme() {
  return {
    bg: cssVar('--bg'), panel: cssVar('--panel'), subtle: cssVar('--subtle'), inset: cssVar('--inset'),
    text: cssVar('--text'), muted: cssVar('--muted'), faint: cssVar('--faint'), accent: cssVar('--accent'),
    profit: cssVar('--profit'), loss: cssVar('--loss'), warning: cssVar('--warning'), border: cssVar('--border'),
    borderStrong: cssVar('--border-strong'), merged: cssVar('--s-merged'), wash: cssVar('--accent-wash'),
  };
}
export function rgbOf(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
export const rgba = (hex, a) => { const [r, g, b] = rgbOf(hex); return `rgba(${r},${g},${b},${a})`; };
// Diverging scale of row 6a: loss -> bg-inset at 0 -> profit.
export function divColor(v, max, c) {
  const t = Math.max(-1, Math.min(1, v / (max || 1)));
  const a = rgbOf(c.inset);
  const b = rgbOf(t >= 0 ? c.profit : c.loss);
  const k = Math.abs(t);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * k)).join(',')})`;
}

export const INFO_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.3v4.2M8 4.6v.2" stroke-linecap="round"/></svg>';
// Row 8: every metric has a one-line ⓘ tooltip.
export const infoBtn = (label, text) => `<button type="button" class="info" data-tip="${esc(text)}" aria-label="${esc(label)}: ${esc(text)}">${INFO_SVG}</button>`;

// ---------- Data ----------
export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
  return r.json();
}

// Row 13 plus the lead's client rule: a daily job that stopped running never sets meta.stale, so the page also
// counts the days since the newest bhavcopy itself (more than 4 calendar days = stale since the day after it).
export function staleOf(m) {
  if (!m) return { stale: false };
  if (m.stale) return { stale: true, since: m.staleSince || m.bhavLatest };
  if (m.bhavLatest && daysBetween(m.bhavLatest, todayIST()) > 4) return { stale: true, since: addDays(m.bhavLatest, 1) };
  return { stale: false };
}
export function renderFreshness(m) {
  const foot = $('#footerData');
  if (!m) { foot.textContent = 'Data date unknown: data/meta.json did not load.'; return; }
  const when = m.updatedAt || m.generatedAt;
  foot.textContent = `Data as of ${fmtDate(m.bhavLatest)} · updated ${when ? fmtIST(when) : 'unknown'}`;
  const st = staleOf(m);
  if (st.stale) {
    const banner = $('#staleBanner');
    banner.textContent = `Data stale since ${fmtDate(st.since)}`;
    banner.hidden = false;
  }
}

// ---------- Header: menu, theme toggle, current-section highlight ----------
export function setupHeader({ onTheme = () => {}, sections = true } = {}) {
  const btn = $('#menuBtn');
  const list = $('#navList');
  const close = () => { list.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    const open = !list.classList.contains('open');
    // The stale banner can sit above the header, so the menu opens under the header's real bottom edge.
    list.style.top = `${Math.round($('#top').getBoundingClientRect().bottom)}px`;
    list.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  });
  list.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && list.classList.contains('open')) { close(); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) close(); });
  window.matchMedia('(min-width: 821px)').addEventListener('change', close);

  const themeBtn = $('#themeBtn');
  const syncThemeBtn = () => {
    const t = document.documentElement.getAttribute('data-theme');
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    $('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#07090D' : '#F4F5F8');
  };
  syncThemeBtn();
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('mmes-theme', next); } catch (e) { /* private mode: the choice lasts this visit */ }
    syncThemeBtn();
    onTheme();
  });

  if (!sections) return;
  const links = new Map($$('.nav-list a[href^="#"]').map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((a) => a.removeAttribute('aria-current'));
      links.get(en.target.id)?.setAttribute('aria-current', 'true');
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  $$('main section[id]').forEach((s) => io.observe(s));
}

// ---------- Tooltip (info buttons and anything with data-tip-html) ----------
const tipEl = () => $('#tip');
let tipOwner = null;
export function showTip(el, html) {
  const tip = tipEl();
  tipOwner = el;
  tip.innerHTML = html;
  tip.hidden = false;
  if (el.classList.contains('info')) el.setAttribute('aria-describedby', 'tip');
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}
export function hideTip() {
  if (tipOwner) tipOwner.removeAttribute('aria-describedby');
  tipOwner = null;
  tipEl().hidden = true;
}
const tipHTML = (el) => (el.classList.contains('info') ? esc(el.dataset.tip) : el.dataset.tipHtml || '');
export function setupTips() {
  const target = (e) => e.target.closest?.('.info, [data-tip-html]');
  document.addEventListener('pointerover', (e) => { const el = target(e); if (el && e.pointerType === 'mouse') showTip(el, tipHTML(el)); });
  document.addEventListener('pointerout', (e) => { const el = target(e); if (el && e.pointerType === 'mouse' && !el.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('.info'); if (el) showTip(el, tipHTML(el)); });
  document.addEventListener('focusout', (e) => { if (e.target.closest('.info')) hideTip(); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.info');
    if (el) { e.preventDefault(); e.stopPropagation(); if (tipOwner === el && e.pointerType !== 'mouse') hideTip(); else showTip(el, tipHTML(el)); return; }
    const sq = e.target.closest('[data-tip-html]');
    if (sq && e.pointerType && e.pointerType !== 'mouse' && !sq.classList.contains('on')) { showTip(sq, tipHTML(sq)); return; }
    hideTip();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });
}

// ---------- On-demand work (row 10: nothing below the fold is built or loaded at page load) ----------
let echartsP = null;
export function loadECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (!echartsP) {
    echartsP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/echarts.min.js';
      s.onload = () => resolve(window.echarts);
      s.onerror = () => { echartsP = null; reject(new Error('vendor/echarts.min.js did not load')); };
      document.head.append(s);
    });
  }
  return echartsP;
}
// Run fn once, when el comes within `margin` of the viewport.
export function whenNear(el, fn, margin = '600px 0px') {
  if (!el) return;
  if (!('IntersectionObserver' in window)) { fn(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); fn(); }
  }, { rootMargin: margin });
  io.observe(el);
}
// Give the browser a turn (input, paint) between two pieces of work, so no single task runs long.
export const yieldToBrowser = () => new Promise((resolve) => {
  if (window.scheduler && typeof window.scheduler.yield === 'function') window.scheduler.yield().then(resolve);
  else setTimeout(resolve, 0);
});
// Wait until the browser has drawn a frame, so the next piece of DOM gets its own layout pass instead of one long
// one. A hidden tab draws no frames, so 100 ms is the upper bound.
export const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(resolve, 0); } };
  requestAnimationFrame(go);
  setTimeout(go, 100);
});

// ---------- ECharts styling shared by every chart ----------
export function tooltipBase(c) {
  return {
    confine: true, backgroundColor: c.inset, borderColor: c.borderStrong, borderWidth: 1, padding: [8, 12],
    textStyle: { color: c.text, fontFamily: UI_FONT, fontSize: 12 },
    extraCssText: 'border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.35);',
  };
}
export const tipRow = (color, name, value, dim) => `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;line-height:20px;${dim ? 'opacity:.75' : ''}"><span style="display:inline-flex;align-items:center;gap:8px">${color ? `<i style="width:10px;height:3px;border-radius:2px;background:${color};display:inline-block"></i>` : ''}${esc(name)}</span><b style="font-family:${NUM_FONT};font-weight:600">${value}</b></div>`;
export const axisLabel = (c) => ({ color: c.muted, fontFamily: NUM_FONT, fontSize: 12 });

// Count-up of card numbers on load (row 7): 600 ms, none under prefers-reduced-motion.
export function countUp(root, fmt) {
  if (reducedMotion()) return; // The final values are already in the markup.
  const els = $$('[data-count]', root);
  if (!els.length) return;
  const t0 = performance.now();
  const D = 600;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / D);
    const e = 1 - Math.pow(1 - k, 3);
    els.forEach((el) => { el.textContent = fmt(el, Number(el.dataset.count) * (k < 1 ? e : 1)); });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

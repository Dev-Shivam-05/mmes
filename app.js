// MMES dashboard. Reads data/*.json (contract: docs/spec/dashboard-v1.md) and renders seven sections.
// No framework and no build step. Every URL is relative so the page works under /mmes/.
// Rule (row 15): every element on screen is drawn from a data file. Nothing here invents a number.

import {
  $, $$, reducedMotion, UI_FONT, NUM_FONT, MINUS, nf0, nf2, MON, WD, esc, rupees, signed, signedPts, nowrapMoney, tone, p2,
  pct1, parseD, fmtDate, fmtDateShort, fmtDateWd, fmtMonth, isoOf, localMs, dateOf, daysBetween, addDays, todayIST, fmtIST,
  inDays, compactINR, hm, minutesOf, hmOf, cssVar, theme, rgbOf, rgba, divColor, infoBtn, getJSON, staleOf, renderFreshness,
  setupHeader as setupHeaderC, showTip, hideTip, setupTips, loadECharts, whenNear, tooltipBase, tipRow, axisLabel,
} from './common.js';

const FILES = {
  meta: 'data/meta.json',
  strategies: 'data/strategies.json',
  tw: 'data/trades-weekly.json',
  tm: 'data/trades-monthly.json',
  calendar: 'data/calendar.json',
  pm: 'data/paper-monthly.json',
  pw: 'data/paper-weekly.json',
  nd: 'data/nifty-daily.json',
  legs: 'data/paper-legs.json',
};

// Row 6a. Only "merged" changes with the theme, so it is read from CSS.
const SERIES = { v3: '#8B7CFF', leg20: '#5C93F0', leg40: '#F2C438', monthly: '#2FD08A' };
// Candle colours (lead, row 14): up = profit token, down = loss token, wicks the same colour.
const CANDLE_UP = '#2FD08A';
const CANDLE_DOWN = '#FF5C6C';
const SHORT = { v3: 'v3', leg20: 'LEG-20', leg40: 'LEG-40', monthly: 'Monthly', merged: 'Merged' };
const WEEKLY = ['v3', 'leg20', 'leg40'];
const LEG_POINTS = { leg20: 20, leg40: 40 };

const DEF = {
  net: 'Total of every trade for 1 set, after charges and 0.25 pt slippage per leg per side.',
  perYear: 'Net divided by the years the backtest covers: a historical average, not a forecast.',
  winPct: 'Share of trades with a profit before slippage. The net figures are after slippage.',
  worst: 'The biggest loss of a single trade: one expiry day for weekly, one month for monthly.',
  maxDD: 'The largest fall of the running total from a high point to a later low.',
  capitalMin: 'The least money that carried 1 set through every trade of the backtest, margin included.',
  capitalSafe: 'Rule-based margin + drawdown buffer; not a guarantee against losses.',
  trades: 'How many trades the backtest made.',
  stop: 'The position is closed when CE + PE cost twice the credit received.',
  legStop: "Dashed red: the price at which this leg would fire the 2× stop, given the other leg's close that day.",
};

const state = {
  data: {},
  errors: {},
  selected: 'v3',
  tableStrat: 'v3',
  sort: { key: 'date', dir: 'desc' },
  year: 'all',
  result: 'all',
  open: new Set(),
  legendSel: {},
  day: null,
  lastDay: null,
  mYear: null,
  monthFilter: null,
};

const charts = {};
const dayCache = new Map();
const seriesColor = (id) => (id === 'merged' ? cssVar('--s-merged') : SERIES[id]);
const seriesVar = (id) => (id === 'merged' ? 'var(--s-merged)' : SERIES[id]);
const info = (label, key) => infoBtn(label, DEF[key] || key);
const WARN_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3 18 17H2L10 3Z"/><path d="M10 8.5v3.5M10 14.5v.1"/></svg>';

// ---------- Data ----------
async function loadAll() {
  const entries = Object.entries(FILES);
  const results = await Promise.allSettled(entries.map(([, url]) => getJSON(url)));
  results.forEach((res, i) => {
    const key = entries[i][0];
    if (res.status === 'fulfilled') state.data[key] = res.value;
    else state.errors[key] = res.reason?.message || String(res.reason);
  });
}
const strategies = () => state.data.strategies?.strategies || [];
const strat = (id) => strategies().find((s) => s.id === id);
const missing = (...keys) => keys.some((k) => !state.data[k]);
const errBox = (keys) => {
  const msgs = keys.filter((k) => state.errors[k]).map((k) => esc(state.errors[k]));
  return `<div class="err" role="alert">Could not load the data for this part${msgs.length ? ` (${msgs.join('; ')})` : ''}. Reload the page to try again.</div>`;
};

// Run one section's renderer; a bug in one part must not blank the rest of the page.
function safely(fn, el) {
  try { fn(); } catch (e) {
    if (el) el.innerHTML = `<div class="err" role="alert">This part could not be drawn: ${esc(e.message)}.</div>`;
    window.__mmesErrors = (window.__mmesErrors || []).concat(`${fn.name}: ${e.message}`);
  }
}

// ---------- Header ----------
function setupHeader() { setupHeaderC({ onTheme: retheme }); }

// ---------- Stale banner + footer ----------
// Row 13 plus the lead's client rule: a daily job that stopped running never sets meta.stale, so the page also
// counts the days since the newest bhavcopy itself (more than 4 calendar days = stale since the day after it).
const staleInfo = () => staleOf(state.data.meta);
function renderMeta() { renderFreshness(state.data.meta); }

// ---------- 1. Today: ticker strip ----------
function nextOnOrAfter(list, today) {
  const sorted = [...(list || [])].sort();
  const i = sorted.findIndex((d) => d >= today);
  return i === -1 ? { next: sorted[sorted.length - 1], rest: [], past: true } : { next: sorted[i], rest: sorted.slice(i + 1), past: false };
}
const tk = (label, value, sub, valueTone = '', subTone = '') => `<div class="tk"><div class="tk-l">${label}</div><div class="tk-v ${valueTone}">${value}</div><div class="tk-s ${subTone}">${sub}</div></div>`;

function currentPaper() {
  const months = state.data.pm?.months || [];
  return months.find((x) => x.status === 'open') || months.find((x) => x.status === 'waiting') || months[months.length - 1] || null;
}

// Review row 14: the ticker keeps NIFTY close, next weekly, next monthly and data as of (no paper P&L here).
function renderTicker() {
  const today = todayIST();
  const items = [];
  const nd = state.data.nd?.candles || [];
  if (nd.length) {
    const last = nd[nd.length - 1];
    const prev = nd[nd.length - 2];
    const chg = prev ? last[4] - prev[4] : null;
    items.push(tk('NIFTY 50 close', p2(last[4]), chg == null ? fmtDate(last[0]) : `${signedPts(chg)} (${chg >= 0 ? '+' : MINUS}${Math.abs(chg / prev[4] * 100).toFixed(2)}%) · ${fmtDateShort(last[0])}`, '', tone(chg)));
  }
  const cal = state.data.calendar;
  if (cal) {
    const w = nextOnOrAfter(cal.weekly, today);
    const mo = nextOnOrAfter(cal.monthly, today);
    if (w.next) items.push(tk('Next weekly expiry', `${WD[parseD(w.next).getUTCDay()]} ${fmtDateShort(w.next)}`, w.past ? 'last known date' : inDays(daysBetween(today, w.next))));
    if (mo.next) items.push(tk('Next monthly expiry', `${WD[parseD(mo.next).getUTCDay()]} ${fmtDateShort(mo.next)}`, mo.past ? 'last known date' : inDays(daysBetween(today, mo.next))));
  }
  const m = state.data.meta;
  if (m) {
    const when = m.updatedAt || m.generatedAt;
    const upd = when ? fmtIST(when).replace(/ \d{4},/, ',') : 'unknown';
    const st = staleInfo();
    items.push(tk('Data as of', fmtDate(m.bhavLatest), st.stale ? `stale since ${fmtDateShort(st.since)}` : `updated ${upd}`, '', st.stale ? 'neg' : ''));
  }
  $('#ticker').innerHTML = items.join('') || errBox(['calendar', 'meta']);
}

// The months a strategy's backtest covers, from the data's own ranges.
function periodOf(s) {
  const m = state.data.meta;
  const span = (a, b) => `${fmtMonth(a)} – ${fmtMonth(b)}`;
  if (s.kind === 'weekly' && m?.weeklyRange) return span(m.weeklyRange[0].slice(0, 7), m.weeklyRange[1].slice(0, 7));
  if (s.kind === 'monthly' && m?.monthlyRange) return span(m.monthlyRange[0], m.monthlyRange[1]);
  const keys = Object.keys(s.months || {}).sort();
  return keys.length ? span(keys[0], keys[keys.length - 1]) : '';
}

function paperState(x) {
  if (!x) return { head: 'No paper month yet', money: null };
  if (x.status === 'closed') {
    const d = x.exit?.date ? fmtDateShort(x.exit.date) : '';
    let head;
    if (x.exit?.why === 'STOP') {
      head = x.trigger?.date
        ? `Closed · stop triggered at the ${fmtDateShort(x.trigger.date)} close (CE + PE ${p2(x.trigger.value)}) · exited at the ${d} open`
        : `Closed · 2× stop · exited at the ${d} open`;
    } else head = `Closed · held to expiry (${d} close)`;
    return { head, money: x.net, moneyLabel: 'Net' };
  }
  if (x.status === 'open') return { head: `Open · as of ${x.last?.date ? fmtDateShort(x.last.date) : '—'}`, money: x.last?.mtm, moneyLabel: 'MTM' };
  return { head: `Waiting · entry at the close of ${x.entry ? fmtDateShort(x.entry) : "the month's first trading day"}`, money: null };
}

// Review row 3: Backtest · Paper · Next, answering "making money? open now? what next?" in one row.
function renderSummary() {
  const box = $('#summary');
  const s = strat(state.selected);
  const today = todayIST();
  const cols = [];
  if (s) {
    cols.push(`<div class="sum">
      <h3 class="eyebrow">Backtest</h3>
      <div class="sum-v num ${tone(s.kpi.net)}">${signed(s.kpi.net)}</div>
      <p class="sum-s"><span class="swatch" style="background:${seriesVar(s.id)}" aria-hidden="true"></span> ${esc(s.name)} · full backtest, ${esc(periodOf(s))} · ${nf0.format(s.kpi.trades)} trades</p>
    </div>`);
  }
  const pp = currentPaper();
  const ps = paperState(pp);
  const pw = state.data.pw;
  const weekly = pw ? ((pw.trades || []).length ? `${pw.trades.length} day${pw.trades.length === 1 ? '' : 's'} recorded` : 'not started') : '—';
  cols.push(`<div class="sum">
    <h3 class="eyebrow">Paper</h3>
    <p class="sum-line"><span class="sub">Monthly${pp ? ` · ${fmtMonth(pp.month)}` : ''}</span><br><b>${esc(ps.head)}</b>${ps.money != null ? ` · <span class="num ${tone(ps.money)}">${signed(ps.money)}</span>` : ''}</p>
    <p class="sum-line"><span class="sub">Weekly</span><br><b>${esc(weekly.charAt(0).toUpperCase() + weekly.slice(1))}</b></p>
  </div>`);
  const cal = state.data.calendar;
  if (cal) {
    const w = nextOnOrAfter(cal.weekly, today);
    const mo = nextOnOrAfter(cal.monthly, today);
    const more = [...w.rest.map((d) => ['weekly', d]), ...(mo.next ? [['monthly', mo.next]] : []), ...mo.rest.map((d) => ['monthly', d])];
    cols.push(`<div class="sum">
      <h3 class="eyebrow">Next</h3>
      <div class="sum-v">${w.next ? `${WD[parseD(w.next).getUTCDay()]} ${fmtDateShort(w.next)}` : '—'}</div>
      <p class="sum-s">Weekly expiry${w.next && !w.past ? `, ${inDays(daysBetween(today, w.next))}` : ''}. Next monthly trade opens at the close of the month's first trading day.</p>
      ${more.length ? `<details class="more"><summary>More expiry dates</summary><div class="chips">${more.map(([k, d]) => `<span class="chip mono">${k === 'monthly' ? 'Monthly ' : ''}${WD[parseD(d).getUTCDay()]} ${fmtDateShort(d)}</span>`).join('')}</div></details>` : ''}
    </div>`);
  }
  box.innerHTML = cols.join('');
}

// ---------- 1. Today: paper cards ----------
function gaugeSVG(value, stopAt, credit, asOf) {
  const cx = 110; const cy = 122; const r = 88;
  const f = value != null && stopAt ? Math.max(0, Math.min(1, value / stopAt)) : 0;
  const pt = (fr, rad = r) => [cx - rad * Math.cos(Math.PI * fr), cy - rad * Math.sin(Math.PI * fr)];
  const [x1, y1] = pt(f);
  const col = f >= 1 ? 'var(--loss)' : f >= 0.75 ? 'var(--warning)' : 'var(--accent)';
  const cf = credit && stopAt ? credit / stopAt : 0.5;
  const [tx1, ty1] = pt(cf, r - 13);
  const [tx2, ty2] = pt(cf, r + 13);
  const [lx, ly] = pt(cf, r + 24);
  return `<svg viewBox="0 0 220 150" role="img" aria-label="CE plus PE ${p2(value)} as of ${esc(asOf)}, ${(f * 100).toFixed(0)}% of the stop threshold ${p2(stopAt)}">
    <path class="g-track" d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"/>
    ${f > 0 ? `<path class="g-val" style="stroke:${col}" d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}"/>` : ''}
    <line class="g-tick" x1="${tx1.toFixed(1)}" y1="${ty1.toFixed(1)}" x2="${tx2.toFixed(1)}" y2="${ty2.toFixed(1)}"/>
    <text class="g-tick-l" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle">credit</text>
    <text class="g-v" x="${cx}" y="${cy - 22}" text-anchor="middle">${p2(value)}</text>
    <text class="g-l" x="${cx}" y="${cy - 4}" text-anchor="middle">CE + PE as of ${esc(asOf)}</text>
    <text class="g-e" x="${cx - r}" y="${cy + 22}" text-anchor="middle">0</text>
    <text class="g-e" x="${cx + r}" y="${cy + 22}" text-anchor="middle">${p2(stopAt)}</text>
  </svg>`;
}

// Small daily candles of one sold leg (row 14c, clarified by review row 13): the sale-price line and an exit
// marker only. The monthly rule has no per-leg stop, so none is drawn. Candles after the exit date are faded.
function legCandlesSVG(rows, entry, exit, name) {
  const W = 240; const H = 96;
  const n = rows.length;
  if (!n) return { svg: '', after: null };
  const vals = rows.flatMap((r) => [r[2], r[3]]).concat([entry], exit?.price != null ? [exit.price] : []);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const pad = (hi - lo || 1) * 0.08; lo -= pad; hi += pad;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const step = W / n;
  const bw = Math.max(2, Math.min(14, step * 0.6));
  let firstAfter = null;
  const candles = rows.map((r, i) => {
    const [d, o, h, l, c] = r;
    const x = (i + 0.5) * step;
    const after = exit && d > exit.date;
    if (after && firstAfter == null) firstAfter = i;
    const top = y(Math.max(o, c)); const bh = Math.max(1, Math.abs(y(o) - y(c)));
    return `<g class="${c >= o ? 'c-up' : 'c-dn'}${after ? ' c-after' : ''}"><title>${esc(name)} ${fmtDate(d)}${after ? ' (after exit)' : ''}: open ${p2(o)}, high ${p2(h)}, low ${p2(l)}, close ${p2(c)}</title><line x1="${x}" x2="${x}" y1="${y(h)}" y2="${y(l)}" stroke-width="1" vector-effect="non-scaling-stroke"/><rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${bh}"/></g>`;
  }).join('');
  let mark = '';
  if (exit && exit.price != null) {
    const i = rows.findIndex((r) => r[0] === exit.date);
    if (i >= 0) {
      const x = (i + 0.5) * step;
      mark = `<line class="c-exit" x1="${x}" x2="${x}" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/><line class="c-exit-p" x1="${x - bw}" x2="${x + bw}" y1="${y(exit.price)}" y2="${y(exit.price)}" vector-effect="non-scaling-stroke"/>`;
    }
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <line class="c-entry" x1="0" x2="${W}" y1="${y(entry)}" y2="${y(entry)}" vector-effect="non-scaling-stroke"/>${candles}${mark}</svg>`;
  return { svg, after: firstAfter == null ? null : (firstAfter / n) * 100 };
}

function paperLegs(x) {
  const L = state.data.legs;
  if (!L || L.month !== x.month || !(L.ce || []).length) return '';
  const closed = x.status === 'closed' && x.exit;
  const leg = (name, k, rows, entry, exitPrice) => {
    const ex = closed ? { date: x.exit.date, price: exitPrice } : null;
    const { svg, after } = legCandlesSVG(rows, entry, ex, `${k} ${name}`);
    const last = rows[rows.length - 1];
    const foot = closed
      ? `<span>Bought back <span class="mono">${p2(exitPrice)}</span> · ${fmtDateShort(x.exit.date)}</span>`
      : `<span>Close <span class="mono">${p2(last?.[4])}</span> · ${last ? fmtDateShort(last[0]) : ''}</span>`;
    return `
      <div class="leg-c">
        <div class="leg-c-h"><span class="label">Sold ${esc(name)}</span><b>${esc(k)} @ ${p2(entry)}</b></div>
        <div class="leg-c-plot">${svg}${after != null ? `<span class="after-l" style="left:${after.toFixed(1)}%">after exit</span>` : ''}</div>
        <div class="leg-c-k">${foot}<span>dashed: sold at ${p2(entry)}</span></div>
      </div>`;
  };
  return `<div class="legs-c">${leg('CE', L.ceK, L.ce, x.ceIn, x.exit?.ce)}${leg('PE', L.peK, L.pe || [], x.peIn, x.exit?.pe)}</div>`;
}

// Review row 1: a closed month shows plain values and no gauge; an open month keeps the gauge with its mark's date.
function monthlyPaperCard(x, count) {
  const status = x.status || 'waiting';
  const ps = paperState(x);
  const head = `
    <div class="t-head">
      <div><h3>Monthly paper trade · ${fmtMonth(x.month)}</h3>
      <p class="kv-sub">Sold ${x.entry ? fmtDate(x.entry) : '—'} · expiry ${x.expiry ? fmtDate(x.expiry) : '—'}${count > 1 ? ` · ${count} months recorded` : ''}</p></div>
      ${status === 'closed' ? '' : `<span class="pill ${esc(status)}">${status === 'open' ? 'Open' : 'Waiting'}</span>`}
    </div>`;
  if (status === 'waiting' && x.ceK == null) {
    return `<div class="card t-card t-paper-m">${head}<p class="note-box">Waiting for the entry at the close of ${x.entry ? fmtDate(x.entry) : "the month's first trading day"}.</p></div>`;
  }
  const last = x.last || {};
  const legs = paperLegs(x);
  if (status === 'closed') {
    const exitVal = x.exit && x.exit.ce != null && x.exit.pe != null ? x.exit.ce + x.exit.pe : last.value;
    return `
      <div class="card t-card t-paper-m">
        ${head}
        <p class="state-h">${esc(ps.head)}</p>
        <div class="closed-body">
          <dl class="vals">
            <div><dt class="label">Premium collected</dt><dd class="kv-v num">${p2(x.credit)} <span class="unit">pts</span></dd></div>
            <div><dt class="label">Combined stop threshold</dt><dd class="kv-v num">${p2(x.stopAt)} <span class="unit">pts</span></dd></div>
            <div><dt class="label">Combined exit premium</dt><dd class="kv-v num">${p2(exitVal)} <span class="unit">pts</span></dd><dd class="kv-sub">CE <span class="mono">${p2(x.exit?.ce)}</span> + PE <span class="mono">${p2(x.exit?.pe)}</span></dd></div>
          </dl>
          <div class="net-once"><div class="label">Net paper result</div><div class="kv-v big num ${tone(x.net)}">${x.net != null ? signed(x.net) : '—'}</div><div class="kv-sub">1 set, after charges and 0.25 pt slippage</div></div>
        </div>
        ${legs}
      </div>`;
  }
  const asOf = last.date ? fmtDateShort(last.date) : '—';
  let away = '';
  if (last.value != null && x.stopAt) away = last.value >= x.stopAt ? 'At or above the stop threshold' : `The stop is ${((x.stopAt - last.value) / last.value * 100).toFixed(0)}% above this value`;
  return `
    <div class="card t-card t-paper-m">
      ${head}
      <div class="pos-body">
        <div class="gauge">
          ${gaugeSVG(last.value, x.stopAt, x.credit, asOf)}
          <div class="g-sub">Stop threshold <span class="mono">${p2(x.stopAt)}</span> (2× credit) ${info('Stop', 'stop')}</div>
          <div class="g-sub">${esc(away)}</div>
        </div>
        <div class="t-card">
          ${legs}
          <div class="kv kv-3">
            <div><div class="label">Premium collected</div><div class="kv-v num">${p2(x.credit)}</div><div class="kv-sub">NIFTY <span class="mono">${p2(x.spot)}</span> at entry</div></div>
            <div><div class="label">CE + PE, ${esc(asOf)}</div><div class="kv-v num">${p2(last.value)}</div><div class="kv-sub">CE <span class="mono">${p2(last.ce)}</span> + PE <span class="mono">${p2(last.pe)}</span></div></div>
            <div><div class="label">MTM, ${esc(asOf)}</div><div class="kv-v big num ${tone(last.mtm)}">${last.mtm != null ? signed(last.mtm) : '—'}</div><div class="kv-sub">1 set, after charges</div></div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderToday() {
  safely(renderSummary, $('#summary'));
  const parts = [];
  const pm = state.data.pm;
  if (pm) {
    const cur = currentPaper();
    parts.push(cur ? monthlyPaperCard(cur, (pm.months || []).length) : `
      <div class="card t-card t-paper-m"><div class="t-head"><h3>Monthly paper trade</h3><span class="pill waiting">Waiting</span></div>
      <p class="note-box">No monthly paper trade has been recorded yet.</p></div>`);
  } else {
    parts.push(`<div class="card t-card t-paper-m"><h3>Monthly paper trade</h3>${errBox(['pm'])}</div>`);
  }
  const pw = state.data.pw;
  if (pw) {
    const trades = pw.trades || [];
    if (!trades.length) {
      parts.push(`
        <div class="card t-card">
          <div class="t-head"><h3>Weekly paper trade</h3><span class="pill waiting">Not started</span></div>
          <p class="note-box">${esc(pw.note)}</p>
          <p class="kv-sub">It runs the Weekly v3 rules on each expiry day, on the owner's PC, and publishes each day here.</p>
        </div>`);
    } else {
      const last = trades[trades.length - 1];
      const total = trades.reduce((a, t) => a + (Number(t.netSlip25 ?? t.net) || 0), 0);
      const lastNet = Number(last.netSlip25 ?? last.net);
      parts.push(`
        <div class="card t-card">
          <div class="t-head"><h3>Weekly paper trade</h3><span class="pill open">${trades.length} day${trades.length === 1 ? '' : 's'}</span></div>
          <div class="kv">
            <div><div class="label">Last day</div><div class="kv-v num">${last.date ? fmtDateShort(last.date) : '—'}</div><div class="kv-sub mono">${esc(last.ceK)} CE / ${esc(last.peK)} PE</div></div>
            <div><div class="label">Last net</div><div class="kv-v num ${tone(lastNet)}">${Number.isFinite(lastNet) ? signed(lastNet) : '—'}</div></div>
            <div><div class="label">All days</div><div class="kv-v num ${tone(total)}">${signed(total)}</div></div>
          </div>
          ${pw.note ? `<p class="kv-sub">${esc(pw.note)}</p>` : ''}
        </div>`);
    }
  } else {
    parts.push(`<div class="card t-card"><h3>Weekly paper trade</h3>${errBox(['pw'])}</div>`);
  }
  $('#todayBody').innerHTML = parts.join('');

  const m = state.data.meta;
  if (m) {
    const job = m.updatedAt ? `The daily job last ran ${fmtIST(m.updatedAt)}.` : `Built ${fmtIST(m.generatedAt)}; the daily job has not run yet.`;
    $('#freshLine').innerHTML = `${staleInfo().stale ? '<span class="pill waiting">Stale</span> ' : ''}Latest NSE prices: <span class="mono">${fmtDateWd(m.bhavLatest)}</span>. ${esc(job)}`;
  }
}

// ---------- 2. Strategy cards with sparklines ----------
function sparkSVG(s) {
  const pts = curve(s);
  if (pts.length < 2) return '';
  const W = 140; const H = 48;
  const t0 = parseD(pts[0][0]).getTime(); const t1 = parseD(pts[pts.length - 1][0]).getTime();
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vs); const hi = Math.max(0, ...vs);
  const x = (d) => ((parseD(d).getTime() - t0) / (t1 - t0 || 1)) * W;
  const y = (v) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  let d = `M ${x(pts[0][0]).toFixed(1)} ${y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i += 1) d += ` H ${x(pts[i][0]).toFixed(1)} V ${y(pts[i][1]).toFixed(1)}`;
  const area = `${d} V ${y(lo).toFixed(1)} H ${x(pts[0][0]).toFixed(1)} Z`;
  const gid = `spg-${s.id}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${seriesVar(s.id)};stop-opacity:.28"/><stop offset="1" style="stop-color:${seriesVar(s.id)};stop-opacity:0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})" stroke="none"/>
    <line class="sp-zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
    <path class="sp-line" d="${d}" style="stroke:${seriesVar(s.id)}"/>
  </svg>`;
}

// Review row 6: notes every weekly card repeated are said once, in the assumptions line above the cards.
const SHARED_NOTE = (n) => /^Slippage of 0\.25 pt/i.test(n) || /^Backtest on the 1-minute option archive/i.test(n);

function renderAssumptions() {
  const m = state.data.meta;
  const wk = m?.weeklyRange ? `${fmtMonth(m.weeklyRange[0].slice(0, 7))} – ${fmtMonth(m.weeklyRange[1].slice(0, 7))}` : '';
  const mo = m?.monthlyRange ? `${fmtMonth(m.monthlyRange[0])} – ${fmtMonth(m.monthlyRange[1])}` : '';
  $('#assume').textContent = `All figures: 1 set (65 + 65), after charges and 0.25 pt slippage per leg per side; backtest ${wk} (weekly) / ${mo} (monthly). The slippage is a guess: bid/ask was never measured. Weekly results come from the 1-minute option archive; nothing here was traded live.`;
}

function renderStrategies() {
  const grid = $('#stratGrid');
  if (missing('strategies')) { grid.innerHTML = errBox(['strategies']); return; }
  safely(renderAssumptions, $('#assume'));
  grid.innerHTML = strategies().map((s) => {
    const k = s.kpi;
    const unit = s.kind === 'weekly' ? 'expiry days' : s.kind === 'monthly' ? 'months' : 'trades';
    const kind = s.kind === 'weekly' ? 'Weekly · expiry day only' : s.kind === 'monthly' ? 'Monthly · held for the month' : 'Weekly + monthly · one account';
    const worstLabel = `Worst ${k.worstUnit === 'month' ? 'month' : 'day'}`;
    const notes = (s.notes || []).filter((n) => !SHARED_NOTE(n)).map((n) => `<li class="${/fragile/i.test(n) ? 'amber' : ''}">${esc(n)}</li>`).join('');
    const sel = s.id === state.selected;
    return `
      <article class="card scard${s.kind !== 'weekly' ? ' wide' : ''}${sel ? ' sel' : ''}" style="--sc:${seriesVar(s.id)}" data-id="${esc(s.id)}">
        <div class="scard-top">
          <div>
            <h3><button type="button" class="scard-btn" data-id="${esc(s.id)}" aria-pressed="${sel}">${esc(s.name)}</button></h3>
            <p class="scard-kind">${kind}</p>
          </div>
          <span class="pill open sel-tag">Selected</span>
        </div>
        <p class="tagline">${esc(s.tagline)}</p>
        <div class="net-row">
          <div>
            <div class="label">Net profit ${info('Net', 'net')}</div>
            <div class="big-net num ${tone(k.net)}" data-count="${k.net}" data-fmt="signed">${signed(k.net)}</div>
          </div>
          ${sparkSVG(s)}
        </div>
        <dl class="metrics">
          <div class="metric"><dt class="label">Average per year (historical) ${info('Average per year (historical)', 'perYear')}</dt><dd class="kv-v num ${tone(k.perYear)}" data-count="${k.perYear}" data-fmt="signed">${signed(k.perYear)}</dd></div>
          <div class="metric"><dt class="label">Winning trades (before slippage) ${info('Winning trades (before slippage)', 'winPct')}</dt><dd class="kv-v num" data-count="${k.winPct}" data-fmt="pct">${pct1(k.winPct)}</dd><dd class="kv-sub">of ${nf0.format(k.trades)} ${unit}</dd></div>
          <div class="metric"><dt class="label">${worstLabel} ${info(worstLabel, 'worst')}</dt><dd class="kv-v num ${tone(k.worst)}" data-count="${k.worst}" data-fmt="signed">${signed(k.worst)}</dd></div>
          <div class="metric"><dt class="label">Max drawdown ${info('Max drawdown', 'maxDD')}</dt><dd class="kv-v num ${tone(-Math.abs(k.maxDD))}" data-count="${-Math.abs(k.maxDD)}" data-fmt="signed">${signed(-Math.abs(k.maxDD))}</dd></div>
          <div class="metric"><dt class="label">Minimum capital ${info('Minimum capital', 'capitalMin')}</dt><dd class="kv-v num" data-count="${k.capitalMin}" data-fmt="rupees">${rupees(k.capitalMin)}</dd></div>
          <div class="metric"><dt class="label">Buffered capital ${info('Buffered capital', 'capitalSafe')}</dt><dd class="kv-v num" data-count="${k.capitalSafe}" data-fmt="rupees">${rupees(k.capitalSafe)}</dd></div>
        </dl>
        ${notes ? `<ul class="notes">${notes}</ul>` : ''}
        ${(s.rules || []).length ? `<details class="rules"><summary>Rules</summary><ul>${s.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
      </article>`;
  }).join('');
  grid.addEventListener('click', (e) => { const b = e.target.closest('.scard-btn'); if (b) select(b.dataset.id); });
  countUp(grid);
}

function countUp(root) {
  if (reducedMotion()) return; // The final values are already in the markup.
  const els = $$('[data-count]', root);
  const fmt = (el, v) => {
    switch (el.dataset.fmt) {
      case 'signed': return signed(v);
      case 'rupees': return rupees(v);
      case 'pct': return pct1(v);
      default: return nf0.format(Math.round(v));
    }
  };
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

// ---------- 3. Compact header of the selected strategy (review row 6 replaced the KPI strip) ----------
function renderPerfHead() {
  const box = $('#perfHead');
  const s = strat(state.selected);
  if (!s) { box.innerHTML = errBox(['strategies']); return; }
  box.innerHTML = `
    <span class="kpi-name"><span class="swatch" style="background:${seriesVar(s.id)}" aria-hidden="true"></span>${esc(s.name)}</span>
    <span class="ph-net"><span class="label">Full-backtest net ${info('Full-backtest net', 'net')}</span><span class="ph-v num ${tone(s.kpi.net)}" data-count="${s.kpi.net}" data-fmt="signed">${signed(s.kpi.net)}</span></span>
    <span class="ph-per">${esc(periodOf(s))} · ${nf0.format(s.kpi.trades)} trades</span>`;
  countUp(box);
}

function select(id) {
  if (!strat(id)) return;
  state.selected = id;
  // The selected series is always on; the others keep whatever the owner toggled (off by default).
  state.legendSel[strat(id).name] = true;
  $$('.scard').forEach((c) => {
    const on = c.dataset.id === id;
    c.classList.toggle('sel', on);
    $('.scard-btn', c).setAttribute('aria-pressed', String(on));
  });
  $$('#eqLegend button').forEach((b) => {
    b.classList.toggle('is-sel', b.dataset.id === id);
    b.setAttribute('aria-pressed', String(state.legendSel[b.dataset.name] !== false));
  });
  safely(renderPerfHead, $('#perfHead'));
  safely(renderSummary, $('#summary'));
  safely(renderSquares, $('#squares'));
  safely(renderExitBars, $('#exitBars'));
  if (id !== 'merged' && id !== state.tableStrat) setTableStrat(id);
  const cs = $('#capStrat');
  if (cs && cs.value !== id) { cs.value = id; renderCapital(); }
  updateDDHead();
  if (charts.eq) charts.eq.setOption(eqOption(), { notMerge: true });
  if (charts.dd) charts.dd.setOption(ddOption(), { notMerge: true });
}

// ---------- Charts (ECharts, loaded on demand) ----------
const narrow = (id) => ($(id)?.clientWidth || 9999) < 560;
const resizer = new ResizeObserver((entries) => {
  entries.forEach((en) => {
    const c = Object.values(charts).find((x) => x && !x.isDisposed() && x.getDom() === en.target);
    if (!c) return;
    // The heatmap changes its own height when it flips; doing that inside this callback would loop the observer.
    if (c === charts.heat) { requestAnimationFrame(() => { layoutHeat(); c.resize(); placeYearLabels(); }); return; }
    const isNarrow = narrow(`#${en.target.id}`);
    if ((c === charts.eq || c === charts.dd) && c.__narrow !== undefined && c.__narrow !== isNarrow) c.setOption({ xAxis: { splitNumber: isNarrow ? 3 : 8 } });
    c.__narrow = isNarrow;
    c.resize();
  });
});
async function mount(key, el, build, after) {
  try {
    const ec = await loadECharts();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    if (charts[key] && !charts[key].isDisposed()) { charts[key].setOption(build(), { notMerge: true }); return charts[key]; }
    el.textContent = '';
    charts[key] = ec.init(el, null, { renderer: 'canvas' });
    charts[key].setOption(build());
    resizer.observe(el);
    if (after) after(charts[key]);
    return charts[key];
  } catch (e) {
    if (charts[key]) { charts[key].dispose(); delete charts[key]; }
    el.innerHTML = `<div class="chart-msg">The chart could not be drawn (${esc(e.message)}). Reload the page to try again.</div>`;
    return null;
  }
}
function rangeStart() {
  const m = state.data.meta;
  if (m?.monthlyRange?.[0]) return `${m.monthlyRange[0]}-01`;
  return strategies().map((s) => s.equity?.[0]?.[0]).filter(Boolean).sort()[0];
}
function rangeEnd() {
  return strategies().map((s) => s.equity?.[s.equity.length - 1]?.[0]).filter(Boolean).sort().pop();
}
// Each curve starts at ₹0 on the first day of the test, so all five begin from the same place.
function curve(s) {
  const start = rangeStart();
  const e = s.equity || [];
  return e.length && e[0][0] > start ? [[start, 0], ...e] : e;
}
function asOf(s, iso) {
  let v = null;
  for (const [d, x] of curve(s)) { if (d <= iso) v = x; else break; }
  return v;
}
function timeAxis(c, id) {
  return {
    type: 'time', min: rangeStart(), max: rangeEnd(), splitNumber: narrow(id) ? 3 : 8,
    axisLine: { lineStyle: { color: c.borderStrong } }, axisTick: { show: false },
    axisLabel: { ...axisLabel(c), hideOverlap: true, formatter: { year: '{yyyy}', month: '{MMM}', day: '{d} {MMM}' } },
    splitLine: { show: false },
  };
}
function currentZoom(chart) {
  // Before its first setOption a chart has no option at all.
  const dz = chart && !chart.isDisposed() ? chart.getOption()?.dataZoom?.[0] : null;
  return { start: dz?.start ?? 0, end: dz?.end ?? 100 };
}

// Review row 7: only the selected series is on by default; it is 2 px, the others 1 px at 45%; the selected
// line ends in a label with its name and running total. Both charts share a 72 / 24 px plot padding.
const PLOT_PAD = { left: 72, right: 24 };
function eqSeries(c) {
  return strategies().map((s) => {
    const sel = s.id === state.selected;
    const col = seriesColor(s.id);
    const data = curve(s);
    const last = data[data.length - 1];
    return {
      id: s.id, name: s.name, type: 'line', step: 'end', showSymbol: false, symbol: 'circle', symbolSize: 8,
      data, z: sel ? 5 : 2,
      lineStyle: { width: sel ? 2 : 1, color: col, opacity: sel ? 1 : 0.45 },
      itemStyle: { color: col, borderColor: c.panel, borderWidth: 2, opacity: sel ? 1 : 0.45 },
      emphasis: { disabled: true },
      areaStyle: sel ? { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: rgba(col, 0.2) }, { offset: 1, color: rgba(col, 0) }] } } : undefined,
      markLine: sel ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: c.faint, type: 'dotted', width: 1.5 }, data: [{ yAxis: 0 }] } : undefined,
      markPoint: sel && last ? {
        silent: true, symbol: 'circle', symbolSize: 8, itemStyle: { color: col, borderColor: c.panel, borderWidth: 2 },
        label: { show: true, position: 'left', distance: 8, formatter: `${s.name}  ${signed(last[1])}`, color: c.text, fontFamily: NUM_FONT, fontSize: 12, backgroundColor: c.panel, borderColor: c.borderStrong, borderWidth: 1, borderRadius: 4, padding: [3, 6] },
        data: [{ coord: last, value: last[1] }],
      } : undefined,
    };
  });
}

function eqTooltip(params) {
  const sel = strat(state.selected);
  const p = params.find((x) => x.seriesId === sel.id);
  const iso = p ? dateOf(p.value[0]) : dateOf(params[0].axisValue);
  const rows = [];
  if (p) {
    const data = curve(sel);
    const i = p.dataIndex;
    const trade = i > 0 ? data[i][1] - data[i - 1][1] : null;
    rows.push(`<div style="display:flex;align-items:center;gap:8px;margin:2px 0 4px"><i style="width:10px;height:3px;border-radius:2px;background:${seriesColor(sel.id)};display:inline-block"></i><b>${esc(sel.name)}</b></div>`);
    if (trade != null) rows.push(tipRow('', sel.kind === 'weekly' ? 'This trade' : 'This month', signed(trade)));
    rows.push(tipRow('', 'Running total', signed(p.value[1])));
  }
  const others = strategies().filter((s) => s.id !== sel.id && state.legendSel[s.name] !== false);
  if (others.length) {
    rows.push(`<div style="height:1px;background:rgba(148,163,184,.2);margin:6px 0"></div>`);
    others.forEach((s) => { const v = asOf(s, iso); rows.push(tipRow(seriesColor(s.id), s.name, v == null ? '—' : signed(v), true)); });
  }
  return `<div style="font-weight:600;margin-bottom:2px">${fmtDateWd(iso)}</div>${rows.join('')}`;
}

function eqOption() {
  const c = theme();
  const zoom = currentZoom(charts.eq);
  return {
    animation: !reducedMotion(), animationDuration: 500,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: { ...PLOT_PAD, top: 16, bottom: 56 },
    legend: { show: false, selected: state.legendSel },
    tooltip: {
      ...tooltipBase(c), trigger: 'axis',
      axisPointer: {
        type: 'cross', lineStyle: { color: c.faint, type: 'dashed' }, crossStyle: { color: c.faint, type: 'dashed' },
        label: { backgroundColor: c.inset, color: c.text, fontFamily: NUM_FONT, fontSize: 12, borderColor: c.borderStrong, borderWidth: 1,
          formatter: (a) => (a.axisDimension === 'x' ? fmtDate(isoOf(a.value)) : signed(a.value)) },
      },
      formatter: eqTooltip,
    },
    xAxis: timeAxis(c, '#equityChart'),
    yAxis: { type: 'value', axisLabel: { ...axisLabel(c), formatter: compactINR }, splitLine: { lineStyle: { color: c.border } } },
    dataZoom: [
      { type: 'inside', filterMode: 'none', start: zoom.start, end: zoom.end },
      {
        type: 'slider', filterMode: 'none', start: zoom.start, end: zoom.end, height: 22, bottom: 12, ...PLOT_PAD,
        borderColor: c.border, backgroundColor: 'transparent', fillerColor: c.wash,
        dataBackground: { lineStyle: { color: c.faint, width: 1 }, areaStyle: { color: c.inset, opacity: 1 } },
        selectedDataBackground: { lineStyle: { color: c.accent, width: 1 }, areaStyle: { color: c.accent, opacity: 0.12 } },
        handleStyle: { color: c.panel, borderColor: c.accent }, moveHandleStyle: { color: c.accent, opacity: 0.5 },
        emphasis: { handleStyle: { borderColor: c.accent }, moveHandleStyle: { color: c.accent } },
        textStyle: { ...axisLabel(c) }, labelFormatter: (v) => fmtDate(isoOf(v)), brushSelect: false,
      },
    ],
    series: eqSeries(c),
  };
}

function renderLegend() {
  const box = $('#eqLegend');
  box.innerHTML = strategies().map((s) => `
    <button type="button" data-id="${esc(s.id)}" data-name="${esc(s.name)}" aria-pressed="${state.legendSel[s.name] !== false}" class="${s.id === state.selected ? 'is-sel' : ''}" style="--c:${seriesVar(s.id)}">
      <span class="sw" aria-hidden="true"></span>${esc(s.name)}
    </button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = b.dataset.name;
    const on = state.legendSel[name] === false;
    state.legendSel[name] = on;
    b.setAttribute('aria-pressed', String(on));
    if (charts.eq) charts.eq.dispatchAction({ type: on ? 'legendSelect' : 'legendUnSelect', name });
  });
}

// Year buttons zoom both the equity and the drawdown chart. The header keeps saying "Full-backtest net".
let rangeFromButton = false;
function setupRange() {
  const seg = $('#eqRange');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !charts.eq) return;
    const r = b.dataset.range;
    $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    rangeFromButton = true;
    if (r === 'all') charts.eq.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    else {
      const a = Math.max(localMs(rangeStart()), localMs(`${r}-01-01`));
      const z = Math.min(localMs(rangeEnd()), localMs(`${r}-12-31`));
      charts.eq.dispatchAction({ type: 'dataZoom', startValue: a, endValue: z });
    }
    rangeFromButton = false;
  });
}

function drawdown(s) {
  let peak = 0;
  return curve(s).map(([d, v]) => { peak = Math.max(peak, v); return [d, Math.round((v - peak) * 100) / 100]; });
}
function updateDDHead() {
  const s = strat(state.selected);
  if (!s) return;
  $('#ddName').textContent = `Drawdown · ${s.name}`;
  $('#ddSwatch').style.background = seriesVar(s.id);
  // Review row 5: the merged account is measured on month-end steps; say so right under the title.
  $('#ddNote').innerHTML = s.kind === 'merged'
    ? `Measured at month-end points; falls within a month are not shown. Worst: <span class="num neg">${signed(-Math.abs(s.kpi.maxDD))}</span>.`
    : `How far the running total sat below its last high. Worst: <span class="num neg">${signed(-Math.abs(s.kpi.maxDD))}</span>.`;
  $('#ddChart').setAttribute('aria-label', `Drawdown of ${s.name}. The largest fall was ${signed(-Math.abs(s.kpi.maxDD))}.`);
  $('#equityChart').setAttribute('aria-label', `Running total of ${s.name}: ${signed(s.kpi.net)} after ${s.kpi.trades} trades.`);
}
function ddOption() {
  const c = theme();
  const s = strat(state.selected);
  const zoom = currentZoom(charts.eq);
  return {
    animation: !reducedMotion(), animationDuration: 400,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: { ...PLOT_PAD, top: 12, bottom: 28 },
    tooltip: {
      ...tooltipBase(c), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: c.faint, type: 'dashed' } },
      formatter: (params) => {
        const p = params?.[0];
        if (!p) return '';
        const v = p.value[1];
        return `<div style="font-weight:600;margin-bottom:4px">${fmtDateWd(dateOf(p.value[0]))}</div>${tipRow(c.loss, v < 0 ? 'Below its high' : 'At its high', signed(v))}`;
      },
    },
    xAxis: timeAxis(c, '#ddChart'),
    yAxis: { type: 'value', max: 0, axisLabel: { ...axisLabel(c), formatter: compactINR }, splitLine: { lineStyle: { color: c.border } } },
    dataZoom: [{ type: 'inside', filterMode: 'none', start: zoom.start, end: zoom.end }],
    series: [{
      type: 'line', step: 'end', showSymbol: false, symbol: 'circle', symbolSize: 8, name: s?.name || '',
      data: s ? drawdown(s) : [],
      lineStyle: { width: 2, color: c.loss }, itemStyle: { color: c.loss, borderColor: c.panel, borderWidth: 2 },
      areaStyle: { color: c.loss, opacity: 0.16 },
    }],
  };
}
// The drawdown chart follows the equity chart's zoom (both share the same x range, so percentages match).
let syncing = false;
function linkZoom() {
  if (!charts.eq || !charts.dd || linkZoom.done) return;
  const pass = (from, to) => from.on('datazoom', () => {
    if (from === charts.eq && !rangeFromButton) $$('#eqRange button').forEach((x) => { const z = currentZoom(charts.eq); x.setAttribute('aria-pressed', String(x.dataset.range === 'all' && z.start === 0 && z.end === 100)); });
    if (syncing) return;
    const z = currentZoom(from); const t = currentZoom(to);
    if (Math.abs(z.start - t.start) < 0.01 && Math.abs(z.end - t.end) < 0.01) return;
    syncing = true;
    to.dispatchAction({ type: 'dataZoom', start: z.start, end: z.end });
    syncing = false;
  });
  pass(charts.eq, charts.dd);
  pass(charts.dd, charts.eq);
  linkZoom.done = true;
}

// ---------- 4. Month heatmap ----------
// Phones show one year at a time (review rows 8-9): 48 px rows instead of 34 cramped ones.
const monthsMobile = () => window.matchMedia('(max-width: 700px)').matches;
function heatMonths() {
  const all = strategies().flatMap((s) => Object.keys(s.months || {})).sort();
  if (!all.length) return [];
  const out = [];
  let [y, m] = all[0].split('-').map(Number);
  const [y1, m1] = all[all.length - 1].split('-').map(Number);
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
const heatYears = () => [...new Set(heatMonths().map((m) => m.slice(0, 4)))];
function currentYear() {
  const ys = heatYears();
  if (!ys.includes(state.mYear)) state.mYear = ys[ys.length - 1];
  return state.mYear;
}
const heatTransposed = () => monthsMobile();
const heatMax = () => Math.max(1, ...strategies().flatMap((s) => Object.values(s.months || {}).map(Math.abs)));
// Desktop: every month, with an empty spacer column between years. Phone: the chosen year's months.
function heatCats() {
  const months = heatMonths();
  if (heatTransposed()) { const y = currentYear(); return months.filter((m) => m.startsWith(y)); }
  const out = [];
  months.forEach((m, i) => { if (i && m.slice(0, 4) !== months[i - 1].slice(0, 4)) out.push(`gap-${m.slice(0, 4)}`); out.push(m); });
  return out;
}
function layoutHeat() {
  const el = $('#heatChart');
  const T = heatTransposed();
  const h = T ? heatCats().length * 48 + 44 : strategies().length * 40 + 64;
  const key = `${T}|${state.mYear}`;
  if (el.style.height !== `${h}px` || (charts.heat && charts.heat.__key !== key)) {
    el.style.height = `${h}px`;
    if (charts.heat) { charts.heat.resize(); charts.heat.setOption(heatOption(), { notMerge: true }); placeYearLabels(); }
  }
  $$('.mobile-year').forEach((x) => { x.hidden = !T; });
}
function heatOption() {
  const c = theme();
  const S = strategies();
  const cats = heatCats();
  const T = heatTransposed();
  const M = heatMax();
  if (charts.heat) charts.heat.__key = `${T}|${state.mYear}`;
  const data = []; const absent = [];
  S.forEach((s, si) => cats.forEach((m, mi) => {
    if (m.startsWith('gap')) return;
    const v = s.months?.[m];
    const pt = T ? [si, mi] : [mi, si];
    if (v != null) data.push([...pt, v]); else absent.push(pt);
  }));
  const monthAxis = {
    type: 'category', data: cats, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false },
    axisLabel: T
      ? { ...axisLabel(c), formatter: (v) => MON[Number(v.slice(5)) - 1] }
      : { ...axisLabel(c), interval: (i, v) => !v.startsWith('gap') && ['01', '04', '07', '10'].includes(v.slice(5)), formatter: (v) => (v.startsWith('gap') ? '' : MON[Number(v.slice(5)) - 1]) },
  };
  const stratAxis = {
    type: 'category', data: S.map((s) => (T ? SHORT[s.id] || s.name : s.name)), axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: c.text, fontFamily: UI_FONT, fontSize: 12, interval: 0 },
  };
  const nameOf = (p) => { const [a, b] = p.value; return { s: S[T ? a : b], m: cats[T ? b : a] }; };
  return {
    animation: false,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: T ? { left: 4, right: 4, top: 28, bottom: 4, containLabel: true } : { left: 4, right: 8, top: 28, bottom: 4, containLabel: true },
    xAxis: T ? { ...stratAxis, position: 'top' } : monthAxis,
    yAxis: T ? { ...monthAxis, inverse: true } : { ...stratAxis, inverse: true },
    visualMap: { show: false, type: 'continuous', seriesIndex: 0, min: -M, max: M, dimension: 2, inRange: { color: [c.loss, c.inset, c.profit] } },
    tooltip: {
      ...tooltipBase(c), trigger: 'item',
      formatter: (p) => {
        const { s, m } = nameOf(p);
        if (p.seriesType === 'custom') return `${esc(s.name)} · ${fmtMonth(m)}<br><b>No trade</b>`;
        return `${esc(s.name)} · ${fmtMonth(m)}<br><b style="font-family:${NUM_FONT}">${signed(p.value[2])}</b><br><span style="opacity:.75">Click to list these trades</span>`;
      },
    },
    series: [
      { type: 'heatmap', data, cursor: 'pointer', itemStyle: { borderColor: c.panel, borderWidth: 2, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: c.text, borderWidth: 1 } } },
      {
        // A month with no trade is an outlined empty cell, never the zero colour (review row 9).
        type: 'custom', data: absent, encode: { x: 0, y: 1 },
        renderItem: (params, api) => {
          const p = api.coord([api.value(0), api.value(1)]);
          const sz = api.size([1, 1]);
          return { type: 'rect', shape: { x: p[0] - sz[0] / 2 + 3, y: p[1] - sz[1] / 2 + 3, width: sz[0] - 6, height: sz[1] - 6, r: 4 }, style: { fill: 'transparent', stroke: c.borderStrong, lineWidth: 1, lineDash: [3, 3] } };
        },
      },
    ],
  };
}
// Centred 2024 / 2025 / 2026 labels over each year's columns (desktop only).
function placeYearLabels() {
  const ch = charts.heat;
  if (!ch || ch.isDisposed() || heatTransposed()) return;
  const c = theme();
  const cats = heatCats();
  const years = [...new Set(cats.filter((x) => !x.startsWith('gap')).map((x) => x.slice(0, 4)))];
  const els = years.map((y) => {
    const ms = cats.filter((x) => x.startsWith(y));
    const a = ch.convertToPixel({ xAxisIndex: 0 }, ms[0]);
    const b = ch.convertToPixel({ xAxisIndex: 0 }, ms[ms.length - 1]);
    return { type: 'text', id: `yl-${y}`, x: (a + b) / 2, y: 6, silent: true, style: { text: y, fill: c.text, font: `600 12px ${NUM_FONT}`, textAlign: 'center' } };
  });
  ch.setOption({ graphic: els });
}
function heatClick(p) {
  if (p.seriesType !== 'heatmap') return;
  const T = heatTransposed();
  const [a, b] = p.value;
  const s = strategies()[T ? a : b];
  const m = heatCats()[T ? b : a];
  filterTableMonth(s.id, m);
}
function renderHeatLegend() {
  const c = theme();
  const M = heatMax();
  $('#heatLegend').innerHTML = `<span><span class="absent-key"></span> No trade</span><span>Loss</span><span class="mono">${signed(-M)}</span><span class="bar" style="background:linear-gradient(90deg, ${c.loss}, ${c.inset}, ${c.profit})"></span><span class="mono">${signed(M)}</span><span>Profit</span>`;
  let best = null; let worst = null;
  strategies().forEach((s) => Object.entries(s.months || {}).forEach(([m, v]) => {
    if (!best || v > best.v) best = { s, m, v };
    if (!worst || v < worst.v) worst = { s, m, v };
  }));
  if (best && worst) $('#heatChart').setAttribute('aria-label', `Monthly profit and loss of each strategy. Best month: ${best.s.name}, ${fmtMonth(best.m)}, ${signed(best.v)}. Worst month: ${worst.s.name}, ${fmtMonth(worst.m)}, ${signed(worst.v)}. The trade table lists every trade.`);
}
function setupMonthYear() {
  const ys = heatYears();
  currentYear();
  $$('.mobile-year').forEach((seg) => {
    seg.innerHTML = ys.map((y) => `<button type="button" data-year="${y}" aria-pressed="${y === state.mYear}">${y}</button>`).join('');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.mYear = b.dataset.year;
      $$('.mobile-year button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.year === state.mYear)));
      layoutHeat();
      safely(renderSquares, $('#squares'));
    });
  });
  window.matchMedia('(max-width: 700px)').addEventListener('change', () => { layoutHeat(); safely(renderSquares, $('#squares')); });
}

// ---------- 4. Per-trade squares (ref 4) ----------
const WHY = {
  SQ1515: { label: 'Held to 15:15', kind: 'hold' },
  STOP: { label: '2× stop', kind: 'stop' },
  'LEG STOP': { label: 'Leg stop', kind: 'stop' },
  EXPIRY: { label: 'Held to expiry', kind: 'hold' },
};
function tradesOf(id) {
  if (id === 'monthly') {
    return (state.data.tm?.spot || []).map((r) => ({ src: 'monthly', date: r.entry, month: r.month, net: r.s25, why: r.why, exit: r.why === 'STOP' ? r.ce_at : r.expiry, raw: r }));
  }
  if (id === 'merged') {
    const months = new Set(Object.keys(strat('merged')?.months || {}));
    return [...tradesOf('v3').filter((t) => months.has(t.month)), ...tradesOf('monthly').filter((t) => months.has(t.month))];
  }
  return (state.data.tw?.[id] || []).map((r) => ({ src: id, date: r.date, month: r.date.slice(0, 7), net: r.slip, why: r.why, exit: r.exitAt || (r.ceExit === r.peExit ? r.ceExit : `CE ${r.ceExit} · PE ${r.peExit}`), raw: r }));
}
const exitText = (t) => `${(WHY[t.why] || { label: t.why }).label}${t.exit ? ` · ${t.src === 'monthly' ? fmtDateShort(t.exit) : t.exit}` : ''}`;

function renderSquares() {
  const box = $('#squares');
  const id = state.selected;
  const s = strat(id);
  if (!s || (id === 'monthly' ? missing('tm') : id === 'merged' ? missing('tw', 'tm') : missing('tw'))) { box.innerHTML = errBox(['tw', 'tm']); return; }
  const c = theme();
  const list = tradesOf(id);
  const M = Math.max(1, ...list.map((t) => Math.abs(t.net)));
  const rows = id === 'monthly' ? 1 : id === 'merged' ? 6 : 5;
  const byMonth = new Map();
  list.forEach((t, i) => {
    if (!byMonth.has(t.month)) byMonth.set(t.month, { w: [], m: null });
    const g = byMonth.get(t.month);
    if (t.src === 'monthly') g.m = i; else g.w.push(i);
  });
  byMonth.forEach((g) => g.w.sort((a, b) => list[a].date.localeCompare(list[b].date)));
  const cell = (i) => {
    if (i == null) return '<span class="sq none" data-tip-html="No trade"></span>';
    const t = list[i];
    const html = `<b>${esc(t.src === 'monthly' ? `${fmtMonth(t.month)} (monthly)` : fmtDateWd(t.date))}</b><br>${esc(strat(t.src === 'monthly' ? 'monthly' : t.src)?.name || '')} · <span style="font-family:${NUM_FONT}">${signed(t.net)}</span> after slippage<br>${esc(exitText(t))}`;
    const click = t.src !== 'monthly';
    const cur = state.lastDay && state.lastDay === t.date && click ? ' cur' : '';
    return `<span class="sq${click ? ' on' : ''}${cur}" style="background:${divColor(t.net, M, c)}" data-i="${i}" data-tip-html="${esc(html)}"></span>`;
  };
  const slots = (key) => {
    const g = byMonth.get(key) || { w: [], m: null };
    if (id === 'monthly') return cell(g.m);
    let out = '';
    for (let r = 0; r < 5; r += 1) out += cell(g.w[r]);
    if (id === 'merged') out += cell(g.m);
    return out;
  };
  const allMonths = [...byMonth.keys()].sort();
  const lo = allMonths[0]; const hi = allMonths[allMonths.length - 1];
  const scale = `<span class="sq-scale"><span class="mono">${signed(-M)}</span><span class="bar" style="background:linear-gradient(90deg, ${c.loss}, ${c.inset}, ${c.profit})"></span><span class="mono">${signed(M)}</span></span>`;
  if (monthsMobile()) {
    const y = currentYear();
    const months = [];
    for (let m = 1; m <= 12; m += 1) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k >= lo && k <= hi) months.push(k); }
    box.className = 'squares sq-mobile';
    box.innerHTML = `<div class="sqm">${months.map((k) => `<div class="sqm-row" style="grid-template-columns:40px repeat(${rows}, minmax(0, 48px))"><span class="sqm-l">${MON[Number(k.slice(5)) - 1]}</span>${slots(k)}</div>`).join('')}</div>`
      + `<div class="sq-foot"><span>Each square is one trade of ${y}. Rows are months; ${id === 'monthly' ? 'one square per month.' : id === 'merged' ? 'squares 1–5 are the Weekly v3 expiry days, the 6th is the monthly trade.' : 'squares are the first through fifth expiry of that month.'}${id !== 'monthly' ? ' Tap a weekly square to open that day.' : ''}</span>${scale}</div>`;
  } else {
    const years = [...new Set(allMonths.map((k) => k.slice(0, 4)))];
    box.className = 'squares';
    box.innerHTML = years.map((y) => {
      let cells = '';
      for (let m = 1; m <= 12; m += 1) cells += slots(`${y}-${String(m).padStart(2, '0')}`);
      return `<div><div class="sq-year-l">${y}</div><div class="sq-grid" style="grid-template-rows:repeat(${rows}, auto)">${cells}</div><div class="sq-m" aria-hidden="true">${MON.map((x) => `<span>${x[0]}</span>`).join('')}</div></div>`;
    }).join('') + `<div class="sq-foot"><span>Each square is one trade. ${id === 'monthly' ? 'One square per month.' : id === 'merged' ? 'Columns are months; rows 1–5 are the Weekly v3 expiry days of that month, row 6 the monthly trade.' : 'Columns are months; rows are the first through fifth expiry of that month.'}${id !== 'monthly' ? ' Click a weekly square to open that day.' : ''}</span>${scale}</div>`;
  }
  $('#sqTitle').textContent = `Every trade · ${s.name}`;
  $('#sqNote').textContent = `${list.length} trades, in date order, coloured by net after slippage.`;
  box.setAttribute('role', 'img');
  const wins = list.filter((t) => Math.round(t.net) > 0).length;
  box.setAttribute('aria-label', `${list.length} trades of ${s.name}: ${wins} made money, ${list.length - wins} did not. The trade table below lists every one.`);
  box.__list = list;
}
function setupSquares() {
  $('#squares').addEventListener('click', (e) => {
    const sq = e.target.closest('.sq.on');
    if (!sq) return;
    const t = $('#squares').__list?.[Number(sq.dataset.i)];
    if (!t || t.src === 'monthly') return;
    hideTip();
    openDay(t.date, WEEKLY.includes(t.src) ? t.src : 'v3', null);
  });
}

// ---------- 4. Exit reasons: one 24 px two-segment bar (review row 10) ----------
function exitBlock(id, name, color) {
  const list = tradesOf(id);
  const groups = new Map();
  list.forEach((t) => {
    const g = groups.get(t.why) || { n: 0, net: 0 };
    g.n += 1; g.net += t.net;
    groups.set(t.why, g);
  });
  const order = [...groups.keys()].sort((a, b) => ((WHY[a]?.kind === 'hold' ? 0 : 1) - (WHY[b]?.kind === 'hold' ? 0 : 1)));
  const n = list.length;
  const col = (why) => (WHY[why]?.kind === 'hold' ? color : 'var(--loss)');
  const label = (why) => (why === 'LEG STOP' && LEG_POINTS[id] ? `Leg stop (${LEG_POINTS[id]} pts)` : (WHY[why]?.label || why));
  return `<div class="xr">
    <div class="xr-t"><b>${esc(name)}</b><span class="muted">${n} trades</span></div>
    <div class="xr-bar" role="img" aria-label="${order.map((w) => `${label(w)} ${(groups.get(w).n / n * 100).toFixed(1)}%`).join(', ')}">${order.map((w) => `<span class="xr-seg" style="background:${col(w)};flex:${groups.get(w).n} 1 0"></span>`).join('')}</div>
    <div class="xr-leg">${order.map((w) => { const g = groups.get(w); return `<div class="xr-row" style="--c:${col(w)}"><i aria-hidden="true"></i><span>${esc(label(w))} <span class="sub mono">${(g.n / n * 100).toFixed(1)}% · ${g.n}</span></span><span class="num ${tone(g.net)}">${signed(g.net)}</span></div>`; }).join('')}</div>
  </div>`;
}
function renderExitBars() {
  const box = $('#exitBars');
  const id = state.selected;
  const cap = '<p class="xr-cap">Exit method, not win rate.</p>';
  if (id === 'merged') {
    if (missing('tw', 'tm')) { box.innerHTML = errBox(['tw', 'tm']); return; }
    box.innerHTML = exitBlock('v3', `${strat('v3')?.name || 'Weekly v3'} (Jan 2024 – Sep 2026)`, SERIES.v3) + exitBlock('monthly', strat('monthly')?.name || 'Monthly', SERIES.monthly) + cap;
    return;
  }
  if (id === 'monthly' ? missing('tm') : missing('tw')) { box.innerHTML = errBox([id === 'monthly' ? 'tm' : 'tw']); return; }
  box.innerHTML = exitBlock(id, strat(id)?.name || id, seriesVar(id)) + cap;
}

// ---------- 4. Monthly view: NIFTY daily candles with the sold strikes (row 14b, review row 12) ----------
function monthlyTrades() {
  const out = (state.data.tm?.spot || []).map((r) => ({
    month: r.month, entry: r.entry, exit: r.why === 'STOP' ? r.ce_at : r.expiry, ceK: r.ceK, peK: r.peK, stop: r.why === 'STOP',
    breach: r.ce_out > r.pe_out ? 'ce' : 'pe', net: r.s25, paper: false,
  }));
  (state.data.pm?.months || []).filter((x) => x.ceK != null && !out.some((o) => o.month === x.month)).forEach((x) => out.push({
    month: x.month, entry: x.entry, exit: x.exit?.date || x.last?.date || x.entry, ceK: x.ceK, peK: x.peK,
    stop: x.exit?.why === 'STOP', breach: (x.exit?.ce ?? x.last?.ce ?? 0) > (x.exit?.pe ?? x.last?.pe ?? 0) ? 'ce' : 'pe',
    net: x.status === 'closed' ? x.net : x.last?.mtm, paper: true, open: x.status === 'open',
  }));
  return out;
}
function mvOption() {
  const c = theme();
  const cs = state.data.nd.candles;
  const dates = cs.map((r) => r[0]);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const at = (d) => { if (idx.has(d)) return idx.get(d); let i = dates.findIndex((x) => x > d); if (i === -1) i = dates.length - 1; return i; };
  const trades = monthlyTrades();
  const span = new Map();
  const ce = []; const pe = []; const stops = [];
  trades.forEach((t) => {
    const a = at(t.entry); const b = Math.max(a, dates[at(t.exit)] > t.exit ? at(t.exit) - 1 : at(t.exit));
    for (let i = a; i <= b; i += 1) span.set(i, t);
    ce.push({ coords: [[a, t.ceK], [b, t.ceK]] });
    pe.push({ coords: [[a, t.peK], [b, t.peK]] });
    if (t.stop) stops.push({ value: [b, t.breach === 'ce' ? t.ceK : t.peK], t });
  });
  const n = dates.length;
  // On a phone the legend wraps to two lines and 250 daily candles would be a smear: show about four months.
  const nar = narrow('#mvChart');
  const from = Math.max(0, n - (nar ? 90 : 250));
  return {
    animation: false,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: { left: 8, right: 16, top: nar ? 64 : 36, bottom: 56, containLabel: true },
    legend: { top: 0, left: 4, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: c.text, fontSize: 12 }, inactiveColor: c.faint, data: ['NIFTY', 'Sold CE strike', 'Sold PE strike', 'Stop exit'] },
    tooltip: {
      ...tooltipBase(c), trigger: 'axis', axisPointer: { type: 'cross', lineStyle: { color: c.faint, type: 'dashed' }, crossStyle: { color: c.faint }, label: { backgroundColor: c.inset, color: c.text, fontFamily: NUM_FONT, fontSize: 12 } },
      formatter: (params) => {
        const i = params[0].dataIndex;
        const r = cs[i];
        const t = span.get(i);
        let h = `<div style="font-weight:600;margin-bottom:4px">${fmtDateWd(r[0])}</div>`;
        h += tipRow('', 'NIFTY open', p2(r[1])) + tipRow('', 'High', p2(r[2])) + tipRow('', 'Low', p2(r[3])) + tipRow('', 'Close', p2(r[4]));
        if (t) {
          h += `<div style="height:1px;background:rgba(148,163,184,.2);margin:6px 0"></div><div style="font-weight:600;margin-bottom:2px">${esc(fmtMonth(t.month))} trade${t.paper ? ' (paper)' : ''}</div>`;
          h += tipRow('', 'Sold', `${t.ceK} CE / ${t.peK} PE`) + tipRow('', 'Entry', fmtDate(t.entry));
          h += tipRow('', t.open ? 'Still open' : t.stop ? 'Exit (2× stop)' : 'Exit (expiry)', t.open ? '—' : fmtDate(t.exit));
          if (t.net != null) h += tipRow('', t.open ? 'MTM so far' : 'Net', signed(t.net));
        }
        return h;
      },
    },
    xAxis: { type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: c.borderStrong } }, axisTick: { show: false }, axisLabel: { ...axisLabel(c), hideOverlap: true, formatter: (v) => fmtDateShort(v) + (v.slice(5, 7) === '01' ? ` ${v.slice(0, 4)}` : '') }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLabel: { ...axisLabel(c), formatter: (v) => nf0.format(v) }, splitLine: { lineStyle: { color: c.border } } },
    dataZoom: [
      { type: 'inside', startValue: from, endValue: n - 1 },
      { type: 'slider', startValue: from, endValue: n - 1, height: 22, bottom: 12, left: 56, right: 24, borderColor: c.border, backgroundColor: 'transparent', fillerColor: c.wash, dataBackground: { lineStyle: { color: c.faint, width: 1 }, areaStyle: { color: c.inset, opacity: 1 } }, handleStyle: { color: c.panel, borderColor: c.accent }, textStyle: { ...axisLabel(c) }, labelFormatter: (v) => (dates[v] ? fmtDateShort(dates[v]) : ''), brushSelect: false },
    ],
    series: [
      { name: 'NIFTY', type: 'candlestick', data: cs.map((r) => [r[1], r[4], r[3], r[2]]), itemStyle: { color: CANDLE_UP, color0: CANDLE_DOWN, borderColor: CANDLE_UP, borderColor0: CANDLE_DOWN } },
      { name: 'Sold CE strike', type: 'lines', coordinateSystem: 'cartesian2d', polyline: false, data: ce, lineStyle: { color: c.accent, width: 2, opacity: 1 }, itemStyle: { color: c.accent }, silent: true, z: 4 },
      { name: 'Sold PE strike', type: 'lines', coordinateSystem: 'cartesian2d', polyline: false, data: pe, lineStyle: { color: c.accent, width: 2, type: 'dashed', opacity: 1 }, itemStyle: { color: c.accent }, silent: true, z: 4 },
      { name: 'Stop exit', type: 'scatter', data: stops.map((x) => x.value), symbol: 'triangle', symbolSize: 11, itemStyle: { color: c.loss, borderColor: c.panel, borderWidth: 1 }, z: 6, tooltip: { show: false } },
    ],
  };
}
// The visible window, so the subtitle's full data range is never mistaken for what is on screen.
function updateMvRange() {
  const ch = charts.mv;
  if (!ch || ch.isDisposed()) return;
  const dz = ch.getOption().dataZoom?.[0];
  const cs = state.data.nd.candles;
  const a = cs[Math.max(0, Math.round(dz?.startValue ?? 0))];
  const b = cs[Math.min(cs.length - 1, Math.round(dz?.endValue ?? cs.length - 1))];
  if (a && b) $('#mvRange').textContent = `Showing ${fmtDate(a[0])} – ${fmtDate(b[0])}`;
}
function setupMonthlyView() {
  const el = $('#mvChart');
  if (missing('nd') || missing('tm')) {
    el.innerHTML = `<div class="chart-msg">The NIFTY daily candles are not in the data yet${state.errors.nd ? ` (${esc(state.errors.nd)})` : ''}.</div>`;
    return;
  }
  const nd = state.data.nd;
  const trades = monthlyTrades();
  $('#mvInfo').innerHTML = info('Source', 'NIFTY 50 daily candles from three sources; see "About this data" under the chart.');
  $('#mvAbout').innerHTML = nd.source ? `<details class="more about-data"><summary>About this data</summary><p>${esc(nd.source)}</p></details>` : '';
  $('#mvNote').textContent = `Daily candles, ${fmtDate(nd.candles[0][0])} – ${fmtDate(nd.candles[nd.candles.length - 1][0])}. Each month's sold CE (solid) and PE (dashed) strikes run from entry to exit; red triangles are the ${trades.filter((t) => t.stop).length} stop exits.`;
  whenNear(el, () => mount('mv', el, mvOption, (ch) => { ch.on('datazoom', updateMvRange); updateMvRange(); }));
}

// ---------- Day drawer: one weekly expiry day in 5-minute candles (row 14a) ----------
function dayRow(stratId, date) { return (state.data.tw?.[stratId] || []).find((r) => r.date === date); }
function dayExits(dd, row, stratId) {
  const e = dd?.exits?.[stratId];
  if (e && (e.ce || e.pe)) return { ce: e.ce ? hm(e.ce) : null, pe: e.pe ? hm(e.pe) : null };
  if (!row) return { ce: null, pe: null };
  if (row.exitAt) return { ce: hm(row.exitAt), pe: hm(row.exitAt) };
  return { ce: row.ceExit ? hm(row.ceExit) : null, pe: row.peExit ? hm(row.peExit) : null };
}
function dayOption(dd, row, stratId) {
  const c = theme();
  const step = dd.step || 5;
  const T = dd.nifty.map((r) => hm(r[0]));
  const bucket = (t) => { const m = minutesOf(t); const b = hmOf(m - (m % step)); return T.includes(b) ? b : T[T.length - 1]; };
  const ceBy = new Map((dd.ce || []).map((r) => [hm(r[0]), r]));
  const peBy = new Map((dd.pe || []).map((r) => [hm(r[0]), r]));
  const prem = T.map((t) => (ceBy.has(t) && peBy.has(t) ? Math.round((ceBy.get(t)[4] + peBy.get(t)[4]) * 100) / 100 : null));
  const credit = row ? row.credit : null;
  const ex = dayExits(dd, row, stratId);
  const entry = hm(dd.entry || '09:26');
  const isStop = row && row.why !== 'SQ1515';
  const nar = narrow('#dayChart');
  // Phones get short marker labels; the exact times are in the facts above the chart.
  const L = (long, short) => (nar ? short : long);
  const vlines = [{ xAxis: bucket(entry), label: L(`Entry ${entry}`, 'Entry'), color: c.accent }];
  if (ex.ce && ex.ce === ex.pe) vlines.push({ xAxis: bucket(ex.ce), label: L(`Exit ${ex.ce}`, 'Exit'), color: isStop ? c.loss : c.muted });
  else {
    if (ex.ce) vlines.push({ xAxis: bucket(ex.ce), label: L(`CE out ${ex.ce}`, 'CE out'), color: ex.ce < '15:15' ? c.loss : c.muted });
    if (ex.pe) vlines.push({ xAxis: bucket(ex.pe), label: L(`PE out ${ex.pe}`, 'PE out'), color: ex.pe < '15:15' ? c.loss : c.muted });
  }
  // Horizontal labels above the plot (review row 11), stacked on up to three levels so neighbours do not collide.
  const left = 64;
  const right = nar ? 66 : 112;
  const plotW = Math.max(100, ($('#dayChart')?.clientWidth || 800) - left - right);
  const px = (b) => ((T.indexOf(b) + 0.5) / T.length) * plotW;
  const ends = [-Infinity, -Infinity, -Infinity];
  vlines.slice().sort((a, b) => T.indexOf(a.xAxis) - T.indexOf(b.xAxis)).forEach((v) => {
    const w = v.label.length * 6.8 + 8;
    const x0 = px(v.xAxis) - w / 2;
    let lvl = ends.findIndex((e) => e <= x0);
    if (lvl === -1) lvl = 2;
    ends[lvl] = x0 + w;
    v.level = lvl;
  });
  const vml = (withLabel) => vlines.map((v) => ({
    xAxis: v.xAxis, lineStyle: { color: v.color, type: 'dashed', width: 1.25 },
    label: { show: withLabel, formatter: v.label, color: v.color, fontFamily: NUM_FONT, fontSize: 11, position: 'end', distance: 4 + (v.level || 0) * 14 },
  }));
  const lows = dd.nifty.map((r) => r[3]).concat([dd.ceK, dd.peK]);
  const highs = dd.nifty.map((r) => r[2]).concat([dd.ceK, dd.peK]);
  const lo = Math.min(...lows); const hi = Math.max(...highs); const pad = (hi - lo) * 0.14;
  // v3's rule is on CE + PE together; LEG-20/40 stop each leg on its own price, so they get the two legs separately.
  const X = LEG_POINTS[stratId];
  const legMode = Boolean(X && row);
  const ceLine = T.map((t) => (ceBy.has(t) ? ceBy.get(t)[4] : null));
  const peLine = T.map((t) => (peBy.has(t) ? peBy.get(t)[4] : null));
  const ceStop = legMode ? Math.round((row.ceIn + X) * 100) / 100 : null;
  const peStop = legMode ? Math.round((row.peIn + X) * 100) / 100 : null;
  const finite = (a) => a.filter((v) => v != null);
  const pmax = legMode ? Math.max(...finite(ceLine), ...finite(peLine), ceStop, peStop) : Math.max(...finite(prem), credit ? credit * 2 : 0);
  // Reference-line labels sit in the right margin (outside the plot, so no vertical marker can cross them).
  // Two labels closer than 14 px are pushed apart, the higher one up and the lower one down.
  const elH = $('#dayChart')?.clientHeight || 520;
  const lowerPx = elH * 0.28 - 28;
  const pmaxAxis = Math.ceil(pmax * 1.12);
  const nudge = (a, b) => (a != null && b != null && (Math.abs(a - b) / pmaxAxis) * lowerPx < 14 ? (a > b ? [-7, 7] : [7, -7]) : [0, 0]);
  const [ceOff, peOff] = legMode ? nudge(ceStop, peStop) : [0, 0];
  const lbl = (text, color, position, dy = 0) => ({ formatter: text, color, fontFamily: NUM_FONT, fontSize: 11, position: 'end', distance: 6, offset: [0, dy] });
  const lower = legMode ? [
    {
      name: `${dd.ceK} CE`, type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: ceLine, showSymbol: false, connectNulls: false,
      lineStyle: { color: c.accent, width: 2 }, itemStyle: { color: c.accent },
      markLine: { silent: true, symbol: 'none', animation: false, data: [{ yAxis: ceStop, lineStyle: { color: c.accent, type: 'dashed', width: 1.25 }, label: lbl(L(`CE stop ${p2(ceStop)}`, 'CE stop'), c.accent, 'end', ceOff) }, ...vml(false)] },
    },
    {
      name: `${dd.peK} PE`, type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: peLine, showSymbol: false, connectNulls: false,
      lineStyle: { color: c.text, width: 2 }, itemStyle: { color: c.text },
      markLine: { silent: true, symbol: 'none', animation: false, data: [{ yAxis: peStop, lineStyle: { color: c.text, type: 'dashed', width: 1.25 }, label: lbl(L(`PE stop ${p2(peStop)}`, 'PE stop'), c.text, 'end', peOff) }] },
    },
  ] : [{
    name: 'CE + PE', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: prem, showSymbol: false, connectNulls: false,
    lineStyle: { color: c.text, width: 2 }, itemStyle: { color: c.text },
    markLine: {
      silent: true, symbol: 'none', animation: false,
      data: [
        ...(credit ? [
          { yAxis: credit, lineStyle: { color: c.muted, type: 'dashed', width: 1.25 }, label: lbl(L(`Credit ${p2(credit)}`, 'Credit'), c.muted, 'end') },
          { yAxis: credit * 2, lineStyle: { color: c.loss, type: 'dashed', width: 1.25 }, label: lbl(L(`2× stop ${p2(credit * 2)}`, '2× stop'), c.loss, 'end') },
        ] : []),
        ...vml(false),
      ],
    },
  }];
  const top0 = 74;
  return {
    animation: false,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: c.inset, color: c.text, fontFamily: NUM_FONT, fontSize: 12 } },
    grid: [{ left, right, top: top0, height: nar ? '40%' : '46%' }, { left, right, top: '72%', bottom: 28 }],
    legend: { show: legMode, top: '66%', right, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: c.text, fontSize: 12 }, inactiveColor: c.faint, data: legMode ? [`${dd.ceK} CE`, `${dd.peK} PE`] : [] },
    tooltip: {
      ...tooltipBase(c), trigger: 'axis', axisPointer: { type: 'cross', lineStyle: { color: c.faint, type: 'dashed' }, crossStyle: { color: c.faint } },
      formatter: (params) => {
        const i = params[0].dataIndex;
        const t = T[i];
        const n = dd.nifty[i];
        let h = `<div style="font-weight:600;margin-bottom:4px">${t} – ${hmOf(minutesOf(t) + step - 1)}</div>`;
        h += tipRow('', 'NIFTY open / close', `${p2(n[1])} / ${p2(n[4])}`) + tipRow('', 'NIFTY high / low', `${p2(n[2])} / ${p2(n[3])}`);
        h += tipRow('', `${dd.ceK} CE close`, ceBy.has(t) ? p2(ceBy.get(t)[4]) : 'no print');
        h += tipRow('', `${dd.peK} PE close`, peBy.has(t) ? p2(peBy.get(t)[4]) : 'no print');
        if (legMode) h += tipRow('', 'CE stop', p2(ceStop)) + tipRow('', 'PE stop', p2(peStop));
        else if (prem[i] != null) h += tipRow('', 'CE + PE', p2(prem[i]));
        return h;
      },
    },
    xAxis: [
      { type: 'category', data: T, gridIndex: 0, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: c.borderStrong } } },
      { type: 'category', data: T, gridIndex: 1, boundaryGap: true, axisTick: { show: false }, axisLine: { lineStyle: { color: c.borderStrong } }, axisLabel: { ...axisLabel(c), interval: nar ? (i, v) => v.endsWith(':00') && Number(v.slice(0, 2)) % 2 === 0 : (i, v) => v.endsWith(':00') || v.endsWith(':30') } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: 'NIFTY', nameLocation: 'end', nameGap: 46, nameTextStyle: { color: c.muted, fontSize: 12, align: 'right' }, min: Math.floor(lo - pad), max: Math.ceil(hi + pad), axisLabel: { ...axisLabel(c), formatter: (v) => nf0.format(v) }, splitLine: { lineStyle: { color: c.border } } },
      { type: 'value', gridIndex: 1, name: legMode ? 'CE, PE' : 'CE + PE', nameLocation: 'end', nameGap: 10, nameTextStyle: { color: c.muted, fontSize: 12, align: 'right' }, min: 0, max: Math.ceil(pmax * 1.12), axisLabel: { ...axisLabel(c) }, splitLine: { lineStyle: { color: c.border } } },
    ],
    series: [
      {
        name: 'NIFTY', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: dd.nifty.map((r) => [r[1], r[4], r[3], r[2]]),
        itemStyle: { color: CANDLE_UP, color0: CANDLE_DOWN, borderColor: CANDLE_UP, borderColor0: CANDLE_DOWN },
        markLine: {
          silent: true, symbol: 'none', animation: false,
          data: [
            { yAxis: dd.ceK, lineStyle: { color: c.accent, width: 1.5, type: 'solid' }, label: { formatter: L(`Sold ${dd.ceK} CE`, `${dd.ceK} CE`), color: c.accent, fontFamily: NUM_FONT, fontSize: 11, position: 'end', distance: 6 } },
            { yAxis: dd.peK, lineStyle: { color: c.accent, width: 1.5, type: 'dashed' }, label: { formatter: L(`Sold ${dd.peK} PE`, `${dd.peK} PE`), color: c.accent, fontFamily: NUM_FONT, fontSize: 11, position: 'end', distance: 6 } },
            ...vml(true),
          ],
        },
      },
      ...lower,
    ],
  };
}

let dayOpener = null;
function setupDrawer() {
  const dr = $('#dayDrawer');
  $('#dayClose').addEventListener('click', closeDay);
  dr.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDay(); });
  $('#dayPrev').addEventListener('click', () => stepDay(-1));
  $('#dayNext').addEventListener('click', () => stepDay(1));
  $('#dayStrat').innerHTML = WEEKLY.map((id) => `<button type="button" data-id="${id}" aria-pressed="false">${esc(strat(id)?.name || SHORT[id])}</button>`).join('');
  $('#dayStrat').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.day) return;
    state.day.strat = b.dataset.id;
    renderDay();
  });
  document.addEventListener('keydown', (e) => {
    if (dr.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDay(); return; }
    if (e.key === 'Tab') {
      // Keep keyboard focus inside the open dialog.
      const f = $$('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])', $('.drawer-panel')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}
function openDay(date, stratId, opener) {
  if (missing('tw')) return;
  dayOpener = opener || document.activeElement;
  const dates = (state.data.tw.v3 || []).map((r) => r.date).sort();
  state.day = { date, strat: WEEKLY.includes(stratId) ? stratId : 'v3', dates };
  state.lastDay = date;
  const dr = $('#dayDrawer');
  dr.hidden = false;
  document.body.classList.add('locked');
  renderDay();
  $('#dayClose').focus();
}
function closeDay() {
  const dr = $('#dayDrawer');
  if (dr.hidden) return;
  dr.hidden = true;
  document.body.classList.remove('locked');
  safely(renderSquares, $('#squares'));
  hideTip();
  const back = dayOpener && document.contains(dayOpener) ? dayOpener : null;
  if (back) back.focus();
  dayOpener = null;
}
function stepDay(k) {
  if (!state.day) return;
  const i = state.day.dates.indexOf(state.day.date);
  const j = i + k;
  if (j < 0 || j >= state.day.dates.length) return;
  state.day.date = state.day.dates[j];
  state.lastDay = state.day.date;
  renderDay();
}
async function renderDay() {
  const { date, strat: sid, dates } = state.day;
  const s = strat(sid);
  const row = dayRow(sid, date);
  const i = dates.indexOf(date);
  $('#dayPrev').disabled = i <= 0;
  $('#dayNext').disabled = i >= dates.length - 1;
  $('#dayTitle').textContent = fmtDateWd(date);
  $('#daySub').textContent = `Signal 09:25 · Entry ${hm(dayCache.get(date)?.entry || '09:26')} · exits of ${s?.name || SHORT[sid]} · trade ${i + 1} of ${dates.length}`;
  $$('#dayStrat button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === sid)));
  $('#dayExplain').innerHTML = row ? nowrapMoney(esc(explain(rowModel(row, sid), sid))) : 'This strategy has no trade on this day.';
  $('#dayKv').innerHTML = row ? `
    <div><div class="label">NIFTY at the 09:25 signal</div><div class="kv-v num">${p2(row.spot)}</div></div>
    <div><div class="label">Credit</div><div class="kv-v num">${p2(row.credit)}</div><div class="kv-sub">${LEG_POINTS[sid] ? `Leg stops: CE <span class="mono">${p2(row.ceIn + LEG_POINTS[sid])}</span> · PE <span class="mono">${p2(row.peIn + LEG_POINTS[sid])}</span>` : `2× stop <span class="mono">${p2(row.credit * 2)}</span>`}</div></div>
    <div><div class="label">Exit</div><div class="kv-v">${esc((WHY[row.why] || { label: row.why }).label)}</div><div class="kv-sub mono">${esc(row.exitAt || `CE ${row.ceExit} · PE ${row.peExit}`)}</div></div>
    <div><div class="label">Net after slippage</div><div class="kv-v num ${tone(row.slip)}">${signed(row.slip)}</div></div>` : '';
  const el = $('#dayChart');
  let dd = dayCache.get(date);
  if (!dd) {
    if (!charts.day) el.innerHTML = '<div class="chart-msg">Loading the day’s candles…</div>';
    try {
      dd = await getJSON(`data/days/${date}.json`);
      dayCache.set(date, dd);
    } catch (e) {
      if (state.day?.date !== date) return;
      if (charts.day) { charts.day.dispose(); delete charts.day; }
      el.innerHTML = `<div class="chart-msg">The candles of this day are not in the data yet (${esc(e.message)}).</div>`;
      return;
    }
  }
  if (state.day?.date !== date || $('#dayDrawer').hidden) return;
  if (charts.day && charts.day.getDom() !== el) { charts.day.dispose(); delete charts.day; }
  await mount('day', el, () => dayOption(dd, row, sid));
  charts.day?.resize();
}

// ---------- 5. Trades ----------
const TABLE_STRATS = ['v3', 'leg20', 'leg40', 'monthly'];
const COLS = [
  { key: 'date', label: 'Date', num: false },
  { key: 'spot', label: 'NIFTY', num: true },
  { key: 'ce', label: 'Sold CE', num: false },
  { key: 'pe', label: 'Sold PE', num: false },
  { key: 'credit', label: 'Credit', num: true },
  { key: 'exit', label: 'Exit', num: false },
  { key: 'net', label: 'Net ₹', num: true },
];
const SORT_SVG = '<svg class="sort-i" viewBox="0 0 8 10" aria-hidden="true" focusable="false"><path class="up" d="M4 0 8 4H0z"/><path class="dn" d="M4 10 0 6h8z"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M3.5 1.5 7 5l-3.5 3.5"/></svg>';

function weeklyExit(r) {
  if (r.exitAt) {
    if (r.why === 'STOP') return { html: `<span class="why stop">2× stop</span> <span class="sub mono">${esc(r.exitAt)}</span>`, key: `1|${r.exitAt}` };
    return { html: `<span class="why hold">Held to</span> <span class="sub mono">${esc(r.exitAt)}</span>`, key: `2|${r.exitAt}` };
  }
  const ce = r.ceExit; const pe = r.peExit;
  if (r.why === 'LEG STOP' || ce !== pe) {
    const first = [ce, pe].filter(Boolean).sort()[0];
    return { html: `<span class="why stop">Leg stop</span> <span class="sub mono">CE ${esc(ce)} · PE ${esc(pe)}</span>`, key: `1|${first}` };
  }
  return { html: `<span class="why hold">Held to</span> <span class="sub mono">${esc(ce || '15:15')}</span>`, key: `2|${ce}` };
}
function rowModel(r, id) {
  if (id === 'monthly') {
    const stop = r.why === 'STOP';
    return {
      id: `m-${r.month}`, date: r.entry, year: r.entry.slice(0, 4), spot: r.spot, ceK: r.ceK, peK: r.peK,
      ceIn: r.ce_in, peIn: r.pe_in, credit: r.credit, net: r.s25, gross: r.net, raw: r,
      dateHTML: `${fmtDateShort(r.entry)} → ${fmtDate(r.expiry)}`,
      exitHTML: stop ? `<span class="why stop">2× stop</span> <span class="sub mono">${fmtDateShort(r.ce_at)}</span>` : `<span class="why hold">Expiry</span> <span class="sub mono">${fmtDateShort(r.expiry)}</span>`,
      exitKey: `${stop ? 1 : 2}|${stop ? r.ce_at : r.expiry}`,
    };
  }
  const ex = weeklyExit(r);
  return {
    id: `${id}-${r.date}`, date: r.date, year: r.date.slice(0, 4), spot: r.spot, ceK: r.ceK, peK: r.peK,
    ceIn: r.ceIn, peIn: r.peIn, credit: r.credit, net: r.slip, gross: r.net, raw: r,
    dateHTML: fmtDateWd(r.date), exitHTML: ex.html, exitKey: ex.key,
  };
}
const rowsFor = (id) => (id === 'monthly' ? (state.data.tm?.spot || []) : (state.data.tw?.[id] || [])).map((r) => rowModel(r, id));

const at = (v) => (v == null ? '' : ` at ${p2(v)}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const netSentence = (gross, slip) => `Net ${signed(gross)} after charges, ${signed(slip)} after slippage.`;
function explain(row, id) {
  const r = row.raw;
  if (id === 'monthly') {
    const sold = `On ${fmtDate(r.entry)}, with NIFTY at ${p2(r.spot)}, sold the ${r.ceK} CE at ${p2(r.ce_in)} and the ${r.peK} PE at ${p2(r.pe_in)} (credit ${p2(r.credit)}).`;
    const exit = r.why === 'STOP'
      ? `CE + PE closed at 2× the credit or more, so both were bought back at the next day's open on ${fmtDate(r.ce_at)}: CE${at(r.ce_out)}, PE${at(r.pe_out)}.`
      : `No stop was hit, so both were held to the expiry on ${fmtDate(r.expiry)}, where CE closed at ${p2(r.ce_out)} and PE at ${p2(r.pe_out)}.`;
    return `${sold} ${exit} ${netSentence(r.net, r.s25)}`;
  }
  const sold = `At 09:25 NIFTY was ${p2(r.spot)} and the straddle was ${p2(r.W)}. Sold the ${r.ceK} CE at ${p2(r.ceIn)} and the ${r.peK} PE at ${p2(r.peIn)} (credit ${p2(r.credit)}).`;
  let exit;
  if (r.exitAt) {
    exit = r.why === 'STOP'
      ? `CE + PE reached 2× the credit, so both were bought back at ${r.exitAt}: CE${at(r.ceOut)}, PE${at(r.peOut)}.`
      : `No stop was hit, so both were bought back at ${r.exitAt}: CE${at(r.ceOut)}, PE${at(r.peOut)}.`;
  } else {
    const X = LEG_POINTS[id] || '';
    const leg = (name, time, out) => (time && time < '15:15'
      ? `the ${name} hit its ${X}-point stop and was bought back${at(out)} at ${time}`
      : `the ${name} was held and bought back${at(out)} at ${time || '15:15'}`);
    exit = `${cap(leg('CE', r.ceExit, r.ceOut))}; ${leg('PE', r.peExit, r.peOut)}.`;
  }
  const est = Number(r.est) || 0;
  const estNote = est > 0 ? ` ${est === 1 ? 'One exit price was' : `${est} exit prices were`} estimated: there was no trade print at that minute, so the last close was used.` : '';
  return `${sold} ${exit} ${netSentence(r.net, r.slip)}${estNote}`;
}

function setupTable() {
  const seg = $('#tStrat');
  seg.innerHTML = TABLE_STRATS.filter((id) => (id === 'monthly' ? state.data.tm : state.data.tw?.[id]))
    .map((id) => `<button type="button" data-id="${id}" aria-pressed="${id === state.tableStrat}" aria-label="${esc(strat(id)?.name || SHORT[id])}">${esc(id === 'monthly' ? (strat(id)?.name || 'Monthly') : SHORT[id])}</button>`).join('');
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTableStrat(b.dataset.id); });
  $('#tYear').addEventListener('change', (e) => { state.year = e.target.value; state.monthFilter = null; state.open.clear(); renderTable(); });
  $('#tFilter').addEventListener('click', (e) => {
    if (!e.target.closest('[data-clear]')) return;
    state.monthFilter = null;
    state.open.clear();
    renderTable();
    $('#tStrat button[aria-pressed="true"]')?.focus();
  });
  $('#tResult').addEventListener('change', (e) => { state.result = e.target.value; state.open.clear(); renderTable(); });
  $('#tHead').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    const key = b.dataset.key;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else state.sort = { key, dir: key === 'exit' || key === 'ce' || key === 'pe' ? 'asc' : 'desc' };
    renderTable();
    $(`#tHead button[data-key="${key}"]`)?.focus();
  });
  $('#tBody').addEventListener('click', (e) => {
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) { openDay(dayBtn.dataset.day, state.tableStrat, dayBtn); return; }
    const tr = e.target.closest('tr.trow');
    if (!tr) return;
    const id = tr.dataset.id;
    const opening = !state.open.has(id);
    if (opening) state.open.add(id); else state.open.delete(id);
    renderTable();
    const btn = $(`#tBody tr.trow[data-id="${CSS.escape(id)}"] .row-btn`);
    btn?.focus();
    // A weekly row also opens that day's candles (row 14a); Esc brings focus back to this row.
    if (opening && state.tableStrat !== 'monthly') openDay(tr.dataset.date, state.tableStrat, btn);
  });
  const scroller = $('#tScroll');
  new ResizeObserver(() => scroller.style.setProperty('--sw', `${scroller.clientWidth}px`)).observe(scroller);
  setTableStrat(state.tableStrat, true);
}
function setTableStrat(id, force) {
  if (!force && id === state.tableStrat) return;
  if (!TABLE_STRATS.includes(id)) return;
  state.tableStrat = id;
  state.open.clear();
  $$('#tStrat button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  const years = [...new Set(rowsFor(id).map((r) => r.year))].sort();
  const ySel = $('#tYear');
  if (state.year !== 'all' && !years.includes(state.year)) state.year = 'all';
  ySel.innerHTML = `<option value="all">All years</option>${years.map((y) => `<option value="${y}">${y}</option>`).join('')}`;
  ySel.value = state.year;
  renderTable();
}
// A month cell of the heatmap lists that strategy's trades of that month.
function filterTableMonth(id, month) {
  const tid = id === 'merged' ? 'v3' : id;
  state.monthFilter = { month, from: id };
  state.year = 'all';
  $('#tYear').value = 'all';
  if (state.tableStrat !== tid) setTableStrat(tid); else { state.open.clear(); renderTable(); }
  $('#trades').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  $('#tFilter [data-clear]')?.focus({ preventScroll: true });
}

function renderTable() {
  const id = state.tableStrat;
  const s = strat(id);
  const head = $('#tHead');
  const body = $('#tBody');
  if (id === 'monthly' ? missing('tm') : missing('tw')) {
    head.innerHTML = '';
    body.innerHTML = `<tr><td class="t-empty">${errBox([id === 'monthly' ? 'tm' : 'tw'])}</td></tr>`;
    return;
  }
  head.innerHTML = COLS.map((c) => {
    const label = c.key === 'date' && id === 'monthly' ? 'Sold → expiry' : c.label;
    const sort = state.sort.key === c.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${c.num ? 'r' : ''}" aria-sort="${sort}"><button type="button" data-key="${c.key}">${esc(label)}${SORT_SVG}</button></th>`;
  }).join('');
  let rows = rowsFor(id);
  const mf = state.monthFilter;
  const chip = $('#tFilter');
  if (mf) {
    rows = rows.filter((r) => (id === 'monthly' ? r.raw.month : r.date.slice(0, 7)) === mf.month);
    chip.hidden = false;
    chip.innerHTML = `<span>Showing <b>${fmtMonth(mf.month)}</b>${mf.from === 'merged' ? ' (the weekly part of v3 + Monthly)' : ''}</span><button type="button" class="btn" data-clear>Clear filter</button>`;
  } else {
    chip.hidden = true;
    chip.innerHTML = '';
  }
  if (state.year !== 'all') rows = rows.filter((r) => r.year === state.year);
  if (state.result === 'profit') rows = rows.filter((r) => Math.round(r.net) > 0);
  if (state.result === 'loss') rows = rows.filter((r) => Math.round(r.net) < 0);
  const k = state.sort.key;
  const dir = state.sort.dir === 'asc' ? 1 : -1;
  const val = (r) => ({ date: r.date, spot: r.spot, ce: r.ceK, pe: r.peK, credit: r.credit, exit: r.exitKey, net: r.net }[k]);
  rows.sort((a, b) => {
    const x = val(a); const y = val(b);
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return cmp * dir || a.date.localeCompare(b.date) * dir;
  });
  const wins = rows.filter((r) => Math.round(r.net) > 0).length;
  const losses = rows.filter((r) => Math.round(r.net) < 0).length;
  const total = rows.reduce((a, r) => a + r.net, 0);
  $('#tSummary').innerHTML = `${esc(s?.name || SHORT[id])}: <b class="mono">${rows.length}</b> ${id === 'monthly' ? 'months' : 'trades'} · <b class="mono">${wins}</b> profit · <b class="mono">${losses}</b> loss after slippage · total <b class="mono ${tone(total)}">${signed(total)}</b>. Net is after charges and 0.25 pt slippage, 1 set.`;
  if (!rows.length) { body.innerHTML = `<tr><td class="t-empty" colspan="${COLS.length}">No trades match these filters.</td></tr>`; return; }
  body.innerHTML = rows.map((r) => {
    const open = state.open.has(r.id);
    const did = `ex-${r.id}`;
    const dayBtn = id !== 'monthly' ? `<br><button type="button" class="btn" data-day="${esc(r.date)}">Open this day's candles</button>` : '';
    return `<tr class="trow${open ? ' open' : ''}" data-id="${esc(r.id)}" data-date="${esc(r.date)}">
      <td><button type="button" class="row-btn" aria-expanded="${open}" aria-controls="${esc(did)}">${CHEV}<span class="mono">${r.dateHTML}</span></button></td>
      <td class="r mono">${p2(r.spot)}</td>
      <td class="mono">${esc(r.ceK)} <span class="sub">@</span> ${p2(r.ceIn)}</td>
      <td class="mono">${esc(r.peK)} <span class="sub">@</span> ${p2(r.peIn)}</td>
      <td class="r mono">${p2(r.credit)}</td>
      <td>${r.exitHTML}</td>
      <td class="r mono ${tone(r.net)}">${signed(r.net)}</td>
    </tr>${open ? `<tr class="tdetail" id="${esc(did)}"><td colspan="${COLS.length}"><div class="explain">${nowrapMoney(esc(explain(r, id)))}${dayBtn}</div></td></tr>` : ''}`;
  }).join('');
}

// ---------- 6. Capital ----------
function setupCapital() {
  const input = $('#capInput');
  const sel = $('#capStrat');
  sel.innerHTML = strategies().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = state.selected;
  $('#capForm').addEventListener('submit', (e) => e.preventDefault());
  input.addEventListener('input', () => {
    const pos = input.selectionStart ?? input.value.length;
    const digitsBefore = input.value.slice(0, pos).replace(/\D/g, '').length;
    const digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 12);
    input.value = digits ? nf0.format(Number(digits)) : '';
    // Put the caret back after the same number of digits, so typing in the middle works.
    let i = 0; let seen = 0;
    while (i < input.value.length && seen < digitsBefore) { if (/\d/.test(input.value[i])) seen += 1; i += 1; }
    input.setSelectionRange(i, i);
    renderCapital();
  });
  sel.addEventListener('change', renderCapital);
  renderCapital();
}
function apiLine() {
  const v = state.data.meta?.costs?.dataApiPerYear;
  return Number.isFinite(Number(v)) && v != null ? `<p class="cap-api">Data API ${rupees(Number(v))} a year is needed only for the weekly paper runner.</p>` : '';
}
function renderCapital() {
  const out = $('#capOut');
  if (missing('strategies')) { out.innerHTML = errBox(['strategies']); return; }
  const capital = Number($('#capInput').value.replace(/\D/g, '')) || 0;
  const s = strat($('#capStrat').value) || strategies()[0];
  const k = s.kpi;
  const sets = Math.floor(capital / k.capitalMin);
  const safe = Math.floor(capital / k.capitalSafe);
  const years = k.net / k.perYear;
  const low = Math.min(k.net50 / years, k.perYear);
  const high = Math.max(k.net50 / years, k.perYear);
  const dd = sets * -Math.abs(k.maxDD);
  const ddPct = capital > 0 ? (Math.abs(dd) / capital) * 100 : 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const headline = sets === 0
    ? `<p class="cap-sets zero" id="capSets">0 sets: one set needs ${rupees(k.capitalMin)}</p>`
    : `<p class="cap-sets" id="capSets">${plural(sets, 'set')}</p><p class="cap-lead">You can run ${plural(sets, 'set')} of ${esc(s.name)} with ${rupees(capital)}.</p>`;
  let warn;
  if (sets === 0) warn = `This is below the minimum for one set. The margin alone on an expiry day is ${rupees(k.marginPeak)}.`;
  else if (sets > safe) warn = `${plural(sets, 'set')} ${sets === 1 ? 'fits' : 'fit'} the margin, but the buffered-capital rule covers ${safe === 0 ? 'none' : plural(safe, 'set')}. A drawdown like the worst one seen would take ${ddPct.toFixed(1)}% of your capital, and a future one can be deeper.`;
  else warn = `A drawdown like the worst one seen would take ${ddPct.toFixed(1)}% of your capital. A future one can be deeper. These are backtest numbers, not a promise.`;
  out.innerHTML = `
    <div>${headline}</div>
    <div class="cap-rows">
      <div class="cap-row"><span class="label">Sets you can run ${info('Capital min', 'capitalMin')}</span><span class="v">${sets}<small>one set needs ${rupees(k.capitalMin)}</small></span></div>
      <div class="cap-row"><span class="label">Sets with the drawdown buffer ${info('Buffered capital', 'capitalSafe')}</span><span class="v" id="capSafe">${safe}<small>one buffered set needs ${rupees(k.capitalSafe)}</small></span></div>
      <div class="cap-row"><span class="label">Average per year (historical) ${info('Average per year (historical)', 'perYear')}</span><span class="v" id="capRange">${sets ? `<span class="num ${tone(sets * low)}">${signed(sets * low)}</span> to <span class="num ${tone(sets * high)}">${signed(sets * high)}</span>` : '—'}<small>at 0.5 pt to 0.25 pt slippage</small></span></div>
      <div class="cap-row"><span class="label">Worst drawdown seen ${info('Max drawdown', 'maxDD')}</span><span class="v" id="capDD">${sets ? `<span class="num neg">${signed(dd)}</span>` : '—'}<small>${sets ? `${ddPct.toFixed(1)}% of your capital` : 'no set to run'}</small></span></div>
    </div>
    <div class="warnbox" role="note">${WARN_SVG}<span>${warn}</span></div>
    ${apiLine()}`;
}

// ---------- 7. How it works ----------
function renderHow() {
  const intro = $('#exIntro');
  const grid = $('#exGrid');
  const day = '2025-01-02';
  if (missing('tw')) { intro.innerHTML = errBox(['tw']); return; }
  const v3 = dayRow('v3', day);
  const l20 = dayRow('leg20', day);
  if (!v3 || !l20) { intro.textContent = 'The example day is not in the trade data.'; return; }
  intro.innerHTML = `On ${fmtDateWd(day)}, NIFTY was <span class="mono">${p2(v3.spot)}</span> at 09:25 and the straddle was <span class="mono">${p2(v3.W)}</span>. Both versions sold the <span class="mono">${v3.ceK}</span> CE at <span class="mono">${p2(v3.ceIn)}</span> and the <span class="mono">${v3.peK}</span> PE at <span class="mono">${p2(v3.peIn)}</span>, a credit of <span class="mono">${p2(v3.credit)}</span> points. Then they did different things.`;
  const card = (name, color, r, text) => `
    <div class="ex-card">
      <div class="ex-head"><b><span class="swatch" style="background:${color}" aria-hidden="true"></span>${esc(name)}</b><span class="pill ${r.net < 0 ? 'loss' : 'profit'}">${r.net < 0 ? 'Lost' : 'Made'}</span></div>
      <div class="ex-net num ${tone(r.net)}">${signed(r.net)}</div>
      <p>${text}</p>
      <p class="kv-sub">After charges. With 0.25 pt slippage: <span class="mono ${tone(r.slip)}">${signed(r.slip)}</span>.</p>
    </div>`;
  const v3Text = v3.why === 'STOP'
    ? `By ${esc(v3.exitAt)} the CE had jumped, and CE + PE cost 2× the credit. The stop bought both back: the CE${at(v3.ceOut)}, the PE${at(v3.peOut)}.`
    : `No stop was hit. Both were bought back at ${esc(v3.exitAt)}.`;
  const legText = (name, time, out) => (time < '15:15'
    ? `The ${name} rose 20 points, so it alone was bought back${at(out)} at ${esc(time)}.`
    : `The ${name} was held and bought back${at(out)} at ${esc(time)}.`);
  const l20Text = `${legText('CE', l20.ceExit, l20.ceOut)} ${legText('PE', l20.peExit, l20.peOut)}`;
  grid.innerHTML = card(strat('v3')?.name || 'Weekly v3', SERIES.v3, v3, v3Text) + card(strat('leg20')?.name || 'Weekly LEG-20', SERIES.leg20, l20, l20Text)
    + `<p class="kv-sub" style="grid-column:1/-1"><button type="button" class="btn" id="exDay">Open the candles of this day</button></p>`;
  $('#exDay').addEventListener('click', (e) => openDay(day, 'leg20', e.currentTarget));
  const mo = strat('monthly');
  if (mo) $('#monthlyNotes').innerHTML = (mo.notes || []).filter((n) => /fragile|intraday/i.test(n)).map((n) => `<li class="${/fragile/i.test(n) ? 'amber' : ''}">${esc(n)}</li>`).join('');
}

// ---------- Charts boot + theme ----------
function setupCharts() {
  if (missing('strategies')) {
    ['#equityChart', '#ddChart'].forEach((s) => { $(s).innerHTML = errBox(['strategies']); });
    return;
  }
  strategies().forEach((s) => { if (!(s.name in state.legendSel)) state.legendSel[s.name] = s.id === state.selected; });
  renderLegend();
  setupRange();
  updateDDHead();
  whenNear($('#equityChart'), () => mount('eq', $('#equityChart'), eqOption, linkZoom));
  whenNear($('#ddChart'), () => mount('dd', $('#ddChart'), ddOption, linkZoom));
}
function setupHeat() {
  if (missing('strategies')) { $('#heatChart').innerHTML = errBox(['strategies']); return; }
  renderHeatLegend();
  layoutHeat();
  whenNear($('#heatChart'), () => mount('heat', $('#heatChart'), heatOption, (ch) => { ch.on('click', heatClick); placeYearLabels(); }));
}
function retheme() {
  if (charts.eq) charts.eq.setOption(eqOption(), { notMerge: true });
  if (charts.dd) charts.dd.setOption(ddOption(), { notMerge: true });
  if (charts.heat) { charts.heat.setOption(heatOption(), { notMerge: true }); placeYearLabels(); }
  if (charts.mv) { charts.mv.setOption(mvOption(), { notMerge: true }); updateMvRange(); }
  if (charts.day && state.day && dayCache.has(state.day.date)) charts.day.setOption(dayOption(dayCache.get(state.day.date), dayRow(state.day.strat, state.day.date), state.day.strat), { notMerge: true });
  if (state.data.strategies) { renderHeatLegend(); updateDDHead(); safely(renderSquares, $('#squares')); }
}

// ---------- Sections on demand (docs/spec/pnl-v1.md row 10) ----------
// At load only Today (and the small Capital form) is built. Every section below is built once: when it comes
// within 600 px of the viewport, or at once when a link jumps to it or past it, so a jump never lands on a
// half-built page. Each section keeps its placeholder size until then.
const lazyQ = [];
function lazy(id, fn) {
  const item = { id, fn, done: false };
  lazyQ.push(item);
  whenNear(document.getElementById(id), () => runLazy(item));
}
function runLazy(item) {
  if (item.done) return;
  item.done = true;
  item.fn();
}
function buildThrough(targetId) {
  const target = targetId && document.getElementById(targetId);
  if (!target) return false;
  for (const it of lazyQ) {
    const el = document.getElementById(it.id);
    const after = el !== target && !el.contains(target) && (target.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (after) break;
    runLazy(it);
    if (el === target || el.contains(target)) break;
  }
  return true;
}
function setupJumps() {
  // Capture phase: the sections are built before the browser scrolls to the anchor.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (a && a.getAttribute('href').length > 1) buildThrough(decodeURIComponent(a.getAttribute('href').slice(1)));
  }, true);
  window.addEventListener('hashchange', () => buildThrough(decodeURIComponent(location.hash.slice(1))));
}

// ---------- Boot ----------
async function boot() {
  setupHeader();
  setupTips();
  setupJumps();
  await loadAll();
  safely(renderMeta, $('#footerData'));
  safely(renderTicker, $('#ticker'));
  // Today in one task (splitting it over three frames measured no better: each frame paid its own layout).
  safely(renderToday, $('#todayBody'));
  // The drawer and the Capital form are not on the first screen: they are set up when the browser is idle
  // (at most 500 ms later). A/B under vitals.py: mean TBT 71 ms against 157 ms over 12 runs each way.
  (window.requestIdleCallback || ((f) => setTimeout(f, 1)))(() => {
    safely(setupDrawer, $('#dayDrawer'));
    safely(setupCapital, $('#capOut'));
  }, { timeout: 500 });
  lazy('strategies', () => safely(renderStrategies, $('#stratGrid')));
  lazy('performance', () => {
    safely(renderPerfHead, $('#perfHead'));
    safely(setupCharts, $('#equityChart'));
  });
  lazy('months', () => {
    safely(setupMonthYear, $('#months'));
    safely(setupHeat, $('#heatChart'));
    safely(setupSquares, $('#squares'));
    safely(renderSquares, $('#squares'));
    safely(renderExitBars, $('#exitBars'));
    safely(setupMonthlyView, $('#mvChart'));
  });
  lazy('trades', () => safely(setupTable, $('#tBody')));
  lazy('how', () => safely(renderHow, $('#exGrid')));
  // Arriving with a #section (for example from the P&L page): build up to it, then go there.
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && buildThrough(hash)) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'instant', block: 'start' }));
}

boot();

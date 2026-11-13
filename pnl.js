// MMES daily paper P&L page. Reads data/pnl-daily.json (contract: docs/spec/pnl-v1.md), data/meta.json and
// data/calendar.json, and draws: the last session's P&L, the summary, a month calendar, a day view, daily bars,
// the transactions and the daily table. Row 15: every number on screen comes from those files; this file only
// adds, formats and colours them.

import {
  $, $$, esc, nf0, nf2, MINUS, WD, tone, p2, pct1, parseD, fmtDate, fmtDateShort, fmtDateWd, fmtMonth,
  todayIST, compactINR, theme, rgba, infoBtn, getJSON, renderFreshness, setupHeader, setupTips, loadECharts, whenNear,
  tooltipBase, tipRow, axisLabel, UI_FONT, NUM_FONT, reducedMotion, yieldToBrowser,
} from './common.js';

const FILES = {
  pnl: 'data/pnl-daily.json', meta: 'data/meta.json', calendar: 'data/calendar.json',
  account: 'data/account.json', runner: 'data/runner.json',
};
// Row 6a series colours.
const SERIES = { v3: '#8B7CFF', leg20: '#5C93F0', monthly: '#2FD08A' };
const NAME = { monthly: 'Monthly', v3: 'Weekly v3', leg20: 'Weekly LEG-20' };
const TYPE = { monthly: 'Overnight', v3: 'Intraday', leg20: 'Intraday' };
const EVENT = { entry: 'Entry', hold: 'Hold', stop: 'Stop hit', exit: 'Exit', none: 'No position' };
const WEEKLY_EMPTY = 'No weekly paper trade yet — runs on expiry days on GitHub, from NSE\'s live option chain.';

const DEF = {
  net: 'The sum of every day\'s P&L since the first paper trade: realised, open MTM, charges and slippage. 1 set.',
  realized: 'Sell price minus buy-back price of the closed legs, times the quantity. Before charges and slippage.',
  charges: 'Brokerage, taxes and fees of the closed trades, by the backtest\'s charges(), booked on the exit day.',
  slippage: '0.25 pt per fill, booked on the day of the fill.',
  openMtm: 'Value of the positions still open at the latest close, against their sale price.',
  thisMonth: 'The sum of the daily P&L of the latest month.',
  bestDay: 'The trading day with the highest total.',
  worstDay: 'The trading day with the lowest total.',
  greenDays: 'Days whose total was above zero, out of every trading day since the first paper trade.',
  avg: 'Paper: the net of the closed paper trades divided by their number. Backtest: the backtest\'s average per trade.',
  // Account card (docs/spec/account-v1.md rows 1, 3, 8 and the data contract).
  acOpening: 'Virtual money put in on the opening day. Paper trades only, no real orders.',
  acBalance: 'The opening plus the net of every closed trade, after charges. The funds ledger adds up to it.',
  acMargin: 'Margin held while a position is open: Zerodha\'s SPAN for the two sold strikes plus the expiry-day 2% ELM, blocked from entry to exit.',
  acAvailable: 'Balance minus the margin blocked. A trade is skipped when its margin is above this.',
  acMtm: 'Value of an open position against its sale price. The file is written after the close, so it is 0 there.',
  acEquity: 'Balance plus open MTM.',
  acReturn: 'Equity minus the opening, divided by the opening.',
  acRoom: 'Balance minus the margin the last trade needed. Below zero, the next trade is skipped unless the margin is lower.',
};

const state = { data: {}, errors: {}, sel: null, month: null };
let dayChartArmed = false;
const charts = {};
// Line colour by sign (reference 8). ECharts 5.5 needs finite piece bounds: open-ended lt / gte pieces throw.
const SIGN_PIECES = (c) => [{ min: -1e15, max: 0, color: c.loss }, { min: 0, max: 1e15, color: c.profit }];

// Paise matter here: a trade's day rows must add up to its net (spec row 4), so money shows 2 decimals.
const signed2 = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const r = Math.round(Number(v) * 100) / 100;
  if (r === 0) return '₹0.00';
  return (r > 0 ? '+' : MINUS) + '₹' + nf2.format(Math.abs(r));
};
const rupees2 = (v) => (v == null ? '—' : '₹' + nf2.format(Math.abs(Number(v))));
const dash = (s) => String(s).replace(/-₹/g, `${MINUS}₹`);
// Calendar cells are about 43 px wide on a phone: at most 6 characters there ("−₹2.6K", "−₹24K", "+₹1.2L"); the
// exact amount is in the cell's label and in the day view. A wide calendar shows whole rupees.
// Whole rupees, rounded half away from zero like every other figure here (−32.50 shows as −₹33).
const wholeAmt = (v) => (Math.round(Math.abs(v)) === 0 ? '₹0' : `${v < 0 ? MINUS : '+'}₹${nf0.format(Math.abs(v))}`);
function cellAmt(v) {
  const a = Math.abs(v);
  if (Math.round(a) === 0) return '₹0';
  const s = v < 0 ? MINUS : '+';
  if (a < 1e3) return `${s}₹${nf0.format(a)}`;
  if (a < 1e4) return `${s}₹${(a / 1e3).toFixed(1)}K`;
  if (a < 1e5) return `${s}₹${Math.round(a / 1e3)}K`;
  return `${s}₹${(a / 1e5).toFixed(1)}L`;
}
// Plain code-point order: the ISO dates and ids sorted here need no locale collation (which loads ICU data).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isoDay = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const errBox = (keys) => {
  const msgs = keys.filter((k) => state.errors[k]).map((k) => esc(state.errors[k]));
  return `<div class="err" role="alert">Could not load the data for this part${msgs.length ? ` (${msgs.join('; ')})` : ''}. Reload the page to try again.</div>`;
};
function safely(fn, el) {
  try { fn(); } catch (e) {
    if (el) el.innerHTML = `<div class="err" role="alert">This part could not be drawn: ${esc(e.message)}.</div>`;
    window.__mmesErrors = (window.__mmesErrors || []).concat(`${fn.name}: ${e.message}`);
  }
}

const P = () => state.data.pnl;
const days = () => P()?.days || [];
const dayOf = (iso) => days().find((d) => d.date === iso);
const weeklyTotal = (d) => (d.weekly?.v3?.pnl ?? 0) + (d.weekly?.leg20?.pnl ?? 0);

// ---------- Load ----------
async function loadAll() {
  const entries = Object.entries(FILES);
  const res = await Promise.allSettled(entries.map(([, u]) => getJSON(u)));
  res.forEach((r, i) => {
    const k = entries[i][0];
    if (r.status === 'fulfilled') state.data[k] = r.value; else state.errors[k] = r.reason?.message || String(r.reason);
  });
  const p = state.data.pnl;
  if (p) {
    p.days = [...(p.days || [])].sort((a, b) => cmp(a.date, b.date));
    p.trades = p.trades || [];
  }
}

// ---------- MMES v3 account, funds ledger, runner line (docs/spec/account-v1.md rows 7, 8) ----------
// The account is shown to the paisa, so its colour is decided to the paisa too: +₹0.40 is green, not neutral.
const tone2 = (v) => (v == null ? '' : Math.round(Number(v) * 100) > 0 ? 'pos' : Math.round(Number(v) * 100) < 0 ? 'neg' : '');
// An unsigned amount (balance, margin): no "+", but a negative one still shows its "−".
const amt2 = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const r = Math.round(Number(v) * 100) / 100;
  return `${r < 0 ? MINUS : ''}₹${nf2.format(Math.abs(r))}`;
};
const pctSigned = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const r = Math.round(Number(v) * 100);
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${(Math.abs(r) / 100).toFixed(2)}%`;
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005 + 1e-9;
const A = () => state.data.account;

// The published file must add up (contract: balance = opening + the trade amounts, available = balance - margin,
// equity = balance + open MTM, return = (equity - opening) / opening). A file that does not is shown as published,
// with a visible line saying which identity failed, never silently.
function accountProblems(a) {
  const out = [];
  let run = 0;
  (a.ledger || []).forEach((e) => {
    run = Math.round((run + (Number(e.amount) || 0)) * 100) / 100;
    if (!near(run, e.balance)) out.push(`the ${fmtDateShort(e.date)} line's balance after (${amt2(e.balance)}, the lines add up to ${amt2(run)})`);
  });
  const trades = (a.ledger || []).filter((e) => e.kind !== 'open').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  if (!near(a.opening + trades, a.balance)) out.push(`balance ${amt2(a.balance)} is not opening + the ledger (${amt2(a.opening + trades)})`);
  if (!near(a.balance - a.marginBlocked, a.available)) out.push('available is not balance − margin blocked');
  if (!near(a.balance + a.openMtm, a.equity)) out.push('equity is not balance + open MTM');
  if (a.opening && !near(((a.equity - a.opening) / a.opening) * 100, a.returnPct)) out.push('return % does not match equity');
  return out;
}

function renderAccount() {
  const a = A();
  const card = $('#acCard');
  if (!a) { $('#acRun').insertAdjacentHTML('beforebegin', errBox(['account'])); return; }
  const set = (id, text, t) => { const el = $(id); el.textContent = text; if (t) el.classList.add(t); };
  $('#acCount').textContent = `Trades ${nf0.format(a.trades ?? 0)} · skipped ${nf0.format(a.skipped ?? 0)}`;
  set('#acOpening', amt2(a.opening));
  $('#acOpeningS').textContent = a.openedOn ? `on ${fmtDateWd(a.openedOn)}` : '';
  set('#acBalance', amt2(a.balance));
  set('#acMargin', amt2(a.marginBlocked));
  const ms = [Math.round((a.marginBlocked || 0) * 100) === 0 ? 'no open position' : 'blocked until the exit'];
  if (a.lastMargin) ms.push(`last trade needed ${a.lastMargin.total == null ? 'an unmeasured margin' : amt2(a.lastMargin.total)} on ${fmtDateShort(a.lastMargin.date)}`);
  $('#acMarginS').innerHTML = ms.map((s) => `<span class="ac-line">${esc(s)}</span>`).join('');
  set('#acAvailable', amt2(a.available));
  set('#acMtm', signed2(a.openMtm), tone2(a.openMtm));
  set('#acEquity', amt2(a.equity));
  set('#acReturn', pctSigned(a.returnPct), tone2(a.returnPct));
  $('#acReturnS').textContent = a.openedOn ? `since ${fmtDateShort(a.openedOn)}` : '';
  // No trade has needed a margin yet: the item is hidden, but keeps its box, so nothing under it moves (row 10).
  const roomItem = $('#acRoomI');
  if (a.room == null) {
    roomItem.classList.add('ac-off');
  } else {
    set('#acRoom', signed2(a.room), tone2(a.room));
    $('#acRoomS').textContent = Math.round(a.room * 100) < 0 ? 'the next trade is skipped while the margin is above the balance' : '';
  }
  const bad = accountProblems(a);
  if (bad.length) $('#acRun').insertAdjacentHTML('beforebegin', `<div class="err" role="alert">data/account.json does not add up: ${bad.map(esc).join('; ')}. The figures are shown as published.</div>`);
  card.dataset.ready = '1';
}

const LEG = (l) => `${l.contract} · sold ${p2(l.sell)} · bought ${l.buy == null ? 'open' : p2(l.buy)} · qty ${nf0.format(l.qty)}`;
function ledgerRow(e) {
  const k = ['open', 'trade', 'skip', 'none'].includes(e.kind) ? e.kind : 'none';
  const legs = k === 'trade' && e.legs?.length ? e.legs.map((l) => `<span class="ac-leg">${esc(LEG(l))}</span>`).join('') : '';
  const fill = e.fill === 'est'
    ? '<span title="No bid or ask in the snapshot: the rule\'s LTP fill, 0.25 pt worse">fill est</span>'
    : e.fill ? `fill ${esc(e.fill)}` : '';
  const sub = k === 'trade'
    ? [e.gross != null ? `gross <span class="mono">${signed2(e.gross)}</span>` : '', e.charges != null ? `charges <span class="mono">${rupees2(e.charges)}</span>` : '', fill].filter(Boolean)
    : [];
  // The opening credit is not a gain: it shows without a sign.
  const amount = k === 'open' ? amt2(e.amount) : signed2(e.amount);
  const amtTone = k === 'trade' ? tone2(e.amount) : 'quiet';
  return `<tr class="k-${k}">
    <td class="ac-d"><span class="mono" title="${esc(fmtDateWd(e.date))}">${esc(fmtDateWd(e.date))}</span></td>
    <td class="ac-e"><span class="ac-t">${esc(dash(e.text))}</span>${legs}${sub.length ? `<span class="ac-s">${sub.join(' · ')}</span>` : ''}</td>
    <td class="r mono ac-a ${amtTone}">${amount}</td>
    <td class="r mono ac-b"><span class="ac-lbl" aria-hidden="true">Balance after </span>${amt2(e.balance)}</td>
  </tr>`;
}
function renderLedger() {
  const body = $('#acLedBody');
  const a = A();
  if (!a) { body.innerHTML = `<tr><td class="t-empty" colspan="4">${errBox(['account'])}</td></tr>`; return; }
  const led = (a.ledger || []).map((e, i) => [e, i]);
  if (!led.length) { body.innerHTML = '<tr><td class="t-empty" colspan="4">No ledger line yet.</td></tr>'; return; }
  // Newest first; two lines of one date keep their file order reversed (the file is oldest first).
  led.sort((x, y) => cmp(y[0].date, x[0].date) || y[1] - x[1]);
  body.innerHTML = led.map(([e]) => ledgerRow(e)).join('');
}

// Test seam: ?now=YYYY-MM-DDTHH:MM (IST) replaces "now" for the runner line ONLY, so each of its states can be
// checked at any hour (.cache/s15/verify-account.py). Everything else on the page keeps the real clock.
function nowIST() {
  const q = new URLSearchParams(window.location.search).get('now');
  if (q && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(q)) return { date: q.slice(0, 10), hm: q.slice(11, 16) };
  const s = new Date(Date.now() + 330 * 60000).toISOString(); // IST is UTC+05:30 all year
  return { date: s.slice(0, 10), hm: s.slice(11, 16) };
}
const WHERE = { github: 'GitHub', pc: 'the PC' };
const hhmm = (ts) => (ts ? String(ts).slice(11, 16) : '—'); // "YYYY-MM-DD HH:MM:SS" in IST
function runnerLine() {
  const now = nowIST();
  const raw = state.data.runner;
  // date null / status "none" is the file published before the first run: never ran. A missing file is the same.
  const r = raw && raw.date && raw.status && raw.status !== 'none' ? raw : null;
  const where = r ? (WHERE[r.where] || r.where || 'an unknown machine') : '';
  const cmd = '<span class="mono">scripts/paper_nse.cmd</span>';
  if (r && r.date === now.date) {
    if (r.status === 'started') return { st: 'run', t: `Runner: started ${hhmm(r.startedAt)} on ${esc(where)} · the result appears at about 15:25`, s: '' };
    if (r.status === 'done') return { st: 'ok', t: `Runner: done ${hhmm(r.updatedAt)} on ${esc(where)}`, s: esc(r.note || '') };
    if (r.status === 'failed') return { st: 'warn', t: `Runner: failed at ${hhmm(r.updatedAt)} on ${esc(where)}. Start ${cmd} on the PC.`, s: esc(r.note || '') };
    return { st: 'warn', t: `Runner: ${esc(r.status)} at ${hhmm(r.updatedAt)} on ${esc(where)}`, s: esc(r.note || '') };
  }
  const weekly = state.data.calendar?.weekly || [];
  if (weekly.includes(now.date) && now.hm >= '09:20' && now.hm < '15:30') {
    return { st: 'warn', t: `Runner: not started today. Double-click ${cmd} on the PC.`, s: '' };
  }
  const last = r ? `Last run: ${esc(fmtDateShort(r.date))}, ${esc(r.status)} on ${esc(where)}` : '';
  const failedLoad = state.errors.runner && !/HTTP 404/.test(state.errors.runner) ? `Runner status unknown: ${esc(state.errors.runner)}` : '';
  if (!state.data.calendar) return { st: 'next', t: 'Next run: unknown, data/calendar.json did not load', s: last || failedLoad };
  // After 15:30 an expiry day without a run is over, so the next run is a later expiry.
  const next = [...weekly].sort().find((d) => (now.hm >= '15:30' ? d > now.date : d >= now.date));
  if (!next) return { st: 'next', t: 'Next run: no expiry day listed in data/calendar.json yet', s: last || failedLoad };
  return { st: 'next', t: `Next run: ${WD[parseD(next).getUTCDay()]} ${fmtDateShort(next)}, starts on its own by 09:15 (GitHub)`, s: last || failedLoad };
}
function renderRunner() {
  const x = runnerLine();
  $('#acRun').dataset.st = x.st;
  $('#acRunT').innerHTML = x.t;
  $('#acRunS').innerHTML = x.s || '&nbsp;';
}

// ---------- Today's P&L strip (reference 9) ----------
function renderToday() {
  if (!P()) { $('#plTodayV').textContent = '—'; $('#plTodayC').textContent = 'The daily P&L file did not load.'; return; }
  const ds = days();
  if (!ds.length) { $('#plTodayV').textContent = '₹0.00'; $('#plTodayC').textContent = 'No paper day yet.'; return; }
  const d = ds[ds.length - 1];
  const isToday = d.date === todayIST();
  $('#plTodayT').textContent = isToday ? "Today's P&L" : "Last session's P&L";
  const quiet = !d.open && Math.round(d.total * 100) === 0 && d.monthly?.event === 'none' && !weeklyTotal(d);
  $('#plTodayD').textContent = `${WD[parseD(d.date).getUTCDay()]} ${fmtDateShort(d.date)}${quiet ? ' · no position' : ''}`;
  $('#plTodayD').title = fmtDateWd(d.date);
  const v = $('#plTodayV');
  v.textContent = signed2(d.total);
  v.className = `pl-today-v num ${tone(d.total)}`;
  $('#plTodayC').innerHTML = `Cumulative <span class="mono ${tone(d.cum)}">${signed2(d.cum)}</span>`;
}

// ---------- Summary (reference 7) ----------
function paperAvg(id) {
  const t = (P()?.trades || []).filter((x) => x.strategy === id && x.status === 'closed' && x.net != null);
  if (!t.length) return null;
  return { avg: t.reduce((a, x) => a + x.net, 0) / t.length, n: t.length };
}
function renderSummary() {
  $$('[data-info]').forEach((el) => { el.outerHTML = infoBtn(el.closest('dt, .label, caption')?.firstChild?.textContent.trim() || 'About', DEF[el.dataset.info]); });
  const p = P();
  if (!p) { $('#plSum').insertAdjacentHTML('beforeend', errBox(['pnl'])); return; }
  const s = p.summary || {};
  const set = (id, v, t) => { const el = $(id); el.textContent = v; if (t !== undefined) el.classList.add(...(t ? [t] : [])); };
  set('#sNet', signed2(s.net), tone(s.net));
  const ds = days();
  $('#sSpan').textContent = ds.length ? `${fmtDate(ds[0].date)} – ${fmtDate(ds[ds.length - 1].date)} · ${ds.length} trading day${ds.length === 1 ? '' : 's'} · 1 set` : 'No paper day yet';
  set('#sReal', signed2(s.realized), tone(s.realized));
  set('#sChg', rupees2(s.charges));
  set('#sSlip', rupees2(s.slippage));
  set('#sOpen', signed2(s.openMtm), tone(s.openMtm));
  set('#sMonth', signed2(s.thisMonth), tone(s.thisMonth));
  $('#sMonthL').textContent = p.asOf ? fmtMonth(p.asOf.slice(0, 7)) : '';
  set('#sBest', s.bestDay ? signed2(s.bestDay.pnl) : '—', s.bestDay ? tone(s.bestDay.pnl) : '');
  $('#sBestD').textContent = s.bestDay ? fmtDateWd(s.bestDay.date) : '';
  set('#sWorst', s.worstDay ? signed2(s.worstDay.pnl) : '—', s.worstDay ? tone(s.worstDay.pnl) : '');
  $('#sWorstD').textContent = s.worstDay ? fmtDateWd(s.worstDay.date) : '';
  set('#sGreen', s.days ? pct1((s.greenDays / s.days) * 100) : '—');
  $('#sGreenD').textContent = s.days ? `${s.greenDays} of ${s.days} days` : '';
  $('#sGreenD').title = s.days ? `${s.greenDays} green, ${s.redDays} red, ${s.flatDays} flat` : '';
  const bt = s.backtestPerTrade || {};
  ['monthly', 'v3', 'leg20'].forEach((id) => {
    const a = paperAvg(id);
    $(`#aP${id}`).innerHTML = a ? `<span class="${tone(a.avg)}">${signed2(a.avg)}</span><span class="sub">${a.n} trade${a.n === 1 ? '' : 's'}</span>` : '<span class="sub">no trade yet</span>';
    const b = $(`#aB${id}`);
    b.textContent = bt[id] != null ? signed2(bt[id]) : '—';
    if (bt[id] != null) b.classList.add(...[tone(bt[id])].filter(Boolean));
  });
}

// ---------- Calendar (reference 8) ----------
function monthsSpan() {
  const p = P();
  if (!p || !days().length) return [];
  const a = (p.start || days()[0].date).slice(0, 7);
  const b = (p.asOf || days()[days().length - 1].date).slice(0, 7);
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [y1, m1] = b.split('-').map(Number);
  while (y < y1 || (y === y1 && m <= m1)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
function renderCalendar() {
  const grid = $('#calGrid');
  if (!P()) { grid.innerHTML = ''; $('#calFoot').innerHTML = errBox(['pnl']); return; }
  const months = monthsSpan();
  if (!months.length) { $('#calTitle').textContent = 'No paper day yet'; return; }
  if (!months.includes(state.month)) state.month = months[months.length - 1];
  const ym = state.month;
  const [y, m] = ym.split('-').map(Number);
  $('#calTitle').textContent = fmtMonth(ym);
  const i = months.indexOf(ym);
  $('#calPrev').disabled = i <= 0;
  $('#calNext').disabled = i >= months.length - 1;
  const p = P();
  const by = new Map(days().map((d) => [d.date, d]));
  const max = Math.max(1, ...days().map((d) => Math.abs(d.total)));
  const first = parseD(isoDay(y, m, 1)).getUTCDay(); // 0 = Sunday
  const lead = (first + 6) % 7; // Monday-first grid
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayIST();
  let html = '';
  for (let k = 0; k < 42; k += 1) {
    const dnum = k - lead + 1;
    if (dnum < 1 || dnum > n) { html += '<span class="pl-d pad" aria-hidden="true"></span>'; continue; }
    const iso = isoDay(y, m, dnum);
    const wd = parseD(iso).getUTCDay();
    const d = by.get(iso);
    if (d) {
      const k2 = Math.round(10 + 35 * Math.min(1, Math.abs(d.total) / max));
      const cls = Math.round(d.total) > 0 ? 'pos' : Math.round(d.total) < 0 ? 'neg' : '';
      const label = `${fmtDateWd(iso)}: ${signed2(d.total)}${EVENT[d.monthly?.event] && d.monthly.event !== 'none' ? `, monthly ${EVENT[d.monthly.event].toLowerCase()}` : ''}`;
      html += `<button type="button" class="pl-d ${cls}${iso === today ? ' today' : ''}" style="--k:${k2}%" data-date="${iso}" aria-pressed="${iso === state.sel}" aria-label="${esc(label)}" title="${esc(label)}"><span class="dn">${dnum}</span><span class="dv"><span class="c">${cellAmt(d.total)}</span><span class="w">${wholeAmt(d.total)}</span></span></button>`;
    } else {
      const weekend = wd === 0 || wd === 6;
      const inRange = iso >= (p.start || '') && iso <= (p.asOf || '');
      const cls = weekend ? 'wkend' : inRange ? 'off' : 'out';
      const tip = weekend ? 'Weekend' : inRange ? 'No NSE session' : iso > (p.asOf || '') ? 'Not yet' : 'Before the first paper trade';
      html += `<span class="pl-d ${cls}" title="${esc(`${fmtDateWd(iso)}: ${tip}`)}"><span class="dn">${dnum}</span></span>`;
    }
  }
  grid.innerHTML = html;
  const inMonth = days().filter((d) => d.date.startsWith(ym));
  const tot = inMonth.reduce((a, d) => a + d.total, 0);
  $('#calFoot').innerHTML = `<span>${fmtMonth(ym)}: <span class="num ${tone(tot)}">${signed2(tot)}</span> over ${inMonth.length} trading day${inMonth.length === 1 ? '' : 's'}</span><span>Deeper colour, bigger amount. Dashed: no session.</span>`;
}
function setupCalendar() {
  $('#calGrid').addEventListener('click', (e) => { const b = e.target.closest('button[data-date]'); if (b) select(b.dataset.date); });
  const step = (k) => {
    const ms = monthsSpan();
    const i = ms.indexOf(state.month) + k;
    if (i < 0 || i >= ms.length) return;
    state.month = ms[i];
    renderCalendar();
    // Keep the day view on a day of the month on screen: its newest day.
    const inMonth = days().filter((d) => d.date.startsWith(state.month));
    if (inMonth.length && !(state.sel || '').startsWith(state.month)) select(inMonth[inMonth.length - 1].date, { keepMonth: true });
  };
  $('#calPrev').addEventListener('click', () => step(-1));
  $('#calNext').addEventListener('click', () => step(1));
}

// ---------- Day detail ----------
// The monthly trade open on a day (entry <= day <= exit, or still open).
function monthlyTradeOn(iso) {
  return (P()?.trades || []).find((t) => t.strategy === 'monthly' && t.entry <= iso && (t.exit ? iso <= t.exit : true));
}
// Its daily-close MTM path up to the day: the running sum of the monthly column's day P&L since the entry.
function monthlyPath(t, iso) {
  let run = 0;
  return days().filter((d) => d.date >= t.entry && d.date <= iso && (!t.exit || d.date <= t.exit))
    .map((d) => { run += d.monthly?.pnl || 0; return [d.date, Math.round(run * 100) / 100]; });
}
function weeklyCell(d) {
  const v3 = d.weekly?.v3; const l20 = d.weekly?.leg20;
  if (!v3 && !l20) return null;
  return { v3, l20 };
}
function renderDay() {
  const iso = state.sel;
  const d = iso && dayOf(iso);
  if (!d) {
    $('#dayH').textContent = P() ? 'No paper day yet' : 'The daily P&L file did not load';
    $('#dayEvents').innerHTML = P() ? '' : `<li>${errBox(['pnl'])}</li>`;
    return;
  }
  $('#dayH').textContent = fmtDateWd(d.date);
  $('#dayNifty').innerHTML = d.nifty ? `NIFTY close <span class="mono">${p2(d.nifty.close)}</span> <span class="mono ${tone(d.nifty.chg)}">(${d.nifty.chg > 0 ? '+' : d.nifty.chg < 0 ? MINUS : ''}${p2(Math.abs(d.nifty.chg))})</span>` : '&nbsp;';
  const v = $('#dayV');
  v.textContent = signed2(d.total);
  v.className = `pl-detail-v num ${tone(d.total)}`;
  const ev = d.events?.length ? d.events : ['No position'];
  const evClass = (s) => (/stop/i.test(s) ? 'ev-stop' : /bought back|exit/i.test(s) ? 'ev-exit' : /sold/i.test(s) ? 'ev-entry' : /no position/i.test(s) ? 'quiet' : '');
  $('#dayEvents').innerHTML = ev.map((s) => `<li class="${evClass(s)}">${esc(dash(s))}</li>`).join('');
  const w = weeklyCell(d);
  const mo = d.monthly || { event: 'none', pnl: 0 };
  $('#dayKv').innerHTML = `
    <div><dt class="label">Monthly</dt><dd class="kv-v num ${tone(mo.pnl)}">${signed2(mo.pnl)}</dd><dd class="kv-sub">${esc(EVENT[mo.event] || mo.event)}${mo.value != null ? ` · CE + PE <span class="mono">${p2(mo.value)}</span>` : ''}</dd></div>
    <div><dt class="label">Weekly v3</dt><dd class="kv-v num ${tone(w?.v3?.pnl)}">${w?.v3 ? signed2(w.v3.pnl) : '—'}</dd><dd class="kv-sub">${w?.v3?.event ? esc(w.v3.event) : 'no trade'}</dd></div>
    <div><dt class="label">Weekly LEG-20</dt><dd class="kv-v num ${tone(w?.l20?.pnl)}">${w?.l20 ? signed2(w.l20.pnl) : '—'}</dd><dd class="kv-sub">${w?.l20?.event ? esc(w.l20.event) : 'no trade'}</dd></div>
    <div><dt class="label">Cumulative</dt><dd class="kv-v num ${tone(d.cum)}">${signed2(d.cum)}</dd></div>
    <div><dt class="label">Open at the close</dt><dd class="kv-v num">${nf0.format(d.open ?? 0)}</dd><dd class="kv-sub">trade${d.open === 1 ? '' : 's'}</dd></div>`;
  // Before the day chart is near the viewport only the text is drawn; the chart follows when it scrolls in.
  if (dayChartArmed) drawDayChart();
}

function dayChartModel() {
  const iso = state.sel;
  const intr = P()?.intraday?.[iso];
  if (intr && (intr.t || []).length) return { kind: 'intraday', intr };
  const t = monthlyTradeOn(iso);
  if (t) return { kind: 'monthly', trade: t, path: monthlyPath(t, iso) };
  const last = (P()?.trades || []).filter((x) => x.strategy === 'monthly' && x.exit && x.exit < iso).sort((a, b) => cmp(b.exit, a.exit))[0];
  return { kind: 'none', last };
}
function hiLoLines(c, hi, lo) {
  const lab = (txt, col, pos) => ({ formatter: txt, color: col, fontFamily: NUM_FONT, fontSize: 11, position: pos, distance: 4 });
  // Each line takes the colour of its own sign (reference 8: a high above zero is green, a low below zero red).
  const col = (v) => (Math.round(v * 100) > 0 ? c.profit : Math.round(v * 100) < 0 ? c.loss : c.muted);
  return {
    silent: true, symbol: 'none', animation: false,
    data: [
      { yAxis: hi, lineStyle: { color: col(hi), type: 'dashed', width: 1 }, label: lab(`High ${signed2(hi)}`, col(hi), 'insideStartTop') },
      { yAxis: lo, lineStyle: { color: col(lo), type: 'dashed', width: 1 }, label: lab(`Low ${signed2(lo)}`, col(lo), 'insideStartBottom') },
    ],
  };
}
function dayOption(model) {
  const c = theme();
  const base = {
    animation: !reducedMotion(), animationDuration: 300,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    yAxis: { type: 'value', scale: true, axisLabel: { ...axisLabel(c), formatter: compactINR }, splitLine: { lineStyle: { color: c.border } } },
  };
  if (model.kind === 'intraday') {
    const x = model.intr;
    const tot = x.t.map((_, i) => Math.round(((x.v3?.[i] || 0) + (x.leg20?.[i] || 0)) * 100) / 100);
    return {
      ...base,
      legend: { top: 0, right: 4, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: c.text, fontSize: 12 }, inactiveColor: c.faint, data: ['v3 + LEG-20', 'v3', 'LEG-20'] },
      grid: { ...base.grid, top: 32 },
      tooltip: { ...tooltipBase(c), trigger: 'axis', formatter: (ps) => `<div style="font-weight:600;margin-bottom:4px">${esc(ps[0].axisValue)}</div>${ps.map((q) => tipRow(q.color?.colorStops ? c.text : q.color, q.seriesName, signed2(q.value))).join('')}` },
      xAxis: { type: 'category', data: x.t, boundaryGap: false, axisLine: { lineStyle: { color: c.borderStrong } }, axisTick: { show: false }, axisLabel: { ...axisLabel(c), hideOverlap: true } },
      visualMap: { show: false, seriesIndex: 0, dimension: 1, pieces: SIGN_PIECES(c) },
      series: [
        { name: 'v3 + LEG-20', type: 'line', data: tot, showSymbol: false, lineStyle: { width: 2 }, itemStyle: { color: c.text }, z: 5, markLine: x.high != null && x.low != null ? hiLoLines(c, x.high, x.low) : undefined },
        { name: 'v3', type: 'line', data: x.v3 || [], showSymbol: false, connectNulls: false, lineStyle: { width: 1, color: SERIES.v3, opacity: 0.8 }, itemStyle: { color: SERIES.v3 } },
        { name: 'LEG-20', type: 'line', data: x.leg20 || [], showSymbol: false, connectNulls: false, lineStyle: { width: 1, color: SERIES.leg20, opacity: 0.8 }, itemStyle: { color: SERIES.leg20 } },
      ],
    };
  }
  const path = model.path;
  const vals = path.map((q) => q[1]);
  const hi = Math.max(...vals); const lo = Math.min(...vals);
  return {
    ...base,
    tooltip: { ...tooltipBase(c), trigger: 'axis', formatter: (ps) => `<div style="font-weight:600;margin-bottom:4px">${fmtDateWd(path[ps[0].dataIndex][0])}</div>${tipRow('', 'Monthly MTM at the close', signed2(ps[0].value))}` },
    xAxis: { type: 'category', data: path.map((q) => fmtDateShort(q[0])), boundaryGap: true, axisLine: { lineStyle: { color: c.borderStrong } }, axisTick: { show: false }, axisLabel: { ...axisLabel(c), hideOverlap: true } },
    visualMap: { show: false, seriesIndex: 0, dimension: 1, pieces: SIGN_PIECES(c) },
    series: [{
      name: 'Monthly MTM', type: 'line', data: vals, showSymbol: true, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 },
      markLine: path.length > 1 ? hiLoLines(c, hi, lo) : undefined,
    }],
  };
}
async function drawDayChart() {
  const el = $('#plDayChart');
  const model = dayChartModel();
  const cap = $('#dayCap');
  if (model.kind === 'none') {
    if (charts.day) { charts.day.dispose(); delete charts.day; }
    const l = model.last;
    el.innerHTML = `<div class="chart-msg"><p>No position was open at this day's close.${l ? ` The last monthly trade closed on ${esc(fmtDateWd(l.exit))} at <span class="num ${tone(l.net)}">${signed2(l.net)}</span>.` : ''}</p></div>`;
    cap.textContent = 'The line shows a weekly expiry day minute by minute, or the open monthly trade close by close.';
    el.setAttribute('aria-label', 'No open position on this day');
    return;
  }
  if (model.kind === 'intraday') {
    cap.innerHTML = `v3 + LEG-20 MTM minute by minute (NSE snapshot); dashed: the day's high <span class="num">${signed2(model.intr.high)}</span> and low <span class="num">${signed2(model.intr.low)}</span>.`;
    el.setAttribute('aria-label', `Weekly paper P&L of ${fmtDateWd(state.sel)}, minute by minute. High ${signed2(model.intr.high)}, low ${signed2(model.intr.low)}.`);
  } else {
    const t = model.trade;
    const last = model.path[model.path.length - 1];
    cap.textContent = `Monthly trade sold ${fmtDateShort(t.entry)}: its MTM at each close up to ${fmtDateShort(last[0])} (NSE bhavcopy closes)${model.path.length > 1 ? '; dashed: its high and low so far' : ''}.`;
    el.setAttribute('aria-label', `Monthly trade MTM from ${fmtDate(t.entry)} to ${fmtDate(last[0])}: ${signed2(last[1])}.`);
  }
  const ec = await mountChart('day', el, () => dayOption(dayChartModel()));
  if (ec) ec.resize();
}

// ---------- Daily bars + running total ----------
function barsOption() {
  const c = theme();
  const ds = days();
  return {
    animation: !reducedMotion(), animationDuration: 400,
    textStyle: { fontFamily: UI_FONT, color: c.muted },
    grid: { left: 8, right: 12, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, left: 4, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: c.text, fontSize: 12 }, inactiveColor: c.faint, data: ['Day total', 'Running total'] },
    tooltip: {
      ...tooltipBase(c), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: rgba('#94A3B8', 0.08) } },
      formatter: (ps) => {
        const d = ds[ps[0].dataIndex];
        const mo = d.monthly?.event && d.monthly.event !== 'none' ? `Monthly: ${EVENT[d.monthly.event] || d.monthly.event}` : 'Monthly: no position';
        return `<div style="font-weight:600;margin-bottom:4px">${fmtDateWd(d.date)}</div>${tipRow('', 'Day total', signed2(d.total))}${tipRow('', 'Running total', signed2(d.cum))}<div style="opacity:.75;margin-top:2px">${esc(mo)}</div>`;
      },
    },
    xAxis: { type: 'category', data: ds.map((d) => fmtDateShort(d.date)), axisLine: { lineStyle: { color: c.borderStrong } }, axisTick: { show: false }, axisLabel: { ...axisLabel(c), hideOverlap: true } },
    yAxis: { type: 'value', axisLabel: { ...axisLabel(c), formatter: compactINR }, splitLine: { lineStyle: { color: c.border } } },
    series: [
      {
        name: 'Day total', type: 'bar', barMaxWidth: 28, itemStyle: { color: c.profit, borderRadius: 3 },
        data: ds.map((d) => ({ value: d.total, itemStyle: { color: d.total < 0 ? c.loss : c.profit, borderRadius: d.total < 0 ? [0, 0, 3, 3] : [3, 3, 0, 0] } })),
      },
      { name: 'Running total', type: 'line', data: ds.map((d) => d.cum), symbol: 'circle', symbolSize: 6, lineStyle: { width: 2, color: c.merged }, itemStyle: { color: c.merged, borderColor: c.panel, borderWidth: 1 }, z: 5 },
    ],
  };
}

// ---------- ECharts mount (loaded only when a chart comes near the viewport) ----------
async function mountChart(key, el, build) {
  try {
    const ec = await loadECharts();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    if (charts[key] && !charts[key].isDisposed() && charts[key].getDom() === el) { charts[key].setOption(build(), { notMerge: true }); return charts[key]; }
    el.textContent = '';
    charts[key] = ec.init(el, null, { renderer: 'canvas' });
    charts[key].setOption(build());
    resizer.observe(el);
    return charts[key];
  } catch (e) {
    if (charts[key]) { charts[key].dispose(); delete charts[key]; }
    el.innerHTML = `<div class="chart-msg">The chart could not be drawn (${esc(e.message)}). Reload the page to try again.</div>`;
    return null;
  }
}
const resizer = new ResizeObserver((entries) => entries.forEach((en) => {
  const c = Object.values(charts).find((x) => x && !x.isDisposed() && x.getDom() === en.target);
  if (c) c.resize();
}));
function setupCharts() {
  const bars = $('#plBarsChart');
  if (!P()) { bars.innerHTML = errBox(['pnl']); $('#plDayChart').innerHTML = ''; return; }
  if (!days().length) { bars.innerHTML = '<div class="chart-msg">No paper day yet.</div>'; return; }
  bars.setAttribute('aria-label', `Daily paper P&L of ${days().length} trading days; running total ${signed2(days()[days().length - 1].cum)}.`);
  // ECharts is about 1 MB: it loads only when a chart is about to scroll into view (row 10).
  whenNear(bars, () => mountChart('bars', bars, barsOption), '200px 0px');
}

// ---------- Selection ----------
function select(iso, { keepMonth = false, scroll = false } = {}) {
  if (!dayOf(iso)) return;
  state.sel = iso;
  if (!keepMonth && !iso.startsWith(state.month || '')) { state.month = iso.slice(0, 7); }
  safely(renderCalendar, $('#calGrid'));
  $$('#calGrid button[data-date]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === iso)));
  $$('#dBody tr[data-date]').forEach((tr) => {
    const on = tr.dataset.date === iso;
    tr.classList.toggle('sel', on);
    tr.querySelector('.row-btn')?.setAttribute('aria-pressed', String(on));
  });
  safely(renderDay, $('#dayEvents'));
  if (scroll) $('#plDay').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

// ---------- Daily table ----------
function renderTable() {
  const body = $('#dBody');
  if (!P()) { body.innerHTML = `<tr><td class="t-empty" colspan="7">${errBox(['pnl'])}</td></tr>`; $('#dSummary').textContent = ''; return; }
  const ds = days();
  if (!ds.length) { body.innerHTML = '<tr><td class="t-empty" colspan="7">No paper day yet.</td></tr>'; return; }
  const total = ds.reduce((a, d) => a + d.total, 0);
  const byMonth = new Map();
  ds.forEach((d) => byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) || 0) + d.total));
  $('#dSummary').innerHTML = `<b class="mono">${ds.length}</b> trading day${ds.length === 1 ? '' : 's'} · total <b class="mono ${tone(total)}">${signed2(total)}</b>${[...byMonth].map(([m, v]) => ` · ${fmtMonth(m)} <b class="mono ${tone(v)}">${signed2(v)}</b>`).join('')}. Money is for 1 set, after charges and slippage.`;
  body.innerHTML = [...ds].reverse().map((d) => {
    const mo = d.monthly || { event: 'none', pnl: 0 };
    const w = weeklyCell(d);
    const wk = w ? `<span class="mono">v3 <span class="${tone(w.v3?.pnl)}">${w.v3 ? signed2(w.v3.pnl) : '—'}</span></span> <span class="sub">·</span> <span class="mono">LEG-20 <span class="${tone(w.l20?.pnl)}">${w.l20 ? signed2(w.l20.pnl) : '—'}</span></span>` : '<span class="sub">—</span>';
    const sel = d.date === state.sel;
    return `<tr data-date="${d.date}" class="${sel ? 'sel' : ''}">
      <td><button type="button" class="row-btn" aria-pressed="${sel}" aria-label="Open ${esc(fmtDateWd(d.date))} in the day view"><span class="mono">${WD[parseD(d.date).getUTCDay()]} ${fmtDateShort(d.date)}</span></button></td>
      <td class="r mono">${d.nifty ? p2(d.nifty.close) : '—'}${d.nifty ? `<span class="sub ${tone(d.nifty.chg)}">${d.nifty.chg > 0 ? '+' : d.nifty.chg < 0 ? MINUS : ''}${p2(Math.abs(d.nifty.chg))}</span>` : ''}</td>
      <td class="mo"><span class="ev ${esc(mo.event)}">${esc(EVENT[mo.event] || mo.event)}</span>${mo.event === 'none' ? '' : ` <span class="mono ${tone(mo.pnl)}" data-mpnl="${mo.pnl}">${signed2(mo.pnl)}</span>`}</td>
      <td class="wk">${wk}</td>
      <td class="r mono ${tone(d.total)}">${signed2(d.total)}</td>
      <td class="r mono ${tone(d.cum)}">${signed2(d.cum)}</td>
      <td class="r mono">${nf0.format(d.open ?? 0)}</td>
    </tr>`;
  }).join('');
}
function setupTable() {
  $('#dBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-date]');
    if (tr) select(tr.dataset.date, { scroll: true });
  });
}

// ---------- Transactions (reference 7) ----------
function legHTML(l, t) {
  const open = l.buy == null;
  return `<div class="pl-leg">
    <div class="pl-leg-h"><b>${esc(l.contract)}</b><div class="r"><div class="label">${open ? 'Open' : 'Realised P&amp;L'}</div><div class="num ${tone(l.pnl)}">${open ? '—' : signed2(l.pnl)}</div></div></div>
    <dl class="pl-leg-kv">
      <div><dt class="label">Quantity</dt><dd>${nf0.format(l.qty)} sold</dd></div>
      <div><dt class="label">Sold at</dt><dd>${p2(l.sell)}</dd></div>
      <div><dt class="label">Bought back at</dt><dd>${open ? 'open' : p2(l.buy)}</dd></div>
    </dl>
    <div class="pl-leg-f"><span>Type <b>${esc(TYPE[t.strategy] || '—')}</b></span><span>Charges <span class="mono">${l.charges == null ? '—' : rupees2(l.charges)}</span></span></div>
  </div>`;
}
function renderTx() {
  const box = $('#txList');
  if (!P()) { box.innerHTML = errBox(['pnl']); return; }
  const trades = [...(P().trades || [])].sort((a, b) => cmp(b.entry, a.entry) || cmp(String(a.strategy), String(b.strategy)));
  const cal = state.data.calendar;
  const nextW = (cal?.weekly || []).filter((d) => d >= todayIST()).sort()[0];
  const weeklyNote = trades.some((t) => t.strategy !== 'monthly') ? '' : `<p class="note-box">${esc(WEEKLY_EMPTY)}${nextW ? ` Next weekly expiry: <span class="mono">${esc(fmtDateWd(nextW))}</span>.` : ''}</p>`;
  if (!trades.length) { box.innerHTML = `<p class="note-box">No paper trade yet.</p>${weeklyNote}`; return; }
  box.innerHTML = weeklyNote + trades.map((t) => {
    const open = t.status === 'open';
    const title = t.strategy === 'monthly' ? `${NAME.monthly} · ${fmtMonth(t.entry.slice(0, 7))}` : `${NAME[t.strategy] || t.strategy} · ${fmtDateWd(t.entry)}`;
    const when = t.strategy === 'monthly'
      ? `Sold ${fmtDateShort(t.entry)} · ${t.exit ? `bought back ${fmtDateShort(t.exit)}` : 'still open'}`
      : `${fmtDate(t.entry)}${t.exit && t.exit !== t.entry ? ` → ${fmtDate(t.exit)}` : ''}`;
    const right = open
      ? `<div class="label"><span class="pill open">Open</span></div><div class="pl-trade-net num ${tone(t.mtm)}">${signed2(t.mtm)}</div><div class="kv-sub">MTM</div>`
      : `<div class="label">Net P&amp;L</div><div class="pl-trade-net num ${tone(t.net)}">${signed2(t.net)}</div>`;
    const foot = open
      ? `MTM at the latest close. Slippage so far <span class="num">${rupees2(t.slippage)}</span>; charges are booked on the exit day.`
      : `Realised <span class="num">${signed2(t.realized)}</span> − charges <span class="num">${rupees2(t.charges)}</span> − slippage <span class="num">${rupees2(t.slippage)}</span> = net <span class="num">${signed2(t.net)}</span>`;
    return `<article class="card pl-trade" data-id="${esc(t.id)}" style="border-left:3px solid ${SERIES[t.strategy] || 'var(--border)'}">
      <div class="pl-trade-h"><div><h4>${esc(title)}</h4><p class="kv-sub">${esc(when)} · ${esc(t.source || '')}</p></div><div class="r">${right}</div></div>
      ${(t.legs || []).map((l) => legHTML(l, t)).join('')}
      <p class="pl-trade-f">${foot}</p>
    </article>`;
  }).join('');
}

// ---------- Theme ----------
function retheme() {
  if (charts.bars && !charts.bars.isDisposed()) charts.bars.setOption(barsOption(), { notMerge: true });
  if (charts.day && !charts.day.isDisposed() && dayChartModel().kind !== 'none') charts.day.setOption(dayOption(dayChartModel()), { notMerge: true });
}

// ---------- Boot ----------
async function boot() {
  setupHeader({ onTheme: retheme, sections: false });
  setupTips();
  await loadAll();
  renderFreshness(state.data.meta);
  safely(renderAccount, $('#acCard .ac-kv'));
  safely(renderLedger, $('#acLedBody'));
  safely(renderRunner, $('#acRunT'));
  safely(renderToday, $('#plToday'));
  safely(renderSummary, $('#plSum'));
  const ds = days();
  state.sel = ds.length ? ds[ds.length - 1].date : null;
  state.month = state.sel ? state.sel.slice(0, 7) : null;
  safely(setupCalendar, $('#calGrid'));
  safely(renderCalendar, $('#calGrid'));
  safely(renderDay, $('#dayEvents'));
  // The day chart, the bars, the transactions and the table are built when they come near the viewport.
  whenNear($('#plDayChart'), () => { dayChartArmed = true; if (state.sel) drawDayChart(); }, '200px 0px');
  safely(setupCharts, $('#plBarsChart'));
  whenNear($('#plTx'), () => safely(renderTx, $('#txList')), '400px 0px');
  safely(setupTable, $('#dBody'));
  whenNear($('#days'), async () => { await yieldToBrowser(); safely(renderTable, $('#dBody')); }, '400px 0px');
}

boot();

"""MMES weekly decision rules, ported from the source project (read-only there):

  v3      D:\\Temp\\Dhan\\Shivam-testing\\nifty-strangle\\mmes-core.ts  runDay()   (both legs out at 2 x credit)
  leg20   D:\\Temp\\Dhan\\Shivam-testing\\nifty-strangle\\leg-sl.ts     runMode(LEG-20)

Both work on one day's per-minute arrays and are incremental: they read minutes [0, complete) and nothing later, and
return the state reached so far ('wait' | 'open' | 'exiting' | 'closed' | 'skip'). paper_nse.py calls them once a minute
with the snapshots received so far; the regression below calls them on the whole archive day.

Day view (a dict):
  t         ['09:15', '09:16', ...]   minute labels (IST), ascending
  complete  minutes [0, complete) are final
  leg(key)  {'o': [...], 'c': [...]} aligned with t (None = no print), or None when the strike is not in the data
  idx(i)    NIFTY index close of minute i, or None
  date      'YYYY-MM-DD' (charges() switches STT on it)

The arithmetic is copied line by line, including priceAt()'s estimate for a v3 exit with no print and LEG's
last-close fallback, because a "cleaner" rewrite would be a different strategy that only looks the same.

    python -I scripts/mmes_rules.py --regress      # AC4: 143 archive days vs replay-v3.csv and leg-sl-days.csv LEG-20
"""
import csv
import gzip
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SIGNAL, K, STOP_X, SQUARE_OFF, STEP, LOT = '09:25', 0.5, 2, '15:15', 50, 65
LEG_X = 20
SLIP = 0.25
IST = timezone(timedelta(hours=5, minutes=30))

SRC = Path(r'D:\Temp\Dhan\Shivam-testing\nifty-strangle\out\paper')
SRC_CHAINS = Path(r'D:\Temp\Dhan\.cache\history\chains\NIFTY')
SRC_IDX = Path(r'D:\Temp\Dhan\.cache\history\idx\NIFTY.json')


def charges(d, buy, sell):
    """Copied from mmes-core.ts charges() (theta-grid.ts): brokerage 40 per leg round trip, STT on the sell side
    (0.15% from 1 Apr 2026, 0.1% before), exchange, SEBI, stamp, GST."""
    stt = 0.0015 if d >= '2026-04-01' else 0.001
    t = buy + sell; b = 40; ex = 0.0003503 * t; se = 0.000001 * t
    return b + stt * sell + ex + se + 0.00003 * buy + 0.18 * (b + ex + se)


def nearest(x):
    """Nearest 50; an exact half goes down (mmes-core.ts nearest)."""
    k0 = math.floor(x / STEP) * STEP
    return k0 + STEP if x - k0 > STEP / 2 else k0


def js_round(x):
    """JavaScript Math.round: halves go up (Python's round() sends them to the even neighbour)."""
    return math.floor(x + 0.5)


def _at(v, h):
    try:
        return v['t'].index(h)
    except ValueError:
        return -1


# ------------------------------------------------------------------------------------------------ v3
def run_v3(v, lot=LOT):
    """mmes-core.ts runDay() with the default rules (stop at 2 x credit, no target)."""
    r = {'date': v['date'], 'state': 'wait', 'note': '', 'lot': lot, 'worst': 0.0}

    def done(state, note):
        r['state'] = state; r['note'] = note
        return r

    leg = v['leg']
    i, sq = _at(v, SIGNAL), _at(v, SQUARE_OFF)
    if i < 0 or sq < 0:
        return done('skip', 'no 09:25 or 15:15 minute in the day')
    if i >= v['complete']:
        return done('wait', '09:25 candle not final yet')
    spot = v['idx'](i)
    if spot is None:
        return done('skip', 'no NIFTY index close at 09:25')
    atm = nearest(spot)
    r.update(spot=spot, atm=atm)
    ceA, peA = leg(f'{atm}CE'), leg(f'{atm}PE')
    aCE = ceA['c'][i] if ceA else None
    aPE = peA['c'][i] if peA else None
    if aCE is None or aPE is None:
        return done('skip', f'ATM {atm} CE or PE has no 09:25 close')
    W = aCE + aPE; e = i + 1
    ceK, peK = nearest(spot + K * W), nearest(spot - K * W)
    r.update(aCE=aCE, aPE=aPE, W=W, ceK=ceK, peK=peK)
    ce, pe = leg(f'{ceK}CE'), leg(f'{peK}PE')
    if e >= v['complete']:
        return done('wait', '09:26 candle not final yet (entry fill)')
    ceIn = ce['o'][e] if ce else None
    peIn = pe['o'][e] if pe else None
    if ceIn is None or peIn is None:
        return done('skip', f'sell strike {ceK} CE or {peK} PE has no 09:26 open')
    credit = ceIn + peIn
    if credit <= 0.05:
        return done('skip', 'credit 0.05 or less')
    r.update(ceIn=ceIn, peIn=peIn, credit=credit, stopAt=STOP_X * credit)

    def price_at(Kk, side, x):
        """theta-grid's priceAt(): the leg's own open at minute x, else an estimate (and it says so)."""
        L = leg(f'{Kk}{side}')
        if L and L['o'][x] is not None:
            return L['o'][x], False
        last = math.nan
        if L:
            for j in range(x - 1, e - 1, -1):
                if L['c'][j] is not None:
                    last = L['c'][j]; break
        d = -1 if side == 'CE' else 1
        n1, p1 = 0, math.nan
        k = 1
        while k <= 40 and not math.isfinite(p1):
            q = leg(f'{Kk + d * k * STEP}{side}')
            q = q['o'][x] if q else None
            if q is not None:
                p1 = q; n1 = k
            k += 1
        q2 = leg(f'{Kk + d * (n1 + 1) * STEP}{side}')
        p2 = q2['o'][x] if q2 else None
        ub = min(last if math.isfinite(last) else math.inf, p1 if math.isfinite(p1) else math.inf)
        if not math.isfinite(ub):
            return math.nan, True
        ratio = p1 / p2 if (p2 is not None and p2 > 0) else math.nan
        est = p1 * ratio ** n1 if (math.isfinite(ratio) and ratio < 1) else ub
        return min(ub, max(0.05, js_round(est * 20) / 20)), True

    lc, lp, hit, worst, val, lastJ = ceIn, peIn, -1, 0.0, credit, -1
    end = min(sq, v['complete'])
    for j in range(e, end):
        if ce['c'][j] is not None:
            lc = ce['c'][j]
        if pe['c'][j] is not None:
            lp = pe['c'][j]
        val = lc + lp; lastJ = j
        worst = min(worst, (credit - val) * lot)
        if val >= STOP_X * credit:
            hit = j; break
    r.update(worst=worst, val=val, mtm=(credit - val) * lot)
    if lastJ >= 0:
        r['lastAt'] = v['t'][lastJ]
    if hit < 0 and v['complete'] < sq:
        return done('open', f'short {ceK} CE + {peK} PE')
    x = hit + 1 if hit >= 0 else sq
    r['why'] = 'STOP' if hit >= 0 else 'SQ1515'
    if hit >= 0:
        r['triggerAt'] = v['t'][hit]
    r['exitAt'] = v['t'][x]
    if x >= v['complete']:
        return done('exiting', f"{r['why']}: buy both back at the {r['exitAt']} open")
    co, coe = price_at(ceK, 'CE', x)
    po, poe = price_at(peK, 'PE', x)
    if not math.isfinite(co) or not math.isfinite(po):
        return done('skip', f"no exit price at {r['exitAt']}")
    pts = (ceIn - co) + (peIn - po)
    costs = charges(v['date'], co * lot, ceIn * lot) + charges(v['date'], po * lot, peIn * lot)
    net = pts * lot - costs
    r.update(ceOut=co, peOut=po, est=int(coe) + int(poe), cePts=ceIn - co, pePts=peIn - po, pts=pts, costs=costs,
             net=net, netSlip25=net - 4 * SLIP * lot, ceExit=r['exitAt'], peExit=r['exitAt'])
    return done('closed', f"{r['why']} at {r['exitAt']}")


# ------------------------------------------------------------------------------------------------ LEG-20
def run_leg(v, X=LEG_X, lot=LOT):
    """leg-sl.ts runMode() kind 'leg': a leg whose close is X points above its own sale price is bought back at the next
    minute's open (a missing print there falls back to the last close, counted in est); the other leg carries on with
    its own X-point stop; whatever is still open goes at the 15:15 open. Made incremental: a leg whose exit minute is
    not final yet is 'exiting'."""
    r = {'date': v['date'], 'state': 'wait', 'note': '', 'lot': lot, 'worst': 0.0, 'est': 0}

    def done(state, note):
        r['state'] = state; r['note'] = note
        return r

    leg, n = v['leg'], v['complete']
    i, sq = _at(v, SIGNAL), _at(v, SQUARE_OFF)
    if i < 0 or sq < 0:
        return done('skip', 'no 09:25 or 15:15 minute in the day')
    if i >= n:
        return done('wait', '09:25 candle not final yet')
    spot = v['idx'](i)
    if spot is None:
        return done('skip', 'no NIFTY index close at 09:25')
    atm = nearest(spot)
    ceA, peA = leg(f'{atm}CE'), leg(f'{atm}PE')
    aCE = ceA['c'][i] if ceA else None
    aPE = peA['c'][i] if peA else None
    r.update(spot=spot, atm=atm)
    if aCE is None or aPE is None:
        return done('skip', f'ATM {atm} CE or PE has no 09:25 close')
    W = aCE + aPE; e = i + 1
    ceK, peK = nearest(spot + K * W), nearest(spot - K * W)
    r.update(aCE=aCE, aPE=aPE, W=W, ceK=ceK, peK=peK)
    ce, pe = leg(f'{ceK}CE'), leg(f'{peK}PE')
    if e >= n:
        return done('wait', '09:26 candle not final yet (entry fill)')
    ceIn = ce['o'][e] if ce else None
    peIn = pe['o'][e] if pe else None
    if ceIn is None or peIn is None or ceIn + peIn <= 0.05:
        return done('skip', f'sell strike {ceK} CE or {peK} PE has no 09:26 open, or credit 0.05 or less')
    credit = ceIn + peIn
    r.update(ceIn=ceIn, peIn=peIn, credit=credit)
    est = 0

    def px(L, x, last):
        nonlocal est
        if x >= n:
            return None                                 # the exit minute is not final yet
        val = L['o'][x]
        if val is not None:
            return val
        est += 1
        return last

    lc, lp, ceX, peX, worst = ceIn, peIn, -1, -1, 0.0
    ceOut = peOut = None
    end = min(sq, n)
    for j in range(e, end):
        if ceX < 0 and ce['c'][j] is not None:
            lc = ce['c'][j]
        if peX < 0 and pe['c'][j] is not None:
            lp = pe['c'][j]
        ceVal = lc if ceX < 0 else ceOut
        peVal = lp if peX < 0 else peOut
        worst = min(worst, (credit - ceVal - peVal) * lot)
        hitCE = ceX < 0 and lc - ceIn >= X
        hitPE = peX < 0 and lp - peIn >= X
        if hitCE and ceX < 0:
            ceX = j + 1; ceOut = px(ce, ceX, lc)
        if hitPE and peX < 0:
            peX = j + 1; peOut = px(pe, peX, lp)
        if ceX >= 0 and peX >= 0:
            break
    r.update(lastCE=lc, lastPE=lp)
    r['ceExit'] = v['t'][ceX] if ceX >= 0 else None
    r['peExit'] = v['t'][peX] if peX >= 0 else None
    r['stopped'] = (1 if ceX >= 0 else 0) + (1 if peX >= 0 else 0)
    stopped_ce, stopped_pe = ceX >= 0, peX >= 0          # before the square-off sets the rest
    ceMark = lc if ceX < 0 or ceOut is None else ceOut
    peMark = lp if peX < 0 or peOut is None else peOut
    r.update(worst=worst, mtm=(credit - ceMark - peMark) * lot, ceOut=ceOut, peOut=peOut, est=est)
    if n < sq and not (ceX >= 0 and peX >= 0 and ceOut is not None and peOut is not None):
        pend = [s for s, X_, o in (('CE', ceX, ceOut), ('PE', peX, peOut)) if X_ >= 0 and o is None]
        if pend:
            return done('exiting', f"{' + '.join(pend)} stopped: bought back at the next open")
        return done('open', f'short {ceK} CE + {peK} PE' + (' (one leg out)' if r['stopped'] else ''))
    # the 15:15 square-off for whatever is still open
    if ceX < 0:
        ceX = sq; ceOut = px(ce, sq, lc)
    if peX < 0:
        peX = sq; peOut = px(pe, sq, lp)
    r['ceExit'], r['peExit'] = v['t'][ceX], v['t'][peX]
    if ceOut is None or peOut is None:
        return done('exiting', 'square-off at the 15:15 open')
    pts = ceIn - ceOut + peIn - peOut
    worst = min(worst, pts * lot)                         # the exits count too (leg-sl.ts)
    costs = charges(v['date'], ceOut * lot, ceIn * lot) + charges(v['date'], peOut * lot, peIn * lot)
    net = pts * lot - costs
    why = 'BOTH STOP' if stopped_ce and stopped_pe else 'CE STOP' if stopped_ce else 'PE STOP' if stopped_pe else 'SQ1515'
    r.update(ceOut=ceOut, peOut=peOut, pts=pts, costs=costs, net=net, netSlip25=net - 4 * SLIP * lot, worst=worst,
             est=est, why=why, mtm=pts * lot)
    return done('closed', f'{why}; CE out {r["ceExit"]}, PE out {r["peExit"]}')


# ------------------------------------------------------------------------------------------------ minute MTM
def mtm_series(v, res, lot=LOT):
    """The day's P&L line of a closed (or open) result: one point per minute from the entry minute to the last exit.
    Each leg is marked at its close while open and at its exit price after it is bought back. Slippage is taken on the
    day of each fill (2 sell fills at entry, 1 per buy fill); the charges land on the final point, so the last point is
    the row's net after charges and slippage. Returns (t, values)."""
    if res.get('ceIn') is None:
        return [], []
    e = _at(v, SIGNAL) + 1
    ce, pe = v['leg'](f"{res['ceK']}CE"), v['leg'](f"{res['peK']}PE")
    xs = {'CE': _at(v, res['ceExit']) if res.get('ceExit') else None,
          'PE': _at(v, res['peExit']) if res.get('peExit') else None}
    last_i = max([x for x in xs.values() if x is not None] + [min(v['complete'], len(v['t'])) - 1])
    if res['state'] == 'closed':
        last_i = max(x for x in xs.values())
    sell = {'CE': res['ceIn'], 'PE': res['peIn']}
    out_px = {'CE': res.get('ceOut'), 'PE': res.get('peOut')}
    series = {'CE': ce, 'PE': pe}
    mark = dict(sell)
    t, vals = [], []
    for j in range(e, last_i + 1):
        fills = 2
        for s in ('CE', 'PE'):
            x = xs[s]
            if x is not None and j >= x and out_px[s] is not None:
                mark[s] = out_px[s]; fills += 1
            else:
                c = series[s]['c'][j] if j < len(series[s]['c']) else None
                if c is not None:
                    mark[s] = c
        m = (sell['CE'] - mark['CE'] + sell['PE'] - mark['PE']) * lot - fills * SLIP * lot
        t.append(v['t'][j]); vals.append(round(m, 2))
    if res['state'] == 'closed' and vals:
        vals[-1] = round(res['netSlip25'], 2)
    return t, vals


# ------------------------------------------------------------------------------------------------ archive + AC4
def hm(ms):
    return datetime.fromtimestamp(ms / 1000, IST).strftime('%H:%M')


def archive_view(date, idx_bar, idx_c):
    ch = json.load(gzip.open(SRC_CHAINS / f'{date}-W1.json.gz', 'rt', encoding='utf-8'))
    t_ms = ch['t']
    legs = ch['legs']
    return {'date': date, 't': [hm(x) for x in t_ms], 'complete': len(t_ms),
            'leg': lambda k: legs.get(k),
            'idx': lambda i: (idx_c[idx_bar[t_ms[i]]] if t_ms[i] in idx_bar else None)}


def cut_view(v, n):
    """The same day with only minutes [0, n) physically present, as the live runner sees it at minute n."""
    cache = {}

    def leg(k):
        if k not in cache:
            L = v['leg'](k)
            cache[k] = None if L is None else {'o': L['o'][:n] + [None] * (len(v['t']) - n),
                                               'c': L['c'][:n] + [None] * (len(v['t']) - n)}
        return cache[k]
    return {'date': v['date'], 't': v['t'], 'complete': n, 'leg': leg, 'idx': lambda i: v['idx'](i) if i < n else None}


def regress(cut_every=0, log=print):
    """AC4: (v3 equal, LEG-20 equal, days) over the replay-v3.csv dates. None when the archive is not on this machine."""
    if not (SRC / 'replay-v3.csv').exists() or not SRC_CHAINS.is_dir() or not SRC_IDX.exists():
        return None
    with open(SRC / 'replay-v3.csv', encoding='utf-8') as fh:
        v3_ref = {r['date']: r for r in csv.DictReader(fh)}
    with open(SRC / 'leg-sl-days.csv', encoding='utf-8') as fh:
        leg_ref = {r['date']: r for r in csv.DictReader(fh) if r['mode'] == f'LEG-{LEG_X}'}
    idx = json.load(open(SRC_IDX, encoding='utf-8'))
    idx_bar = {t: i for i, t in enumerate(idx['t'])}
    same_v3 = same_leg = 0
    bad = []
    for date in sorted(v3_ref):
        v = archive_view(date, idx_bar, idx['c'])
        a, b = run_v3(v), run_leg(v)
        ra, rb = v3_ref[date], leg_ref.get(date)
        okv = (a['state'] == 'closed' and abs(a['net'] - float(ra['net'])) <= 0.01
               and abs(a['netSlip25'] - float(ra['netSlip25'])) <= 0.01 and a['exitAt'] == ra['exitAt']
               and a['why'] == ra['why'] and (a.get('triggerAt') or '') == ra['triggerAt'] and a['ceK'] == int(ra['ceK'])
               and a['peK'] == int(ra['peK']) and a['est'] == int(ra['est']) and abs(a['worst'] - float(ra['worst'])) <= 0.01)
        okl = (rb is not None and b['state'] == 'closed' and abs(b['net'] - float(rb['net'])) <= 0.01
               and abs(b['netSlip25'] - float(rb['slip'])) <= 0.01 and b['ceExit'] == rb['ceExit']
               and b['peExit'] == rb['peExit'] and abs(b['worst'] - float(rb['worst'])) <= 0.01)
        same_v3 += okv; same_leg += okl
        if not okv:
            bad.append(f"v3 {date}: {a['state']} net {a.get('net')} exit {a.get('exitAt')} vs {ra['net']} {ra['exitAt']}")
        if not okl:
            bad.append(f"LEG-20 {date}: {b['state']} net {b.get('net')} exits {b.get('ceExit')}/{b.get('peExit')} vs "
                       f"{rb and rb['net']} {rb and rb['ceExit']}/{rb and rb['peExit']}")
        # the minute line ends at the row's net after slippage
        for res in (a, b):
            ts, vals = mtm_series(v, res)
            if not vals or abs(vals[-1] - res['netSlip25']) > 0.01 or ts[0] != '09:26':
                bad.append(f'{date}: minute MTM line does not end at the net')
        # incremental: with the day cut physically at each minute, no decision may differ from the full day's
        if cut_every:
            for n in range(0, len(v['t']) + 1, cut_every):
                cv = cut_view(v, n)
                for fn, full in ((run_v3, a), (run_leg, b)):
                    r = fn(cv)
                    if r['state'] == 'closed' and (abs(r['net'] - full['net']) > 1e-9 or r['ceExit'] != full['ceExit']):
                        bad.append(f'{date} cut {n}: {fn.__name__} closed early with a different answer')
                    if r['state'] == 'skip':
                        bad.append(f'{date} cut {n}: {fn.__name__} skipped a day the full data trades')
    for b_ in bad[:15]:
        log(f'  MISMATCH {b_}')
    log(f'[rules] AC4: v3 {same_v3}/{len(v3_ref)} equal replay-v3.csv; LEG-{LEG_X} {same_leg}/{len(leg_ref)} equal '
        f'leg-sl-days.csv (net within Rs 0.01, same exit times); {len(bad)} problem(s)')
    return same_v3, same_leg, len(v3_ref), len(leg_ref), bad


def main():
    if '--regress' in sys.argv:
        cut = 1 if '--cut' in sys.argv else 0
        res = regress(cut_every=cut)
        if res is None:
            print('[rules] SKIP: the source archive is not on this machine'); return 0
        a, b, n, nl, bad = res
        return 0 if (a == n == nl == b and n == 143 and not bad) else 1
    print(__doc__)
    return 0


if __name__ == '__main__':
    sys.exit(main())

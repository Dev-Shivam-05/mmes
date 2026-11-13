"""Checks for the dashboard's data. Exits 1 on any failure. Standard library only (runs in CI as `python3 scripts/check.py`).

  (a) every card KPI in data/strategies.json, recomputed from the per-trade rows with code written apart from
      export.py, within Rs 1 (win % within 0.05, as it is stored to 1 decimal); plus the contract's expected values
  (b) regression: monthly_core replayed over the 34 historical months must equal data/trades-monthly.json "spot"
      (34/34, net within Rs 0.01). Needs the source project's bhavcopy cache; prints SKIP where it is absent (CI).
      Open or closed paper months whose files are still in data/bhav must re-evaluate to the stored record.
  (d) every data file parses and has the contract's top-level keys
  (e) candles (row 14): one days/<date>.json per weekly trade, 5-minute buckets 09:15 .. 15:25 with l <= o, c <= h,
      strikes and exit times equal to the trade rows; nifty-daily and paper-legs well formed. Three random trade days
      and three random index days are rebuilt from the raw source files (SKIP where absent) and must match exactly;
      so must every Yahoo day of the saved Yahoo file and every paper-legs candle whose bhavcopy is still in data/bhav.
  (c) privacy grep over every file in the repo except .git/
"""
import gzip
import json
import math
import os
import random
import re
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
SRC_BHAV = Path(r'D:\Temp\Dhan\.cache\mmes-monthly')
SRC_IDX = Path(r'D:\Temp\Dhan\.cache\history\idx\NIFTY.json')
SRC_CHAINS = Path(r'D:\Temp\Dhan\.cache\history\chains\NIFTY')
SRC_YAHOO = Path(r'D:\Temp\Dhan\.cache\yahoo\nsei-1d.json')
FAILS = []


def fail(msg):
    FAILS.append(msg)
    print(f'FAIL {msg}')


def ok(msg):
    print(f'ok   {msg}')


def load(name):
    with open(DATA / name, encoding='utf-8') as fh:
        return json.load(fh)


# ------------------------------------------------------------------------------------------------ (d) shapes
KEYS = {
    'meta.json': ['generatedAt', 'updatedAt', 'bhavLatest', 'stale', 'staleSince', 'weeklyRange', 'monthlyRange'],
    'strategies.json': ['strategies'],
    'trades-weekly.json': ['v3', 'leg20', 'leg40'],
    'trades-monthly.json': ['spot', 'fwd'],
    'calendar.json': ['asOf', 'weekly', 'monthly', 'lot'],
    'paper-monthly.json': ['rules', 'months'],
    'paper-weekly.json': ['trades', 'note'],
    'nifty-daily.json': ['source', 'candles'],
    'paper-legs.json': ['month', 'ceK', 'peK', 'ce', 'pe'],
}
STRAT_KEYS = ['id', 'name', 'tagline', 'kind', 'rules', 'kpi', 'notes', 'equity', 'months']
KPI_KEYS = ['trades', 'winPct', 'net', 'net50', 'perYear', 'worst', 'worstUnit', 'maxDD', 'capitalMin', 'capitalSafe', 'marginPeak']
ROW_KEYS = ['date', 'spot', 'W', 'ceK', 'peK', 'ceIn', 'peIn', 'credit', 'why', 'exitAt', 'ceExit', 'peExit', 'ceOut', 'peOut',
            'pts', 'net', 'slip', 'worst']
MROW_KEYS = ['month', 'entry', 'expiry', 'spot', 'W', 'ceK', 'peK', 'ce_in', 'pe_in', 'credit', 'ce_out', 'ce_at', 'pe_out',
             'pe_at', 'why', 'pts', 'net', 's25', 's100', 'worst']
PAPER_KEYS = ['month', 'entry', 'expiry', 'spot', 'W', 'ceK', 'peK', 'ceIn', 'peIn', 'credit', 'stopAt', 'status', 'trigger',
              'last', 'exit', 'net']


def need(obj, keys, where):
    miss = [k for k in keys if k not in obj]
    if miss:
        fail(f'{where}: missing keys {miss}')
    return not miss


def check_shapes():
    got = {}
    for name, keys in KEYS.items():
        try:
            got[name] = load(name)
        except Exception as e:
            fail(f'{name}: does not parse ({e})'); continue
        need(got[name], keys, name)
    for f in sorted(DATA.glob('*.json')):
        if f.name not in KEYS:
            try:
                json.load(open(f, encoding='utf-8')); ok(f'{f.name} parses (no contract keys)')
            except Exception as e:
                fail(f'{f.name}: does not parse ({e})')
    for f in sorted((DATA / 'bhav').glob('*.json.gz')):
        try:
            j = json.load(gzip.open(f, 'rt', encoding='utf-8'))
            if j.get('date') != f.name[:10] or not j.get('rows'):
                fail(f'bhav/{f.name}: date mismatch or no rows')
        except Exception as e:
            fail(f'bhav/{f.name}: does not parse ({e})')
    s = got.get('strategies.json', {}).get('strategies', [])
    if [x.get('id') for x in s] != ['v3', 'leg20', 'leg40', 'monthly', 'merged']:
        fail(f"strategies order is {[x.get('id') for x in s]}")
    for x in s:
        if need(x, STRAT_KEYS, f"strategy {x.get('id')}"):
            need(x['kpi'], KPI_KEYS, f"kpi {x['id']}")
    for sid, rows in got.get('trades-weekly.json', {}).items():
        for r in rows:
            if not need(r, ROW_KEYS, f'trades-weekly {sid} {r.get("date")}'):
                break
    for r in got.get('trades-monthly.json', {}).get('spot', []) + got.get('trades-monthly.json', {}).get('fwd', []):
        if not need(r, MROW_KEYS, f'trades-monthly {r.get("month")}'):
            break
    for m in got.get('paper-monthly.json', {}).get('months', []):
        need(m, PAPER_KEYS, f'paper-monthly {m.get("month")}')
        if m.get('status') not in ('open', 'closed', 'waiting'):
            fail(f"paper-monthly {m.get('month')}: status {m.get('status')}")
        t = m.get('trigger')
        if t is not None:
            # the stop's close: on or after entry, at or above stopAt, and the day before the next-open exit
            if (not isinstance(t, dict) or set(t) != {'date', 'value'} or not (m['entry'] < t['date'] <= m['last']['date'])
                    or t['value'] + 0.005 < m['stopAt']
                    or (m.get('exit') and not (t['date'] < m['exit']['date'] and m['exit']['why'] == 'STOP'))):
                fail(f"paper-monthly {m.get('month')}: trigger {t} does not fit stopAt {m.get('stopAt')} / exit {m.get('exit')}")
        elif m.get('exit') and m['exit'].get('why') == 'STOP':
            fail(f"paper-monthly {m.get('month')}: exit is STOP but trigger is null")
    meta = got.get('meta.json', {})
    for k in ('bhavLatest',):
        try:
            date.fromisoformat(meta.get(k))
        except Exception:
            fail(f'meta.{k} is not a date: {meta.get(k)}')
    c = meta.get('costs')
    if not isinstance(c, dict) or set(c) != {'dataApiMonthly', 'gstPct', 'dataApiPerYear'}:
        fail(f'meta.costs is not {{dataApiMonthly, gstPct, dataApiPerYear}}: {c}')
    elif (c['dataApiMonthly'], c['gstPct']) != (499, 18) or abs(c['dataApiPerYear'] - c['dataApiMonthly'] * 12 * (100 + c['gstPct']) / 100) > 0.005:
        fail(f'meta.costs: {c} (contract: 499, 18, 499 x 12 x 1.18 = 7065.84)')
    if not FAILS:
        ok('(d) every data file parses and has the contract keys')
    return got


# ------------------------------------------------------------------------------------------------ (a) KPIs
# Constants straight from the contract's table, not from export.py.
MARGIN_ONE = 198_016 + 65_777
YEARS = {'weekly': (date(2026, 9, 25) - date(2024, 1, 1)).days / 365, 'monthly': 34 / 12, 'merged': 33 / 12}
EXPECTED = {   # contract "Data contract" table and the lead's brief; +-1
    'v3': dict(net=86_338, winPct=57.3, maxDD=-32_214, perYear=31_577, capitalSafe=400_000),
    'leg20': dict(net=79_387, winPct=62.2, maxDD=-12_976, perYear=29_034),
    'leg40': dict(net=79_923, winPct=46.2, maxDD=-22_945, perYear=29_230),
    'monthly': dict(net=178_060, winPct=70.6, maxDD=-46_964, perYear=62_845),
    'merged': dict(net=251_190, maxDD=-30_684, perYear=91_342),
}


def up10k(v):
    return 10_000 * math.ceil(v / 10_000)


def worst_fall(steps):
    """Largest peak-to-trough fall of the running total (0 or negative). Peak starts at 0, the account's start."""
    best, total, fall = 0.0, 0.0, 0.0
    for s in steps:
        total = total + s
        if total > best:
            best = total
        fall = min(fall, total - best)
    return fall


def capital_needed(trades, margin):
    """max over trades of margin - money made before the trade - min(0, the trade's worst MTM)."""
    made, top = 0.0, 0.0
    for t in trades:
        top = max(top, margin - made - min(0.0, t[1]))
        made = made + t[0]
    return up10k(top)


def recompute(got):
    tw = got['trades-weekly.json']; tm = got['trades-monthly.json']['spot']
    calc = {}
    for sid in ('v3', 'leg20', 'leg40'):
        rows = tw[sid]
        after = [r['slip'] for r in rows]
        dd = worst_fall(after)
        calc[sid] = dict(trades=len(rows), winPct=100.0 * len([r for r in rows if r['net'] > 0]) / len(rows),
                         net=sum(after), net50=sum(r['net'] for r in rows) - len(rows) * 2 * 2 * 0.5 * 65,
                         perYear=sum(after) / YEARS['weekly'], worst=min(after), worstUnit='day', maxDD=dd,
                         capitalMin=capital_needed([(r['slip'], r['worst']) for r in rows], MARGIN_ONE),
                         capitalSafe=up10k(1.1 * MARGIN_ONE + 3 * abs(dd) + 10_000), marginPeak=MARGIN_ONE,
                         equityEnd=sum(after), monthsSum=sum(after))
    after = [r['s25'] for r in tm]
    dd = worst_fall(after)
    calc['monthly'] = dict(trades=len(tm), winPct=100.0 * len([r for r in tm if r['net'] > 0]) / len(tm), net=sum(after),
                           net50=sum(r['net'] for r in tm) - len(tm) * 130, perYear=sum(after) / YEARS['monthly'],
                           worst=min(after), worstUnit='month', maxDD=dd,
                           capitalMin=capital_needed([(r['s25'], r['worst']) for r in tm], MARGIN_ONE),
                           capitalSafe=up10k(1.1 * MARGIN_ONE + 3 * abs(dd) + 10_000), marginPeak=MARGIN_ONE,
                           equityEnd=sum(after), monthsSum=sum(after))
    # merged: v3 and the monthly in one account, Jan 2024 .. Sep 2026, one step per calendar month
    per_month = {}
    for r in tw['v3']:
        per_month[r['date'][:7]] = per_month.get(r['date'][:7], 0.0) + r['slip']
    inside = [r for r in tm if '2024-01' <= r['month'] <= '2026-09']
    for r in inside:
        per_month[r['month']] = per_month.get(r['month'], 0.0) + r['s25']
    steps = [per_month[m] for m in sorted(per_month)]
    both = [r['net'] for r in tw['v3']] + [r['net'] for r in inside]
    dd = worst_fall(steps)
    calc['merged'] = dict(trades=len(both), winPct=100.0 * len([v for v in both if v > 0]) / len(both), net=sum(steps),
                          net50=sum(both) - len(both) * 130, perYear=sum(steps) / YEARS['merged'], worst=min(steps),
                          worstUnit='month', maxDD=dd, capitalMin=up10k(2 * MARGIN_ONE),
                          capitalSafe=up10k(1.1 * 2 * MARGIN_ONE + 3 * abs(dd) + 10_000), marginPeak=2 * MARGIN_ONE,
                          equityEnd=sum(steps), monthsSum=sum(steps))
    if len(steps) != 33:
        fail(f'merged: {len(steps)} months, expected 33')
    return calc


def check_kpis(got):
    n0 = len(FAILS)
    # every weekly row's points must be its own four prices: ceIn - ceOut + peIn - peOut (leg-sl.ts computes pts so)
    n_rows = n_est = 0
    for sid in ('v3', 'leg20', 'leg40'):
        for r in got['trades-weekly.json'][sid]:
            n_rows += 1
            if r.get('ceOut') is None or r.get('peOut') is None:
                fail(f"(a) {sid} {r['date']}: an exit price is missing"); continue
            if abs(r['ceIn'] - r['ceOut'] + r['peIn'] - r['peOut'] - r['pts']) > 0.01:
                fail(f"(a) {sid} {r['date']}: ceIn - ceOut + peIn - peOut = "
                     f"{r['ceIn'] - r['ceOut'] + r['peIn'] - r['peOut']:.2f}, pts {r['pts']}")
            if r.get('est') not in (0, 1, 2):
                fail(f"(a) {sid} {r['date']}: est {r.get('est')} is not 0, 1 or 2")
            n_est += r.get('est') or 0
    print(f'     weekly rows: {n_rows}, each pts = its four prices within 0.01; {n_est} exit price(s) estimated')
    calc = recompute(got)
    for s in got['strategies.json']['strategies']:
        sid, k, c = s['id'], s['kpi'], calc[s['id']]
        for key in KPI_KEYS:
            a, b = k[key], c[key]
            if isinstance(b, str) or key in ('trades', 'capitalMin', 'capitalSafe', 'marginPeak'):
                good = a == b
            else:
                good = abs(a - b) <= (0.05 if key == 'winPct' else 1.0)
            if not good:
                fail(f'(a) {sid}.{key}: card {a} vs recomputed {b}')
        if abs(s['equity'][-1][1] - c['equityEnd']) > 1:
            fail(f"(a) {sid}: equity ends at {s['equity'][-1][1]}, net is {c['equityEnd']}")
        if abs(sum(s['months'].values()) - c['monthsSum']) > 1:
            fail(f'(a) {sid}: months sum to {sum(s["months"].values())}, net is {c["monthsSum"]}')
        if [e[0] for e in s['equity']] != sorted(e[0] for e in s['equity']):
            fail(f'(a) {sid}: equity dates are not in order')
        for key, want in EXPECTED[sid].items():
            if abs(k[key] - want) > (0.05 if key == 'winPct' else 1.0):
                fail(f'(a) {sid}.{key}: {k[key]} vs the contract\'s {want}')
        print(f"     {sid:<8} trades {c['trades']:>3} win {c['winPct']:5.1f}% net {c['net']:>11,.2f} net50 {c['net50']:>11,.2f} "
              f"perYear {c['perYear']:>10,.2f} worst {c['worst']:>10,.2f} maxDD {c['maxDD']:>10,.2f} "
              f"capMin {c['capitalMin']:>8,} capSafe {c['capitalSafe']:>8,}")
    notes = next(s for s in got['strategies.json']['strategies'] if s['id'] == 'monthly')['notes']
    for want in ('Strikes centred on the option-implied forward instead of the index close: \u20b91,20,354. Treat the result as fragile.',
                 'Daily bars: intraday risk is not visible.'):
        if want not in notes:
            fail(f'(a) monthly notes lack: {want}')
    fwd = sum(r['s25'] for r in got['trades-monthly.json']['fwd'])
    if abs(fwd - 120_354) > 1:
        fail(f'(a) forward-centred monthly net is {fwd}, the note says 1,20,354')
    pw = got['paper-weekly.json']
    if not pw['trades'] and pw['note'] != ('No live paper trade yet. The first possible day is Tue 17 Nov 2026; it needs a new '
                                           'Dhan token and the Data API plan.'):
        fail('(d) paper-weekly note is not the contract\'s empty-ledger note')
    if len(FAILS) == n0:
        ok('(a) every card KPI equals its recomputation (Rs 1) and the contract\'s expected values')


# ------------------------------------------------------------------------------------------------ (b) regression
def check_regression(got):
    sys.path.insert(0, str(Path(__file__).resolve().parent))      # the shared core, under python -I as well
    import monthly_core as mc
    n0 = len(FAILS)
    if SRC_BHAV.is_dir() and SRC_IDX.exists():
        days = mc.load_days(str(SRC_BHAV))
        idx = mc.load_idx_close(str(SRC_IDX))
        stored = got['trades-monthly.json']['spot']
        mine = {r['month']: r for r in mc.replay(days, idx, sorted({d[:7] for d in days})) if r['month'] <= '2026-10'}
        same = 0
        for s in stored:
            r = mine.get(s['month'])
            if not r:
                fail(f"(b) {s['month']}: no replayed month"); continue
            bad = [k for k in MROW_KEYS if (abs(r[k] - s[k]) > 0.01 if isinstance(s[k], float) else r[k] != s[k])]
            if bad:
                fail(f"(b) {s['month']}: differs in {bad}")
            else:
                same += 1
        if len(mine) != len(stored):
            fail(f'(b) replay has {len(mine)} months, the data {len(stored)}')
        print(f'     regression: {same}/{len(stored)} months equal (net within Rs 0.01)')
    else:
        print(f'SKIP (b) regression: {SRC_BHAV} not on this machine')
    days = mc.load_days(str(DATA / 'bhav'))
    for m in got['paper-monthly.json']['months']:
        if m['status'] == 'waiting' or m['entry'] not in days:
            continue
        p = mc.plan(days, m['month'])
        r = mc.evaluate(days, m['month'], *p) if p else None
        if not r or r['status'] != m['status'] or r['ceK'] != m['ceK'] or r['peK'] != m['peK'] or r['last_date'] != m['last']['date']:
            fail(f"(b) paper {m['month']}: stored record does not re-evaluate from data/bhav"); continue
        if m['status'] == 'closed' and abs(r['s25'] - m['net']) > 0.01:
            fail(f"(b) paper {m['month']}: net {m['net']} vs {r['s25']}")
        want_t = {'date': r['trigger'][0], 'value': round(r['trigger'][1], 2)} if r['trigger'] else None
        if m['trigger'] != want_t:
            fail(f"(b) paper {m['month']}: trigger {m['trigger']} vs re-evaluated {want_t}")
        ok(f"(b) paper {m['month']} re-evaluates: {m['status']}, trigger {m['trigger']}, last {m['last']['date']}")
    if len(FAILS) == n0:
        ok('(b) regression')


# ------------------------------------------------------------------------------------------------ (e) candles
SLOTS = [f'{(555 + 5 * i) // 60:02d}:{(555 + 5 * i) % 60:02d}' for i in range(75)]     # 09:15 .. 15:25
EPOCH = date(1970, 1, 1)


def sane(series, where, slots=None):
    """[[key, o, h, l, c]]: keys strictly increasing (and inside slots when given), l <= o, c <= h."""
    keys = [b[0] for b in series]
    if keys != sorted(set(keys)):
        fail(f'(e) {where}: keys not strictly increasing'); return False
    if slots is not None and not set(keys) <= set(slots):
        fail(f'(e) {where}: buckets outside 09:15 .. 15:25: {sorted(set(keys) - set(slots))[:3]}'); return False
    for k, o, h, l, c in series:
        if not (l <= o <= h and l <= c <= h):
            fail(f'(e) {where} {k}: o {o} h {h} l {l} c {c} breaks l <= o, c <= h'); return False
    return True


def ist_parts(ms):
    """(IST date, minute of the IST day) by integer arithmetic, apart from export.py's datetime path."""
    s = ms // 1000 + 5 * 3600 + 30 * 60
    return (EPOCH + timedelta(days=s // 86400)).isoformat(), (s % 86400) // 60


def buckets(minutes):
    """[(minute of day, o, h, l, c)] in time order -> {hh:mm: [o, h, l, c]} for 09:15 .. 15:29, nulls skipped."""
    acc = {}
    for mn, o, h, l, c in minutes:
        if mn < 555 or mn > 929 or o is None or h is None or l is None or c is None:
            continue
        slot = SLOTS[(mn - 555) // 5]
        if slot in acc:
            a = acc[slot]; acc[slot] = [a[0], max(a[1], h), min(a[2], l), c]
        else:
            acc[slot] = [o, h, l, c]
    return {k: [round(x, 2) for x in v] for k, v in acc.items()}


def as_map(series):
    return {b[0]: list(b[1:]) for b in series}


def check_candles(got):
    n0 = len(FAILS)
    v3 = {r['date']: r for r in got['trades-weekly.json']['v3']}
    legs = {s: {r['date']: r for r in got['trades-weekly.json'][s]} for s in ('leg20', 'leg40')}
    folder = DATA / 'days'
    files = sorted(f.name for f in folder.glob('*.json')) if folder.is_dir() else []
    if files != sorted(f'{d}.json' for d in v3):
        fail(f'(e) days/: {len(files)} files, expected one per weekly trade ({len(v3)})')
    day = {}
    for f in files:
        try:
            j = json.load(open(folder / f, encoding='utf-8'))
        except Exception as e:
            fail(f'(e) days/{f}: does not parse ({e})'); continue
        if not need(j, ['date', 'step', 'nifty', 'ce', 'pe', 'ceK', 'peK', 'entry', 'exits'], f'days/{f}'):
            continue
        d = j['date']; day[d] = j; r = v3.get(d)
        if not r or f != f'{d}.json' or j['step'] != 5 or j['entry'] != '09:26':
            fail(f'(e) days/{f}: date, step or entry wrong'); continue
        if (j['ceK'], j['peK']) != (r['ceK'], r['peK']):
            fail(f'(e) days/{f}: strikes {j["ceK"]}/{j["peK"]} vs the trade {r["ceK"]}/{r["peK"]}')
        want = {'v3': {'ce': r['exitAt'], 'pe': r['exitAt']},
                'leg20': {'ce': legs['leg20'][d]['ceExit'], 'pe': legs['leg20'][d]['peExit']},
                'leg40': {'ce': legs['leg40'][d]['ceExit'], 'pe': legs['leg40'][d]['peExit']}}
        if j['exits'] != want:
            fail(f'(e) days/{f}: exits {j["exits"]} vs the trade rows {want}')
        if [b[0] for b in j['nifty']] != SLOTS:
            fail(f'(e) days/{f}: NIFTY is not the 75 buckets 09:15 .. 15:25')
        for s in ('nifty', 'ce', 'pe'):
            sane(j[s], f'days/{f} {s}', SLOTS)
        if not j['ce'] or not j['pe']:
            fail(f'(e) days/{f}: a leg has no candle')
    size = sum((folder / f).stat().st_size for f in files)
    print(f'     days/: {len(files)} files, {size:,} bytes')

    nd = got['nifty-daily.json']['candles']
    sane(nd, 'nifty-daily')
    if not nd or nd[0][0] != '2024-01-01':
        fail('(e) nifty-daily does not start on 2024-01-01')
    print(f'     nifty-daily: {len(nd)} candles, {nd[0][0]} .. {nd[-1][0]}')

    rng = random.Random()
    if SRC_IDX.exists() and SRC_CHAINS.is_dir():
        idx = json.load(open(SRC_IDX, encoding='utf-8'))
        by = {}
        for t, o, h, l, c in zip(idx['t'], idx['o'], idx['h'], idx['l'], idx['c']):
            dd, mn = ist_parts(t)
            by.setdefault(dd, []).append((mn, o, h, l, c))
        pick = rng.sample(sorted(day), 3)
        for d in pick:
            j = day[d]
            ch = json.load(gzip.open(SRC_CHAINS / f'{d}-W1.json.gz', 'rt', encoding='utf-8'))
            mins = [ist_parts(t)[1] for t in ch['t']]
            got_ = {'nifty': buckets(sorted(by[d])),
                    'ce': buckets(zip(mins, *(ch['legs'][f"{j['ceK']}CE"][k] for k in 'ohlc'))),
                    'pe': buckets(zip(mins, *(ch['legs'][f"{j['peK']}PE"][k] for k in 'ohlc')))}
            for s in ('nifty', 'ce', 'pe'):
                if as_map(j[s]) != got_[s]:
                    fail(f'(e) days/{d}.json {s}: differs from the raw minutes')
        # daily candles: the session's 09:15-15:29 minutes (all minutes for an evening-only special session); where a
        # UDiFF bhavcopy exists, its underlying price is the close and the high/low stretch to hold it
        idx_end = max(by)
        stored = {c[0]: c[1:] for c in nd}
        under = {}
        for folder in (SRC_BHAV, DATA / 'bhav'):
            for f in (sorted(folder.glob('*.json.gz')) if folder.is_dir() else []):
                j = json.load(gzip.open(f, 'rt', encoding='utf-8'))
                if j.get('format') == 'udiff' and j.get('under'):
                    under[j['date']] = j['under']
        if not SRC_BHAV.is_dir():
            print('SKIP (e) daily candles from raw: the source bhavcopy cache is not on this machine')
        pick_d = rng.sample(sorted(by), 3) + ['2026-08-03']          # 3 Aug 2026: the official close sits above the minutes
        for d in pick_d:
            ms = sorted(by[d]); inside = [m for m in ms if 555 <= m[0] <= 929] or ms
            o, h, l, c = inside[0][1], max(m[2] for m in inside), min(m[3] for m in inside), inside[-1][4]
            if d in under:
                c = under[d]; h = max(h, c); l = min(l, c)
            want = [round(x, 2) for x in (o, h, l, c)]
            if SRC_BHAV.is_dir() and stored.get(d) != want:
                fail(f'(e) nifty-daily {d}: {stored.get(d)} vs the raw minutes + official close {want}')
        if set(d for d in stored if d <= idx_end) != set(by):
            fail('(e) nifty-daily: the index days do not match the index file day for day')
        print(f'     rebuilt from raw: trade days {pick}, index days {pick_d}')
        if SRC_YAHOO.exists():
            y = json.load(open(SRC_YAHOO, encoding='utf-8'))['chart']['result'][0]; q = y['indicators']['quote'][0]
            n = n_ov = 0; gaps = []
            for i, t in enumerate(y['timestamp']):
                d = ist_parts(int(t) * 1000)[0]
                if q['close'][i] is None:
                    continue
                if d > idx_end:
                    n += 1
                    want = [round(q[k][i], 2) for k in ('open', 'high', 'low', 'close')]
                    if stored.get(d) != want:
                        fail(f'(e) nifty-daily {d}: {stored.get(d)} vs the saved Yahoo bar {want}')
                elif d in stored:                      # overlap: the index-built close must be the official one
                    n_ov += 1; gaps.append(abs(stored[d][3] - q['close'][i]))
                    if gaps[-1] > 0.05:
                        fail(f'(e) nifty-daily {d}: close {stored[d][3]} vs Yahoo\'s official close {q["close"][i]:.2f}')
            print(f'     nifty-daily: {n} Yahoo days after {idx_end} equal the saved Yahoo file; {n_ov} overlap days, '
                  f'largest close gap to Yahoo {max(gaps, default=0):.4f}')
    else:
        print('SKIP (e) raw rebuild of candles: the source archive is not on this machine')

    pl = got['paper-legs.json']
    sane(pl['ce'], 'paper-legs ce'); sane(pl['pe'], 'paper-legs pe')
    held = [m for m in got['paper-monthly.json']['months'] if m['status'] in ('open', 'closed')]
    if held and pl['month'] != held[-1]['month']:
        fail(f"(e) paper-legs is {pl['month']}, the newest held paper month is {held[-1]['month']}")
    if held and (DATA / 'bhav' / f"{held[-1]['entry']}.json.gz").exists():
        m = held[-1]; want = {'ce': [], 'pe': []}
        for f in sorted((DATA / 'bhav').glob('*.json.gz')):
            d = f.name[:10]
            if d < m['entry'] or d > m['last']['date']:
                continue
            for r in json.load(gzip.open(f, 'rt', encoding='utf-8'))['rows']:
                if r[0] == m['expiry'] and r[9] > 0 and r[4] > 0 and \
                        ((r[2] == 'CE' and r[1] == m['ceK']) or (r[2] == 'PE' and r[1] == m['peK'])):
                    want[r[2].lower()].append([d, r[3], r[4], r[5], r[6]])
        if pl['ce'] != want['ce'] or pl['pe'] != want['pe']:
            fail(f"(e) paper-legs {m['month']}: differs from data/bhav")
        else:
            print(f"     paper-legs {m['month']}: {len(pl['ce'])} CE + {len(pl['pe'])} PE days equal data/bhav")
    if len(FAILS) == n0:
        ok('(e) candles')


# ------------------------------------------------------------------------------------------------ (c) privacy
# Built with join() at run time so that neither this file nor a compiled copy of it contains the literals.
TOKENS = [''.join(p).lower() for p in (('Man', 'oj'), ('DHA', 'N_'), ('11035', '75055'), ('access', '-token'))]
ALLOWED_EMAIL = ''.join(('41898282+github-actions[bot]', '@', 'users.noreply.github.com'))
EMAIL = re.compile(r'[A-Za-z0-9._%+\-\[\]]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}')
FILE_EXT = re.compile(r'\.(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|css|json|html?|woff2?|ttf|otf|map|md|txt)$', re.I)


def check_privacy():
    n0 = len(FAILS); files = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != '.git']
        for fn in filenames:
            p = Path(dirpath) / fn
            rel = p.relative_to(ROOT).as_posix()
            raw = p.read_bytes(); files += 1
            if fn.endswith('.gz'):
                try:
                    raw = gzip.decompress(raw)
                except OSError:
                    pass
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = None
            low = (text if text is not None else raw.decode('latin-1')).lower()
            for t in TOKENS:
                if t in low:
                    fail(f'(c) {rel}: contains a forbidden word ({t[:2]}...)')
            if text is None:
                continue                      # binary (fonts, images): an e-mail regex over random bytes only misfires
            for m in EMAIL.finditer(text):
                e = m.group(0)
                if e == ALLOWED_EMAIL or FILE_EXT.search(e):     # e.g. icon@2x.png is a file name, not an address
                    continue
                fail(f'(c) {rel}: contains an e-mail address ({e[:3]}...)')
    if len(FAILS) == n0:
        ok(f'(c) privacy grep: {files} files, 0 matches')


def main():
    got = check_shapes()
    if all(k in got for k in KEYS):
        try:
            check_kpis(got)
        except Exception as e:
            fail(f'(a) crashed: {type(e).__name__}: {e}')
        try:
            check_regression(got)
        except Exception as e:
            fail(f'(b) crashed: {type(e).__name__}: {e}')
        try:
            check_candles(got)
        except Exception as e:
            fail(f'(e) crashed: {type(e).__name__}: {e}')
    check_privacy()
    print(f"{'FAILED: ' + str(len(FAILS)) + ' problem(s)' if FAILS else 'ALL CHECKS PASSED'}")
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())

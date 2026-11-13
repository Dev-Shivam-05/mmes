"""Local only: turn the source project's backtest outputs into the dashboard's data/*.json (docs/spec/dashboard-v1.md,
"Data contract"). Run on the owner's laptop:

    python -I scripts/export.py

Reads (absolute paths, read-only): replay-v3.csv, leg-sl-days.csv, monthly-rows.json, the 1-minute NIFTY index file,
the option archive's expiry-day files and a saved Yahoo ^NSEI daily file. Writes data/meta.json, strategies.json,
trades-weekly.json, trades-monthly.json, paper-weekly.json, days/<date>.json (143), nifty-daily.json, and the first
calendar.json, paper-monthly.json and paper-legs.json through the same code update.py runs every day.
"""
import csv
import gzip
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# `python -I` drops the script's own folder from sys.path (isolated mode), so add it explicitly to import the shared code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import monthly_core as mc  # noqa: E402
import update  # noqa: E402

SRC = Path(r'D:\Temp\Dhan\Shivam-testing\nifty-strangle\out\paper')
SRC_BHAV = Path(r'D:\Temp\Dhan\.cache\mmes-monthly')                   # compact NSE F&O bhavcopies, 2024-01 .. 2026-11
SRC_HOL = SRC_BHAV / 'holidays.json'
SRC_IDX = Path(r'D:\Temp\Dhan\.cache\history\idx\NIFTY.json')          # NIFTY 50 index, 1-minute o/h/l/c, ms epoch
SRC_CHAINS = Path(r'D:\Temp\Dhan\.cache\history\chains\NIFTY')         # <date>-W1.json.gz: the expiring weekly's legs
SRC_YAHOO = Path(r'D:\Temp\Dhan\.cache\yahoo\nsei-1d.json')            # Yahoo chart API, ^NSEI daily bars
DATA = update.DATA
LOT = mc.LOT
WEEKLY_YEARS = 2 + 268 / 365          # 1 Jan 2024 -> 25 Sep 2026, the source's YEARS (leg-sl.ts, capital-mmes.ts); 2.734 rounded
MONTHLY_YEARS = 34 / 12
MERGED_YEARS = 33 / 12
MARGIN = mc.M_EXP                      # 2,63,793: 1,98,016 + the 65,777 expiry ELM
MERGED_MARGIN = 2 * mc.M_EXP           # both strategies open on a monthly expiry day
COMMON = ('2024-01', '2026-09')        # the months the weekly archive and the monthly backtest both cover
SLIP_50 = 4 * 0.5 * LOT                # 0.5 pt per leg per side, 2 legs, in and out
LEG_MODES = {'v3': 'v3 (2x credit)', 'leg20': 'LEG-20', 'leg40': 'LEG-40'}
DATA_API_MONTHLY, GST_PCT = 499, 18


def ceil10k(x):
    return int(math.ceil(x / 10_000) * 10_000)


def f2(x):
    return round(float(x), 2)


def load_weekly():
    with open(SRC / 'replay-v3.csv', encoding='utf-8') as fh:
        v3 = {r['date']: r for r in csv.DictReader(fh)}
    legs = defaultdict(dict)
    with open(SRC / 'leg-sl-days.csv', encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            legs[r['mode']][r['date']] = r
    out = {}
    for sid, mode in LEG_MODES.items():
        rows = legs[mode]
        if sorted(rows) != sorted(v3):
            raise SystemExit(f'{mode}: dates differ from replay-v3.csv')
        res = []
        for d in sorted(v3):
            e, l = v3[d], rows[d]
            pts = float(l['pts'])
            row = dict(date=d, spot=float(e['spot']), W=f2(e['W']), ceK=int(float(e['ceK'])), peK=int(float(e['peK'])),
                       ceIn=float(e['ceIn']), peIn=float(e['peIn']), credit=f2(e['credit']))
            if sid == 'v3':
                worst = min(float(e['worst']), float(e['pts']) * LOT)          # the exit counts too
                # the leg-sl v3 row must be the same trade as the paper runner's replay
                if (abs(float(e['net']) - float(l['net'])) > 0.011 or abs(float(e['netSlip25']) - float(l['slip'])) > 0.011
                        or abs(worst - float(l['worst'])) > 0.011 or l['ceExit'] != e['exitAt'] or l['peExit'] != e['exitAt']):
                    raise SystemExit(f'{d}: leg-sl v3 row differs from replay-v3.csv')
                row.update(why=e['why'], exitAt=e['exitAt'], ceExit=l['ceExit'], peExit=l['peExit'], ceOut=float(e['ceOut']),
                           peOut=float(e['peOut']), pts=f2(e['pts']), net=float(e['net']), slip=float(e['netSlip25']),
                           worst=f2(worst), est=int(float(e['est'])))
            else:
                # leg rows carry no 'why': a leg bought back before 15:15 is a leg stop (monthly-strangle.py's term)
                why = 'LEG STOP' if (l['ceExit'] != '15:15' or l['peExit'] != '15:15') else 'SQ1515'
                ce_out, ce_est = exit_price(d, f"{row['ceK']}CE", l['ceExit'], row['ceIn'])
                pe_out, pe_est = exit_price(d, f"{row['peK']}PE", l['peExit'], row['peIn'])
                row.update(why=why, exitAt=None, ceExit=l['ceExit'], peExit=l['peExit'], ceOut=ce_out, peOut=pe_out,
                           pts=f2(pts), net=float(l['net']), slip=float(l['slip']), worst=float(l['worst']),
                           est=ce_est + pe_est)
            res.append(row)
        out[sid] = res
    return out


_CHAIN = {}


def exit_price(d, key, hm, sale):
    """A leg's exit price as leg-sl.ts takes it: the 1-minute OPEN at its exit minute. With no print there, the last
    close from the 09:26 entry minute up to the minute before (the sale price if there is none), and est = 1."""
    if d not in _CHAIN:
        with gzip.open(SRC_CHAINS / f'{d}-W1.json.gz', 'rt', encoding='utf-8') as fh:
            ch = json.load(fh)
        _CHAIN[d] = ([ist(t).strftime('%H:%M') for t in ch['t']], ch['legs'])
    hms, legs = _CHAIN[d]
    L, x, e = legs[key], hms.index(hm), hms.index('09:26')
    if L['o'][x] is not None:
        return round(L['o'][x], 2), 0
    last = sale
    for j in range(e, x):
        if L['c'][j] is not None:
            last = L['c'][j]
    return round(last, 2), 1


def drawdown(values):
    eq = pk = dd = 0.0
    for v in values:
        eq += v; pk = max(pk, eq); dd = min(dd, eq - pk)
    return dd


def path_capital(rows, slip_key, worst_key, margin):
    need = cum = 0.0
    for r in rows:
        need = max(need, margin - cum - min(0.0, r[worst_key])); cum += r[slip_key]
    return ceil10k(need)


def kpi(n, wins, net, net50, years, worst, unit, dd, cap_min, margin):
    return dict(trades=n, winPct=round(100 * wins / n, 1), net=f2(net), net50=f2(net50), perYear=f2(net / years),
                worst=f2(worst), worstUnit=unit, maxDD=f2(dd), capitalMin=cap_min,
                capitalSafe=ceil10k(1.1 * margin + 3 * abs(dd) + 10_000), marginPeak=margin)


WEEKLY_RULES = [
    'Expiry day only: the nearest NIFTY weekly expiry (Tuesday, or the trading day before a holiday).',
    'At 09:25: spot = NIFTY 50 index 1-minute close; ATM = nearest 50 strike; W = ATM CE + ATM PE close.',
    'Sell 1 set (65 CE + 65 PE) at the 09:26 open: CE strike nearest spot + 0.5 W, PE strike nearest spot - 0.5 W.',
]
NOTE_SLIP = 'Slippage of 0.25 pt per leg per side is a guess: bid/ask was never measured.'
NOTE_DATA = 'Backtest on the 1-minute option archive, 1 Jan 2024 to 25 Sep 2026. Not traded live.'


def strategies(wk, mon):
    out = []
    names = {
        'v3': ('Weekly v3', 'Expiry-day strangle. Both legs out at 2x credit.',
               WEEKLY_RULES + ['Stop: on a 1-minute close, if CE + PE >= 2 x credit, buy both back at the next minute\'s open.',
                               'Otherwise buy both back at the 15:15 open. No target, no hedge.'],
               [NOTE_DATA, NOTE_SLIP, 'v3 was picked on 2024-2025 only; 2026 (38 expiry days) was held out.']),
        'leg20': ('Weekly LEG-20', 'v3 entry. Each leg has its own 20-point stop.',
                  WEEKLY_RULES + ['Stop: a leg whose 1-minute close is 20 points above its own sale price is bought back at the next minute\'s open; the other leg stays.',
                                  'Legs not stopped are bought back at the 15:15 open.'],
                  [NOTE_DATA, NOTE_SLIP, '2 days had a missing exit print; the last close was used.']),
        'leg40': ('Weekly LEG-40', 'v3 entry. Each leg has its own 40-point stop.',
                  WEEKLY_RULES + ['Stop: a leg whose 1-minute close is 40 points above its own sale price is bought back at the next minute\'s open; the other leg stays.',
                                  'Legs not stopped are bought back at the 15:15 open.'],
                  [NOTE_DATA, NOTE_SLIP, '2 days had a missing exit print; the last close was used.']),
    }
    for sid in ('v3', 'leg20', 'leg40'):
        rs = wk[sid]
        name, tag, rules, notes = names[sid]
        n = len(rs); net = sum(r['slip'] for r in rs)
        k = kpi(n, sum(r['net'] > 0 for r in rs), net, sum(r['net'] - SLIP_50 for r in rs), WEEKLY_YEARS,
                min(r['slip'] for r in rs), 'day', drawdown(r['slip'] for r in rs),
                path_capital(rs, 'slip', 'worst', MARGIN), MARGIN)
        eq, cum, months = [], 0.0, defaultdict(float)
        for r in rs:
            cum += r['slip']; eq.append([r['date'], f2(cum)]); months[r['date'][:7]] += r['slip']
        out.append(dict(id=sid, name=name, tagline=tag, kind='weekly', rules=rules, kpi=k, notes=notes, equity=eq,
                        months={m: f2(v) for m, v in sorted(months.items())}))

    # monthly k 1, 2x credit stop (the 'spot' rows)
    n = len(mon); net = sum(r['s25'] for r in mon)
    k = kpi(n, sum(r['net'] > 0 for r in mon), net, sum(r['net'] - SLIP_50 for r in mon), MONTHLY_YEARS,
            min(r['s25'] for r in mon), 'month', drawdown(r['s25'] for r in mon),
            path_capital(mon, 's25', 'worst', MARGIN), MARGIN)
    eq, cum = [], 0.0
    for r in mon:
        cum += r['s25']; eq.append([max(r['ce_at'], r['pe_at']), f2(cum)])
    out.append(dict(id='monthly', name='Monthly k 1', tagline='Month-long strangle at spot +/- 1 straddle. Both out at 2x credit.',
                    kind='monthly',
                    rules=['Contract: the month\'s last NIFTY expiry. 1 set = 65 CE + 65 PE.',
                           'Entry at the close of the month\'s first trading day. ATM = nearest 50 to the index close; W = ATM CE + ATM PE close.',
                           'Sell the CE nearest spot + W and the PE nearest spot - W.',
                           'Stop: if CE + PE close at or above 2 x credit on a day before the expiry, buy both back at the next day\'s open.',
                           'Otherwise hold both to the expiry day\'s close.'],
                    kpi=k,
                    notes=['Strikes centred on the option-implied forward instead of the index close: \u20b91,20,354. Treat the result as fragile.',
                           'Daily bars: intraday risk is not visible.',
                           'Backtest on NSE\'s daily F&O bhavcopy, Jan 2024 to Oct 2026 (34 months).', NOTE_SLIP],
                    equity=eq, months={r['month']: f2(r['s25']) for r in mon}))

    # merged: v3 weekly + monthly in one account, monthly steps over the common months
    common = update.months_from(*COMMON)
    wmon, wlast = defaultdict(float), {}
    for r in wk['v3']:
        wmon[r['date'][:7]] += r['slip']; wlast[r['date'][:7]] = r['date']
    mm = {r['month']: r for r in mon if COMMON[0] <= r['month'] <= COMMON[1]}
    if sorted(mm) != common or any(m not in wmon for m in common):
        raise SystemExit('merged: a common month is missing on one side')
    series = [wmon[m] + mm[m]['s25'] for m in common]
    trades = [r for r in wk['v3']] + [mm[m] for m in common]
    net = sum(series)
    net50 = sum(r['net'] - SLIP_50 for r in wk['v3']) + sum(mm[m]['net'] - SLIP_50 for m in common)
    k = kpi(len(trades), sum(r['net'] > 0 for r in trades), net, net50, MERGED_YEARS, min(series), 'month',
            drawdown(series), ceil10k(MERGED_MARGIN), MERGED_MARGIN)
    eq, cum = [], 0.0
    for m, v in zip(common, series):
        cum += v; eq.append([max(wlast[m], mm[m]['ce_at'], mm[m]['pe_at']), f2(cum)])
    out.append(dict(id='merged', name='v3 + Monthly', tagline='Weekly v3 and Monthly k 1 in one account.', kind='merged',
                    rules=['Runs Weekly v3 and Monthly k 1 at the same time, 1 set each.',
                           'On a monthly expiry day both are open, so the account needs both margins: 2 x \u20b92,63,793 = \u20b95,27,586.'],
                    kpi=k,
                    notes=['Covers the 33 months both backtests have: Jan 2024 to Sep 2026.',
                           'Drawdown is measured on month-end steps.', 'Trades and win % count every weekly and monthly trade in those months.'],
                    equity=eq, months={m: f2(v) for m, v in zip(common, series)}))
    return out


def ist(ms):
    return datetime.fromtimestamp(ms / 1000, mc.IST)


def five_min(minutes):
    """[(hh:mm, o, h, l, c)] 1-minute bars of one day -> 5-minute buckets 09:15 .. 15:25 (minutes 09:15-15:29).
    A minute with any null price is skipped; a bucket with no minute is left out."""
    out = {}
    for hm, o, h, l, c in minutes:
        if not ('09:15' <= hm <= '15:29') or None in (o, h, l, c):
            continue
        mm = int(hm[3:5])
        key = f'{hm[:3]}{mm - mm % 5:02d}'                 # 09:15 sits on a 5-minute boundary, so plain flooring works
        b = out.get(key)
        if b is None:
            out[key] = [key, o, h, l, c]
        else:
            b[2] = max(b[2], h); b[3] = min(b[3], l); b[4] = c
    return [[k, round(o, 2), round(h, 2), round(l, 2), round(c, 2)] for k, o, h, l, c in (out[k] for k in sorted(out))]


def write_compact(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(obj, fh, separators=(',', ':'), ensure_ascii=False)


def index_minutes():
    """{date: [(hh:mm, o, h, l, c)]} from the 1-minute index file, in time order."""
    with open(SRC_IDX, encoding='utf-8') as fh:
        idx = json.load(fh)
    by = defaultdict(list)
    for t, o, h, l, c in zip(idx['t'], idx['o'], idx['h'], idx['l'], idx['c']):
        dt = ist(t)
        by[dt.date().isoformat()].append((dt.strftime('%H:%M'), o, h, l, c))
    for v in by.values():
        v.sort()
    return by


def build_days(wk, idx_by):
    """data/days/<date>.json for every weekly trade date: NIFTY, the sold CE and the sold PE in 5-minute candles."""
    folder = DATA / 'days'
    os.makedirs(folder, exist_ok=True)
    rows = {sid: {r['date']: r for r in wk[sid]} for sid in wk}
    written = set()
    for d, r in rows['v3'].items():
        with gzip.open(SRC_CHAINS / f'{d}-W1.json.gz', 'rt', encoding='utf-8') as fh:
            ch = json.load(fh)
        hms = [ist(t).strftime('%H:%M') for t in ch['t']]
        legs = {}
        for side, k in (('ce', f"{r['ceK']}CE"), ('pe', f"{r['peK']}PE")):
            L = ch['legs'][k]
            legs[side] = five_min(zip(hms, L['o'], L['h'], L['l'], L['c']))
            # the archive must hold the trade itself: the 09:26 open is the sale price
            i = hms.index('09:26')
            if abs(L['o'][i] - (r['ceIn'] if side == 'ce' else r['peIn'])) > 0.001:
                raise SystemExit(f'{d}: {k} 09:26 open {L["o"][i]} is not the sale price')
        spot = dict((m[0], m[4]) for m in idx_by[d]).get('09:25')
        if spot is None or abs(spot - r['spot']) > 0.001:
            raise SystemExit(f'{d}: index 09:25 close {spot} is not the trade\'s spot {r["spot"]}')
        exits = {'v3': {'ce': r['exitAt'], 'pe': r['exitAt']}}
        for sid in ('leg20', 'leg40'):
            exits[sid] = {'ce': rows[sid][d]['ceExit'], 'pe': rows[sid][d]['peExit']}
        write_compact(folder / f'{d}.json', {'date': d, 'step': 5, 'nifty': five_min(idx_by[d]), 'ce': legs['ce'],
                                             'pe': legs['pe'], 'ceK': r['ceK'], 'peK': r['peK'], 'entry': '09:26',
                                             'exits': exits})
        written.add(f'{d}.json')
    for f in os.listdir(folder):                    # one file per trade date, nothing else
        if f not in written:
            os.remove(folder / f)
    size = sum(os.path.getsize(folder / f) for f in written)
    print(f'days: {len(written)} files, {size:,} bytes ({size / len(written):,.0f} per day)')


def official_closes():
    """{date: NIFTY's official close} from every UDiFF bhavcopy (8 Jul 2024 on: its UndrlygPric, the `under` field),
    in the source cache and in data/bhav. Old-format files carry no underlying price."""
    out = {}
    for folder in (SRC_BHAV, update.BHAV):
        for d, j in mc.load_days(str(folder)).items():
            if j.get('format') == 'udiff' and j.get('under'):
                out[d] = round(j['under'], 2)
    return out


def build_daily(idx_by):
    """data/nifty-daily.json: daily candles from the index minutes, then Yahoo ^NSEI daily bars for later dates.
    Where a UDiFF bhavcopy exists the close is NSE's official close, and the high/low widen to hold it: the official
    close is computed over the last 30 minutes and can sit outside the minutes' range (3 Aug 2026)."""
    official = official_closes()
    candles, n_off = [], 0
    for d in sorted(idx_by):
        ms = [m for m in idx_by[d] if '09:15' <= m[0] <= '15:29'] or idx_by[d]   # an evening Muhurat session has no 09:15-15:29 minute
        o, h, l, c = round(ms[0][1], 2), round(max(m[2] for m in ms), 2), round(min(m[3] for m in ms), 2), round(ms[-1][4], 2)
        if d in official:
            c = official[d]; h = max(h, c); l = min(l, c); n_off += 1
        candles.append([d, o, h, l, c])
    idx_end = candles[-1][0]
    first_off = min((d for d in official if d <= idx_end), default=None)
    with open(SRC_YAHOO, encoding='utf-8') as fh:
        y = update.yahoo_bars(json.load(fh))
    later = [b for b in y if b[0] > idx_end]
    candles += later
    prev = update.read_json(DATA / 'nifty-daily.json', {})
    candles += [c for c in prev.get('candles', []) if c[0] > candles[-1][0]]    # days update.py appended since
    source = (f'NIFTY 50 index. {candles[0][0]} to {idx_end}: open, high and low from the 1-minute index bars of the '
              f'option archive (09:15-15:29). Close: NSE\'s official close from the F&O bhavcopy from {first_off} '
              f'(high and low widened to include it); before that, the 15:29 minute\'s close, which is not the official '
              f'close. From {later[0][0] if later else "the next session"}: Yahoo Finance ^NSEI daily bars.')
    update.write_json(DATA / 'nifty-daily.json', {'source': source, 'candles': candles}, compact=True)
    print(f'nifty-daily: official close on {n_off} index days (from {first_off}); '
          f'{len(candles)} candles, {candles[0][0]} .. {candles[-1][0]}; index to {idx_end}, '
          f'Yahoo {later[0][0] if later else "-"} .. {later[-1][0] if later else "-"} ({len(later)} from the saved file)')


def main():
    os.makedirs(DATA, exist_ok=True)
    wk = load_weekly()
    with open(SRC / 'monthly-rows.json', encoding='utf-8') as fh:
        mrows = json.load(fh)
    strat = strategies(wk, mrows['spot'])
    update.write_json(DATA / 'trades-weekly.json', wk)
    update.write_json(DATA / 'trades-monthly.json', mrows)                  # unchanged, as the contract says
    update.write_json(DATA / 'strategies.json', {'strategies': strat})
    idx_by = index_minutes()
    build_days(wk, idx_by)
    build_daily(idx_by)
    if not (DATA / 'paper-weekly.json').exists():
        update.write_json(DATA / 'paper-weekly.json', {'trades': [], 'note': (
            "No weekly paper trade yet. The first possible day is Tue 17 Nov 2026. It runs on GitHub on each expiry day "
            "from NSE's free option chain (scripts/paper_nse.py); the owner's PC is the backup.")})
    if not update.HOL_FILE.exists() and SRC_HOL.exists():                   # seed the holidays the paper record can meet
        with open(SRC_HOL, encoding='utf-8') as fh:
            src_hol = json.load(fh)
        update.write_json(update.HOL_FILE, {d: v for d, v in sorted(src_hol.items()) if d >= update.PAPER_FROM})
    ranges = {'weeklyRange': [wk['v3'][0]['date'], wk['v3'][-1]['date']],
              'monthlyRange': [mrows['spot'][0]['month'], mrows['spot'][-1]['month']],
              # the Dhan Data API plan (Rs 499 a month, plus 18% GST) that the weekly strategy needs; contract, 13 Nov QA
              'costs': {'dataApiMonthly': DATA_API_MONTHLY, 'gstPct': GST_PCT,
                        'dataApiPerYear': round(DATA_API_MONTHLY * 12 * (1 + GST_PCT / 100), 2)}}
    update.rebuild(update.ist_today(), job_ran=False, failed=False, ranges=ranges)
    for s in strat:
        k = s['kpi']
        print(f"{s['id']:<8} trades {k['trades']:>3}  win {k['winPct']:>5}%  net {k['net']:>11,.2f}  net50 {k['net50']:>11,.2f}  "
              f"perYear {k['perYear']:>10,.2f}  worst {k['worst']:>10,.2f}/{k['worstUnit']}  maxDD {k['maxDD']:>10,.2f}  "
              f"capMin {k['capitalMin']:>8,}  capSafe {k['capitalSafe']:>8,}  margin {k['marginPeak']:,}")
    print('wrote data/meta.json strategies.json trades-weekly.json trades-monthly.json paper-weekly.json calendar.json paper-monthly.json')


if __name__ == '__main__':
    main()

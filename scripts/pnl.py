"""Daily paper P&L (docs/spec/pnl-v1.md rows 2-4 and 7, "Data contract additions"): builds data/pnl-daily.json from

  data/paper-monthly.json   the forward monthly paper record (entry, sold strikes, exit, net)
  data/bhav/*.json.gz       the daily closes of its two legs between entry and exit
  data/paper-weekly.json    the weekly paper rows (v3, LEG-20) written by paper_nse.py on expiry days, + their minute MTM
  data/nifty-daily.json     the NIFTY close of each day
  data/strategies.json      the backtest's average per trade (shown beside the paper numbers)

    python -I scripts/pnl.py            # rebuild data/pnl-daily.json (update.py and paper_nse.py call build() too)

Definitions (spec row 4). Money is rupees for 1 set (65 CE + 65 PE).
  day P&L      change in open MTM, close to close, + realised on the exit day
  entry day    - slippage of the 2 sell fills (the position is marked at the entry close, which is its sale price: MTM 0)
  hold day     (previous CE+PE close - today's CE+PE close) x 65
  stop day     the same close-to-close change; event "stop" (the close that reached 2 x credit)
  exit day     (previous CE+PE close - exit value) x 65 - every charge of the trade - slippage of the 2 buy fills
  weekly day   the paper row's net after charges and slippage (entry and exit fall on the same day)
So a closed trade's day rows add up to its net exactly. Charges are booked on the exit day, 0.25 pt slippage per fill on
the day of the fill.

Trade fields: realized = gross points x 65 of a closed trade (before charges and slippage), charges = charges() of the
two round trips, slippage = the slippage booked so far (2 fills while open, 4 once closed), net = realized - charges -
slippage, mtm = (credit - CE+PE close) x 65 for an open trade (gross, like a broker's unrealised P&L). Hence
summary.net = summary.realized - summary.charges - summary.slippage + summary.openMtm, which check.py verifies.

Frozen days: update.py prunes the bhavcopy files of finished months, so a closed monthly trade whose entry file is gone
is copied from the previous pnl-daily.json (the same rule update.py uses for paper-monthly.json). Never delete
data/pnl-daily.json by hand once a month has been pruned.
"""
import sys
from pathlib import Path

# `python -I` drops the script's own folder from sys.path (isolated mode), so add it explicitly to import the shared core.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import monthly_core as mc  # noqa: E402
import update  # noqa: E402

DATA = update.DATA
OUT = DATA / 'pnl-daily.json'
START = '2026-11-02'                  # the first paper trade (spec row 2)
LOT = mc.LOT
SLIP_FILL = mc.SLIP * LOT             # 0.25 pt x 65 = Rs 16.25 per fill
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
SRC_MONTHLY, SRC_WEEKLY = 'NSE bhavcopy close', 'NSE snapshot'


def r2(x):
    return None if x is None else round(x + 0.0, 2) + 0.0      # + 0.0 turns -0.0 into 0.0


def rupees(x):
    """Rs with Indian grouping and a sign, e.g. -21,882.17 -> '-Rs 21,882.17' (events are plain text)."""
    s = f'{abs(x):.2f}'
    whole, frac = s.split('.')
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:]); head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ','.join(parts + [tail])
    return f"{'-' if x < 0 else '+'}₹{whole}.{frac}"


def contract(expiry, strike, side):
    """'NIFTY 23 Nov 2026 24050 CE' (the broker-statement name of a NIFTY option)."""
    y, m, d = int(expiry[:4]), int(expiry[5:7]), int(expiry[8:10])
    return f'NIFTY {d} {MON[m - 1]} {y} {int(strike)} {side}'


def read_json(path, default):
    return update.read_json(path, default)


# ------------------------------------------------------------------------------------------------ monthly
def monthly_trade(m, days):
    """(trade dict, {date: monthly cell}, {date: [event strings]}) for one held paper month, from data/bhav.

    The legs' daily closes come from the bhavcopy (close column), with the same carry rule as monthly_core.evaluate: a
    day without a quote for a leg keeps that leg's previous close."""
    E, M = m['entry'], m['expiry']
    ce_in, pe_in, credit = m['ceIn'], m['peIn'], m['ceIn'] + m['peIn']
    closed = m['status'] == 'closed'
    exit_date = m['exit']['date'] if closed else None
    last_date = m['last']['date']
    span = [d for d in sorted(days) if E <= d <= last_date]
    if not span or span[0] != E:
        raise RuntimeError(f"{m['month']}: entry file {E} is not in data/bhav")
    cells, notes = {}, {}
    trig = (m.get('trigger') or {}).get('date')
    last = {'CE': ce_in, 'PE': pe_in}
    prev_val = credit
    ce_name, pe_name = contract(M, m['ceK'], 'CE'), contract(M, m['peK'], 'PE')
    for d in span:
        if d == E:
            cells[d] = {'event': 'entry', 'pnl': r2(-2 * SLIP_FILL), 'value': r2(credit)}
            notes[d] = [f"Monthly: sold {ce_name} @ {ce_in:.2f} + {pe_name} @ {pe_in:.2f}, credit {credit:.2f}, "
                        f"stop at CE + PE {2 * credit:.2f}"]
            continue
        if d == exit_date:
            break
        b = mc.book(days[d], M)
        for s, k in (('CE', m['ceK']), ('PE', m['peK'])):
            q = b.get((k, s))
            if q:
                last[s] = q[3]
        val = last['CE'] + last['PE']
        ev = 'stop' if d == trig else 'hold'
        cells[d] = {'event': ev, 'pnl': r2((prev_val - val) * LOT), 'value': r2(val)}
        if ev == 'stop':
            if abs(val - m['trigger']['value']) > 0.005:
                raise RuntimeError(f"{m['month']}: the stop close {val:.2f} on {d} is not the recorded trigger {m['trigger']}")
            notes[d] = [f"Monthly: stop hit, CE + PE closed at {val:.2f} (stop {2 * credit:.2f}); both are bought back at "
                        f"the next open"]
        prev_val = val
    legs = [{'contract': ce_name, 'qty': LOT, 'sell': ce_in, 'buy': None, 'pnl': None, 'charges': None},
            {'contract': pe_name, 'qty': LOT, 'sell': pe_in, 'buy': None, 'pnl': None, 'charges': None}]
    trade = {'id': f"monthly-{m['month']}", 'strategy': 'monthly', 'entry': E, 'exit': exit_date,
             'status': 'closed' if closed else 'open', 'source': SRC_MONTHLY, 'legs': legs,
             'realized': None, 'charges': None, 'slippage': r2(2 * SLIP_FILL), 'net': None, 'mtm': None}
    if closed:
        ce_out, pe_out = m['exit']['ce'], m['exit']['pe']
        c_ce = mc.charges(E, ce_out * LOT, ce_in * LOT)      # the source dates charges by the entry day
        c_pe = mc.charges(E, pe_out * LOT, pe_in * LOT)
        legs[0].update(buy=ce_out, pnl=r2((ce_in - ce_out) * LOT), charges=r2(c_ce))
        legs[1].update(buy=pe_out, pnl=r2((pe_in - pe_out) * LOT), charges=r2(c_pe))
        gross = (credit - ce_out - pe_out) * LOT
        net = gross - c_ce - c_pe - 4 * SLIP_FILL
        if abs(net - m['net']) > 0.01:
            raise RuntimeError(f"{m['month']}: net {net:.2f} from the exit prices is not the recorded {m['net']}")
        # the exit day closes the books: the residual against the recorded net, so the rows add up to it exactly
        before = sum(c['pnl'] for c in cells.values())
        formula = (prev_val - (ce_out + pe_out)) * LOT - c_ce - c_pe - 2 * SLIP_FILL
        pnl = r2(m['net'] - before)
        if abs(pnl - formula) > 0.02:
            raise RuntimeError(f"{m['month']}: exit-day P&L {formula:.2f} vs the residual {pnl:.2f}")
        cells[exit_date] = {'event': 'exit', 'pnl': pnl, 'value': None}
        how = 'at the open' if m['exit']['why'] == 'STOP' else 'at the expiry close'
        notes[exit_date] = [f"Monthly: bought back {how}: CE @ {ce_out:.2f} + PE @ {pe_out:.2f}; charges "
                            f"{c_ce + c_pe:.2f}; trade net {rupees(m['net'])}"]
        trade.update(realized=r2(gross), charges=r2(c_ce + c_pe), slippage=r2(4 * SLIP_FILL), net=r2(m['net']))
    else:
        trade['mtm'] = r2((credit - prev_val) * LOT)
    return trade, cells, notes


def frozen_monthly(m, prev):
    """A closed month whose bhavcopy files are pruned: its trade and day cells as the previous pnl-daily.json had them."""
    tid = f"monthly-{m['month']}"
    t = next((x for x in prev.get('trades', []) if x.get('id') == tid), None)
    if not t:
        raise RuntimeError(f"{m['month']}: its bhavcopy files are pruned and the previous pnl-daily.json has no {tid}")
    cells, notes = {}, {}
    for d in prev.get('days', []):
        if t['entry'] <= d['date'] <= (t['exit'] or d['date']) and d['monthly']['event'] != 'none':
            cells[d['date']] = d['monthly']
            notes[d['date']] = [e for e in d.get('events', []) if e.startswith('Monthly:')]
    return t, cells, notes


# ------------------------------------------------------------------------------------------------ weekly
def weekly_event(row):
    why = (row.get('why') or '').upper()
    if row.get('slip') is None:
        return 'skip'
    return 'stop' if 'STOP' in why else 'exit'


def weekly_trade(row):
    d, sid = row['date'], row['strategy']
    if row.get('slip') is None:                    # a skipped expiry day: no position, the row says why
        return None
    lot = row.get('lot') or LOT
    legs = []
    for s, k, i, o in (('CE', row['ceK'], row['ceIn'], row['ceOut']), ('PE', row['peK'], row['peIn'], row['peOut'])):
        legs.append({'contract': contract(row.get('expiry') or d, k, s), 'qty': lot, 'sell': i, 'buy': o,
                     'pnl': r2((i - o) * lot), 'charges': r2(mc.charges(d, o * lot, i * lot))})
    return {'id': f'{sid}-{d}', 'strategy': sid, 'entry': d, 'exit': d, 'status': 'closed', 'source': SRC_WEEKLY,
            'legs': legs, 'realized': r2(row['pts'] * lot), 'charges': r2(row['charges']),
            'slippage': r2(4 * mc.SLIP * lot), 'net': r2(row['slip']), 'mtm': None}


def weekly_note(row):
    name = {'v3': 'Weekly v3', 'leg20': 'Weekly LEG-20'}[row['strategy']]
    if row.get('slip') is None:
        return f"{name}: no trade ({row.get('why') or 'skipped'})"
    ex = (f"both out at {row['ceExit']}" if row['ceExit'] == row['peExit']
          else f"CE out at {row['ceExit']}, PE out at {row['peExit']}")
    est = f", {row['est']} minute(s) carried forward" if row.get('est') else ''
    return (f"{name}: sold {int(row['ceK'])} CE @ {row['ceIn']:.2f} + {int(row['peK'])} PE @ {row['peIn']:.2f}, {ex} "
            f"({row['why']}), net {rupees(row['slip'])} (NSE snapshot{est})")


# ------------------------------------------------------------------------------------------------ build
def per_trade_backtest(strategies):
    by = {s['id']: s['kpi'] for s in strategies.get('strategies', [])}
    return {k: (r2(by[k]['net'] / by[k]['trades']) if k in by and by[k]['trades'] else None)
            for k in ('monthly', 'v3', 'leg20')}


def build(write=True, log=print, weekly_path=None, out_path=None, prev_path=None):
    """Rebuild pnl-daily from the data files. paper_nse.py --dry / --sim pass their own weekly file and output path
    (under .cache/), so a test never touches data/."""
    out_path = Path(out_path or OUT)
    paper = read_json(DATA / 'paper-monthly.json', {'months': []})
    weekly = read_json(weekly_path or DATA / 'paper-weekly.json', {'trades': []})
    nd = read_json(DATA / 'nifty-daily.json', {'candles': []})['candles']
    prev = read_json(prev_path or out_path, {})
    days = mc.load_days(str(DATA / 'bhav'))

    trades, mcell, notes, open_span = [], {}, {}, []
    for m in paper.get('months', []):
        if m['status'] not in ('open', 'closed'):
            continue
        if m['entry'] in days:
            t, cells, nts = monthly_trade(m, days)
        else:
            if m['status'] != 'closed':
                raise RuntimeError(f"{m['month']}: open but its entry file {m['entry']} is not in data/bhav")
            t, cells, nts = frozen_monthly(m, prev)
        for d, c in cells.items():
            if d in mcell:
                raise RuntimeError(f'{d}: two monthly trades on one day')
            mcell[d] = c
        for d, n in nts.items():
            notes.setdefault(d, []).extend(n)
        trades.append(t)
        if t['status'] == 'open':
            open_span.append((t['entry'], max(cells)))

    # NSE-snapshot rows of the two paper strategies from the start date on (other ledger shapes are not day P&L)
    wrows = [r for r in weekly.get('trades', []) if r.get('strategy') in ('v3', 'leg20') and (r.get('date') or '') >= START]
    wcell = {}
    for r in sorted(wrows, key=lambda r: (r['date'], r['strategy'])):
        wcell.setdefault(r['date'], {'v3': None, 'leg20': None})[r['strategy']] = {
            'pnl': r2(r['slip']) if r.get('slip') is not None else 0.0, 'event': weekly_event(r)}
        notes.setdefault(r['date'], []).append(weekly_note(r))
        t = weekly_trade(r)
        if t:
            trades.append(t)

    # the trading days: every bhavcopy date, every weekly paper date, and the frozen days of the previous file
    prev_days = {d['date']: d for d in prev.get('days', [])}
    dates = sorted({d for d in days if d >= START} | set(wcell) | {d for d in prev_days if d >= START})
    close = {c[0]: c[4] for c in nd}
    order = [c[0] for c in nd]
    pos = {d: i for i, d in enumerate(order)}

    out_days, cum = [], 0.0
    for d in dates:
        if d in close:
            i = pos[d]
            chg = r2(close[d] - close[order[i - 1]]) if i > 0 else None
            nifty = {'close': close[d], 'chg': chg}
        elif d in prev_days:
            nifty = prev_days[d]['nifty']
        else:
            nifty = {'close': None, 'chg': None}
        mc_ = mcell.get(d)
        ev = list(notes.get(d, []))
        if mc_ is None:
            # an open monthly trade on a day after its newest bhavcopy (a weekly paper day, before the evening's file)
            if any(e < d and d > last for e, last in open_span):
                mc_ = {'event': 'hold', 'pnl': 0.0, 'value': None}
                ev.append('Monthly: no bhavcopy for this day yet; its MTM change lands with the next daily job')
            else:
                mc_ = {'event': 'none', 'pnl': 0.0, 'value': None}
        wk = wcell.get(d, {'v3': None, 'leg20': None})
        total = r2(mc_['pnl'] + sum(x['pnl'] for x in wk.values() if x))
        cum = r2(cum + total)
        n_open = sum(1 for t in trades if t['strategy'] == 'monthly' and t['entry'] <= d
                     and (t['exit'] is None or d < t['exit']))
        if mc_['event'] == 'none' and not any(wk.values()):
            ev.append('No position')
        out_days.append({'date': d, 'nifty': nifty, 'monthly': mc_, 'weekly': wk, 'total': total, 'cum': cum,
                         'open': n_open, 'events': ev})

    closed = [t for t in trades if t['status'] == 'closed']
    opened = [t for t in trades if t['status'] == 'open']
    as_of = dates[-1] if dates else None
    tot = [x['total'] for x in out_days]
    best = max(out_days, key=lambda x: x['total']) if out_days else None
    worst = min(out_days, key=lambda x: x['total']) if out_days else None
    summary = {
        'net': r2(cum),
        'realized': r2(sum(t['realized'] for t in closed)),
        'charges': r2(sum(t['charges'] for t in closed)),
        'slippage': r2(sum(t['slippage'] for t in trades)),
        'openMtm': r2(sum(t['mtm'] for t in opened)),
        'thisMonth': r2(sum(x['total'] for x in out_days if as_of and x['date'][:7] == as_of[:7])),
        'bestDay': {'date': best['date'], 'pnl': best['total']} if best else None,
        'worstDay': {'date': worst['date'], 'pnl': worst['total']} if worst else None,
        'greenDays': sum(1 for v in tot if v > 0), 'redDays': sum(1 for v in tot if v < 0),
        'flatDays': sum(1 for v in tot if v == 0), 'days': len(tot),
        'backtestPerTrade': per_trade_backtest(read_json(DATA / 'strategies.json', {})),
    }
    gap = summary['net'] - (summary['realized'] - summary['charges'] - summary['slippage'] + summary['openMtm'])
    if abs(gap) > 0.05:
        raise RuntimeError(f'summary does not reconcile: net {summary["net"]} vs the parts (gap {gap:.2f})')
    intraday = {d: v for d, v in (weekly.get('intraday') or {}).items() if d in wcell}
    trades.sort(key=lambda t: (t['entry'], t['strategy']))
    res = {'start': START, 'asOf': as_of, 'summary': summary, 'days': out_days, 'trades': trades,
           'intraday': intraday}
    if write:
        update.write_json(out_path, res)
    # the virtual account (account-v1.md) is rebuilt from the same weekly rows, next to the P&L file, by every caller
    import account                                                # here, like update.py imports this module lazily
    account.build(weekly=weekly, as_of=as_of, out_path=out_path.parent / 'account.json', write=write, log=log)
    log(f"[pnl] {len(out_days)} days {dates[0] if dates else '-'} .. {as_of}, {len(trades)} trades "
        f"({len(opened)} open), net {summary['net']}, open MTM {summary['openMtm']}")
    return res


def main():
    res = build()
    for d in res['days']:
        print(f"  {d['date']}  monthly {d['monthly']['event']:<5} {d['monthly']['pnl']:>11.2f}  total {d['total']:>11.2f}  "
              f"cum {d['cum']:>11.2f}  open {d['open']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""The virtual MMES v3 account (docs/spec/account-v1.md rows 1-5 and 8): data/account.json from the weekly paper rows.

    python -I scripts/account.py         # rebuild data/account.json (pnl.build() calls build() too)

Rules, in the order a broker would apply them on an expiry day:
  1. The account opens with OPENING rupees on OPENED. Only v3 rows dated on or after OPENED count (row 2).
  2. A v3 row the rules skipped (no 09:25 price, ...) is a ledger line "No trade: ..." for 0.
  3. Margin (row 3): if the row carries a measured margin and the balance before the trade is below it, the trade is
     refused: "Skipped: insufficient funds (need X, have Y)" for 0. An unmeasured margin never refuses a trade.
  4. Otherwise the trade is booked at its bid/ask fills (row 4): the row's `ba` block, net of charges (row 5). A row
     without a `ba` block (none exist before S15) falls back to its LTP + 0.25 pt net and says "est".
The file is written after the close, so nothing is open: marginBlocked = openMtm = 0 (row 8).
check.py recomputes all of this with its own code (AC4, AC5).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # python -I leaves the script's folder off sys.path
import update  # noqa: E402

OPENING = 270000
OPENED = '2026-11-16'
STRATEGY = 'v3'
LOT = 65
OUT = update.DATA / 'account.json'
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def r2(x):
    return None if x is None else round(x + 0.0, 2) + 0.0


def inr(x):
    """2,74,100.00 -> '₹2,74,100.00' (Indian grouping, no sign)."""
    whole, frac = f'{abs(x):.2f}'.split('.')
    if len(whole) > 3:
        head, tail, parts = whole[:-3], whole[-3:], []
        while len(head) > 2:
            parts.insert(0, head[-2:]); head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ','.join(parts + [tail])
    return f"{'-' if x < 0 else ''}₹{whole}.{frac}"


def contract(expiry, strike, side):
    y, m, d = int(expiry[:4]), int(expiry[5:7]), int(expiry[8:10])
    return f'NIFTY {d} {MON[m - 1]} {y} {int(strike)} {side}'


def entry(row, bal):
    """(ledger line without the running balance, the measured margin or None) for one v3 row, given the balance
    before it."""
    d = row['date']
    m = row.get('margin') if isinstance(row.get('margin'), dict) else None
    measured = m if m and isinstance(m.get('total'), (int, float)) and m['total'] > 0 else None
    base = {'date': d, 'gross': None, 'charges': None, 'fill': None, 'legs': None, 'amount': 0.0}
    if row.get('slip') is None:
        why = (row.get('why') or 'skipped').removeprefix('SKIP: ')
        return {**base, 'kind': 'none', 'text': f'No trade: {why}'}, measured
    if measured and bal < measured['total']:
        return {**base, 'kind': 'skip',
                'text': f"Skipped: insufficient funds (need {inr(measured['total'])}, have {inr(bal)})"}, measured
    ba = row.get('ba') if isinstance(row.get('ba'), dict) and row['ba'].get('net') is not None else None
    stop = 'STOP' in (row.get('why') or '').upper()
    how = 'stop: CE + PE reached 2 × the credit' if stop else 'square-off'
    if ba:
        sells, buys, gross, chg, amount = (ba['ceIn'], ba['peIn']), (ba['ceOut'], ba['peOut']), ba['pts'] * LOT, \
            ba['charges'], ba['net']
        fill = 'est' if ba.get('est') else 'bid/ask'
        when = f"at {ba['inAt']}, bought back at {ba['outAt']}"
    else:                                         # a row from before S15: its LTP fill + 0.25 pt slippage
        sells, buys, gross, chg, amount = (row['ceIn'], row['peIn']), (row['ceOut'], row['peOut']), row['pts'] * LOT, \
            row['charges'], row['slip']
        fill = 'est'
        when = f"bought back at {row.get('ceExit')}"
    legs = [{'contract': contract(row.get('expiry') or d, k, s), 'qty': LOT, 'sell': r2(i), 'buy': r2(o)}
            for s, k, i, o in (('CE', row['ceK'], sells[0], buys[0]), ('PE', row['peK'], sells[1], buys[1]))]
    text = f"MMES v3: sold {int(row['ceK'])} CE + {int(row['peK'])} PE {when} ({how})"
    if not measured:
        text += ' · margin not measured'
    return {**base, 'kind': 'trade', 'text': text, 'gross': r2(gross), 'charges': r2(chg), 'fill': fill,
            'legs': legs, 'amount': r2(amount)}, measured


def build(weekly=None, as_of=None, out_path=None, write=True, log=print):
    weekly = weekly if weekly is not None else update.read_json(update.DATA / 'paper-weekly.json', {'trades': []})
    rows = sorted((r for r in weekly.get('trades', []) if r.get('strategy') == STRATEGY and (r.get('date') or '') >= OPENED),
                  key=lambda r: r['date'])
    bal = float(OPENING)
    ledger = [{'date': OPENED, 'kind': 'open', 'text': 'Opening balance (virtual money)', 'amount': float(OPENING),
               'balance': float(OPENING), 'gross': None, 'charges': None, 'fill': None, 'legs': None}]
    last_margin, realized, charges, n_trades, n_skip = None, 0.0, 0.0, 0, 0
    for row in rows:
        e, m = entry(row, bal)
        if m:
            last_margin = {'date': row['date'], **{k: m.get(k) for k in ('scrip', 'span', 'exposure', 'elm', 'total')}}
        bal = r2(bal + e['amount'])
        e['balance'] = bal
        ledger.append(e)
        if e['kind'] == 'trade':
            n_trades += 1; realized += e['gross']; charges += e['charges']
        elif e['kind'] == 'skip':
            n_skip += 1
    blocked, mtm = 0.0, 0.0
    equity = r2(bal + mtm)
    out = {'opening': OPENING, 'openedOn': OPENED, 'strategy': STRATEGY, 'lot': LOT,
           'asOf': as_of or (rows[-1]['date'] if rows else OPENED),
           'balance': bal, 'realized': r2(realized), 'charges': r2(charges), 'net': r2(bal - OPENING),
           'marginBlocked': blocked, 'available': r2(bal - blocked), 'openMtm': mtm, 'equity': equity,
           'returnPct': r2((equity - OPENING) / OPENING * 100), 'trades': n_trades, 'skipped': n_skip,
           'lastMargin': last_margin, 'room': r2(bal - last_margin['total']) if last_margin else None,
           'ledger': ledger}
    if write:
        update.write_json(Path(out_path or OUT), out)
    log(f"[account] balance {bal:.2f} after {n_trades} trade(s), {n_skip} skipped, ledger {len(ledger)} line(s)")
    return out


if __name__ == '__main__':
    build()

"""Monthly NIFTY strangle, k 1 with the 2x-credit stop, as importable functions.

A faithful port of the source project's monthly-strangle.py run(1, 'V3', 'opt', 'spot'), made incremental: a month can be
`open` (its last mark is the newest day on disk) or `closed` (stopped out, or held to the monthly expiry's close).
Used by export.py, update.py and check.py. Standard library only, so it runs in CI without installs.

Rules (copied from monthly-strangle.py's header):
  contract  the calendar month's last NIFTY expiry (the monthly), 1 set = 65 CE + 65 PE
  entry     the first trading day of the month, at that day's close. Spot = the underlying close (UDiFF files) or the
            NIFTY index's last minute (old-format files). ATM = nearest 50, an exact half goes down. W = ATM CE + ATM PE close.
  width     k 1: CE = nearest(spot + W), PE = nearest(spot - W)
  stop      CE + PE close >= 2 x credit on a day's close -> both out at the next day's open
  exit      otherwise the monthly expiry day's close
  costs     charges() below; slippage 0.25 pt per leg per side
"""
import gzip
import json
import math
import os
from datetime import date, datetime, timedelta, timezone

LOT, STEP = 65, 50
M_OPEN, M_EXP = 198_016, 198_016 + 65_777          # margin while open; on the expiry day (+ the 2% expiry ELM)
SLIP = 0.25
IST = timezone(timedelta(hours=5, minutes=30))
RULES = ('k 1, 2x-credit stop. Entry at the close of the month\'s first trading day: sell 1 set (65 CE + 65 PE) of the '
         'month\'s last NIFTY expiry. W = ATM CE + ATM PE close; CE strike = nearest 50 to spot + W, PE strike = nearest '
         '50 to spot - W. If CE + PE close at or above 2 x the credit on any day before the expiry, both are bought back '
         'at the next day\'s open; otherwise both are held to the expiry day\'s close. Daily bhavcopy bars only. '
         'Net is after charges and 0.25 pt slippage per leg per side.')


def charges(d, buy, sell):
    """Copied from monthly-strangle.py (theta-grid.ts / mmes-core.ts). d is the entry date, as the source uses it."""
    stt = 0.0015 if d >= '2026-04-01' else 0.001
    t = buy + sell; b = 40; ex = 0.0003503 * t; se = 0.000001 * t
    return b + stt * sell + ex + se + 0.00003 * buy + 0.18 * (b + ex + se)


def nearest(x):
    k0 = math.floor(x / STEP) * STEP
    return k0 + STEP if x - k0 > STEP / 2 else k0


def load_days(folder):
    """{date: compact bhavcopy dict} for every <date>.json.gz in folder."""
    days = {}
    if not os.path.isdir(folder):
        return days
    for f in sorted(os.listdir(folder)):
        if f.endswith('.json.gz'):
            with gzip.open(os.path.join(folder, f), 'rt', encoding='utf-8') as fh:
                j = json.load(fh)
            days[j['date']] = j
    return days


def load_idx_close(path):
    """{date: NIFTY index close of the day's last minute}; only old-format days (no underlying close) need it."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        idx = json.load(fh)
    out = {}
    for t, c in zip(idx['t'], idx['c']):
        out[datetime.fromtimestamp(t / 1000, IST).date().isoformat()] = c     # the last minute of each day wins
    return out


def book(day, exp):
    """(strike, type) -> (open, high, low, close, contracts) for expiry `exp` in one day's compact file."""
    out = {}
    for r in day['rows']:
        if r[0] == exp:
            o, h, l, c, n = r[3], r[4], r[5], r[6], r[9]
            if n <= 0 or h <= 0:
                o = h = l = c                       # an untraded contract: only its close is a price
            out[(int(r[1]), r[2])] = (o, h, l, c, n)
    return out


def first_weekday(month, holidays):
    """The first weekday of 'YYYY-MM' that is not a known holiday (the expected entry day)."""
    d = date(int(month[:4]), int(month[5:7]), 1)
    while d.weekday() >= 5 or d.isoformat() in holidays:
        d += timedelta(days=1)
    return d.isoformat()


def plan(days, month, idx_close=None):
    """(E, M, spot) for a month whose entry file is on disk, else None.

    E = the first file of the month on disk, M = the month's last expiry listed in E's file (as in the source)."""
    ds = sorted(d for d in days if d[:7] == month)
    if not ds:
        return None
    E = ds[0]
    exps = sorted({r[0] for r in days[E]['rows'] if r[0][:7] == month})
    if not exps:
        return None
    spot = days[E].get('under') or (idx_close or {}).get(E)
    if not spot:
        return None
    return E, exps[-1], spot


def evaluate(days, month, E, M, spot, k=1):
    """Run one month as far as the files on disk go. Returns a dict with the source row's keys
    (month, entry, expiry, spot, W, ceK, peK, ce_in, pe_in, credit, ce_out, ce_at, pe_out, pe_at, why, pts, net, s25,
    s100, worst) plus status ('open' | 'closed'), last_date, last_ce, last_pe. Open months carry None in the exit fields.
    Returns None where the source skips the month (a strike missing from the entry file)."""
    dates = sorted(days)
    b0 = book(days[E], M)
    atm = nearest(spot)
    a_ce, a_pe = b0.get((atm, 'CE')), b0.get((atm, 'PE'))
    if not a_ce or not a_pe:
        return None
    W = a_ce[3] + a_pe[3]
    ck, pk = nearest(spot + k * W), nearest(spot - k * W)
    if (ck, 'CE') not in b0 or (pk, 'PE') not in b0:
        return None
    ce_in, pe_in = b0[(ck, 'CE')][3], b0[(pk, 'PE')][3]
    credit = ce_in + pe_in
    path = [d for d in dates if E < d <= M]
    out = {'CE': None, 'PE': None}; last = {'CE': ce_in, 'PE': pe_in}; worst = 0.0; why = 'EXPIRY'
    pending = False; last_date = E; trigger = None
    for d in path:
        b = book(days[d], M)
        q = {'CE': b.get((ck, 'CE')), 'PE': b.get((pk, 'PE'))}
        if pending:                                    # the stop fired yesterday: out at this day's open
            for s in ('CE', 'PE'):
                if out[s] is None:
                    out[s] = (q[s][0] if q[s] else last[s], d)
            last_date = d
            break
        for s in ('CE', 'PE'):
            if out[s] is None and q[s]:
                last[s] = q[s][3]
        last_date = d
        val = last['CE'] + last['PE']
        worst = min(worst, (credit - val) * LOT)
        if d < M and last['CE'] + last['PE'] >= 2 * credit:
            pending = True; why = 'STOP'; trigger = (d, last['CE'] + last['PE'])    # the close that fired the stop
    closed = out['CE'] is not None or (M in days and not pending)
    row = dict(month=month, entry=E, expiry=M, spot=spot, W=W, ceK=ck, peK=pk, ce_in=ce_in, pe_in=pe_in, credit=credit,
               trigger=trigger)
    if closed:
        for s in ('CE', 'PE'):
            if out[s] is None:
                out[s] = (last[s], M)                 # the expiry day's close
        pts = ce_in - out['CE'][0] + pe_in - out['PE'][0]
        worst = min(worst, pts * LOT)
        net = pts * LOT - charges(E, out['CE'][0] * LOT, ce_in * LOT) - charges(E, out['PE'][0] * LOT, pe_in * LOT)
        row.update(ce_out=out['CE'][0], ce_at=out['CE'][1], pe_out=out['PE'][0], pe_at=out['PE'][1], why=why, pts=pts,
                   net=net, s25=net - 4 * SLIP * LOT, s100=net - 4 * 1.0 * LOT, worst=worst, status='closed',
                   last_date=out['CE'][1], last_ce=out['CE'][0], last_pe=out['PE'][0])
    else:
        row.update(ce_out=None, ce_at=None, pe_out=None, pe_at=None, why=why if pending else None, pts=None, net=None,
                   s25=None, s100=None, worst=worst, status='open', last_date=last_date, last_ce=last['CE'],
                   last_pe=last['PE'], pending_stop=pending)
    return row


def mark_net(E, ce_in, pe_in, ce, pe):
    """Rupees for 1 set if both legs were bought back at (ce, pe): after charges and 0.25 pt slippage."""
    pts = ce_in - ce + pe_in - pe
    return pts * LOT - charges(E, ce * LOT, ce_in * LOT) - charges(E, pe * LOT, pe_in * LOT) - 4 * SLIP * LOT


def replay(days, idx_close, months):
    """Source-shaped rows (closed months only) for the given months, the way monthly-strangle.py builds them."""
    res = []
    for m in months:
        p = plan(days, m, idx_close)
        if not p:
            continue
        E, M, spot = p
        if M not in days:                              # not expired yet: the source leaves it out
            continue
        r = evaluate(days, m, E, M, spot)
        if r and r['status'] == 'closed':
            res.append(r)
    return res

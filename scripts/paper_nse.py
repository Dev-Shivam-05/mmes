"""Weekly MMES paper runner on NSE's live option chain (docs/spec/pnl-v1.md rows 8-9). Runs on the owner's PC on a
NIFTY expiry day; no Dhan plan, no token, no order is ever placed.

    python -I scripts/paper_nse.py --push     # the expiry-day run (scripts/paper_nse.cmd does this on a double-click)
    python -I scripts/paper_nse.py            # the same, but it commits and pushes nothing
    python -I scripts/paper_nse.py --once     # one chain fetch now: spot, expiry, ATM straddle, the strikes v3 would sell
    python -I scripts/paper_nse.py --dry      # the full loop on any trading day; outputs under .cache/dry/, never pushes
         [--minutes N]                        #   (dry only) stop after N snapshots, to test the plumbing
    python -I scripts/paper_nse.py --sim DATE [--as DATE2]
                                              # offline test: an archive day's minutes stand in for NSE, labelled
                                              #   DATE2 in the outputs (.cache/sim/ only)

Access: one nseindia.com page load in a headed Chrome parked off-screen (NSE answers only a headed Chrome), one
`/api/option-chain-contract-info?symbol=NIFTY` for the expiry list, then ONE `/api/option-chain-v3?type=Indices&symbol=
NIFTY&expiry=DD-Mon-YYYY` a minute. The answers are data: parsed as JSON, every number checked, nothing executed.

Clock (row 9, the deviation from the backtest's candles): one snapshot a minute at hh:mm:50 local time, 09:15:50 to
15:15:50. Minute m's close = the m:50 snapshot. A fill "at the next minute's open" = the next snapshot. The 15:15
square-off = the 15:14:50 snapshot. So the rules see o[m] = c[m] = snapshot(m), except o[15:15] = snapshot(15:14). A
minute whose snapshot failed is carried forward from the one before and counted in `est`. Spot = the chain's
underlyingValue. LTP 0 (no trade today) is no price.

Files: `.cache/nse-snapshots/<date>.jsonl` (raw snapshots, ATM +- 15 strikes and the sold strikes; gitignored), its
`.log`, and `.result.json`. A restart the same day reloads the snapshots already taken. At the end it writes the day's
rows into data/paper-weekly.json (+ the minute MTM line), rebuilds data/pnl-daily.json, runs check.py, and only with
--push and a green check: git pull --ff-only, git add data, git commit, git push origin live.
"""
import ctypes
import gzip
import json
import math
import subprocess
import sys
import time
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # python -I leaves the script's folder off sys.path
import mmes_rules as rules  # noqa: E402
import pnl  # noqa: E402
import update  # noqa: E402

ROOT = update.ROOT
IST = rules.IST
HOME = 'https://www.nseindia.com'
PAGE = 'https://www.nseindia.com/option-chain'
API_INFO = 'https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY'
API_CHAIN = 'https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry={exp}'
GRID = [f'{h:02d}:{m:02d}' for h, m in ((x // 60, x % 60) for x in range(9 * 60 + 15, 15 * 60 + 16))]   # 09:15 .. 15:15
SQ = GRID.index(rules.SQUARE_OFF)
SECOND = 50                         # take minute m's snapshot at m:50 local
LATE = 25                           # a snapshot that cannot start by m:50 + 25 s is a missed minute
WINDOW = 15                         # strikes kept each side of the snapshot's ATM
ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
SOURCE = 'NSE snapshot'
NOTE = "Paper trades from NSE's live option chain, one snapshot a minute (minute close = the hh:mm:50 snapshot)."
LOG_FH = None


def log(s):
    line = f"{datetime.now(IST).strftime('%H:%M:%S')} {s}"
    print(line, flush=True)
    if LOG_FH:
        LOG_FH.write(line + '\n'); LOG_FH.flush()


def r2(x):
    return None if x is None else round(x + 0.0, 2) + 0.0


# ------------------------------------------------------------------------------------------------ NSE (untrusted data)
def num(x):
    """A finite float from an untrusted JSON value, else None."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def nse_date(s):
    """'17-Nov-2026' -> '2026-11-17' (raises on anything else)."""
    return datetime.strptime(s.strip(), '%d-%b-%Y').date().isoformat()


def parse_chain(j, keep=()):
    """A compact snapshot from an option-chain-v3 answer: spot, NSE's timestamp, and per strike [CE ltp, bid, ask,
    PE ltp, bid, ask] for ATM +- 15 strikes plus the strikes in `keep`. Raises ValueError on a malformed answer."""
    rec = j.get('records') if isinstance(j, dict) else None
    if not isinstance(rec, dict) or not isinstance(rec.get('data'), list):
        raise ValueError('no records.data')
    spot = num(rec.get('underlyingValue'))
    if not spot or spot <= 0:
        raise ValueError(f"bad underlyingValue {rec.get('underlyingValue')!r}")
    rows = {}
    for d in rec['data']:
        if not isinstance(d, dict):
            continue
        k = num(d.get('strikePrice'))
        if k is None or k <= 0 or k % rules.STEP:
            continue
        row = []
        for side in ('CE', 'PE'):
            q = d.get(side) if isinstance(d.get(side), dict) else {}
            ltp, bid, ask = num(q.get('lastPrice')), num(q.get('buyPrice1')), num(q.get('sellPrice1'))
            row += [ltp if ltp and ltp > 0 else None, bid if bid and bid > 0 else None, ask if ask and ask > 0 else None]
        rows[int(k)] = row
    if not rows:
        raise ValueError('no strikes')
    atm = rules.nearest(spot)
    want = {atm + i * rules.STEP for i in range(-WINDOW, WINDOW + 1)} | {int(x) for x in keep}
    ts = rec.get('timestamp') if isinstance(rec.get('timestamp'), str) else None
    return {'spot': spot, 'nse': ts[:40] if ts else None, 'rows': [[k] + rows[k] for k in sorted(rows) if k in want]}


class Nse:
    """One headed Chrome for the whole day. get() is one API request; a failure returns None."""

    def __init__(self):
        from playwright.sync_api import sync_playwright          # imported here: --sim and the checks never need it
        self.pw = sync_playwright().start()
        self.br = self.pw.chromium.launch(headless=False, channel='chrome', args=['--window-position=-32000,-32000'])
        self.page = self.br.new_page()
        self.fails = 0
        self.warm_at = 0.0
        self.warm()

    def warm(self):
        """The cookies NSE's API wants come from a page load (the home page, then the option-chain page's referer)."""
        self.warm_at = time.time()
        self.page.goto(HOME, timeout=40000, wait_until='domcontentloaded')
        log('[nse] home page loaded')

    def get(self, url):
        try:
            r = self.page.request.get(url, timeout=20000, headers={'Referer': PAGE, 'Accept': 'application/json'})
            body = r.body() if r.status == 200 else b''
            if r.status != 200 or not body:
                raise ValueError(f'HTTP {r.status}')
            j = json.loads(body[:5_000_000].decode('utf-8'))
            self.fails = 0
            return j
        except Exception as e:                                    # network, HTTP, JSON: all a missed minute
            self.fails += 1
            log(f'[nse] request failed ({type(e).__name__}: {str(e)[:100]}), {self.fails} in a row')
            if self.fails >= 2 and time.time() - self.warm_at > 300:
                try:
                    self.warm()                                   # at most one extra page load per 5 minutes
                except Exception as e2:
                    log(f'[nse] home page reload failed: {type(e2).__name__}')
            return None

    def expiries(self):
        j = self.get(API_INFO)
        if not isinstance(j, dict) or not isinstance(j.get('expiryDates'), list):
            raise RuntimeError('option-chain-contract-info gave no expiryDates')
        return sorted(nse_date(e) for e in j['expiryDates'] if isinstance(e, str))

    def snapshot(self, expiry, keep=()):
        j = self.get(API_CHAIN.format(exp=datetime.fromisoformat(expiry).strftime('%d-%b-%Y')))
        if j is None:
            return None
        try:
            return parse_chain(j, keep)
        except ValueError as e:
            log(f'[nse] malformed chain answer: {e}')
            return None

    def close(self):
        try:
            self.br.close()
        finally:
            self.pw.stop()


class Sim:
    """Offline stand-in for Nse: minute m's snapshot = the archive's NIFTY close and leg closes of minute m."""

    def __init__(self, day):
        idx = json.load(open(rules.SRC_IDX, encoding='utf-8'))
        bar = {t: i for i, t in enumerate(idx['t'])}
        ch = json.load(gzip.open(rules.SRC_CHAINS / f'{day}-W1.json.gz', 'rt', encoding='utf-8'))
        self.t = [rules.hm(x) for x in ch['t']]
        self.ms = ch['t']; self.legs = ch['legs']; self.idx_c = idx['c']; self.bar = bar; self.day = day

    def expiries(self):
        return [self.day]

    def snapshot(self, expiry, keep=(), minute=None):
        if minute not in self.t:
            return None
        i = self.t.index(minute)
        if self.ms[i] not in self.bar:
            return None
        spot = self.idx_c[self.bar[self.ms[i]]]
        ks = sorted({int(k[:-2]) for k in self.legs})
        atm = rules.nearest(spot)
        want = {atm + j * rules.STEP for j in range(-WINDOW, WINDOW + 1)} | {int(x) for x in keep}
        rows = []
        for k in ks:
            if k in want:
                ce, pe = self.legs.get(f'{k}CE'), self.legs.get(f'{k}PE')
                rows.append([k, ce['c'][i] if ce else None, None, None, pe['c'][i] if pe else None, None, None])
        return {'spot': spot, 'nse': f'sim {minute}', 'rows': rows}

    def close(self):
        pass


# ------------------------------------------------------------------------------------------------ rules view
def view(day, snaps):
    """The rules' day view from the snapshots so far. snaps: {minute: snapshot}. Minutes before the newest one that
    have no snapshot are carried forward from the snapshot before them. Returns (view, est, received)."""
    got = [m for m in GRID if m in snaps]
    if not got:
        return {'date': day, 't': GRID, 'complete': 0, 'leg': lambda k: None, 'idx': lambda i: None}, 0, 0
    last_i = GRID.index(got[-1])
    per, carried, prev = [], 0, None
    for i in range(last_i + 1):
        s = snaps.get(GRID[i])
        if s is None:                                  # a missed minute: the snapshot before it, carried forward
            carried += 1
            s = prev
        per.append(s); prev = s
    n = len(per)
    complete = n if n != SQ else SQ + 1          # the 15:15 open is the 15:14:50 snapshot, known once that one is in
    cache = {}

    def leg(key):
        if key in cache:
            return cache[key]
        k, side = int(key[:-2]), key[-2:]
        col = 1 if side == 'CE' else 4
        c = [None] * len(GRID); found = False
        for i, s in enumerate(per):
            if s is None:
                continue
            for row in s['rows']:
                if row[0] == k:
                    c[i] = row[col]; found = True
                    break
        if not found:
            cache[key] = None
            return None
        o = list(c)
        o[SQ] = c[SQ - 1] if len(per) >= SQ else None     # row 9: the 15:15 exit is the 15:14:50 snapshot
        cache[key] = {'o': o, 'c': c}
        return cache[key]

    def idx(i):
        return per[i]['spot'] if i < len(per) and per[i] is not None else None

    return {'date': day, 't': GRID, 'complete': complete, 'leg': leg, 'idx': idx}, carried, len(got)


def quote(snap, k, side):
    """(ltp, bid, ask) of strike k from a snapshot, or (None, None, None)."""
    for row in (snap or {}).get('rows', []):
        if row[0] == k:
            return tuple(row[1:4]) if side == 'CE' else tuple(row[4:7])
    return None, None, None


class Narrator:
    """Prints each SIGNAL / ENTRY / STOP / EXIT once per strategy."""

    def __init__(self):
        self.said = set()

    def once(self, key, text):
        if key not in self.said:
            self.said.add(key); log(text)

    def tell(self, name, r):
        if r.get('ceK') is not None:
            self.once((name, 'signal'), f"SIGNAL {name}: spot {r['spot']:.2f}, ATM {r['atm']}, W {r['W']:.2f} "
                                        f"(CE {r['aCE']:.2f} + PE {r['aPE']:.2f}) -> sell {r['ceK']} CE + {r['peK']} PE")
        if r.get('ceIn') is not None:
            self.once((name, 'entry'), f"ENTRY {name}: sold {r['ceK']} CE @ {r['ceIn']:.2f} + {r['peK']} PE @ "
                                       f"{r['peIn']:.2f}, credit {r['credit']:.2f}" +
                      (f", stop at CE + PE {r['stopAt']:.2f}" if r.get('stopAt') else f', each leg out at +{rules.LEG_X}'))
        if name == 'v3' and r.get('triggerAt'):
            self.once((name, 'stop'), f"STOP {name}: CE + PE closed at {r['val']:.2f} >= {r['stopAt']:.2f} at "
                                      f"{r['triggerAt']}; both out at the next snapshot")
        if name == 'leg20':
            why = r.get('why') or ''
            for s in ('CE', 'PE'):
                x = r.get(f'{s.lower()}Exit')
                # before the close a set exit time can only be a stop; once closed, `why` names the stopped legs
                stopped = x and (s in why or 'BOTH' in why if r['state'] == 'closed' else True)
                if stopped:
                    self.once((name, 'stop', s), f"STOP {name}: {s} closed {rules.LEG_X} or more above its sale; "
                                                 f"bought back at the {x} snapshot")
        if r['state'] == 'closed':
            self.once((name, 'exit'), f"EXIT {name}: {r['why']}, CE out {r['ceExit']} @ {r['ceOut']:.2f}, PE out "
                                      f"{r['peExit']} @ {r['peOut']:.2f}; {r['pts']:.2f} pts, net {r['net']:.2f}, "
                                      f"after slippage {r['netSlip25']:.2f}")
        if r['state'] == 'skip':
            self.once((name, 'skip'), f'SKIP {name}: {r["note"]}')


# ------------------------------------------------------------------------------------------------ the day
def wait_until(t):
    while True:
        left = (t - datetime.now(IST)).total_seconds()
        if left <= 0:
            return
        time.sleep(min(left, 5.0))


def target(day, minute):
    h, m = int(minute[:2]), int(minute[3:])
    return datetime.combine(date.fromisoformat(day), datetime.min.time(), IST).replace(hour=h, minute=m, second=SECOND)


def load_snaps(path):
    snaps = {}
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            try:
                s = json.loads(line)
                snaps[s['m']] = s
            except (ValueError, KeyError):
                continue
    return snaps


def money(r):
    """'open mtm -1339' / 'closed net -4281' (after slippage) for the minute status line."""
    if r['state'] == 'closed':
        return f"closed net {r['netSlip25']:.0f}"
    return r['state'] + (f" mtm {r['mtm']:.0f}" if r.get('mtm') is not None else '')


def run_loop(src, day, expiry, snaps, snap_file, sim=False, max_minutes=None):
    tell = Narrator()
    taken = 0
    res = {}
    for minute in GRID:
        if minute in snaps:
            continue
        if not sim:
            due = target(day, minute)
            now = datetime.now(IST)
            if (now - due).total_seconds() > LATE:
                continue                                   # its moment has passed: carried forward later
            wait_until(due)
        v0, _, _ = view(day, snaps)
        keep = set()
        for fn in (rules.run_v3, rules.run_leg):
            r = fn(v0)
            for k in ('atm', 'ceK', 'peK'):
                if r.get(k) is not None:
                    keep.add(r[k])
        s = src.snapshot(expiry, keep, minute=minute) if sim else src.snapshot(expiry, keep)
        if s is None:
            log(f'{minute} missed (carried forward)')
        else:
            s = {'m': minute, 'at': datetime.now(IST).strftime('%H:%M:%S'), **s}
            snaps[minute] = s
            with open(snap_file, 'a', encoding='utf-8', newline='\n') as fh:
                fh.write(json.dumps(s, separators=(',', ':')) + '\n')
            taken += 1
        v, est, got = view(day, snaps)
        res = {'v3': rules.run_v3(v), 'leg20': rules.run_leg(v)}
        for name, r in res.items():
            tell.tell(name, r)
        if s is not None and not sim or (sim and minute in ('09:25', '12:00', '15:14')):
            a, b = res['v3'], res['leg20']
            log(f"{minute} spot {s['spot'] if s else '-'} NSE {s.get('nse') if s else '-'} | v3 {money(a)} | "
                f"leg20 {money(b)} | carried {est}")
        if max_minutes and taken >= max_minutes:
            log(f'--minutes {max_minutes}: stopping the loop')
            break
    v, est, got = view(day, snaps)
    return v, est, got


def weekly_rows(day, v, est, got, res):
    rows = []
    for name in ('v3', 'leg20'):
        r = res[name]
        base = {'date': day, 'strategy': name, 'source': SOURCE, 'spot': r2(r.get('spot')), 'W': r2(r.get('W')),
                'ceK': r.get('ceK'), 'peK': r.get('peK'), 'ceIn': r2(r.get('ceIn')), 'peIn': r2(r.get('peIn'))}
        if r['state'] == 'closed':
            base.update(ceOut=r2(r['ceOut']), peOut=r2(r['peOut']), ceExit=r['ceExit'], peExit=r['peExit'],
                        why=r['why'], pts=r2(r['pts']), charges=r2(r['costs']), net=r2(r['net']),
                        slip=r2(r['netSlip25']))
        else:
            why = r['note'] if r['state'] == 'skip' else f"incomplete day ({r['state']}: {r['note']})"
            base.update(ceOut=None, peOut=None, ceExit=None, peExit=None, why=f'SKIP: {why}', pts=None, charges=None,
                        net=None, slip=None)
        base.update(est=est, minutes=got)
        rows.append(base)
    return rows


def intraday(v, res):
    """{t, v3, leg20, high, low}: each strategy's minute MTM (rules.mtm_series), on one time axis from 09:26 to the
    last exit; a finished strategy holds its final value. high / low are of v3 + leg20, the day's weekly P&L line."""
    lines = {n: rules.mtm_series(v, res[n]) for n in ('v3', 'leg20')}
    t = sorted({x for ts, _ in lines.values() for x in ts})
    if not t:
        return None
    out = {'t': t}
    for n, (ts, vals) in lines.items():
        m = dict(zip(ts, vals)); col, last = [], None
        for x in t:
            if x in m:
                last = m[x]
            col.append(last)
        out[n] = col
    tot = [(a or 0) + (b or 0) for a, b in zip(out['v3'], out['leg20'])]
    out['high'], out['low'] = r2(max(tot)), r2(min(tot))
    return out


def write_weekly(path, day, rows, line):
    old = update.read_json(path, {'trades': [], 'note': ''})
    keep = [r for r in old.get('trades', []) if not (r.get('date') == day and r.get('strategy') in ('v3', 'leg20'))]
    trades = sorted(keep + rows, key=lambda r: (r.get('date') or '', r.get('strategy') or ''))
    intr = dict(old.get('intraday') or {})
    if line:
        intr[day] = line
    else:
        intr.pop(day, None)
    days = sorted({r['date'] for r in trades})
    out = {'trades': trades, 'note': f"{NOTE} {len(days)} expiry day(s), latest {days[-1]}." if days else old.get('note', ''),
           'intraday': {d: intr[d] for d in sorted(intr)}}
    update.write_json(path, out)
    log(f'wrote {path}')


def git(*args):
    log('git ' + ' '.join(args))
    p = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    for line in (p.stdout + p.stderr).strip().splitlines():
        log(f'  {line}')
    return p.returncode


def keep_awake(on):
    """Hold the PC awake while the loop runs (Windows SetThreadExecutionState); a no-op elsewhere."""
    try:
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if on else ES_CONTINUOUS
        ctypes.windll.kernel32.SetThreadExecutionState(ctypes.c_uint(flags))
        log('keep-awake on' if on else 'keep-awake off')
    except (AttributeError, OSError):
        pass


# ------------------------------------------------------------------------------------------------ modes
def cmd_once():
    nse = Nse()
    try:
        exps = nse.expiries()
        exp = exps[0]
        s = nse.snapshot(exp)
        if s is None:
            print('no chain answer'); return 1
        spot = s['spot']; atm = rules.nearest(spot)
        ce_a, pe_a = quote(s, atm, 'CE')[0], quote(s, atm, 'PE')[0]
        print(f"NSE timestamp   {s['nse']}  (fetched {datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S')} IST)")
        print(f'spot            {spot:.2f}  (NIFTY underlyingValue)')
        today = datetime.now(IST).date().isoformat()
        print(f"nearest expiry  {exp}  ({'TODAY: an MMES day' if exp == today else 'not today'}); next {exps[1:4]}")
        if ce_a is None or pe_a is None:
            print(f'ATM {atm}: CE or PE has no LTP'); return 1
        W = ce_a + pe_a
        ck, pk = rules.nearest(spot + rules.K * W), rules.nearest(spot - rules.K * W)
        print(f'ATM             {atm}: CE {ce_a:.2f} + PE {pe_a:.2f} = W {W:.2f}')
        for k, side in ((ck, 'CE'), (pk, 'PE')):
            ltp, bid, ask = quote(s, k, side)
            print(f"v3 would sell   {k} {side}  LTP {ltp}  bid {bid}  ask {ask}")
        c1, c2 = quote(s, ck, 'CE')[0], quote(s, pk, 'PE')[0]
        if c1 is not None and c2 is not None:
            print(f'credit at LTP   {c1 + c2:.2f}  (v3 stop at {2 * (c1 + c2):.2f}; LEG-20 stops at CE {c1 + 20:.2f} / PE {c2 + 20:.2f})')
        print('nothing written')
        return 0
    finally:
        nse.close()


def cmd_day(dry, push, sim_day=None, max_minutes=None, label=None):
    global LOG_FH
    sim = sim_day is not None
    base = ROOT / '.cache' / ('sim' if sim else 'dry' if dry else 'nse-snapshots')
    base.mkdir(parents=True, exist_ok=True)
    day = (label or sim_day) if sim else datetime.now(IST).date().isoformat()
    snap_file = base / f'{day}.jsonl'
    LOG_FH = open(base / f'{day}.log', 'a', encoding='utf-8')
    log(f"paper_nse {'SIM' if sim else 'DRY' if dry else 'LIVE PAPER'} {day}{' --push' if push else ''}")
    if sim and snap_file.exists():
        snap_file.unlink()                                 # a sim always starts fresh
    src = Sim(sim_day) if sim else Nse()
    awake = False
    try:
        exps = [day] if sim else src.expiries()
        expiry = next((e for e in exps if e >= day), None)
        if expiry != day:
            msg = f'not a NIFTY expiry day: the nearest expiry is {expiry}'
            if not dry:
                log(msg + '. Nothing to do.'); return 0
            log(msg + '; --dry runs the loop on its chain anyway')
        snaps = load_snaps(snap_file)
        if snaps:
            log(f'resuming: {len(snaps)} snapshots already in {snap_file.name}')
        if not sim:
            keep_awake(True); awake = True
            first = target(day, GRID[0])
            if datetime.now(IST) < first:
                log(f'waiting for {GRID[0]}:{SECOND}')
        v, est, got = run_loop(src, day, expiry, snaps, snap_file, sim=sim, max_minutes=max_minutes)
    except KeyboardInterrupt:
        log('stopped by hand: the snapshots so far are kept; run again to resume'); return 1
    finally:
        src.close()
        if awake:
            keep_awake(False)
    if got == 0:
        log('no snapshot was taken today (started after the session?): nothing written'); return 1
    res = {'v3': rules.run_v3(v), 'leg20': rules.run_leg(v)}
    rows = weekly_rows(day, v, est, got, res)
    line = intraday(v, res)
    for r in rows:
        log(f"ROW {r['strategy']}: {r['why']}, net after slippage {r['slip']}, snapshots {r['minutes']}, carried {r['est']}")
    (base / f'{day}.result.json').write_text(json.dumps({'rows': rows, 'intraday': line, 'expiry': expiry,
                                                         'raw': res}, indent=1, default=str), encoding='utf-8')
    if dry or sim:
        wk = base / 'paper-weekly.json'
        if not wk.exists():
            update.write_json(wk, update.read_json(update.DATA / 'paper-weekly.json', {'trades': [], 'note': ''}))
        write_weekly(wk, day, rows, line)
        out = pnl.build(weekly_path=wk, out_path=base / 'pnl-daily.json', prev_path=update.DATA / 'pnl-daily.json',
                        log=log)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import check
        bad = check.check_pnl(out, update.read_json(wk, {}), strict_days=False)
        log(f"{'sim' if sim else 'dry'} pnl check: {'ok' if not bad else bad}. Nothing pushed.")
        return 0 if not bad else 1
    if push:
        # the CI job commits data every evening: take its commits first, so the push below is a fast-forward
        if git('pull', '--ff-only', 'origin', 'live') != 0:
            log('git pull failed: STOP. The day is saved in .cache/nse-snapshots; rerun after fixing git.'); return 1
    write_weekly(update.DATA / 'paper-weekly.json', day, rows, line)
    pnl.build(log=log)
    ok = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve().parent / 'check.py')], cwd=ROOT).returncode == 0
    log(f"check.py {'passed' if ok else 'FAILED'}")
    if not push:
        log('no --push: data written locally, nothing committed'); return 0 if ok else 1
    if not ok:
        log('check.py failed: nothing committed'); return 1
    if git('add', 'data') != 0:
        return 1
    if subprocess.run(['git', 'diff', '--cached', '--quiet', '--', 'data'], cwd=ROOT).returncode == 0:
        log('no change: nothing to commit'); return 0
    if git('commit', '-m', f'paper: weekly {day}', '--', 'data') != 0:
        log('commit failed: STOP, nothing pushed'); return 1
    if git('push', 'origin', 'live') != 0:
        log('push failed: the commit is local; push it by hand'); return 1
    log('pushed')
    return 0


def main():
    try:
        sys.stdout.reconfigure(errors='replace')          # a redirected cp1252 console must not crash the day's run
    except AttributeError:
        pass
    a = sys.argv[1:]
    if '--once' in a:
        return cmd_once()
    if '--sim' in a:
        return cmd_day(dry=True, push=False, sim_day=a[a.index('--sim') + 1],
                       label=a[a.index('--as') + 1] if '--as' in a else None)
    mm = int(a[a.index('--minutes') + 1]) if '--minutes' in a else None
    dry = '--dry' in a
    if mm and not dry:
        print('--minutes is for --dry only'); return 2
    return cmd_day(dry=dry, push='--push' in a and not dry, max_minutes=mm)


if __name__ == '__main__':
    sys.exit(main())

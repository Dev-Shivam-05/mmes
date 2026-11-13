"""Daily job: fetch NSE's F&O bhavcopy for the new weekdays, then rebuild the forward monthly paper record, the expiry
calendar and meta.json. Runs in GitHub Actions (update.yml, ubuntu + xvfb) and locally:

    python -I scripts/update.py

Access pattern (copied from the source project's monthly-bhav.py): one nseindia.com page load in a headed Chrome parked
off-screen (NSE answers only a headed Chrome), then one archive request every 2 s. Three blocked-looking answers in a
row stop the run. A weekday that answers 404 on both URLs is a holiday, EXCEPT today's IST date: NSE publishes the file
around 18:00-20:00 IST, so a 404 today means "not published yet". Downloads are data: parsed as CSV text, never executed.

Failure rule: any fetch failure keeps the old data, marks meta.json stale and still exits 0, so the page shows the amber
banner and the job does not crash. Closed paper months are frozen in data/paper-monthly.json (their bhavcopy files are
pruned afterwards), so that file must never be deleted by hand.
"""
import csv
import gzip
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# `python -I` drops the script's own folder from sys.path (isolated mode), so add it explicitly to import the shared core.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import monthly_core as mc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
BHAV = DATA / 'bhav'
HOL_FILE = DATA / 'holidays.json'
PAPER_FROM = '2026-11'               # the forward paper record starts in November 2026 (contract)
GAP = 2.0
STALE_DAYS = 4                        # contract row 13
MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']


def log(s):
    print(f'[update] {s}', flush=True)


def ist_today():
    return datetime.now(mc.IST).date()


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, obj, compact=False):
    # write to a temp file and rename, so a crash mid-write never leaves a half file for the page to read
    path = Path(path)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        if compact:
            json.dump(obj, fh, separators=(',', ':'), ensure_ascii=False)
        else:
            json.dump(obj, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)


# ---------------------------------------------------------------- NIFTY daily candles from Yahoo (contract row 14 b)
YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1mo'


def yahoo_bars(j):
    """[[date, o, h, l, c]] from a Yahoo chart API answer for ^NSEI. The answer is untrusted: every bar must be four
    finite positive numbers with l <= o, c <= h, on strictly increasing IST dates, or the whole answer is refused."""
    res = j['chart']['result'][0]
    if res['meta'].get('symbol') != '^NSEI':
        raise ValueError(f"symbol {res['meta'].get('symbol')}")
    q = res['indicators']['quote'][0]
    out = []
    for i, t in enumerate(res['timestamp']):
        o, h, l, c = (q[k][i] for k in ('open', 'high', 'low', 'close'))
        if None in (o, h, l, c):
            continue                                     # an empty bar is no candle
        o, h, l, c = (round(float(x), 2) for x in (o, h, l, c))
        if not all(math.isfinite(x) and x > 0 for x in (o, h, l, c)) or not (l <= min(o, c) and max(o, c) <= h):
            raise ValueError(f'bad bar at {t}: {o} {h} {l} {c}')
        d = datetime.fromtimestamp(int(t), mc.IST).date().isoformat()
        if out and d <= out[-1][0]:
            raise ValueError(f'dates out of order at {d}')
        out.append([d, o, h, l, c])
    return out


def update_daily(now_ist):
    """Append the Yahoo daily bars nifty-daily.json does not have yet. A failure keeps the old file and is only logged:
    it does not make the page stale (the bhavcopy is the job's data)."""
    path = DATA / 'nifty-daily.json'
    prev = read_json(path, None)
    if not prev or not prev.get('candles'):
        log('nifty-daily: no file to append to (export.py writes the first one)'); return
    try:
        req = urllib.request.Request(YAHOO_URL, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            bars = yahoo_bars(json.loads(r.read(5_000_000).decode('utf-8')))
    except Exception as e:
        log(f'nifty-daily: Yahoo FAILED ({type(e).__name__}: {str(e)[:120]}); old file kept'); return
    today = now_ist.date().isoformat()
    last = prev['candles'][-1][0]
    # today's bar is still forming until the close; the job runs at 16:30 IST, a local run may be earlier
    add = [b for b in bars if b[0] > last and (b[0] < today or now_ist.strftime('%H:%M') >= '16:00')]
    if add:
        prev['candles'] += add
        write_json(path, prev, compact=True)
    log(f"nifty-daily: Yahoo answered {len(bars)} bars ({bars[0][0] if bars else '-'} .. {bars[-1][0] if bars else '-'}); "
        f"appended {len(add)}" + (f' ({add[0][0]} .. {add[-1][0]})' if add else '') + f"; file ends {prev['candles'][-1][0]}")


def bhav_dates():
    return sorted(f[:10] for f in os.listdir(BHAV) if f.endswith('.json.gz')) if BHAV.is_dir() else []


# ---------------------------------------------------------------- fetch (URL patterns and parser from monthly-bhav.py)
def urls(d):
    y, m, dd = d.strftime('%Y'), d.strftime('%m'), d.strftime('%d')
    udiff = f'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{y}{m}{dd}_F_0000.csv.zip'
    old = f'https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{y}/{MON[d.month - 1]}/fo{dd}{MON[d.month - 1]}{y}bhav.csv.zip'
    return [old, udiff] if d < date(2024, 7, 8) else [udiff, old]      # NSE moved to UDiFF on 8 Jul 2024


def iso(s):
    s = s.strip()
    for f in ('%Y-%m-%d', '%d-%b-%Y'):
        try:
            return datetime.strptime(s.title() if '-' in s and s[3:6].isalpha() else s, f).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f'unrecognised date {s}')


def parse(text, d):
    rd = csv.reader(io.StringIO(text))
    h = [x.strip() for x in next(rd)]
    ud = 'FinInstrmTp' in h
    names = (dict(inst='FinInstrmTp', sym='TckrSymb', exp='XpryDt', k='StrkPric', type='OptnTp', o='OpnPric', hi='HghPric', lo='LwPric',
                  cl='ClsPric', st='SttlmPric', oi='OpnIntrst', n='TtlTradgVol') if ud else
             dict(inst='INSTRUMENT', sym='SYMBOL', exp='EXPIRY_DT', k='STRIKE_PR', type='OPTION_TYP', o='OPEN', hi='HIGH', lo='LOW',
                  cl='CLOSE', st='SETTLE_PR', oi='OPEN_INT', n='CONTRACTS'))
    missing = [v for v in names.values() if v not in h]
    if missing:
        raise ValueError(f'{d}: unexpected header, missing {missing}')
    c = {k: h.index(v) for k, v in names.items()}
    u = h.index('UndrlygPric') if 'UndrlygPric' in h else -1
    last = (d + timedelta(days=70)).isoformat()
    rows, under = [], None
    for v in rd:
        if len(v) < len(h) or v[c['sym']].strip() != 'NIFTY' or v[c['inst']].strip() not in ('IDO', 'OPTIDX'):
            continue
        exp = iso(v[c['exp']])
        if exp < d.isoformat() or exp > last:
            continue
        if u >= 0 and under is None and float(v[u] or 0) > 0:
            under = float(v[u])
        rows.append([exp, float(v[c['k']]), v[c['type']].strip(), *(float(v[c[k]] or 0) for k in ('o', 'hi', 'lo', 'cl', 'st', 'oi', 'n'))])
    return {'format': 'udiff' if ud else 'old', 'under': under, 'rows': rows}


def todo_dates(today, holidays):
    have = bhav_dates()
    if not have:
        raise RuntimeError('data/bhav is empty: seed it before the first run')
    d = date.fromisoformat(have[-1]) + timedelta(days=1)
    out = []
    while d <= today:
        if d.weekday() < 5 and d.isoformat() not in holidays:
            out.append(d)
        d += timedelta(days=1)
    return out


def fetch(todo, today, holidays):
    """Fetch every date in order. Returns (saved, new_holidays, failure or None). Stops at the first date it cannot
    settle, so the files on disk never have a gap (a gap could hide a stop day)."""
    saved, new_hol = [], []
    from playwright.sync_api import sync_playwright          # imported here: export.py and check.py never need it
    blocked = req = 0
    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=False, channel='chrome', args=['--window-position=-32000,-32000'])
        try:
            page = br.new_page()
            page.goto('https://www.nseindia.com', timeout=30000, wait_until='domcontentloaded')
            for d in todo:
                tried, done = [], False
                for url in urls(d):
                    while True:                                # a blocked-looking answer retries this URL
                        time.sleep(GAP); req += 1
                        body = None
                        try:
                            r = page.request.get(url, timeout=60000); status = r.status
                            if status == 200:
                                body = r.body()
                        except Exception as e:                 # network error: counts as blocked-looking
                            status = f'error {str(e)[:80]}'
                        if status == 404 or (status == 200 and body):
                            blocked = 0
                            break
                        blocked += 1
                        log(f'{d}: blocked-looking answer {status} ({blocked} in a row)')
                        if blocked >= 3:
                            return saved, new_hol, f'3 blocked-looking answers in a row (last {status}) at {d}'
                    tried.append({'url': url, 'status': status})
                    if status == 404:
                        continue
                    z = zipfile.ZipFile(io.BytesIO(body))
                    p = parse(z.read(z.namelist()[0]).decode('utf-8', 'replace'), d)
                    if not p['rows']:
                        return saved, new_hol, f'{d}: file has no NIFTY option rows'
                    with gzip.open(BHAV / f'{d}.json.gz', 'wt', encoding='utf-8') as f:
                        json.dump({'date': d.isoformat(), 'url': url, 'sha256': hashlib.sha256(body).hexdigest(), **p}, f)
                    log(f"{d}: saved, {p['format']}, {len(p['rows'])} NIFTY option rows, underlying {p['under']}")
                    saved.append(d.isoformat()); done = True
                    break
                if done:
                    continue
                if d == today:                                  # published around 18:00-20:00 IST: not a holiday
                    log(f'{d}: 404 on both URLs, today in IST, so not published yet')
                    break
                holidays[d.isoformat()] = tried; new_hol.append(d.isoformat())
                log(f'{d}: 404 on both URLs, recorded as a holiday')
        finally:
            br.close()
    log(f'{req} archive requests')
    return saved, new_hol, None


# ---------------------------------------------------------------- rebuild (shared with export.py)
def months_from(first, last):
    out, y, m = [], int(first[:4]), int(first[5:7])
    while f'{y:04d}-{m:02d}' <= last:
        out.append(f'{y:04d}-{m:02d}')
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def month_complete_expiries(newest):
    """{month: last expiry} for the months whose whole span lies inside the file's 70-day expiry window. A month cut
    off by the window could show a weekly as its 'last' expiry."""
    d = date.fromisoformat(newest['date'])
    horizon = d + timedelta(days=70)
    last = {}
    for e in sorted({r[0] for r in newest['rows']}):
        last[e[:7]] = e
    out = {}
    for m, e in last.items():
        y, mo = int(m[:4]), int(m[5:7])
        end = (date(y + (mo == 12), mo % 12 + 1, 1) - timedelta(days=1))
        if end <= horizon:
            out[m] = e
    return out


def r2(x):
    return None if x is None else round(x, 2)


def build_paper(days, today, holidays, prev):
    prev_by = {m['month']: m for m in prev.get('months', [])}
    newest = days[max(days)] if days else None
    exp_of = month_complete_expiries(newest) if newest else {}
    out = []
    for m in months_from(PAPER_FROM, today.isoformat()[:7]):
        old = prev_by.get(m)
        # frozen: its files may already be pruned. A record written before `trigger` existed is rebuilt once while its
        # files are still here; without them it is kept, with trigger null.
        if old and old.get('status') == 'closed' and ('trigger' in old or old['entry'] not in days):
            old.setdefault('trigger', None)
            log(f"{m}: closed (kept as recorded), exit {old['exit']['why']} {old['exit']['date']}, net {old['net']}")
            out.append(old); continue
        E0 = mc.first_weekday(m, holidays)
        p = mc.plan(days, m) if E0 in days else None
        if p and p[0] != E0:
            raise RuntimeError(f'{m}: first file on disk is {p[0]}, expected entry {E0}')
        if not p:
            log(f'{m}: waiting for the entry day {E0}')
            out.append(dict(month=m, entry=E0, expiry=exp_of.get(m), spot=None, W=None, ceK=None, peK=None, ceIn=None,
                            peIn=None, credit=None, stopAt=None, status='waiting', trigger=None, last=None, exit=None,
                            net=None))
            continue
        E, M, spot = p
        r = mc.evaluate(days, m, E, M, spot)
        if r is None:
            raise RuntimeError(f'{m}: a strike is missing from the entry file {E}')
        if r['status'] == 'closed':
            mtm = r['s25']
            ex = dict(date=r['ce_at'], ce=r['ce_out'], pe=r['pe_out'], why=r['why'])
            net = r2(r['s25'])
        else:
            mtm = mc.mark_net(E, r['ce_in'], r['pe_in'], r['last_ce'], r['last_pe'])
            ex, net = None, None
        rec = dict(month=m, entry=E, expiry=M, spot=spot, W=r2(r['W']), ceK=r['ceK'], peK=r['peK'], ceIn=r['ce_in'],
                   peIn=r['pe_in'], credit=r2(r['credit']), stopAt=r2(2 * r['credit']), status=r['status'],
                   trigger=dict(date=r['trigger'][0], value=r2(r['trigger'][1])) if r['trigger'] else None,
                   last=dict(date=r['last_date'], ce=r['last_ce'], pe=r['last_pe'], value=r2(r['last_ce'] + r['last_pe']),
                             mtm=r2(mtm)),
                   exit=ex, net=net)
        log(f"{m}: {r['status']}, entry {E}, expiry {M}, sold {r['ceK']} CE @ {r['ce_in']} + {r['peK']} PE @ {r['pe_in']}, "
            f"last {r['last_date']} value {rec['last']['value']} mtm {rec['last']['mtm']}" + (f", exit {ex['why']} net {net}" if ex else ''))
        out.append(rec)
    return {'rules': mc.RULES, 'months': out}


def build_calendar(days, today):
    newest = days[max(days)]
    exps = sorted({r[0] for r in newest['rows']})
    weekly = [e for e in exps if e >= today.isoformat()][:4]
    monthly = [e for m, e in sorted(month_complete_expiries(newest).items()) if e >= today.isoformat()][:2]
    return {'asOf': newest['date'], 'weekly': weekly, 'monthly': monthly, 'lot': mc.LOT}


def build_meta(prev, today, bhav_latest, job_ran, failed, ranges=None):
    """Row 13: stale when the last daily job failed, or when the newest bhavcopy is more than 4 calendar days older
    than the run date on a weekday. staleSince is the run date on which it was first seen stale."""
    aged = today.weekday() < 5 and bhav_latest is not None and (today - date.fromisoformat(bhav_latest)).days > STALE_DAYS
    stale = bool(failed) or aged
    since = (prev.get('staleSince') or today.isoformat()) if stale and prev.get('stale') else (today.isoformat() if stale else None)
    r = ranges or {}
    return {'generatedAt': utc_now_iso(),
            'updatedAt': utc_now_iso() if job_ran else prev.get('updatedAt'),
            'bhavLatest': bhav_latest, 'stale': stale, 'staleSince': since,
            'weeklyRange': r.get('weeklyRange', prev.get('weeklyRange')),
            'monthlyRange': r.get('monthlyRange', prev.get('monthlyRange')),
            'costs': r.get('costs', prev.get('costs'))}             # written by export.py, carried by the daily job


def prune(paper, today):
    """Delete bhavcopy files older than the entry day of the oldest open month, keeping at least the current month,
    and always the newest file (calendar.json and bhavLatest come from it)."""
    keep_from = today.replace(day=1).isoformat()
    for m in paper['months']:
        if m['status'] == 'open':
            keep_from = min(keep_from, m['entry'])
    have = bhav_dates()
    gone = [d for d in have[:-1] if d < keep_from]
    for d in gone:
        os.remove(BHAV / f'{d}.json.gz')
    log(f'prune: keep files from {keep_from}; deleted {len(gone)}' + (f' ({gone[0]} .. {gone[-1]})' if gone else ''))


def build_paper_legs(days, paper, prev):
    """The newest paper month that holds a position: daily o/h/l/c of its sold CE and PE from the entry day to its last
    mark (the exit day once closed). Untraded days (no contracts, or a zero high) carry no candle. If that month's files
    are already pruned, the file written before is kept."""
    held = [m for m in paper['months'] if m['status'] in ('open', 'closed')]
    if not held:
        return {'month': None, 'ceK': None, 'peK': None, 'ce': [], 'pe': []}
    m = held[-1]
    if m['entry'] not in days:
        if prev and prev.get('month') == m['month']:
            return prev
        log(f"paper-legs: {m['month']}'s files are pruned and no earlier paper-legs.json holds it: no candles")
        return {'month': m['month'], 'ceK': m['ceK'], 'peK': m['peK'], 'ce': [], 'pe': []}
    out = {'month': m['month'], 'ceK': m['ceK'], 'peK': m['peK'], 'ce': [], 'pe': []}
    for d in sorted(days):
        if not (m['entry'] <= d <= m['last']['date']):
            continue
        for r in days[d]['rows']:
            # row: [expiry, strike, CE|PE, open, high, low, close, settle, OI, contracts]
            if r[0] != m['expiry'] or int(r[1]) != (m['ceK'] if r[2] == 'CE' else m['peK']) or r[9] <= 0 or r[4] <= 0:
                continue
            out[r[2].lower()].append([d, r[3], r[4], r[5], r[6]])
    return out


def rebuild(today, job_ran, failed, ranges=None):
    """Writes paper-monthly.json, paper-legs.json, calendar.json and meta.json from data/bhav. Returns the paper dict."""
    holidays = read_json(HOL_FILE, {})
    days = mc.load_days(str(BHAV))
    if not days:
        raise RuntimeError('data/bhav holds no files')
    paper = build_paper(days, today, holidays, read_json(DATA / 'paper-monthly.json', {}))
    legs = build_paper_legs(days, paper, read_json(DATA / 'paper-legs.json', None))
    cal = build_calendar(days, today)
    write_json(DATA / 'paper-monthly.json', paper)
    write_json(DATA / 'paper-legs.json', legs)
    log(f"paper-legs: {legs['month']}, CE {legs['ceK']} {len(legs['ce'])} days, PE {legs['peK']} {len(legs['pe'])} days")
    write_json(DATA / 'calendar.json', cal)
    log(f"calendar: as of {cal['asOf']}, weekly {cal['weekly']}, monthly {cal['monthly']}")
    meta = build_meta(read_json(DATA / 'meta.json', {}), today, max(days), job_ran, failed, ranges)
    write_json(DATA / 'meta.json', meta)
    log(f"meta: bhavLatest {meta['bhavLatest']}, stale {meta['stale']}, staleSince {meta['staleSince']}")
    return paper


def mark_stale_only(today):
    """Last resort when the rebuild itself failed: keep every data file, flip meta.json to stale."""
    prev = read_json(DATA / 'meta.json', {})
    have = bhav_dates()
    meta = build_meta(prev, today, have[-1] if have else prev.get('bhavLatest'), True, True)
    write_json(DATA / 'meta.json', meta)
    log(f"meta: stale {meta['stale']}, staleSince {meta['staleSince']} (old data kept)")


def main():
    today = ist_today()
    log(f'run date (IST) {today}')
    holidays = read_json(HOL_FILE, {})
    failure = None
    try:
        todo = todo_dates(today, holidays)
        log(f"weekdays to fetch: {[d.isoformat() for d in todo] or 'none'}")
        if todo:
            saved, new_hol, failure = fetch(todo, today, holidays)
            if new_hol:
                write_json(HOL_FILE, holidays)
            log(f"saved {saved or 'nothing'}; new holidays {new_hol or 'none'}")
            if not saved and failure is None:
                log('no new session')
        else:
            log('no new session')
    except Exception as e:                                        # Chrome missing, NSE down, parser surprise ...
        failure = f'{type(e).__name__}: {str(e)[:200]}'
    if failure:
        log(f'FETCH FAILED: {failure}. Old data kept; the page will show stale.')
    try:
        paper = rebuild(today, job_ran=True, failed=bool(failure))
        prune(paper, today)
    except Exception as e:
        log(f'REBUILD FAILED: {type(e).__name__}: {str(e)[:200]}')
        mark_stale_only(today)
    try:
        update_daily(datetime.now(mc.IST))
    except Exception as e:                                        # never let the chart's extra data fail the job
        log(f'nifty-daily: FAILED ({type(e).__name__}: {str(e)[:120]}); old file kept')
    return 0


if __name__ == '__main__':
    sys.exit(main())

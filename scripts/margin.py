"""Expiry-day margin of the v3 strangle, from Zerodha's public SPAN calculator (docs/spec/account-v1.md row 3).

    python -I scripts/margin.py 2026-11-17 25700 24900     # prints the margin of 1 lot CE + 1 lot PE sold

No login. One GET of the calculator page (to learn its scrip names, e.g. NIFTY26N17 for a weekly, NIFTY26NOV for the
month's last expiry) and one POST. The answer is untrusted data: parsed as JSON, every number checked, nothing executed.
The calculator's `total.total` is SPAN + exposure. On the expiry day SEBI adds a further 2% ELM, which equals the
calculator's own `exposure` figure (measured 12 Nov 2026, Shivam-testing/CLAUDE.md), so the margin is total + exposure.
A failure returns {'error': ...}; the caller takes the trade and shows "not measured" (row 3).
"""
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

URL = 'https://zerodha.com/margin-calculator/SPAN/'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
IST = timezone(timedelta(hours=5, minutes=30))
MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
WEEK_M = '123456789OND'                  # Zerodha's one-letter month in a weekly scrip: 1..9, then O, N, D
SCRIP = re.compile(r'NIFTY\d\d[0-9A-Z]{2,3}')


def _num(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def scrip_names(expiry):
    """(weekly, monthly) scrip names of a NIFTY expiry date, e.g. 2026-11-17 -> ('NIFTY26N17', 'NIFTY26NOV')."""
    d = date.fromisoformat(expiry)
    yy = f'{d.year % 100:02d}'
    return f'NIFTY{yy}{WEEK_M[d.month - 1]}{d.day:02d}', f'NIFTY{yy}{MON[d.month - 1]}'


def pick_scrip(expiry, page_names):
    """The calculator's name for this expiry: the weekly form if the page lists it, else the monthly form (the month's
    last expiry is listed only under its monthly name). None if neither is listed."""
    wk, mo = scrip_names(expiry)
    if wk in page_names:
        return wk
    if mo in page_names:
        return mo
    return None


def _http(url, data=None, timeout=20):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json, text/html'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise ValueError(f'HTTP {r.status}')
        return r.read(3_000_000)


def expiry_margin(expiry, ce_k, pe_k, lot, fetch=_http):
    """{'scrip', 'span', 'exposure', 'elm', 'total', 'at'} for selling `lot` of the ce_k CE and the pe_k PE, or
    {'error': text}. `fetch` is a test seam."""
    at = datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S')
    try:
        names = set(SCRIP.findall(fetch(URL).decode('utf-8', 'replace')))
        scrip = pick_scrip(expiry, names)
        if not scrip:
            return {'error': f'the calculator lists no scrip for {expiry}', 'at': at}
        fields = [('action', 'calculate')]
        for side, k in (('CE', ce_k), ('PE', pe_k)):
            fields += [('exchange[]', 'NFO'), ('product[]', 'OPT'), ('scrip[]', scrip), ('option_type[]', side),
                       ('strike_price[]', str(int(k))), ('qty[]', str(int(lot))), ('trade[]', 'sell')]
        j = json.loads(fetch(URL, urllib.parse.urlencode(fields).encode()).decode('utf-8'))
        tot = j.get('total') if isinstance(j, dict) else None
        span, expo, total = (_num(tot.get(k)) if isinstance(tot, dict) else None for k in ('span', 'exposure', 'total'))
        if not (span and expo and total) or span <= 0 or expo <= 0 or abs(span + expo - total) > 1:
            return {'error': f'unexpected calculator answer {str(tot)[:120]}', 'at': at}
        r = lambda x: round(x + 0.0, 2) + 0.0    # noqa: E731
        return {'scrip': scrip, 'span': r(span), 'exposure': r(expo), 'elm': r(expo), 'total': r(total + expo), 'at': at}
    except Exception as e:                                    # network, HTTP, JSON: "not measured", never a crash
        return {'error': f'{type(e).__name__}: {str(e)[:120]}', 'at': at}


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) != 3:
        print(__doc__); sys.exit(2)
    print(json.dumps(expiry_margin(a[0], int(a[1]), int(a[2]), 65), indent=1))

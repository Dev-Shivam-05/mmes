"""Publish the weekly paper runner's ledger to the dashboard. The owner runs it on the laptop (the weekly paper runner
needs the paid Dhan data plan and a token that must never leave that machine, contract row 4):

    python -I scripts/publish_weekly.py           # writes data/paper-weekly.json only
    python -I scripts/publish_weekly.py --push    # also runs check.py, then commits and pushes that one file

Reads the source project's out/paper/ledger.csv if it exists. With no ledger it writes the contract's empty note.
"""
import csv
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # python -I leaves the script's folder off sys.path
import update  # noqa: E402

LEDGER = Path(r'D:\Temp\Dhan\Shivam-testing\nifty-strangle\out\paper\ledger.csv')
OUT = update.DATA / 'paper-weekly.json'
EMPTY_NOTE = ("No weekly paper trade yet. The first possible day is Tue 17 Nov 2026. It runs on the owner's PC from NSE's "
              'free option chain (scripts/paper_nse.py).')
TEXT = {'date', 'expiry', 'state', 'note', 'why', 'triggerAt', 'exitAt'}     # every other ledger column is a number


def value(col, s):
    s = (s or '').strip()
    if s == '':
        return None
    if col in TEXT:
        return s
    try:
        f = float(s)
    except ValueError:
        return s                       # an unexpected text in a number column is kept as text, not dropped
    return int(f) if f.is_integer() and col in ('lot', 'atm', 'ceK', 'peK') else f


def build():
    if not LEDGER.exists():
        print(f'[publish] no ledger at {LEDGER}: writing the empty note')
        return {'trades': [], 'note': EMPTY_NOTE}
    with open(LEDGER, encoding='utf-8', newline='') as fh:
        rows = [{k: value(k, v) for k, v in r.items()} for r in csv.DictReader(fh)]
    rows.sort(key=lambda r: r.get('date') or '')
    if not rows:
        return {'trades': [], 'note': EMPTY_NOTE}
    print(f"[publish] {len(rows)} ledger rows, {rows[0]['date']} .. {rows[-1]['date']}")
    return {'trades': rows, 'note': f"Paper trades from the weekly paper runner: {len(rows)} expiry day(s), latest {rows[-1]['date']}."}


def git(*args):
    print('[publish] git ' + ' '.join(args), flush=True)
    return subprocess.run(['git', *args], cwd=update.ROOT)


def main():
    # S13: scripts/paper_nse.py (NSE, free) replaced this Dhan-ledger path. Writing over its rows would delete them.
    if OUT.exists():
        with open(OUT, encoding='utf-8') as fh:
            cur = json.load(fh)
        if any(t.get('source') == 'NSE snapshot' for t in cur.get('trades', [])):
            print('[publish] REFUSED: data/paper-weekly.json holds NSE paper rows from scripts/paper_nse.py; '
                  'this older Dhan path would overwrite them.')
            return 1
    update.write_json(OUT, build())
    print(f'[publish] wrote {OUT.relative_to(update.ROOT).as_posix()}')
    if '--push' not in sys.argv:
        return 0
    # the file goes public: run every check (privacy grep included) before it leaves the machine
    if subprocess.run([sys.executable, '-I', str(Path(__file__).resolve().parent / 'check.py')]).returncode != 0:
        print('[publish] check.py failed: nothing committed'); return 1
    if git('add', 'data/paper-weekly.json').returncode != 0:
        return 1
    if subprocess.run(['git', 'diff', '--cached', '--quiet', '--', 'data/paper-weekly.json'], cwd=update.ROOT).returncode == 0:
        print('[publish] no change: nothing to commit'); return 0
    if git('commit', '-m', 'data: weekly paper rows', '--', 'data/paper-weekly.json').returncode != 0:
        print('[publish] commit failed: stop, nothing pushed'); return 1
    if git('push', 'origin', 'live').returncode != 0:
        print('[publish] push failed: the commit is local; push it by hand'); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

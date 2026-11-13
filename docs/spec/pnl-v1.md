# S13: daily paper P&L page (spec v1, locked 13 Nov 2026)

The owner replied "go" to this table on 13 Nov 2026, with three broker P&L screens as design references (a summary card
with net / realised / charges and a transactions list; a month calendar of coloured day cells with a day's intraday P&L
line and its High/Low; a "Today's P&L" line), and: "use the option chain NSE gives daily, or another source".
It extends `dashboard-v1.md`; everything there still holds.

## Locked decisions
| # | Item | Locked value |
|---|---|---|
| 1 | Page | `pnl.html` → https://dev-shivam-05.github.io/mmes/pnl.html, with a "P&L" link in the header of both pages |
| 2 | Rows | One row per NSE trading day from 2 Nov 2026, the first paper trade, newest first. A day without a position still shows, with ₹0 and "no position" |
| 3 | Row columns | Date · NIFTY close (± change) · Monthly paper: event (Entry / Hold / Stop hit / Exit) + day P&L · Weekly paper v3 + LEG-20 (expiry days only) · Day total · Cumulative · Open positions |
| 4 | P&L definition | Day P&L = change in open MTM (close to close) + realised on exit. Charges (`charges()` of the backtest) are booked on the exit day. Slippage is 0.25 pt per fill on the day of the fill. 1 set. **A trade's day rows must add up to its final net** (Nov 2026 monthly: −₹21,882.17) |
| 5 | Top summary | Total paper P&L · this month · best day · worst day · % green days · open MTM now · the backtest's average per trade, from strategies.json, beside it |
| 6 | Charts | Daily P&L bars (green/red) + a cumulative line; a month calendar of day cells coloured by day P&L (reference 2); a day detail with that day's P&L line and its High/Low (a minute line on weekly paper days, a daily-close line for the monthly). Real data only |
| 7 | Monthly paper data | The existing daily job writes `data/pnl-daily.json` |
| 8 | Weekly paper data | `scripts/paper_nse.py` on the owner's PC on expiry days, 09:20–15:20. NSE's live option chain (`/api/option-chain-v3`, headed Chrome, **1 request a minute** at about hh:mm:50), the same decision rules as the backtest for v3 and LEG-20. About 15:20 it writes `data/paper-weekly.json` + `data/pnl-daily.json`, commits and pushes (`--push`). No Dhan plan. The PC must be on and awake (the script holds the PC awake while it runs) |
| 9 | Deviation | NSE gives LTP snapshots, not candles: minute m's close = the snapshot at m:50; the "next minute's open" fill = the next snapshot; the 15:15 exit = the 15:14:50 snapshot. Rows carry `source: "NSE snapshot"`, shown on the page |
| 10 | Speed | Both pages: CLS ≤ 0.1 and TBT ≤ 200 ms (median of 3) under the throttled test `.cache/qa/vitals.py` (150 ms RTT, 1.6 Mbps, 4× CPU, 412×823); 0 console errors at 390 and 1440 |

## Data contract additions
### `data/pnl-daily.json`
```
{ "start": "2026-11-02", "asOf": date,
  "summary": { "net", "realized", "charges", "slippage", "openMtm", "thisMonth",
               "bestDay": {date, pnl}, "worstDay": {date, pnl}, "greenDays", "redDays", "flatDays", "days",
               "backtestPerTrade": { "monthly": number, "v3": number, "leg20": number } },
  "days": [ { "date", "nifty": { "close", "chg" },
              "monthly": { "event": "entry"|"hold"|"stop"|"exit"|"none", "pnl", "value": CE+PE close or null },
              "weekly": { "v3": { "pnl", "event" } | null, "leg20": { "pnl", "event" } | null },
              "total", "cum", "open": number of open trades at that day's close, "events": [string] } ],
  "trades": [ { "id", "strategy": "monthly"|"v3"|"leg20", "entry": date, "exit": date|null, "status": "open"|"closed",
                "source": "NSE bhavcopy close"|"NSE snapshot",
                "legs": [ { "contract": "NIFTY 23 Nov 2026 24050 CE", "qty": 65, "sell", "buy"|null, "pnl"|null, "charges"|null } ],
                "realized"|null, "charges"|null, "slippage", "net"|null, "mtm"|null } ],
  "intraday": { "<date>": { "t": ["09:26", ...], "v3": [mtm ₹...], "leg20": [mtm ₹...], "high", "low" } } }
```
`days` has no gap: every date that has a file in `data/bhav`, or a weekly paper row, from `start` to `asOf`. `total` =
monthly pnl + weekly pnls; `cum` = the running sum of `total`.

### `data/paper-weekly.json` rows
`{ date, strategy: "v3"|"leg20", source: "NSE snapshot", spot, W, ceK, peK, ceIn, peIn, ceOut, peOut, ceExit, peExit, why,
pts, charges, net, slip, est, minutes }` (`minutes` = snapshots received; `est` = minutes carried forward).

## Acceptance criteria
1. `pnl.html` answers 200. Its rows cover every trading day from 2 Nov to the newest, none missing.
2. Nov 2026 monthly: entry 2 Nov, stop hit at the 5 Nov close, exit 6 Nov. Its day rows sum to −₹21,882.17 (±₹1).
3. `check.py` recomputes day totals, cumulative, the summary and the trade nets from the rows: 0 differences.
4. The Python rules port reproduces the archive backtest: v3 = `replay-v3.csv` and LEG-20 = `leg-sl-days.csv` on 143/143
   days (net within ₹0.01, the same exit times).
5. `paper_nse.py --once` fetches one NSE chain snapshot and prints spot, expiry, the ATM straddle and the strikes that
   would be sold; `--dry` on a non-expiry day logs about 1 snapshot a minute and pushes nothing.
6. Row 10's speed numbers on both pages.

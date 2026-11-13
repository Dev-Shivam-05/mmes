# S15: virtual ₹2.7 L account + a weekly runner that starts on its own (spec v1, locked 13 Nov 2026)

The owner replied "go for it" to this table on 13 Nov 2026. The request was: "on a daily basis it should auto trade and
update; add virtual money of 2.7 L so it looks real; no cheating, everything with the live market; take the option
chain from NSE, adjust it yourself if needed". It extends `dashboard-v1.md` and `pnl-v1.md`; everything there still
holds unless a row below replaces it.

## Locked decisions
| # | Item | Locked value |
|---|---|---|
| 1 | Virtual money | Opening balance **₹2,70,000** on Mon 16 Nov 2026. The first possible trade is Tue 17 Nov. |
| 2 | What it trades | **MMES v3 only**, 1 set (1 lot CE + 1 lot PE, qty 65 each). Monthly k1 and LEG-20 stay on the page as separate paper lines, outside the ₹2.7 L. |
| 3 | Margin, like a broker | At entry: Zerodha's SPAN calculator for the two sold strikes (no login), plus the expiry-day 2% ELM (= the calculator's `exposure` figure). It is blocked until the exit. If available < margin: **no trade**, and the ledger reads "Skipped: insufficient funds (need ₹X, have ₹Y)". If the calculator does not answer, the trade is taken and the margin shows "not measured". |
| 4 | Fill price | Sell at the **bid**, buy back at the **ask**, from the same NSE snapshot the rules fill at. The account books this fill. The LTP + 0.25 pt fill stays beside it, for comparison with the backtest. A missing bid or ask: the rule's LTP fill ∓ 0.25 pt, marked "est". |
| 5 | Charges | The backtest's `charges()` (`mmes_rules.py`: brokerage 40 per leg round trip, STT 0.15% of the sell side from 1 Apr 2026, exchange, SEBI, stamp, GST), on the bid/ask prices, booked on the exit day. |
| 6 | Who runs it | GitHub Actions `.github/workflows/paper.yml`, no PC. Four schedule triggers each weekday at 06:30 / 07:15 / 08:00 / 08:45 IST. The first run to start takes the day, and the others exit. A day that `data/calendar.json` does not list as a weekly expiry exits in about a minute. The day runs in two jobs, start → 11:55 and 11:56 → 15:20, because GitHub stops a job at 6 h; the snapshots go from the first to the second as an artifact. At about 15:20 the runner writes the day, runs `check.py`, commits, pushes and deploys. |
| 7 | Backup | The page shows the runner: "started hh:mm on GitHub", "done", "failed" or "not started". If it says "not started" at 09:20 on an expiry day, the owner double-clicks `scripts/paper_nse.cmd`. That run refuses if `data/runner.json` says GitHub started today (and has not failed). A PC run writes `runner.json` itself, so GitHub's later triggers stand down. |
| 8 | Account on the page | Top of `pnl.html`: Opening · Balance · Margin blocked · Available · Open MTM · Equity · Return % since 16 Nov, and a **funds ledger** like a broker statement (date, entry, ₹ ±, balance after). Label: "Virtual money · paper trades, no real orders". |
| 9 | Data source | NSE only: `/api/option-chain-v3`, 1 request a minute (unchanged), and the NSE bhavcopy for the monthly line and the daily close. No Dhan. |
| 10 | No-cheating rules | (a) Decisions use only snapshots already received. (b) A missed minute is carried forward and counted, never filled in later. (c) A finished day is never edited: `check.py` fails if any weekly row or ledger entry dated before today (IST) differs from its committed version. (d) The day's raw NSE snapshots, with NSE's own timestamps, are committed as `data/snapshots/<date>.jsonl.gz`. |

## Out of scope
- Live MTM during the day on the page (the result appears at about 15:25).
- Real orders, a broker login, the Dhan API.
- Any change to the v3 rules.

## Data contract
### `data/account.json` (written by `scripts/account.py`, called from `pnl.build()`)
```
{ "opening": 270000, "openedOn": "2026-11-16", "strategy": "v3", "lot": 65, "asOf": date,
  "balance", "realized", "charges", "net", "marginBlocked", "available", "openMtm", "equity", "returnPct",
  "trades": n, "skipped": n,
  "lastMargin": { "date", "scrip", "span", "exposure", "elm", "total" } | null,
  "room": balance - lastMargin.total | null,
  "ledger": [ { "date", "kind": "open"|"trade"|"skip"|"none", "text", "amount", "balance",
                "gross"|null, "charges"|null, "fill": "bid/ask"|"est"|null,
                "legs": [ { "contract", "qty", "sell", "buy" } ] | null } ] }      // oldest first
```
`balance` = `opening` + Σ the trade amounts. `available` = `balance` − `marginBlocked`. `equity` = `balance` +
`openMtm`. `returnPct` = (`equity` − `opening`) / `opening` × 100. The published file is written after the close, so
`marginBlocked` and `openMtm` are 0 (row 8's "Margin blocked" shows "no open position").

### `data/paper-weekly.json` v3 rows gain
`ba: { ceIn, peIn, ceOut, peOut, inAt, outAt, est, pts, charges, net }` (bid/ask fills, row 4) and
`margin: { scrip, span, exposure, elm, total, at } | { error } | null` (row 3).

### `data/runner.json`
`{ date, where: "github"|"pc", status: "started"|"done"|"failed", startedAt, updatedAt, note }`. Times are IST
`YYYY-MM-DD HH:MM:SS`. The file always exists, so the page never asks for a missing file: before the first run it is
`{ date: null, where: null, status: "none", startedAt: null, updatedAt: null, note: "has not run yet" }`.

## Acceptance criteria
1. A GitHub `--once` run fetches NSE's option chain from a GitHub server and prints spot, expiry and the strikes v3
   would sell.
2. Mon 16 Nov, market hours: a scheduled `paper` run starts on its own and exits green with "not an expiry day"; a
   dispatched `dry` run takes 5 snapshots.
3. Tue 17 Nov: the runner starts by 09:15 without a click, takes ≥ 350 of the 361 snapshots, and the trade is on the
   page by 15:45.
4. Balance = 2,70,000 + Σ realised net, and Available = Balance − margin blocked. `check.py` recomputes both from the
   weekly rows with its own code: 0 differences.
5. A test day with the balance below the margin gives "Skipped: insufficient funds" and books nothing.
6. In a test day, the booked fills equal the snapshot's bid (sell) and ask (buy), and the LTP fill equals the v3 rules'
   output.
7. Changing a past row makes `check.py` fail. With `runner.json` saying GitHub started today, `paper_nse.py --push`
   refuses.
8. Both pages: 0 console errors at 390 and 1440, CLS ≤ 0.1, TBT ≤ 200 ms (pnl-v1 row 10).

## Risks
- NSE may refuse its option-chain API to GitHub's servers (AC1 measures it first).
- GitHub can start every trigger late or not at all; then only the PC backup catches the day.
- ₹2.7 L leaves about ₹10k above the expiry-day margin (₹2,60,409 on 12 Nov), and v3's backtest max drawdown is
  −₹32,214, so row 3 can skip trades after about ₹10k of losses. The owner kept ₹2.7 L.

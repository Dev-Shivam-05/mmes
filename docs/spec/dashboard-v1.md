# S12: MMES public dashboard (spec v1, locked 13 Nov 2026)

The owner approved this table with "go for it" on 13 Nov 2026. It is the contract. A value not written here may not be
introduced silently: add a row and get approval.

Source project: the owner's side project `D:\Temp\Dhan\Shivam-testing\nifty-strangle\` (STRATEGY.md is the strategy's
definition). This repo only displays its results and runs one free daily job.

## Locked decisions
| # | Item | Locked value |
|---|---|---|
| 1 | Hosting | Public GitHub repo `Dev-Shivam-05/mmes`, GitHub Pages → https://dev-shivam-05.github.io/mmes/ |
| 2 | Branches | Default branch `live`. There is no `main` branch. |
| 3 | Background job | GitHub Actions `update.yml`: weekdays 11:00 UTC (16:30 IST) + `workflow_dispatch`. ubuntu-latest + xvfb + headed Chrome (Python Playwright, `channel="chrome"`) fetches the day's NSE F&O bhavcopy (1 request a weekday), updates the monthly paper trade, commits `data/*.json`. |
| 4 | Weekly live data | Not automated (paid Dhan Data API; its token must not leave the owner's machine). Backtest only, plus `scripts/publish_weekly.py`, which the owner runs on the laptop to publish paper-runner rows. |
| 5 | Sections (one page) | (1) Today; (2) Strategy cards; (3) Equity curve + drawdown, with (6) the Capital calculator beside it from 1200 px (the owner's reference 6; order accepted 13 Nov); (4) Month heatmap; (5) Trade log; (7) How it works |
| 6 | Visual tokens | Dark default + light toggle. Dark: bg `#07090D`, panel `#0C1016`, subtle `#121822`, inset `#19202B`, text `#E6EAF2`, muted `#A3ADBD`, faint `#7A8597`, accent `#8B7CFF`, profit `#2FD08A`, loss `#FF5C6C`, warning `#F5B83D`, border `rgba(148,163,184,.10)`. Light: bg `#F4F5F8`, panel `#FFFFFF`, text `#0F172A`, muted `#475569`, accent `#6D5BF5`, profit `#0E9F6E`, loss `#E02D3C`, warning `#B7791F`. Fonts: Inter (UI) + JetBrains Mono (numbers), self-hosted woff2. Spacing scale 8 px. Card radius 12 px. Transitions 160 ms `cubic-bezier(.4,0,.2,1)`. (The palette is the owner's own terminal's, `D:\Temp\Dhan\public\app.css`.) |
| 6a | Chart series colours (all from the same terminal tokens) | v3 `#8B7CFF` (--accent), leg20 `#5C93F0` (--big-in), leg40 `#F2C438` (--big-out), monthly `#2FD08A` (--up), merged `#E6EAF2` in dark / `#0F172A` in light (--fg-base). Heatmap: loss `#FF5C6C` → 0 `--bg-inset` → profit `#2FD08A`. |
| 7 | Interaction | Apache ECharts 5.5.1, vendored at `vendor/echarts.min.js`: tooltips, legend toggles, drag/inside zoom on the equity curve. Trade table sortable by any column and filterable by strategy, year and result. Count-up of card numbers on load, 600 ms, none under `prefers-reduced-motion`. |
| 8 | Wording | English UI, short sentences. Every metric has an ⓘ tooltip of one line. Rupees in Indian grouping (`₹1,78,060`). Profit and loss always carry + / − signs, never colour alone. |
| 9 | Tech | Static site, no build step: `index.html`, `styles.css`, `app.js` (ES module), `data/*.json`. Python scripts make the data. Every URL in the page is relative, so it works under `/mmes/`. |
| 10 | ChatGPT | 1–2 rounds of design critique (spec + data shapes + screenshots), adopted only inside rows 5–9. Record in `docs/debate/`. |
| 11 | Build | Subagents: A data exporter + checks, B UI, C Actions + Pages, D independent QA |
| 12 | Privacy | The page says "MMES · NIFTY expiry strangle". The repo must contain none of: the family name in the strategy's full title, the broker's env-var prefix, the broker client id, the token header name, or an email address (except the GitHub Actions bot's noreply address). The exact list lives only in `scripts/check.py`, built from split strings so the file does not match itself. `scripts/check.py` fails on any hit. |
| 13 | Freshness | Footer: "Data as of <date> · updated <time IST>". If the last daily job failed or the newest bhavcopy is more than 4 calendar days older than the job's run date on a weekday, the page shows an amber "stale since <date>" banner. |

| 14 | Real candles (owner, 13 Nov: "real candles", "ab tak jo bhi chal raha hai uske according"; reference images 1–6) | (a) **Trade day view**: clicking a weekly trade shows that expiry day's real NIFTY **5-minute candles** 09:15–15:30 (the Dhan archive's 1-minute index bars, aggregated), the sold CE and PE strikes as horizontal lines, and markers at 09:26 entry and at each leg's exit. Under it, the sold CE + PE combined premium (5-minute closes) with the credit line and the 2× stop line. (b) **Monthly view**: NIFTY **daily candles** Jan 2024 → newest, each month's sold strikes as step lines, stop exits marked. (c) **Open paper position**: the sold CE and PE **daily candles** since entry with the entry (sale) price line and an exit marker. No per-leg stop line: the monthly stop is on CE + PE combined, shown as a number (clarified after the 13 Nov design review, `docs/debate/2026-11-13-design/RESULT.md` row 13). Every candle comes from a data file; nothing is drawn by hand. |
| 15 | Every element is data-driven (owner, 13 Nov) | No avatar, search box, notification bell, order book, wallet or deposit button, or any widget without data behind it |

## Data contract (`data/*.json`). Scripts write it, the UI reads it, and nothing else.
### Added after the 13 Nov QA
- `data/paper-monthly.json` months[] gain `trigger: { date, value } | null`: the close on which CE + PE first reached the
  stop (the exit is at the next day's open, in `exit`).
- `data/meta.json` gains `costs: { dataApiMonthly: 499, gstPct: 18, dataApiPerYear: 7065.84 }`, so no cost is typed into
  the page's code.
- `data/holidays.json`: the weekdays NSE published no bhavcopy for (written by update.py; the page does not read it).

### Added for row 14
- `data/days/<date>.json` (one file per weekly trade date, 143): `{ date, step: 5, nifty: [[hhmm, o, h, l, c], ...],
  ce: [[hhmm, o, h, l, c]], pe: [[hhmm, o, h, l, c]], ceK, peK, entry: "09:26", exits: { v3: {ce, pe}, leg20: {ce, pe},
  leg40: {ce, pe} } }` (exit times hh:mm). Built from the source archive `.cache/history/chains/NIFTY/<date>-W1.json.gz`
  (legs) and `.cache/history/idx/NIFTY.json` (index).
- `data/nifty-daily.json`: `{ source: string, candles: [[date, o, h, l, c], ...] }`. Up to 25 Sep 2026 from the index
  minutes; after that, Yahoo `^NSEI` daily bars (free, no key), appended by update.py.
- `data/paper-legs.json`: `{ month, ceK, peK, ce: [[date, o, h, l, c]], pe: [[date, o, h, l, c]] }` for the newest paper
  month, from `data/bhav`.

All money is rupees for 1 set (65 CE + 65 PE), after charges and 0.25 pt slippage per leg per side unless a field says
otherwise. Dates are `YYYY-MM-DD` (IST trading dates).

### `data/meta.json`
`{ "generatedAt": ISO-8601 UTC, "updatedAt": ISO-8601 UTC of the last daily job or null, "bhavLatest": date,
"stale": bool, "staleSince": date|null, "weeklyRange": [from, to], "monthlyRange": [fromMonth, toMonth] }`

### `data/strategies.json`
`{ "strategies": [ Strategy, ... ] }`, in this order: `v3`, `leg20`, `leg40`, `monthly`, `merged`.
Strategy = `{ id, name, tagline, kind: "weekly"|"monthly"|"merged", rules: [string],
kpi: { trades, winPct, net, net50, perYear, worst, worstUnit: "day"|"month", maxDD, capitalMin, capitalSafe,
marginPeak }, notes: [string], equity: [[date, cumNet], ...], months: { "YYYY-MM": net } }`

| Field | Definition |
|---|---|
| `net` | sum of the per-trade net after 0.25 slippage. Expected: v3 86,338; leg20 79,387; leg40 79,923; monthly 1,78,060; merged 2,51,190 (±1) |
| `net50` | the same at 0.5 pt slippage |
| `perYear` | weekly: net / (2 + 268/365) (1 Jan 2024 – 25 Sep 2026, as in the source's `leg-sl.ts`); monthly: net / (34/12); merged: net / (33/12) |
| `merged` trades / win % | the 143 v3 days + the 33 monthly trades in Jan 2024 – Sep 2026 = 176; worst and maxDD on month steps (agent A, accepted) |
| `winPct` | trades with net (before slippage) > 0, divided by trades |
| `worst` | the lowest single trade after slippage (a day for weekly, a month for monthly) |
| `maxDD` | the largest peak-to-trough fall of the cumulative net (merged: on monthly steps) |
| `marginPeak` | weekly and monthly 2,63,793 (1,98,016 + the 65,777 expiry ELM); merged 5,27,586 |
| `capitalMin` | ceil to ₹10,000 of max over trades (marginPeak − cumulative net before the trade − min(0, worst MTM of the trade)); merged: ceil(marginPeak) to ₹10,000 |
| `capitalSafe` | ceil to ₹10,000 of 1.1 × marginPeak + 3 × abs(maxDD) + 10,000 (the review's rule, `docs/debate` of the source project) |
| `merged` | v3 weekly + monthly in one account over the 33 months both cover (Jan 2024 – Sep 2026) |

`notes` must carry, for `monthly`: "Strikes centred on the option-implied forward instead of the index close: ₹1,20,354.
Treat the result as fragile." and "Daily bars: intraday risk is not visible."

### `data/trades-weekly.json`
`{ "v3": [Row], "leg20": [Row], "leg40": [Row] }`.
Row = `{ date, spot, W, ceK, peK, ceIn, peIn, credit, why, exitAt, ceExit, peExit, ceOut, peOut, pts, net, slip, worst, est }`
(`est` = how many of the two exit prices had no print at their minute and used the last close, as the source does;
4 leg exits in total, all PE 15:15 on 2 Jan 2025 and 17 Apr 2025)
(`slip` = net after 0.25 slippage; for leg rows, `exitAt` is null and `ceExit`/`peExit` are the two exit times).

### `data/trades-monthly.json`
`{ "spot": [MRow], "fwd": [MRow] }`. MRow = the rows of the source `out/paper/monthly-rows.json`, unchanged.

### `data/calendar.json`
`{ "asOf": date, "weekly": [next 4 NIFTY expiries], "monthly": [next 2 monthly expiries (the last expiry of a calendar
month)], "lot": 65 }`, taken from the newest bhavcopy's expiry list.

### `data/paper-monthly.json`
Forward paper record of the monthly k 1 2× stop, from November 2026:
`{ "rules": string, "months": [ { month, entry, expiry, spot, W, ceK, peK, ceIn, peIn, credit, stopAt, status:
"open"|"closed"|"waiting", last: { date, ce, pe, value, mtm }, exit: { date, ce, pe, why } | null, net: number|null } ] }`.
The same logic as `monthly-strangle.py` `run(1, 'V3')`. Regression: replayed over Jan 2024 – Oct 2026 it must equal the
source `monthly-rows.json` "spot" on 34/34 months (net within ₹0.01).

### `data/paper-weekly.json`
`{ "trades": [ledger rows of the source paper runner], "note": string }`. It starts empty, with the note "No live
paper trade yet. The first possible day is Tue 17 Nov 2026; it needs a new Dhan token and the Data API plan."

## Acceptance criteria (binary)
1. https://dev-shivam-05.github.io/mmes/ answers 200.
2. Every card number equals the source files (`scripts/check.py` recomputes them from the per-trade rows; any
   difference > ₹1 fails).
3. Capital calculator: ₹2,00,000 → "0 sets: one set needs ₹2,70,000"; ₹5,00,000 → 1 set of v3.
4. One manual run of `update.yml` ends green, and the footer date changes or reads "no new session".
5. Screenshots of all 7 sections at 390×844 and 1440×900, dark and light, with zero console errors.
6. Lighthouse mobile: performance ≥ 85, accessibility ≥ 95.
7. The privacy grep (row 12) finds 0 matches.

## Out of scope
Real orders, broker login, alerts, weekly live signals on GitHub, a page login, a custom domain.

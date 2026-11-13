# Review - dashboard design - 2026-11-13 - 1 round - prompt: none (project context only)

ChatGPT temporary chat. Context: the spec `docs/spec/dashboard-v1.md`, 5 screenshots of the build (1440, dark) and 5 of
the owner's reference dashboards (not stored in this repo; they are third-party designs). One round: every point was
agreed or rejected with a reason, and its open questions are data checks that the independent QA agent covers.

| # | Point | Proposed by | Evidence | Verdict | Status |
|---|---|---|---|---|---|
| 1 | The closed monthly card shows the exit value under "CE + PE now", with a gauge. That reads as a live position | ChatGPT | today screenshot: 544.70 is the 6 Nov exit value | agreed: closed state = no gauge; "Closed · stop triggered 6 Nov"; credit / stop threshold / exit value as plain values; net shown once; candles after the exit date faded and labelled "after exit". Open state keeps the gauge, with the mark's date | build |
| 2 | LEG views show v3's 2× stop | ChatGPT | the day-drawer screenshot | already fixed before the reply: LEG views now draw each leg with its own +20/+40 stop. ChatGPT's alternative (keep v3's line faint) is rejected because the per-leg line is the selected strategy's real rule | done |
| 3 | The first screen does not answer "making money? / open now? / next?" | ChatGPT | today screenshot | agreed: a 3-column summary at the top of Today: backtest result (selected strategy's full net) · paper status · next event | build |
| 4 | Labels: "Per year" reads as a forecast; win % is before slippage while the net is after; "Capital safe" sounds like a guarantee | ChatGPT | contract field definitions | agreed: "Average per year (historical)", "Winning trades (before slippage)", "Buffered capital" with the tooltip "Rule-based margin + drawdown buffer; not a guarantee against losses" | build |
| 5 | Put limits next to results: merged drawdown on month steps; the monthly warnings stay visible | ChatGPT | contract `merged`, `notes` | agreed | build |
| 6 | Shared assumptions repeated on every card; the Performance KPI strip repeats the cards | ChatGPT | strategies screenshot | agreed: one assumptions line above the cards; the KPI strip becomes a compact header (strategy · full-backtest net · period) | build |
| 7 | The equity chart's scale is dominated by monthly/merged when weekly is selected | ChatGPT | performance screenshot | agreed: only the selected series by default, the others toggleable; a 2 px selected line; an endpoint label; "Full-backtest net" stays labelled as such when zoomed | build |
| 8 | Mobile: full-screen drawer, 48 px controls, 16 px gutters | ChatGPT | reasoning (no mobile shot sent) | agreed where the build differs | build |
| 9 | Heatmap: year group labels; absent ≠ zero; a cell click filters the trade log | ChatGPT | months screenshot | agreed | build |
| 10 | The exit-reason stripes are hard to read | ChatGPT | months screenshot | agreed: one 24 px two-segment bar + "Exit method, not win rate" | build |
| 11 | Day drawer: "Signal measured 09:25 · Entry 09:26"; horizontal labels; CE strike solid, PE dashed; caption explaining premium gaps (no trade print in that window) | ChatGPT | day screenshot | agreed. The gap at the end of 2 Jan 2025 is real: the archive has no PE print in those buckets (66 of 75) | build |
| 12 | The monthly chart heading and tooltip (OHLC + that month's trade), the visible date range, the source disclosure | ChatGPT | months screenshot | agreed | build |
| 13 | The paper card's per-leg "stop lines" are derived (2× credit minus the other leg) and imply leg stops the monthly rule does not have | ChatGPT | today screenshot | agreed: remove them; keep the sale-price line and an exit marker. Spec row 14(c) is clarified accordingly | build |
| 14 | The ticker repeats the November P&L | ChatGPT | today screenshot | agreed: the ticker keeps NIFTY close, next weekly, next monthly and data as of | build |

## Recommended next steps
All "build" rows went to the UI agent the same day, together with the independent QA findings.

## Points still open
- Lighthouse (AC6) can only be measured after the deploy (no Node on the build PC).

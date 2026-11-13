# MMES · NIFTY expiry strangle — dashboard

Live page: **https://dev-shivam-05.github.io/mmes/**

This is a public, static dashboard of one trader's NIFTY options research: the backtest of five strategy versions
(weekly expiry-day v3, LEG-20, LEG-40, a monthly strangle, and the weekly + monthly account merged), and a forward paper
record of the monthly strangle that updates itself every weekday from NSE's free end-of-day data.

**Backtest and paper results only. Not advice. Past results do not promise future returns.**

## What updates by itself, and what does not
| Part | How it updates | Cost |
|---|---|---|
| Monthly paper trade, expiry calendar, "data as of" | GitHub Actions `update.yml`, Mon–Fri 16:30 and 21:00 IST: fetches that day's NSE F&O bhavcopy (one file), recomputes, commits `data/`, redeploys | free (public repo) |
| Weekly v3 / LEG-20 paper trades | Not automatic. They need 1-minute option prices from a paid data plan, and its login token must stay on the trader's own PC. Run `python -I scripts/publish_weekly.py --push` on that PC after a paper-trading day | – |
| Backtest numbers | Fixed. Re-made locally with `python -I scripts/export.py` from the research folder | – |

If NSE does not answer, the old numbers stay and the page shows an amber "Data stale since …" banner.

## Files
- `index.html`, `styles.css`, `app.js`, `vendor/`: the page (no build step).
- `data/*.json`: everything the page shows. The format is in `docs/spec/dashboard-v1.md` ("Data contract").
- `scripts/export.py`: backtest → `data/`. `scripts/update.py`: the daily job. `scripts/check.py`: recomputes every
  number on the page from the per-trade rows, and blocks the deploy if one differs or if private data appears.
- `.github/workflows/update.yml` (daily), `.github/workflows/pages.yml` (deploy after every push).

## Run it locally
    python -I -m http.server 8800 --bind 127.0.0.1
then open http://127.0.0.1:8800/ .

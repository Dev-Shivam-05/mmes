# Topic: design review of a public trading-research dashboard

## The owner's words (13 Nov 2026, Roman Hindi, translated)
"Create a dashboard for these strategies with a free live public URL. Take interactive dashboard designs from ChatGPT
and implement them. It must be completely premium and easy to understand." Then he sent 6 reference dashboards
(5 attached as `reference-*.png`) and added: "Everything in the UI must come from the data or the strategy, rather
than adding normal things just to fill space. Make the charts yourself from real data. Real candles, following what
has actually run."

## What the dashboard is
A static one-page site (no framework, ECharts 5.5.1, Inter + JetBrains Mono, dark default + light toggle) showing the
owner's NIFTY options research. Five strategy versions are shown: Weekly v3, Weekly LEG-20, Weekly LEG-40, Monthly k1
and v3 + Monthly. The page also has a forward paper tracker of the monthly strategy, refreshed daily by GitHub Actions
from NSE's free end-of-day file. The reader is the owner: a non-programmer trader who reads simple English.
The locked spec is attached as context (`dashboard-v1.md`). Its colour tokens and data contract are fixed. Its
"Data contract" lists every field that exists.

## The five screenshots of the current build (1440 px, dark)
`ours-1440-today.png`, `ours-1440-strategies.png`, `ours-1440-performance.png`, `ours-1440-months.png`,
`ours-1440-day.png` (the drawer opened from a trade row: that day's real 5-minute NIFTY candles, strike lines, entry
and exit markers).

## Rules for your answer
- Use only data that exists (the data contract). Propose no widget, field or number that the files do not hold, and
  no decoration without data (no avatars, search boxes, bells, order books, wallets).
- Each proposal must be concrete enough to build in under an hour: which section, what changes, and which exact
  tokens / sizes / labels.
- Keep the locked colour tokens. You may propose how to use them (glow, weight, hierarchy, density).

## Agenda
1. Compared with the references, what makes ours look less premium? List concrete visual changes: hierarchy, type
   sizes, spacing, density, panel treatment, glow, alignment, chart styling.
2. First screen for a non-programmer. In 5 seconds it must answer: "Is it making money? What is open now? What happens
   next?" Does it? What would you move, rename or cut?
3. Data-only rule: is anything on screen redundant, decorative, or repeated in two places? What should go?
4. Charts and interaction: the equity chart, the heatmaps, the exit-reason bar, the real-candle day drawer and the
   monthly NIFTY chart. What would make each one easier to read? Use existing fields only.
5. Wording: which labels or sentences would confuse the owner? Give the replacement text.
6. Mobile (390 px): what to change. You see desktop shots only, so reason from the layout.
7. Your ranked top 10 changes, each tagged with the agenda point it belongs to.

Answer each agenda point by number: agree / disagree because ... / need data: ... . End with the list of points still
open.

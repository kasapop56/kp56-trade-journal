# KP56 Trading Co-pilot — Feedback Loop & Factor Attribution
### Technical design document (for peer review)

**Status:** LIVE in production (`kp56-trade-journal.vercel.app`), 2026-08-20.
**Purpose of this doc:** give a reviewer everything needed to critique the design
without the build conversation. It describes a discretionary-trading "co-pilot"
for XAUUSD (gold) and, in particular, the **self-review / learning layer** added
in Phase 9 & 9b. The most important section for a reviewer is
[§10 Open questions](#10-open-questions-for-peer-review).

---

## 1. What the system is

A human trades XAUUSD manually (discretionary, on TradingView charts + MT5). A
"co-pilot" sits alongside and, on demand, produces a short disciplined **read**
(a market call + level plan) by merging two live data feeds and asking an LLM
(Claude `claude-sonnet-5`, low reasoning effort, Thai output). It is **advice
only — no auto-execution.**

Phase 9 closes the loop: the co-pilot now **grades its own past reads** against
what price actually did, and **learns which ingredients** (Mario structure, Fibo
levels, value area, ATR regime, session) correlate with winning reads.

Everything is a **layer on top of already-live ingest** — no new market data
sources, minimal EA/indicator changes.

- Stack: vanilla JS static site + Vercel serverless functions (Node) + Supabase
  (Postgres + RLS + Realtime). **Not** Next.js.
- Constraints: Vercel **Hobby plan** → max **12 serverless functions**, no
  sub-daily cron. Evaluation is triggered on dashboard tab render (like a
  data-driven refresh), not by cron.

---

## 2. Data sources (ingest — pre-existing)

| Source | Table | Written by | Notes |
|---|---|---|---|
| MT5 "Mario" SITREP (~hourly) | `market_sitreps` | `api/sitrep.js` (webhook) | bias M15/M5, POC/VAH/VAL (+prev day), HTF confluence, order-block summary, scored supply/demand zones (jsonb w/ tags+score+tier) |
| TradingView Fibo frames | `fibo_snapshots` | `api/fibo-snapshot.js` (webhook) | active side S/B, leg direction, focus/test entry levels, TP/SL, frame high/low/mid |
| Live price heartbeat (~30s) | `kp_price` | `api/price.js` | single upserted row |
| Live open positions (~10s) | `kp_positions` | `api/positions.js` | broker ground-truth snapshot (self-healing) |
| Closed-bar price feed | `trade_events` (`event='BAR'`) | RainbowPilot EA | `payload.ctx.bar1=[o,h,l,c]`, `payload.t_gmt` (GMT close). **The replay backbone.** |
| Manual-trade study events | `trade_events` (OPEN/MODIFY/CLOSE) | JournalSync EA | position reconstruction, MFE/MAE |
| Closed trades | `mt5_trades` | JournalSync | nightly trade grading |

---

## 3. New tables (the feedback loop)

- **`kp_market_state`** — one row per read evaluation: the merged snapshot the read
  was based on. Top-level: bias_m15/m5, vp_position, poc/vah/val, fibo_side,
  nearest_supply/demand (jsonb). `raw` jsonb now carries the **full factor set**
  (zones, htf_conf, h1_count, ob_summary, fibo_leg_dir) so attribution has complete
  ingredients going forward. Linked from each read via `market_state_id`.
- **`kp_signals`** — the read log: `ts, trigger_type, headline, message, price,
  bias_call (Buy|Sell|No trade), zones_referenced, market_state_id, delivered_to,
  meta`. (Note: no `symbol` column — symbol defaults to config.)
- **`kp_atr`** — daily ATR "ladder" frame, one row per (symbol, trading-day):
  `day_open, atr, atr_len, method, day_high/low, bands (jsonb ±0.25…±1.25 ATR)`.
  Fed by the "Daily ATR Zones" TradingView indicator's once-a-day alert →
  `api/fibo-snapshot.js` (type-routed `"daily_atr"`).
- **`kp_read_outcomes`** — one row per graded read (PK `signal_id`). Fields:
  `verdict, day_type, direction_actual, fav_atr, adv_atr, fav_pts, adv_pts,
  reached_band, target_zone, reached_target, zone_behavior, behavior_note,
  atr_source, bars_seen, meta`. `meta.factors` holds the ingredient snapshot used
  by attribution (no dedicated columns — aggregation is done in JS).
- **`kp_reports`** — nightly report log.

All new tables: anon-SELECT RLS (dashboard reads via anon key), writes via
service-role, added to Realtime.

---

## 4. Pipeline / data flow

```
                 ┌── market_sitreps (MT5) ──┐
 read request →  │                          │→ buildState() → Claude read → kp_signals
 (🔍 button /    └── fibo_snapshots (TV) ───┘        │            (+Telegram)
  cron GET)           + kp_price + kp_positions      └→ recordState() → kp_market_state
                                                        (+ carry_forward context injected)

 tab render →  /api/fibo-eval?target=reads&write=1
                     → runEval(): loadBars(trade_events BAR) → buildDays()
                       → for each kp_signals read: classify() → kp_read_outcomes
                       → buildFactors() → meta.factors

 tab render →  /api/fibo-eval?target=attribution  → runAttribution(): group by factor → hit-rate

 nightly 🌙 →  /api/report → runReport(): runEval (fresh) + runAttribution
                       + grade mt5_trades → Claude coach → Telegram + kp_reports
```

---

## 5. Method — how a read is graded (`classify()` in `api/_kp_eval.js`)

The measuring frame is a **daily-open ± ATR ladder** (0.25/0.5/0.75/1.0/1.25 ×
ATR), the same ladder the trader sees on the chart. Steps:

1. **Load** all `BAR` bars since the lookback window; group into trading days
   (`buildDays`), keeping each day's open/high/low/close + its bar list.
2. **ATR frame:** use `kp_atr` for that day if present, else a fallback ATR
   computed from the BAR feed (SMA of daily true range). **ATR is used only as a
   size yardstick** (daily volatility ≈ broker-independent).
3. **Replay** bars *after* the read, capped to the read's trading day:
   - `fav` = favourable excursion from the read price in the call direction;
     `adv` = adverse excursion. Expressed in ATR units (`fav_atr`, `adv_atr`) and
     points.
   - **Verdict** (first-touch): reach `+winAtr×ATR` before `−lossAtr×ATR` → `WIN`;
     hit the loss level first → `LOSS`; a bar that hits both → `LOSS` (tie is
     conservative because OHLC can't order intrabar). Neither, and the day is
     over → `STALL` (both excursions `< stallAtr×ATR`) or `PARTIAL`. Still today →
     `PENDING`. Past day, unresolved → `EXPIRED`.
   - **"No trade" calls:** correct if the day was BALANCE/RANGE (`OK_NOTRADE`),
     else `MISSED` (a move happened while sitting out).
4. **Day type** = day travel ÷ ATR → `BALANCE (<0.5)`, `NORMAL`, `TREND (≥1.0)`,
   `OUTSIZED (≥1.5)`.
5. **Zone behaviour** (of the nearest opposing zone the read leaned on):
   `HELD / BROKE / SWEEP_RECLAIM / UNTESTED`.
6. **`behavior_note`** — one Thai line in ladder language, e.g.
   *"went +0.75 ATR (75pt), against 0.25 ATR · quiet day · zone 4319 held"*.

Thresholds (`_kp_config.eval`, all **observational**, tune from data):
`winAtr 0.5, lossAtr 0.5, stallAtr 0.25, dayBalanceAtr 0.5, dayTrendAtr 1.0,
dayOutsizedAtr 1.5`.

**Look-ahead control:** each read's tradeable window is capped to its own trading
day (an entry days later would be a dead level price wandered back to). Un-entered
past reads become `EXPIRED`, not perpetual `PENDING`.

---

## 6. Trading-day boundary (selectable mode)

Only the **daily** ATR frame is broker-sensitive (M15/M5 Fibo/Mario align across
brokers; a "daily" candle is cut at each broker's own server rollover). Mixing the
broker's daily-open with a different day window skews `day_type`. Mode is therefore
selectable (`_kp_config.eval`):

- **`dayWindow: 'chart'`** (default): day starts at `dayCutUtcHour` UTC
  (GBE gold ≈ 4) → `day_type` + anchor **match the Daily ATR Zones indicator**.
  Portable — change `dayCutUtcHour` per broker.
- **`dayWindow: 'session'`**: Bangkok civil day (00:00 +07), consistent with the
  report/Fibo cut; ATR used purely as magnitude; broker-agnostic.

Implemented via mode-aware `dayShiftMs()` behind `bkkDay`/`bkkDateStr`, so day
grouping, read-capping, and ATR-date lookup all honour the mode with one switch.
`dayCutUtcHour=4` was inferred from the D-bar countdown and validated indirectly
(today's post-rollover read classified BALANCE, matching the chart's ~21pt daily
bar); to be reconfirmed against the first real alert's `kp_atr.ts`.

---

## 7. Factor attribution (`runAttribution()`)

For each read, `buildFactors()` snapshots the ingredients present + alignment
flags into `meta.factors`:

- `call`, `bias_m15`, `bias_m5`, `bias_conflict` (M15≠M5)
- `call_vs_m15`, `call_vs_fibo_leg` (with / against)
- `mario_fibo_aligned` (M15 bias vs Fibo active side)
- `vp_bucket` (premium / discount / balance / mid)
- `zone_source` (MT5 / Fibo), `zone_tier`, `zone_score_bucket` (high/mid/low),
  `zone_tags` (BOS / CHoCH / confluence tags)
- **`zone_state`** (fresh / retested), **`zone_retest_count`**, **`zone_fresh`** —
  Zone Freshness (see §7.1)
- `atr_day_type`, `reached_band`, `session` (asia / london / ny)
- `htf_conf`, `ob_summary`

Aggregation groups outcomes by each dimension and computes a **directional
hit-rate = WIN / (WIN + LOSS)** per bucket, with a `small_sample` flag (n<3).
Exposed at `/api/fibo-eval?target=attribution`; surfaced in the nightly report as
a "what works" block (the prompt is told to honour `small_sample` and never
fabricate a percentage).

**Design intent:** capture ingredients *now* so no backfill is ever needed;
numbers become meaningful only after weeks of accumulation.

### 7.1 Zone Freshness (implemented 2026-08-20)

Motivation: reads are stateless, so the co-pilot would re-issue the same
supply/demand zone even after price had already tested it and given its move — a
re-used zone is generally weaker (liquidity consumed). Two parts:

1. **Read-time context (`buildZoneUsage` in `_kp_lib.js`):** for each nearest zone,
   replay today's BAR feed to count how many times price has TESTED it (`tests`)
   and whether it has closed THROUGH it (`broke`), injected into the read as
   `zone_usage`. The prompt tells the model: `tests=0` → clean first-touch;
   `tests≥1` → manage tighter / partial faster / require a fresh rejection;
   `broke=true` → zone compromised, role flipped; consolidating-into-zone on a
   retest → likely to break, not hold.
2. **Attribution factor (`zoneFreshness` in `_kp_eval.js`):** each read's target
   zone gets `zone_fresh` / `zone_retest_count` / `zone_state` (fresh vs retested)
   → a new attribution dimension, to test the hypothesis "fresh zones out-perform
   re-used ones."

A "test" = a bar whose range overlaps the zone band after being outside it
(discrete touches, debounced). Read-time context toggle `_kp_config.zoneFreshness`.

---

## 8. Carry-forward (descriptive)

Before each new read, `buildCarryForward()` injects into the prompt: today's ATR
ladder frame + a digest of the last completed day (day type, direction, zones that
held/broke/were swept, the co-pilot's own lean vs how it resolved). This is
**descriptive context only** — it does not change the call by rule. The
score-driven auto-adjust (feeding proven factor edges back into the call) is
deliberately **deferred** until ~2–4 weeks of data exist.

---

## 9. File inventory

Serverless routes (`api/*.js`, each = 1 function; **12/12 used**):
`sitrep, fibo-snapshot (also daily_atr + fibo events), fibo-eval (also
?target=reads/attribution), fibo-sim, ingest, context, positions, price,
analyze, report, sitrep-latest, post-plan`.

Non-route modules (`api/_*.js`, not counted as functions):
- `_kp_lib.js` — engine: `buildState`, `evaluateTriggers`, `callClaude`,
  `recordState`, `buildCarryForward`, `runAnalysis`. Holds the co-pilot system
  prompt.
- `_kp_eval.js` — evaluator: `loadBars`, `buildDays`, `computeAtr`, `classify`,
  `buildFactors`, `runEval`, `runAttribution`, day-boundary helpers.
- `_kp_report.js` — `runReport`, `copilotAccuracy`; imports `runEval`/`runAttribution`.
- `_kp_config.js` — all tunables.

Front-end: `js/copilot.js` (renders the co-pilot tab, kicks the evaluator on
render (throttled 60s), shows verdict badges), `css/style.css`.

Indicator: `DailyATRZones.pine` (Pine v5; adds a once-a-day `alert()` emitting
`{type:"daily_atr", secret, symbol, atr, day_open, atr_len, method, ts}`).

SQL: `supabase_schema_kp_atr.sql`, `supabase_schema_kp_read_outcomes.sql`
(+ earlier `kp_copilot`, `kp_price`, `kp_positions`, `kp_reports`).

---

## 10. Open questions for peer review

These are the areas the author is least certain about — please scrutinise:

1. **Statistical validity of attribution.** Hit-rate = WIN/(WIN+LOSS) over tiny
   samples (currently ~5 decided reads). Many factor dimensions are tested at once
   → multiple-comparisons / false-discovery risk. Is `small_sample n<3` anywhere
   near strict enough? Should there be a minimum decided-N gate and a confidence
   interval before any factor is reported as an "edge"?
2. **Verdict thresholds.** `winAtr = lossAtr = 0.5×ATR`, symmetric first-touch,
   tie→LOSS. Is 0.5 ATR a sensible "played out" bar for a discretionary read? Does
   symmetric win/loss bias the hit-rate? Intrabar ordering is unknowable from OHLC
   — is tie→LOSS the right conservative choice, or should ties be excluded?
3. **Same-day cap vs late reads.** Reads late in the trading day have little runway
   → structurally biased toward STALL/PENDING/EXPIRED. Is the same-day cap fair, or
   should the window be a fixed horizon (e.g. N bars / N hours) regardless of the
   day boundary?
4. **`MISSED` semantics.** A "No trade — wait for the edge" read is scored `MISSED`
   if the day trended, even if no good entry ever appeared. Is that a fair penalty,
   or should "correctly avoided a bad entry" be distinguishable from "missed a
   clean move"?
5. **Fallback ATR.** Days without a real indicator alert use an SMA-of-daily-TR
   ATR computed from the intraday BAR feed, which can mis-estimate (feed gaps →
   understated ranges) and skews `day_type`. How much should day_type be trusted
   before real ATR history accumulates?
6. **Day boundary.** `dayCutUtcHour=4` is inferred, not confirmed; broker DST or
   server changes would silently break alignment. Better to derive it from the
   real alert timestamp each day?
7. **Single feed dependency.** The whole replay depends on one EA (RainbowPilot,
   demo) streaming `BAR` events. Gaps → `NO_BARS`/`PENDING`. Symbol suffix
   ('XAUUSD' vs 'XAUUSDr') is matched by prefix — robust enough?
8. **Correlation vs causation.** Factors are correlated (e.g. "mid value area" +
   "No trade" co-occur). Attribution reports marginal hit-rates with no control for
   confounders. Is a marginal breakdown misleading; is a simple model (or at least
   cross-tabs) warranted before acting on any edge?
9. **Read price basis.** The read price `P0` is a snapshot that may be stale
   (`price_age_min`); excursions are measured from a possibly-stale `P0`. Impact on
   fav/adv accuracy?
10. **Selection bias.** Reads are manual/event-triggered, not uniform samples of
    market states, so attribution describes "states the trader asked about", not
    the market. Does that invalidate cross-read comparisons?
11. **LLM read variance.** The read (Buy/Sell/No trade + levels) is LLM-generated
    at low effort; the same state can yield slightly different calls. How much does
    that noise floor limit what attribution can ever learn?
12. **Zone identity & test-counting.** Zone Freshness (§7.1) counts a "test" as a
    bar range overlapping the zone band after being outside it. Zones are taken from
    the current nearest supply/demand, not tracked as persistent objects across
    reads, so the same structural zone drifting a few points isn't linked. Is the
    overlap/debounce heuristic robust, and does per-read (not per-zone) accounting
    mis-count freshness when zones shift intraday?

---

## 11. Design principles (rationale)

- **Reuse, don't re-ingest.** The co-pilot is a layer; it never re-points webhooks
  or duplicates market data.
- **Observational first.** Grade and log for weeks before letting scores change
  behaviour; let data pick thresholds (a lesson from prior overfit/out-of-sample
  work on this account).
- **Advice only, no auto-execution.**
- **Honesty over flattery** in the reports (grade the co-pilot itself, flag when it
  was wrong, honour small samples).
- **Match what the trader sees** (ATR ladder, day type align to the chart).

---

*End of document. For the live diagnostics a reviewer can hit (read-only GET, no
auth):* `…/api/fibo-eval?target=reads` (dry) and `…/api/fibo-eval?target=attribution`.

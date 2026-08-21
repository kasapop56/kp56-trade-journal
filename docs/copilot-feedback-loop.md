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
  meta`. (Note: no `symbol` column — symbol defaults to config.) Since Phase 9c
  (§14) `meta` also carries `plan` (structured level plan), `plan_source`,
  `prompt_version` and `freshness` (input ages at read time).
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
    → **MEASURED, see §19** (2026-08-20). The call is 100% stable; the *zone
    selection* is not, and it decides whether a plan fills at all — so the variance
    lands on sample membership, not on the calls.
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

*Live diagnostics (read-only GET, no auth). For the live diagnostics a reviewer can hit (read-only GET, no
auth):* `…/api/fibo-eval?target=reads` (dry) and `…/api/fibo-eval?target=attribution`.
---

## 12. Peer review round 1 — Fable 5 (2026-08-20)

This doc was sent to Claude Fable 5 for an independent second opinion. The reviewer
read the doc, then verified it against `_kp_eval.js`, `_kp_lib.js`, `_kp_report.js`,
`_kp_config.js`, `fibo-eval.js`, `fibo-snapshot.js` and the BAR emitter in
`RainbowPilot.mq5`, and pulled both live diagnostics endpoints.

**Live state at review time:** 15 reads · 5 decided (1W/4L) · **1** real `kp_atr`
row · 9 days of bars · **13/15 reads on days labelled `OUTSIZED`**.

> **Headline verdict.** "The plumbing is genuinely good, but the grader is measuring
> a different trade than the one the co-pilot recommends, the regime labels are
> currently corrupted by the fallback ATR, and the attribution layer as configured is
> mathematically incapable of ever reaching statistical significance. The one
> behavioural insight the loop has produced so far ('too timid — 8/10 No-trades were
> MISSED') is substantially a measurement artifact."

### 12.1 Findings

**[CRITICAL] 1 — The verdict grades a trade nobody was advised to take.**
`classify()` measures first touch of ±0.5×ATR from `P0` (the snapshot price at read
time), but the reads are *level plans*: the system prompt forbids mid-range entries
and demands zone-edge entries with SL/TP. A read "Sell 4340, SL 4348, TP1 4325"
issued at 4325 is graded as *sell-at-market-4325* — the entry the read told the
trader not to take. A plan-replay engine already exists for Fibo frames
(`replaySide()`); the co-pilot was given a cruder yardstick that contradicts its own
philosophy. Every attribution number inherits the mislabelling.
*Fix:* emit a machine-readable plan, grade with the `fibo-eval` state machine
(entry = first zone touch → TP1-vs-SL first touch, no fill → `NO_FILL`), and keep the
±0.5 ATR measure as a separately-named "directional lean accuracy".

**[CRITICAL] 2 — The first "insight" is manufactured by the fallback ATR + the
whole-day MISSED window.** (a) `computeAtr()` accepts as few as **one** sample,
includes runt days (Sunday stub, EA-offline gaps), and the feed is 9 days old →
understated ATR → inflated travel÷ATR → everything classifies TREND/OUTSIZED (13/15
live). (b) Buy/Sell reads are graded on *post-read* excursion, but "No trade" reads
are graded against the whole day's `day_type`/`direction_actual`, computed open→high/low
**including price action before the read** — so a correct 20:00 "No trade" after the
morning already trended is graded `MISSED`. Compounded: almost no day is BALANCE, so
almost every past-day "No trade" auto-grades MISSED → "8/10 MISSED → too
conservative". Acting on that would change real trading behaviour on an artifact.
*Fix:* seed `kp_atr` from the 3-year Dukascopy M1 archive; refuse `day_type` when
`atr_source='computed'` from <10 complete days; grade "No trade" on post-read travel
only, and distinguish "a move happened but never offered a zone entry".

**[CRITICAL] 3 — Attribution cannot reach evidence by construction, not by patience.**
Read rate ≈1.7/day, decided fraction ≈33% → a rolling 30-day window caps decided
reads at ~17 **forever**; the window discards data as fast as it accrues. That sample
is split across ~12 dimensions × 2–6 buckets ≈ 30+ simultaneous hit-rates.
Wilson 95% CI on the live 1W/4L (20%) is ≈[4%, 62%]; detecting a 65%-vs-50% edge at
80% power needs ~100–130 decided reads *per bucket*. With ~30 buckets of n≈8 coin
flips, P(at least one bucket ≥75%) ≈ 99% — and the report prompt is told to "surface
the 2–3 STRONGEST edges" from buckets sorted by hit-rate descending: a machine built
to harvest the winner's curse and phrase it in confident Thai.
Two concrete bugs: `small_sample: b.n < minSamples` flags on **n** (all verdicts) not
on the decided base `win+loss` the percentage uses (live: "Sell 0% (n=4)" unflagged);
and samples aren't independent (reads cluster within days).
*Fix:* Wilson CI per bucket, suppress percentages below ~10 decided, no "edge" below
~30–50 decided with a CI excluding 50%, sort by CI lower bound, cluster by day,
preregister ≤5 hypotheses, widen the window — and until then **remove the 📊 block
from the nightly report**.

**[HIGH] 4 — Three different "trading days" coexist, joined by string equality.**
Evaluator = chart-mode UTC−04:00; `kp_atr` ingest stamps the **Bangkok** civil date;
Fibo eval / report / carry-forward = Bangkok. The ATR join is
`atrByDate.get(bkkDateStr(read_ts))` — one date string computed one way, matched
against a date string computed another. They coincide **only 11:00–24:00 Bangkok**.
Bonus: the column named `bkk_date` holds chart dates; broker DST silently shifts every
boundary by an hour with no error.
*Fix:* one shared day module for all five call sites, key `kp_atr` off the alert's own
`ts` through it, rename `bkk_date` → `trade_date`, warn loudly when a day with bars
has no `kp_atr` row.

**[HIGH] 5 — Verdicts are non-deterministic and history is silently rewritable.**
`runEval` recomputes and upserts everything each run; the tab calls `days=7`, the
report `days=2`, and the fallback ATR is computed from *that run's* window — so the
same read can be graded differently at 23:30 and next morning. No `eval_version` or
`prompt_version` is recorded, so tuning `winAtr` later silently re-grades all history.

**[HIGH] 6 — `atr_day_type` in the factor set is outcome leakage.** Day type is not
knowable at read time and is computed from the same travel that decides the verdict;
"buy reads win on TREND days" is near-tautological and not actionable ex-ante.
`reached_band` is worse (captured, not yet aggregated — a loaded footgun).

**[HIGH] 7 — The bar containing the read leaks pre-read price into the post-read
window.** `t_gmt` is stamped at emission and `bar1` is the just-closed bar, so a bar's
timestamp is its **close**; `filter(b.t > t0)` admits a full bar of pre-read movement.
Not uniform noise: reads fire *precisely* when price spikes into a zone, so the
triggering wick is counted as post-read adverse excursion — biased against exactly the
sweep-and-reclaim setups the system was designed around.

**[HIGH] 8 — The policy drifts while the statistics assume it's fixed.** Carry-forward
injects the co-pilot's own graded history into the prompt; prompt edits and LLM
sampling noise make the read-generating policy nonstationary, yet attribution pools all
reads as one policy. *Fix:* stamp `prompt_version`; report per version. And add
**phantom pseudo-reads** — grade a phantom "M15 bias" call and a phantom "No trade" at
every hourly SITREP with the identical yardstick — to get the base rate at unselected
moments. The co-pilot only deserves belief where it beats its own phantom baseline.

**[MEDIUM] 9 — Stale ingredients and stale `P0`, with staleness not persisted.**
`maxStateAgeMin: 180` treats a 3-hour-old M15 bias as fresh; `price_age_min` is
computed but never written to `kp_signals`, so stale-`P0` reads cannot even be filtered
at eval time — and cannot be recovered later.

**[MEDIUM] 10 — Same-day cap creates bucket-dependent censoring.** An Asia read has
~20h of runway, a late-NY read ~2h → decided-fraction varies by bucket, biasing every
cross-bucket comparison. Report each bucket's decided-fraction next to its hit-rate.

**[MEDIUM] 11 — Zone Freshness: right instinct, mismeasured.** Test counts reset at the
day boundary (liquidity doesn't respawn at broker rollover); zones aren't persistent
objects (a zone drifting $3 becomes "fresh"); counts come from a gappy single feed;
freshness is computed for the *nearest* zone, not the zone the plan used; Fibo "zones"
have `lo==hi` (knife-edge tests) yet feed the same factor. Treat `zone_state` as
unusable for now.

**[MEDIUM] 12 — Hit-rate is the wrong objective even when measured correctly.** Plans
are asymmetric (SL≠TP1, partial at TP1, runner to TP2); a 40% plan can be excellent.
Score in **R multiples** once plan-replay exists; keep hit-rate as descriptive.

**[MEDIUM] 13 — Everything degrades silently.** Alert deactivated on a Pine re-paste →
fallback ATR forever; EA down → bars vanish; eval only runs when a human opens the tab;
a Vercel timeout on the write path is swallowed by `fetch().catch(()=>{})`. *Fix:* a
health line in the report/dashboard (bar coverage % of 288 expected M5, `atr_source`
split, age of last `kp_atr` row, age of last eval write, verdicts changed since last
run) that visibly poisons the day's stats when red.

**[MEDIUM] 14 — LLM parse failures pollute the data silently.** An unparseable `CALL:`
line yields `bias_call=null`, which skips both the direction branch and the no-trade
branch → the read becomes a fake `STALL` ("market went nowhere"). Add `UNGRADEABLE`;
move the call+plan to structured output; measure the self-agreement noise floor by
replaying ~10 identical states.

**[LOW] 15 — `write=1` is an unauthenticated write endpoint** (quota risk, not
corruption — it's a recompute). **[LOW] 16 — Assorted:** `sessionOf` uses fixed UTC
hours (DST smears session buckets); `loadBars` ignores `payload.tf`; `kp_signals` has
no symbol column; `zone_tier` is built but never aggregated.

### 12.2 Reviewer's answers to §10

- **Q2 (tie→LOSS):** immaterial at M5 with a 1.0×ATR total span — the boundary-bar leak
  (#7) matters 100× more. Count ties separately for honesty.
- **Q7 (single feed):** prefix matching is fine; the real holes are the ignored `tf`,
  no gap detection, no backfill. The Dukascopy M1 pipeline can both seed ATR and
  cross-check the live feed's daily H/L (>$2 disagreement = flag the day).
- **Q9 (stale P0):** the killer detail is that staleness isn't *persisted* → unfixable
  retroactively. Start persisting today even if nothing else changes.

### 12.3 Reviewer's top 3

1. **Grade the plan, not the snapshot** (#1, #12, half of #14).
2. **Fix the yardstick's ground truth** — seed ATR, unify the day definition, exclude
   the boundary bar, re-grade No-trade (#2, #4, #5, #7).
3. **Statistical guardrails on attribution, and mute it until they exist** (#3, #8).

> "Do not trust the loop as a learning device yet — trust it as instrumentation. […]
> The honest answer to 'what has the co-pilot learned?' is: how to measure — not yet
> what works."

---

## 13. Author-side verification & response (Claude Opus 5, 2026-08-20)

Every finding that carries the argument was re-checked against the source before
being accepted. **They hold.**

### 13.1 Verified in code

| # | Claim | Evidence |
|---|---|---|
| 1 | Grader measures a trade the read didn't recommend | `callClaude` parsed **only** the `CALL:` line → `bias_call`; no zone/SL/TP was ever stored. `classify()` grades ±0.5 ATR from `P0` while the prompt forbids mid-range entry |
| 2 | Fallback ATR systematically small | `computeAtr` accepts **1** sample, averages whatever days the feed has, runt days included |
| 2b | MISSED uses a different window | `call==='none'` → verdict from `day_type`/`direction_actual`, both open→high/low |
| 3a | `small_sample` wrong denominator | `small_sample: b.n < minSamples` vs `hit_rate_pct = win/(win+loss)` |
| 3b | Sorted by raw hit-rate, then "strongest edges" | `.sort((a,z) => (z.hit_rate_pct ?? -1) - …)` + the report prompt |
| 4 | ATR join mixes two day definitions | `kp_atr.atr_date` = Bangkok +7 (`fibo-snapshot.js`); eval looks up with UTC−4 (`_kp_eval.js`). Agree **only 11:00–24:00 Bangkok** — the arithmetic checks out |
| 6 | `atr_day_type` leakage | stored as a factor **and** aggregated by `runAttribution` |
| 7 | Boundary-bar leak | `t_gmt = TimeGMT()` at emission, `bar1` = just-closed bar → the stamp is the bar's **close**; `payload.tf` exists at top level but `loadBars` drops it |
| 9 | `price_age_min` not persisted | present in `buildState`, absent from the `kp_signals` insert |
| 14 | Unparsed CALL → fake STALL | `call=null` → `dir=0` → `result` null → falls through to STALL/PARTIAL |

### 13.2 One thing the review missed

The comment above the ATR frame in `classify()` claims the ATR broker's cut "can no
longer skew `day_type`" because the day is measured on our own window. That is true
only in `session` mode. The live config is **`chart`** mode, where `dayOpen` **is**
`kp_atr.day_open`. So when the date join in #4 misses, `dayOpen` silently falls back to
the first bar the EA happened to emit — an inflated ATR *and* a wrong anchor, from the
same failure. #2 and #4 are one bug, not two.

### 13.2b Found while backfilling: the co-pilot has never advised an entry

Running the plan recovery over the 16 stored reads turned up something **neither
review caught**, and it outranks finding #1.

| Reads **with** a position open at read time | 4, 7, 9, 10, 11 → **Buy/Sell** · 12 → No trade |
|---|---|
| Reads with **no** position | 1, 2, 3, 5, 6, 8, 13, 14, 15, 16 → **all "No trade"** |

The split is total. **Every directional call on record was made while a position was
already open** — those reads are the 🧾 live-order coaching mode, and their `CALL:`
word echoes the exposure the trader already has rather than advising an entry. Read 9
is the clearest case: `bias_call: Buy`, and the entire body is management advice on an
already-open 0.05 buy ("TP ไกลเกินจริง ควรดึงลงมา"). No entry was ever proposed.

Consequences:

1. Only `Buy`/`Sell` reads can produce `WIN`/`LOSS`, so **the entire live 1W/4L record
   — the headline "hit rate" — is computed on reads that advised no entry at all.**
   It measures whether the trader's *existing position* moved favourably, attributed
   to the co-pilot as if it had called the trade.
2. The mirror image explains the "too conservative" artifact from the other side: with
   no position open the co-pilot has said "No trade" **10 times out of 10**. That is
   structural (no position → nothing to coach → wait for the edge), not timidity, so
   "lean more aggressive" is the wrong lesson twice over.
3. The 🔴/🟢 markers are **not** a reliable entry signal either: with positions open the
   model reuses them for existing trade groups (read 12: `🔴 ไม้เก่าทั้งหมด (entry
   4386-4430)`). And a bare `Sell …` line is often the position block
   (`Sell 0.01 @ 4340.36 · SL 4349.24 · TP 4314.81`) — the first version of the
   fallback parser swept that into a fake $34-wide "advised zone", which is how the
   whole pattern surfaced. A false plan is worse than no plan.

So reads must be partitioned by **`read_kind`** (`entry` vs `manage`) before anything is
graded, and management reads need their own yardstick (was the SL/TP advice good?),
not the directional one. This is captured from now on (§14) and backfilled for history.

### 13.3 Where the review is softened

1. **Plan-replay is not a drop-in replacement for the current yardstick.** The construct
   is wrong, but plan-replay introduces `NO_FILL`, which will swallow a large share of
   reads — it makes the sample starvation of #3 *worse*. Keep **both** tracks: rename the
   current metric to what it actually is (directional lean — symmetric, clean 50% null,
   dense coverage) and add plan-replay as the slow-accumulating truth metric. Do not
   delete the dense one.
2. **The phantom-read baseline (#8) is the best idea in the review and it is buried.**
   It reuses `classify()` verbatim, costs almost nothing, and is the only thing that turns
   the loop from self-description into a comparison against a null. It ranks *above* the
   plan-replay build on value-per-effort.
3. **Degrade the 📊 block, don't delete it.** Show raw W/L tallies with no percentages and
   no "strongest edge" phrasing until a bucket clears ~10 decided. Counts are honest at any
   n; deleting the block kills the habit, keeping percentages teaches noise.

### 13.4 Action plan

The decisive argument for acting now: there are **15 reads over 9 days**. Re-grading
history is free today and expensive in three months.

| Step | Work | Findings | Status |
|---|---|---|---|
| **1** | **Capture what cannot be backfilled** — structured plan (side/zone/SL/TP1/TP2) into `kp_signals.meta`, plus `price_age_min`, `prompt_version`, `eval_version` | 1, 5, 8, 9, 14 | ✅ **DONE 2026-08-20** (§14) |
| **1b** | **Partition reads by `read_kind`** — stop grading management notes as directional calls; management reads get their own yardstick | §13.2b | ✅ captured 2026-08-20 · grading split still ⬜ |
| 2 | Cheap correctness cluster — one shared day fn + key `kp_atr` off the alert `ts`; exclude the boundary bar (`b.t − tfMs ≥ t0`); fix the `small_sample` denominator; drop `atr_day_type` from the attribution dims; add `UNGRADEABLE`; grade No-trade on post-read travel only | 2b, 4, 6, 7, 14 | ✅ **DONE 2026-08-20** (§15) |
| 3 | ~~Seed `kp_atr` from the 3-year Dukascopy archive~~ — **DROPPED (trader's call, 2026-08-20).** Gold's 2026 regime differs enough from 2023–25 that a 3-year ATR would import the wrong volatility scale: "more pain than gain". It also contradicts the project's own out-of-sample lesson (see the CISD work: no edge in choppy gold, profit only in the bull regime). Replaced by: keep the **recent-window** fallback (already regime-local, measured at 83% of truth) with a minimum-sample floor, and make the indicator alert the primary source | 2, 5 | ✅ resolved by decision |
| 4 | Phantom-read baseline at every SITREP + the health header | 8, 13 | ⬜ |
| 5 | Wilson CIs + decided-N gates + day clustering; degrade the 📊 block until they land | 3 | ⬜ |
| **6** | **Plan-replay grading — PROMOTED to next.** No longer a "second track": per §16, 10 of 16 reads are pending limit plans, so replay (zone touch → TP1-vs-SL) is the *only* way to grade the majority of what the co-pilot produces. Everything else it has ever said is position coaching | 1, §16 | ⬜ **next** |
| 7 | R-multiples, persistent zone registry, censoring controls | 10, 11, 12 | ⬜ deferred — revisit at ~3 months of data |

**Standing conclusion (agreed):** the loop is trustworthy as *instrumentation*, not yet
as a *learning device*. The "too conservative" finding is not actionable — and per
§13.2b, neither is the hit rate: **both** live headline numbers are artifacts of the
entry/manage confusion, from opposite directions.

---

## 19. Self-consistency — the noise floor (2026-08-20)

**Question that prompted it:** would a *multi-agent ensemble* (several roles each
producing a plan, then voting) improve the co-pilot? Before answering, the cheaper
question had to be settled first: **how often does the single agent agree with
itself?** That number caps what any ensemble could average and what any attribution
layer could ever detect — it is the control group for the whole idea. It is also the
open question §10.11 raised and never measured.

### 19.1 Method

Twelve market states were frozen and replayed **five times each** through the live
read policy (60 calls, `prompt_version f32d3fdf`, `claude-sonnet-5`, `effort: low`).

- **States** = every position-free (`read_kind: 'entry'`) read in `kp_signals`,
  reconstructed as-of its own timestamp: the same `market_sitreps` row, the same
  `fibo_snapshots` row, the same zone list, the same input ages, plus an as-of
  carry-forward digest (prior days only) and an as-of `zone_usage` block
  (`zoneFreshness(..., beforeMs)` — bars strictly before the read). No look-ahead.
- **Calls** go through `callClaude()` itself — same system prompt, same `OUTPUT_HINT`,
  same parser. Read-only: no `kp_signals` row, no `kp_market_state`, no Telegram.
  Nothing entered the loop or the attribution window.
- **Grading** replays each replicate's plan through `replayPlan()` — the production
  engine, `entryFill: 'mid'` — against the real `BAR` feed.
- Cost: **$1.06** for 60 calls. Harness in `scratchpad/noise/`
  (`build-states.js` → `run.js` → `score.js`).

> **There is no determinism knob.** Sonnet 5 rejects `temperature`, `top_p` and
> `top_k` with a 400. This is a property of the policy, not a setting left wrong.

### 19.2 Result

| Layer | Agreement across 5 runs of one state |
|---|---|
| **Call** (Buy / Sell / No trade) | **12/12 unanimous — 100%** |
| **Stance** (wait / entry_now / stand_aside) | 11/12 — 92% |
| **Sides offered** (buy, sell, both) | 9/12 — 75% |
| **Levels**, given the same zone | median entry spread **$0.38 = 0.11R** |
| **Graded verdict** (`replayPlan`) | **7/12 — 58%** |

The co-pilot never once contradicted itself on direction. Its *graded record* moved
anyway. Five independent runs over the identical twelve states:

| run | record | decided | win rate |
|---|---|---|---|
| 1 | 4W 5L | 9/12 | **44%** |
| 2 | 1W 6L | 7/12 | 14% |
| 3 | 1W 6L | 7/12 | 14% |
| 4 | 2W 6L | 8/12 | 25% |
| 5 | 1W 6L | 7/12 | 14% |

**§17.4's "LOSS 4 · WIN 2" is one draw from this.** It sits inside the spread.

### 19.3 The noise is zone SELECTION, not arithmetic

The levels are not fuzzy. When two runs pick the same zone they copy it to the cent,
straight off the Mario list. What varies is **which zone off the discrete menu the
read decides to wait at**:

```
read 16  price 4496.15   supply menu: 4494.88-4497.27  and  4507.75-4510.29
  rep 1, 4, 5 → sell 4494.88-4497.27   → filled → WIN
  rep 2, 3    → sell 4507.75-4510.29   → never reached → PENDING
```

Four of the five split states are this, and it matters more than a flipped verdict:
a `LOSS` is a data point, a `PENDING` is **absence**, and absence is invisible to
attribution. **The sampler is quietly choosing which reads enter the sample.** That is
a censoring mechanism nobody specified, sitting upstream of every number the loop
produces — and it is worse than finding #10's bucket-dependent censoring, because it
is not a property of the state at all.

The single true WIN/LOSS flip is the same disease. On read 5 four runs offered only a
sell; run 1 added a buy at 4335–4338 while price stood at **4335.81** — inside its own
entry zone. That leg filled instantly and won. **The one WIN in that state came from
the replicate that broke the system prompt's own "never enter mid-range" rule.**

Conversely, where the structure is unambiguous the policy is very stable: reads 17 and
18 put 5/5 replicates on the same sell zone with stops within $0.50.

### 19.4 What this says about the ensemble

1. **A vote is worth nothing here.** It decides *direction*, and direction has **zero
   measured variance** — five agents return 5/5 unanimous on 12/12 states. That is a
   machine which is 100% confident and 0% informative: the correlated-vote trap, now
   demonstrated rather than argued.
2. **The disagreement is the signal — but an ensemble is the most expensive possible
   way to buy it.** Replicates diverge exactly where the menu holds two plausible
   adjacent zones (13, 15, 16) and converge where it holds one (17, 18). "Two candidate
   zones within $13" is computable from `state.zones` directly, for $0 and no extra
   call. Setup ambiguity is already in the input.
3. **Zone-selection noise wants a rule, not a vote.** A majority vote across five runs
   just returns the modal zone. The same determinism is available in code or prompt for
   nothing — and unlike a vote, it *removes* the variance instead of averaging it.
4. **If it is ever built, it belongs inside** as a new `prompt_version`: the hash splits
   attribution automatically, plan replay grades it free, and the grading
   infrastructure is the expensive asset already owned. Latency fits Hobby (~10 s per
   call measured; five in parallel lands inside `maxDuration: 60`).

**Decision (trader, 2026-08-20): no build.** Revisit once there is more data.

### 19.5 Limits of this measurement

- The **existence** of selection noise is established. The **magnitude is not.** Reads
  14/15/16 are near-duplicates of one setup and 17/18 were still unresolved, so the
  14–44% spread rests on roughly two or three independent situations — the same
  clustering finding #3 warned about. Do not quote the range as a measurement.
- Twelve states, two days, one bull regime, 12/12 `wait` reads. It may not hold in
  choppy gold.
- The result is **asymmetrically informative**: the prompt pushes hard toward "wait at
  the zone edge", so *high* agreement could have been the attractor talking. A messy
  result is the strong direction — which is what came back.
- Measured on `f32d3fdf` only. Nothing on the remaining roadmap (step 4 phantom
  baseline, step 5 Wilson CIs) touches `SYSTEM_PROMPT`, `OUTPUT_HINT`, model, effort or
  the two feature flags, so the number survives those steps; any prompt edit voids it.

### 19.6 Incidental finding — reads are being truncated

**4 of 60 calls (6.7%) hit `max_tokens: 900`**, were cut off, lost the `PLAN:` line and
silently fell back to the text parser (`plan_source: 'parsed'`). That is the exact
lower-fidelity path §17.2 traced verdict flips to, running on ~7% of production reads.
The cap clipped the *last* line, which is precisely the line the evaluator needs.

**FIXED 2026-08-20.** `CFG.maxTokens` 900 → **1600** (≈2× the measured p90 of 818;
output is billed on tokens generated, so the ceiling costs nothing). `api/analyze.js`
`maxDuration` 30 → **60** at the same time: a 900-token read already took ~17 s, so
raising the token cap without raising the time budget would have swapped a truncated
read for a *timed-out* one — which loses the whole read instead of one line. Verified
by replaying the three affected states (5, 8, 18): 5/5 clean, all `plan_source: json`,
9.7–12.2 s. Note the truncation event is stochastic (~7%/call), so that check confirms
the configuration and the absence of regression, not the tail event itself; the
argument for the fix is that the cap now sits far above any observed need.

### 19.7 Consequence for the standing conclusion

§13.4 concluded the loop is trustworthy as *instrumentation*, not as a *learning
device*. This sharpens it: **the instrument has a measurable jitter, and the jitter
acts on sample membership rather than on the readings.** Before any factor is called an
edge, it must clear not only a decided-N gate and a CI (step 5) but this floor — a
bucket difference smaller than the policy's own run-to-run variation is not evidence.

---

## 18. Closing the small gaps (2026-08-20, `EVAL_REV 9k`)

Five items that were each small on their own; two of them were silent-failure risks.

| Gap | What it was | Verified |
|---|---|---|
| Report summarised the wrong metric | It read `basis=lean` attribution — the directional measure that grades a market order the prompt forbids | now `basis=plan` |
| **Health was invisible** | The health block existed only inside an API response. Every failure here is quiet (a Pine alert stops firing, the EA goes down), so clean verdict badges could sit on missing data for weeks | one line in the nightly report + an amber banner on the co-pilot tab |
| **`read_price_age_min` captured but ignored** | Excursions are measured *from* the read price; a stale snapshot makes every distance wrong | `STALE_PRICE` above `maxReadPriceAgeMin` (5 min). A *null* age is a pre-9c read — unknown, not stale — so it is still graded |
| `sessionOf` assumed fixed UTC hours | London and New York change DST on different dates | asks Europe/London, America/New_York, Asia/Tokyo. **3 of 48 hour-slots reclassified**, all at session edges |
| `write=1` unauthenticated | It cannot require a key — the dashboard calls it on every tab render — so quota was open to anyone with the URL | server-side throttle: 30 s since the last outcome refresh. Verified: `1st: write (18 rows)` → `2nd: throttled, retry_in 29` |

`STALE_PRICE` and `UNGRADEABLE` join `manage` in being excluded from attribution.

---

## 17. Step 6 — plan replay (2026-08-20)

`EVAL_REV` 9c → **9h** across one session, because the first four versions produced
numbers that were impossible rather than merely surprising.

### 17.1 Mechanism

For every non-`manage` read with entry legs, each advised leg is replayed as a
pending limit order, in a track kept **separate** from the directional lean verdict:

- **entry** — the first bar that trades into the zone band. Fill is always *inside*
  the zone: the bar's open if it opened within the band, otherwise the edge price
  approached (a buy limit at the upper edge, a sell at the lower).
- **outcome** — TP1 vs SL, first touch wins; a bar touching both is a `LOSS`, since
  OHLC cannot order intrabar. Records `rr1`, MFE/MAE in R, bars held.
- **read verdict** — the leg that filled **first**, scorable or not. A read usually
  advises both sides; the first fill is the trade that would have happened.
- **not scored** — `NO_FILL` (price never came), `NO_LEVELS` (no SL or TP),
  `SL_IN_ZONE` / `TP_IN_ZONE` (a level closer than $0.50 to the fill).

Exposed as `?target=attribution&basis=plan` alongside the default `basis=lean`.
Never mixed: different questions, different null rates.

### 17.2 Four bugs, caught by output being impossible

| Symptom | Cause | Fix |
|---|---|---|
| `MFE 87R` | Fill taken at the bar's **open** when the bar opened outside the band → a sell filled at 4366.70 against a 4366.75 stop, R = **$0.05** | Fill clamped inside the zone; `MIN_RISK` $0.50 floor → `SL_IN_ZONE` |
| `RR 0` on a `WIN` | **`Number(null) === 0`** — finite, so a *missing* stop became a real-looking `0`. Risk = \|entry − 0\| = the whole gold price → a stop that can never be hit → automatic win | `num()` rejects null/undefined/`''` before converting |
| `LOSS` with `MFE 18.58R` | MFE/MAE kept accumulating to the end of the day, long after the trade was stopped out | Excursions stop when the trade resolves |
| Same setup, opposite verdicts 8 min apart (reads 1 vs 2) | When the first-filled leg couldn't be scored, the scorer fell through and graded *the other side* — so the verdict depended on parse completeness | First fill decides, scorable or not; otherwise the read is unscorable |

**The `num(null)` bug reached well beyond plan replay.** In `zoneFreshness` a zone
with a missing bound became the band `[0, 0]`, which nothing ever touches → `tests: 0`
→ reported **`fresh: true`**. Fresh zones have been over-counted, which is part of why
finding #11 called `zone_state` unusable — not only zone drift. It also made
`zone_behavior` read `UNTESTED` for those zones, and a null read price would have been
graded from `0` rather than skipped. **Every other `api/*.js` `num()` already had the
guard; `_kp_eval.js` was the only one without it.**

### 17.3 Where the fill sits inside the zone (trader's call, `9i`→`9j`)

The reward-to-risk looked implausibly small (0.30–0.37 on the winners), which turned
out to be two measurement faults, not bad plans:

1. **TP1 was being scored as the reward** when the read's own format is
   `TP1 … ปิด50% · TP2`. **Trader's ruling: score TP1 as a FULL exit** — the 50% close
   is advice inside the read, not the measuring rule — so `rr1` is simply the plan's
   reward-to-risk.
2. **The fill point was assuming the worst entry in every zone.** The co-pilot places
   its stop *just beyond the far edge* (read 1: zone ends 4366.75, SL 4368 — $1.25),
   so the plan is only coherent if the fill is deep in the zone. Filling at first
   touch quadrupled the risk.

Measured across all three conventions (`?fill=near|mid|far`):

| fill | WIN | LOSS | NO_FILL | median RR1 |
|---|---|---|---|---|
| near | 2 | 4 | 1 | 0.86 |
| mid | 2 | 4 | 1 | 1.06 |
| far | 2 | 4 | 1 | 1.73 |

**The verdicts are identical across all three** — a prediction that the convention
would flip wins and losses was wrong; four of the six decided plans have real zone
width and still resolved the same way. Only the R-multiples move. **Trader's ruling:
`entryFill: 'mid'`**, which fixes the RR reading without touching a single verdict.

### 17.4 Result

```
plan (fill=mid):  LOSS 4 · WIN 2 · NO_LEVELS 2 · NO_FILL 1 · PENDING 1
lean:             MISSED 6 · MANAGE 6 · OK_NOTRADE 1 · PENDING 3
```

**The run beyond TP1** (added at the trader's request): for every win, how far price
kept going past the target before returning to the entry price — what leaving at TP1
cost. Bounded at the return to entry, because past that a runner is at breakeven.

| read | RR to TP1 | ran beyond TP1 | came back to entry? |
|---|---|---|---|
| 14 | 0.71 | **+1.10 R** (533 pt) | no — still running at day end |
| 15 | 0.54 | **+0.83 R** (533 pt) | no — still running at day end |

Both winners took roughly **a third of the move that was there** and the market never
came back to offer the entry again. That is the first concrete, actionable signal the
loop has produced about read *quality* rather than about its own plumbing — targets
look set too close. It is also **one observation, not two**: reads 14 and 15 are
near-duplicates of the same setup, which is why both show the identical 533 pt.

Nothing here is a rate or an edge. Six decided plans across roughly four independent
situations remains a description, not a result.

Six decided plans, 2 wins. **This is not a win rate.** Reads 1 and 2 are the same
setup eight minutes apart; 14, 15 and 16 are near-duplicates of one another. Six
"decided" reads are roughly **four independent situations** — exactly the clustering
finding #3 warned about, now visible in the data rather than argued in the abstract.
Nothing here should be read as a result about the co-pilot's edge; what it does show
is that the machinery finally measures the advice that was actually given.

Two observations that *are* worth carrying forward, both descriptive:

- The two wins (reads 14, 15) had `rr1` of **0.37 and 0.30** — the target was closer
  than the stop. Winning at sub-1R reward-to-risk is a shape worth watching once
  there is enough data to say anything: it is how a good hit rate can still lose money
  (finding #12).
- One read produced `NO_LEVELS` because its plan was prose ("รอราคาเด้งขึ้นไปแตะโซน
  4351.5-4355.1 พร้อมสัญญาณกลับตัว") with no stop or target. The `PLAN:` line added in
  §14 prevents that going forward.

---

## 16. "No trade" was never no trade (2026-08-20)

The trader asked whether the co-pilot's caution is simply what an edge-based method
(Fibo + order blocks) produces — you wait for price to come to the level. Checking it
against the reads gave a sharper answer than expected.

**Yes, waiting is by design.** The system prompt forbids mid-range entries outright
("Never suggest entering at mid-range / POC. Only at zone edges with confirmation")
and names the wait explicitly ("the correct call is often 'no trade — wait for the
edge'").

**But the co-pilot was never silent.** Reading the three flat reads that had captured
no plan showed they all had one, written in an older bullet format the parser missed:

> **Read 1** (`CALL: No trade`) — *รอ Sell ที่ supply 4363–4366.75 · Entry ~4364.8-4366
> | SL 4368 | TP1 4358 | TP2 4354* · *รอ Buy ที่ demand 4343.22–4347.28 แบบ
> sweep-and-reclaim*

Across all 16 stored reads: **`wait` 10 · `manage` 6 · `stand_aside` 0 · `entry_now` 0.**
Every position-free read issued a complete conditional plan with zone, SL and TP. Not
one was genuinely "no opinion".

So **"No trade" is a labelling failure, not caution.** The word collapses two opposite
answers — *stand aside, I have no view* and *wait at this level, here is the entry, the
stop and the target* — and the loop recorded the second as the first. "The co-pilot had
no opinion 10 times" was really "the co-pilot issued 10 pending limit plans".

Consequences:

1. `read_stance` (`manage` | `entry_now` | `wait` | `stand_aside`) is now captured per
   read and backfilled. `MISSED` on a `wait` read means only "a move happened" — it is
   **not** a verdict on the plan.
2. **Plan-replay is promoted from deferred to next** (step 6). It is not a refinement
   any more: 10 of 16 reads are pending limit plans, and replay is the only way to
   grade them at all. The remaining 6 are position coaching. There is nothing else.
3. The open design question stands, but narrowed: not *"why is it so cautious"* — it
   isn't — but **"are its waiting levels good, and does it wait for the right ones?"**
   That is a question plan-replay can actually answer.

**Also resolved by the trader (same session):** the 3-year ATR seed is **dropped**.
Gold's 2026 regime differs enough from 2023–25 that importing that volatility scale
would be "more pain than gain" — consistent with this account's own out-of-sample
history. The recent-window fallback is regime-local by construction and measured at 83%
of truth; the fix is a minimum-sample floor, not more history.

---

## 15. Step 2 — grade the right reads, on the right day, from the right bar (2026-08-20)

`EVAL_REV` 9c → 9d (`eval_version: 9d-59aa51`). All 16 reads re-graded under the new
rule; the stamp keeps the two scoring regimes distinguishable.

### 15.1 What changed

**`classify()`**
- **`read_kind` partition** — reads taken with a position open get verdict `MANAGE`:
  out of WIN/LOSS, out of the hit rate, out of attribution.
- **Boundary bar excluded** — bars are stamped at their close, so `b.t > t0` admitted
  the bar containing the read. Now the bar must have *opened* at/after the read, using
  `payload.tf` (previously ignored entirely).
- **"No trade" graded on post-read travel**, not the whole day's travel from the day
  open. New verdict **`NO_ENTRY_OFFERED`**: a move happened, but price never came to
  the level the read said to wait for — using the plan legs captured in §14.
- **`UNGRADEABLE`** for an unparseable `CALL:` line (previously became a fake `STALL`).
- Records `read_kind`, `post_max_atr`, `leg_touched`, `entry_legs`, `runway_h`.

**`runEval()`**
- `kp_atr` joined on a **day index derived from the alert's own timestamp**, not on a
  date string (finding #4). Effect was immediate: `atr_source` went from ~all
  `computed` to `indicator` wherever a row exists.
- **health block** — `atr_source` split, days with bars but no ATR row, the alert's
  observed UTC hours, and a `warn` line. Currently: *"8/9 days have bars but no
  `kp_atr` row"*.
- **dry mode now runs the classifier** and returns a per-read preview instead of
  skipping it, so a change is inspectable before anything is written.

**Attribution** — `small_sample` counts **decided** reads (the base the percentage
uses, not `n`); `atr_day_type` dropped from the aggregated dimensions (outcome
leakage); buckets with a decided base sort first.

**Report** — accuracy excludes manage reads and counts them separately; the 📊 block
is degraded to counts-only, with an explicit ban on the words edge/rule/trap and a
one-line "still collecting" mode under 20 decided.

**Other** — unknown `?target` now 400s instead of falling through to the Fibo frame
evaluator; dashboard badges for the three new verdicts.

### 15.2 What the re-grade actually showed

```
tally:  MISSED 6 · MANAGE 6 · OK_NOTRADE 1 · PENDING 3
attribution: total_with_factors 10 · decided 0 · skipped_manage 6 · buckets passing the gate 0
```

**The hit rate is gone — there is none.** Every previously "decided" read (the 1W/4L)
was a management note; with those correctly excluded, **zero** reads have a
directional outcome, and **zero** attribution buckets pass the decided-gate. That is
the honest state of the evidence, and it is the strongest possible confirmation of
§13.2b.

**One review assumption did not survive measurement.** Finding #2 argued the computed
ATR was badly understated ("gold does not have 13 outsized days in 15"). Measured
against the real indicator value on the same instrument: **computed 73.31 vs indicator
88.81 — the fallback is 83% of the truth, a 17% understatement, not an
order-of-magnitude error.** Gold genuinely did travel ~$110–160/day this week, so the
`OUTSIZED` labels are largely *real*. Consequences:

- Seeding ATR history (step 3) is still worth doing for determinism, but it is a
  precision fix, not the artifact-killer it was billed as — **urgency downgraded**.
- The "too conservative" observation is therefore *not* mainly an ATR artifact either.
  It is a real pattern with a **structural** cause: with no position open the co-pilot
  has nothing to coach, so it says "wait" — 10 times out of 10. The 6 `MISSED` reads
  are honest. The wrong lesson would still be "be more aggressive"; the right question
  is why the co-pilot never proposes an entry when flat.

**The day-cut is still unconfirmed.** The new diagnostic reports
`atr_alert_utc_hours: [6]` against `day_cut_utc_hour: 4` — but the only `kp_atr` rows
so far came from a **manual** `curl`, so that 06:00 reflects when the POST was sent,
not when the indicator fires. The diagnostic is in place; it needs one real alert to
mean anything.

---

## 14. Changelog — Phase 9c: capture-now (2026-08-20)

Step 1 of §13.4. No grading logic changed; this only records at read time what could
never be reconstructed afterwards.

**`_kp_lib.js`**
- `OUTPUT_HINT` now ends with a machine-readable line the user never sees:
  `PLAN: [{"side":"sell","zone":[4340,4344],"sl":4348,"tp1":4325,"tp2":4310}]`
  (one object per actionable side, `[]` for no trade).
- `parsePlan()` — two parsers: the model's `PLAN:` JSON line, else a fallback that reads
  the visible 🔴/🟢 level block. The fallback also works on **already-stored** reads.
- Legs carry `kind` (`entry` | `manage`) and each read carries `read_kind`, defaulted
  from whether a position was open at read time (the model's explicit `PLAN` `kind`
  wins). A leg starts **only** on a 🔴/🟢 marker, with the zone read before any SL/TP
  label and section markers closing the leg — a bare `Sell …` line is the 🧾 position
  block, not advice (§13.2b).
- `callClaude()` strips the `PLAN:` line from the body (dashboard/Telegram output is
  byte-for-byte unchanged) and returns `plan`, `plan_source`, `prompt_version`.
- `PROMPT_VERSION` = 8-char SHA-1 of `SYSTEM_PROMPT + OUTPUT_HINT + model + effort +
  carryForward + zoneFreshness` → the policy's identity, so attribution can be split by
  version instead of pooling reads from different policies.
- `runAnalysis()` writes a capture-now block into `kp_signals.meta`: `prompt_version`,
  `plan`, `plan_source`, and `freshness {price_source, price_age_min, sitrep_age_min,
  fibo_age_min, positions_source, positions_age_min}`.
- `runPlanBackfill()` — one-off recovery of plans from past reads' `message` text.

**`_kp_eval.js`**
- `EVAL_VERSION` = `EVAL_REV` + hash of `CFG.eval` → stamped on every outcome row
  (`meta.eval_version`), so a later threshold change can never silently re-grade history
  into the same bucket. Bump `EVAL_REV` whenever `classify()` itself changes.
- Outcome `meta` also carries `read_price_age_min`, `prompt_version`, `plan_source`
  (copied from the read), so stale-`P0` reads become filterable at eval time.
- The `kp_signals` select now includes `meta`; the run summary reports `eval_version`,
  the distinct `prompt_versions` in the window (`pre-9c` for older reads), and
  `plans_captured`.

**`fibo-eval.js`** — new maintenance route `?target=backfill_plans[&write=1]`
(no new serverless function; still 12/12).

**No SQL, no EA, no Pine change** — `kp_signals.meta` and `kp_read_outcomes.meta` are
already `jsonb`.

**Verified live, and it needed a fix first.** The first read through the new prompt
(signal 17) wrote the visible format perfectly and simply **stopped at the ⚠️ line** —
`plan_source: parsed`, the text-parser fallback. The instructions had been placed
*after* the "ใช้รูปแบบนี้เป๊ะ ๆ ตามลำดับ" block, so they read as commentary about the
format rather than part of it, and the ~14-line cap argued against adding a line.
Moving `PLAN:` inside the ordered template (directly under ⚠️), stating it does not
count toward the cap, and repeating it as a mandatory last line in the **system**
prompt fixed it: signal 18 returned `plan_source: json` with both legs structured, and
the line is stripped from the displayed message as intended.

This is worth recording as a pattern: the capture layer degrades **silently** — for
weeks it would have kept inferring plans from prose while appearing to work. Any
future change to the output contract needs one live read to confirm it, not a deploy.

**Deploy + one-off:**
```
git push                                  # Vercel auto-deploy
/api/fibo-eval?target=backfill_plans      # dry run — check `with_plan` and `sample`
/api/fibo-eval?target=backfill_plans&write=1
```


---

## Discretionary observations

Chart patterns noticed by hand — untested hypotheses waiting for the evaluator —
live in [`observations.md`](observations.md), not here. Nothing moves from there
into the prompt or the Pine until it has been measured.

### Daily true range (2026-08-21)

`kp_atr` now also carries the completed previous day's `day_high` / `day_low` /
`day_close` / `tr` / `prev_close`, written by `writePrevDay()` from the same
`daily_atr` alert. `atr` is the 10-day regime; `tr / atr` is the day. Migration:
`db_kp_atr_daily_tr.sql`. Rationale and the falsified hypothesis that produced it:
[`observations.md`](observations.md).

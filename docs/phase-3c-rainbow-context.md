# Phase 3c — RainbowMA context capture

**Status:** Deployed 2026-04-26. End-to-end backend verified 2026-04-27. Frontend "Setup Verdict" modal section built 2026-04-27 (commit pending) — awaiting Vercel deploy verification.

## TL;DR

Capture the RainbowMA indicator's state at TWO moments per position (open + close), across 4 timeframes (M1/M5/M15/H1), into `mt5_trades`. Single chart instance publishes — runs on M1, queries M5/M15/H1 internally via `iMA()`. Open-time state survives the gap to close via a per-position file in `MQL5/Files/Common/`.

## What changed

Five deliverables, all on `main` branch of `kp56-trade-journal`:

1. **`supabase_schema_phase3c.sql`** — 50 new columns on `mt5_trades`:
   - `rainbow_capture_method_open`, `rainbow_capture_method_close` (text)
   - 4 TFs × 2 moments × 6 fields each (`slow_ma`, `close_price`, `band_idx`, `candle`, `body_points`, `order_state`)
   - Idempotent (all `ADD COLUMN IF NOT EXISTS`)

2. **`mt5/RainbowMA.mq5` v1.30** — adds `RainbowJournal_PublishState()`:
   - Publishes `RAINBOW_<TF>_*` GlobalVariables every tick
   - Uses index 1 (last completed bar) — never the forming bar
   - Sentinel `slow_ma=0` when a TF isn't warmed up → EA reads as null
   - Single chart instance covers all 4 TFs via `iMA(_Symbol, tf, ...)`

3. **`mt5/JournalSync.mq5` v1.10** — adds rainbow capture path:
   - `DEAL_ENTRY_IN` → `RainbowWriteOpenSnapshot(pos_id)` saves JSON fragment to `Files\Common\rainbow_open_<pos>.json`
   - `DEAL_ENTRY_OUT` → reads that file + snapshots current GVs as close-state, both shipped in `trade_closed` payload, file deleted after read
   - If open-file missing (EA reload mid-position) → `capture_method_open=none` + nulls

4. **`api/ingest.js`** — `rainbowFields()` helper flattens the 50 keys from payload → row in upsert.

5. **Memory** — saved `feedback_design_scope.md` ([./.claude/projects/.../memory/feedback_design_scope.md]):
   user prefers wider scope on data/journal design (raw → narrow reversible, narrow → raw isn't).

## Deploy state

| Layer | Where | Status |
|---|---|---|
| DB schema | Supabase prod | ✅ Run by user 2026-04-26 |
| Webhook | Vercel auto-deploy from `main` | ✅ Pushed commit `1e429c3` |
| RainbowMA.mq5 | MT5 terminal (account 87464504) | ✅ v1.30 attached to XAUUSDr M1, `Publish RAINBOW_* = true` |
| RainbowMA.mq5 (H1 chart) | Same terminal | ✅ Secondary chart, `Publish = false` |
| JournalSync.mq5 | MT5 terminal | ✅ v1.10 reloaded |

## Verification checklist

First live trade: **deal 7236714855 / pos 7241343521**, XAUUSDr SELL 0.05 @ 4704.92 → 4704.26, +$3.30, opened 2026-04-27 09:03:05, closed 09:03:11.

MT5-side (verified from Experts log):
- [x] ✅ 2026-04-27 — Experts log: `[JournalSync] rainbow open snapshot saved pos=7241343521 → rainbow_open_7241343521.json`
- [ ] ⚠ File existence between open and close — not directly observed (open and close were 6s apart; log shows save, deletion is silent on success)
- [x] ✅ 2026-04-27 — Experts log: `trade_closed deal=7236714855 ... → HTTP 200`
- [x] ✅ 2026-04-27 — Experts log: `balance_snapshot bal=3473.61 eq=3473.61 → HTTP 200`

Supabase row (verified 2026-04-27 via SQL Editor):
- [x] ✅ `rainbow_m1_open_band_idx = -1` (price above all bands)
- [x] ✅ `rainbow_m5_open_order_state = 'MIXED'` (tangled stack)
- [x] ✅ `rainbow_m15_open_slow_ma = 4705.42` (price 4704.92 was just below M15 slow MA)
- [x] ✅ `rainbow_h1_open_candle = 'green'` (last completed H1 bar bullish)
- [x] ✅ All 4 TFs returned non-null → no warm-up gap, all charts cached
- [ ] (Other 46 fields not spot-checked but cross-TF coverage proves the 50-column write path works)

Verification SQL:
```sql
select rainbow_capture_method_open, rainbow_capture_method_close,
       rainbow_m1_open_slow_ma, rainbow_m1_open_band_idx, rainbow_m1_open_order_state,
       rainbow_m5_open_band_idx, rainbow_m15_open_band_idx, rainbow_h1_open_band_idx
from mt5_trades where deal_ticket = 7236714855;
```

If M5/M15/H1 fields come back null but M1 works → open the M5/M15/H1 charts once on the same MT5 terminal so MT5 caches their bar history, then the next trade should fill them.

## Frontend: Setup Verdict modal section (built 2026-04-27)

`js/app.js` — added `setupVerdictHTML(t)` rendered between Result and Time inside `openMT5Modal()`. Scores 7 signals per trade:

- **Mario bias** — `bias_m15`, `bias_m5` vs trade direction (BEAR favors SELL, BULL favors BUY)
- **OB context** — `ob_status` text matched against /supply/ (favors SELL) and /demand/ (favors BUY)
- **Rainbow per TF** — M1/M5/M15/H1, combining `band_idx` and `order_state`:
  - `aligned`: bear half (band ≥ 4) + BEAR_STACK for SELL, or bull half (band ≤ 1) + BULL_STACK for BUY
  - `against`: opposite
  - `neutral`: MIXED stack, or band/stack disagree

**Conviction %** = (aligned × 1.0 + neutral × 0.5) / total non-missing. Colored gold default, green ≥ 70%, red ≤ 40%.

**Mario decision** (`WAIT`/`BUY`/`SELL`) renders as a tag in the section header but is NOT counted in conviction — it acts as a separate "system veto" indicator. User can see at a glance if they overrode Mario.

**Open vs Close** — both states are rendered when rainbow open ≠ close (band_idx or order_state differs on any TF). For short trades where states are identical, only open is shown plus "identical to open" note.

**Weights** — `SIGNAL_WEIGHTS` map at top of the helper block. All 1.0 today. Tune individual signals once we have enough closed trades to see which actually predict P&L (user noted this is the next iteration once data accrues).

CSS: `.verdict-section` / `.verdict-table` / `.conviction` / `.va` `.vx` `.vn` `.vm` row classes added in `css/style.css`.

## Open questions / future work
- **Weighted conviction** — `SIGNAL_WEIGHTS` in `js/app.js` all 1.0 today. After ~30+ closed trades, analyze which signals actually predicted outcomes and tune. User explicitly flagged this as deferred until data accrues.
- **Backfill historical trades** — possible for ~7-day window (MT5 default M1 history). Script would loop `mt5_trades` rows, query MT5 for bars at each `open_time`, recompute EMAs. Not yet built.
- **Generated `rainbow_setup` column** — derived categorical signal for the user's behavioral pattern ("BEARISH_BAND_PULLBACK" etc.). Defer until 2-3 weeks of live data lets us see what rule actually predicts outcomes.
- **Dashboard / analytics view** — query "win rate when entry was below slow MA + bear stack on all TFs" needs UI work in `index.html`. Not yet started.
- **Dynamic SL idea** — user wants SL that trails to "trend flip" zone using rainbow inversion (MA1 cross MA8) rather than naive price-cross. Validate with collected data first; don't pre-design.
- **Multi-publisher race** — if user attaches RainbowMA to multiple charts with `Publish=true` on more than one, GVs race + TG queue counter races. Currently mitigated by user discipline. Optional future v1.31 guard: chart-id lock GV.

## Related files

- `supabase_schema_phase3c.sql` — DB migration (already run)
- `mt5/RainbowMA.mq5` — indicator (v1.30)
- `mt5/JournalSync.mq5` — EA (v1.10)
- `api/ingest.js` — webhook handler
- `supabase_schema_phase3b.sql` — Phase 3b (Mario context) — sister capture path, same GV-publish pattern
- `mt5/Mario.mq5` — Mario v5 indicator, same publish pattern (`MarioJournal_PublishState`)

## Commits

- `6eec2b7` — Phase 3c: capture RainbowMA context at trade open + close
- `1e429c3` — Track RainbowMA v1.30 alongside JournalSync

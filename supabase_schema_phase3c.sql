-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3c: RainbowMA context columns on mt5_trades.
--
-- Captures the RainbowMA indicator's state at TWO moments per position:
--   • OPEN  — snapshotted by JournalSync EA when DEAL_ENTRY_IN fires,
--             persisted to MQL5/Files/Common/rainbow_open_<pos>.json
--             so it survives between open and close.
--   • CLOSE — read directly from RAINBOW_* GlobalVariables when
--             DEAL_ENTRY_OUT fires.
--
-- Per snapshot we capture 4 timeframes (M1, M5, M15, H1). RainbowMA runs on
-- a single chart and queries all 4 TFs via iMA() — no need to attach to
-- multiple charts.
--
-- Per (timeframe × moment) we capture 6 fields:
--   slow_ma        — the user's Slow MA (MA-8 / 150 EMA on user's setup)
--   close_price    — last completed bar's close on that TF
--   band_idx       — where price sits in the rainbow:
--                      -1 = above all bands (above MA-1 fast)
--                       0..6 = between MA-N and MA-(N+1)
--                       7 = below MA-8 (slow)
--                    Negative dist_to_slow can be derived from
--                    close_price - slow_ma.
--   candle         — last completed bar's color: 'red' / 'green' / 'doji'
--   body_points    — abs(close - open) of last bar in points (Point()-units)
--   order_state    — MA stack alignment:
--                      'BULL_STACK' = MA1<MA2<...<MA8 (all rising order)
--                      'BEAR_STACK' = MA1>MA2>...>MA8 (all falling order)
--                      'MIXED'      = anything else (rainbow tangled)
--
-- Idempotent: each ADD COLUMN uses IF NOT EXISTS, safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- Capture method per moment ('rainbow_gv' | 'rainbow_file' | 'none')
alter table mt5_trades add column if not exists rainbow_capture_method_open  text;
alter table mt5_trades add column if not exists rainbow_capture_method_close text;

-- ── M1 — entry timeframe ────────────────────────────────────────────────────
alter table mt5_trades add column if not exists rainbow_m1_open_slow_ma      numeric;
alter table mt5_trades add column if not exists rainbow_m1_open_close_price  numeric;
alter table mt5_trades add column if not exists rainbow_m1_open_band_idx     smallint;
alter table mt5_trades add column if not exists rainbow_m1_open_candle       text;
alter table mt5_trades add column if not exists rainbow_m1_open_body_points  numeric;
alter table mt5_trades add column if not exists rainbow_m1_open_order_state  text;

alter table mt5_trades add column if not exists rainbow_m1_close_slow_ma     numeric;
alter table mt5_trades add column if not exists rainbow_m1_close_close_price numeric;
alter table mt5_trades add column if not exists rainbow_m1_close_band_idx    smallint;
alter table mt5_trades add column if not exists rainbow_m1_close_candle      text;
alter table mt5_trades add column if not exists rainbow_m1_close_body_points numeric;
alter table mt5_trades add column if not exists rainbow_m1_close_order_state text;

-- ── M5 ──────────────────────────────────────────────────────────────────────
alter table mt5_trades add column if not exists rainbow_m5_open_slow_ma      numeric;
alter table mt5_trades add column if not exists rainbow_m5_open_close_price  numeric;
alter table mt5_trades add column if not exists rainbow_m5_open_band_idx     smallint;
alter table mt5_trades add column if not exists rainbow_m5_open_candle       text;
alter table mt5_trades add column if not exists rainbow_m5_open_body_points  numeric;
alter table mt5_trades add column if not exists rainbow_m5_open_order_state  text;

alter table mt5_trades add column if not exists rainbow_m5_close_slow_ma     numeric;
alter table mt5_trades add column if not exists rainbow_m5_close_close_price numeric;
alter table mt5_trades add column if not exists rainbow_m5_close_band_idx    smallint;
alter table mt5_trades add column if not exists rainbow_m5_close_candle      text;
alter table mt5_trades add column if not exists rainbow_m5_close_body_points numeric;
alter table mt5_trades add column if not exists rainbow_m5_close_order_state text;

-- ── M15 ─────────────────────────────────────────────────────────────────────
alter table mt5_trades add column if not exists rainbow_m15_open_slow_ma      numeric;
alter table mt5_trades add column if not exists rainbow_m15_open_close_price  numeric;
alter table mt5_trades add column if not exists rainbow_m15_open_band_idx     smallint;
alter table mt5_trades add column if not exists rainbow_m15_open_candle       text;
alter table mt5_trades add column if not exists rainbow_m15_open_body_points  numeric;
alter table mt5_trades add column if not exists rainbow_m15_open_order_state  text;

alter table mt5_trades add column if not exists rainbow_m15_close_slow_ma     numeric;
alter table mt5_trades add column if not exists rainbow_m15_close_close_price numeric;
alter table mt5_trades add column if not exists rainbow_m15_close_band_idx    smallint;
alter table mt5_trades add column if not exists rainbow_m15_close_candle      text;
alter table mt5_trades add column if not exists rainbow_m15_close_body_points numeric;
alter table mt5_trades add column if not exists rainbow_m15_close_order_state text;

-- ── H1 ──────────────────────────────────────────────────────────────────────
alter table mt5_trades add column if not exists rainbow_h1_open_slow_ma      numeric;
alter table mt5_trades add column if not exists rainbow_h1_open_close_price  numeric;
alter table mt5_trades add column if not exists rainbow_h1_open_band_idx     smallint;
alter table mt5_trades add column if not exists rainbow_h1_open_candle       text;
alter table mt5_trades add column if not exists rainbow_h1_open_body_points  numeric;
alter table mt5_trades add column if not exists rainbow_h1_open_order_state  text;

alter table mt5_trades add column if not exists rainbow_h1_close_slow_ma     numeric;
alter table mt5_trades add column if not exists rainbow_h1_close_close_price numeric;
alter table mt5_trades add column if not exists rainbow_h1_close_band_idx    smallint;
alter table mt5_trades add column if not exists rainbow_h1_close_candle      text;
alter table mt5_trades add column if not exists rainbow_h1_close_body_points numeric;
alter table mt5_trades add column if not exists rainbow_h1_close_order_state text;

notify pgrst, 'reload schema';

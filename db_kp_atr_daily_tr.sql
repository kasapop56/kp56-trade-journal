-- ── KP56 Co-pilot · daily true range on kp_atr (2026-08-21) ─────────────────
-- The ATR the ladder is drawn from is a 10-day RMA — it describes the REGIME and
-- barely moves day to day (88.81 → 89.25 across a 16,000-point Wednesday). What
-- was missing is the DAY: true range, and where the day closed inside it.
--
-- Fed by the "Daily ATR Zones" alert, which fires on the first bar of the new day
-- and now carries the completed previous day's OHLC (prev_o/h/l/c + prev2_c).
-- api/fibo-snapshot.js writes those onto the PREVIOUS day's row — day_high and
-- day_low already existed here unused; day_close / tr / prev_close are new.
--
-- Derived at read time, not stored (so a change of definition needs no backfill):
--   tr_ratio  = tr / atr        → "is today quiet?"   bottom quartile ≈ < 0.71
--   close_loc = (day_close - day_low) / (day_high - day_low)
--   eff       = abs(day_close - day_open) / (day_high - day_low)
--               → < 0.35 churn (price kept coming back) · >= 0.65 one-way grind
-- Note `atr` on a row is the ATR as of that day's OPEN, i.e. it excludes that
-- day's own range — which is what makes tr / atr an honest surprise measure.

begin;

alter table public.kp_atr add column if not exists day_close  numeric;  -- close of that day
alter table public.kp_atr add column if not exists tr         numeric;  -- true range, price units
alter table public.kp_atr add column if not exists prev_close numeric;  -- close of the day BEFORE (the TR gap reference)

comment on column public.kp_atr.tr is
  'Daily true range = max(H-L, |H-prev_close|, |L-prev_close|). Compare to atr (10-day RMA) for tr_ratio.';

commit;

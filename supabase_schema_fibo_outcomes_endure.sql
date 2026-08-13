-- ============================================================================
-- Fibo outcomes: "endure past SL" columns  (2026-08-13)
-- ----------------------------------------------------------------------------
-- Lets us answer, from data, "if I had held past the SL, would it have come
-- back to win — and how wide would the SL need to be?" instead of guessing a
-- number (550/604/…). Populated by /api/fibo-eval on the next write run.
--
--   heat_pts     : worst adverse distance from the entry level, in POINTS, from
--                  entry until TP1 was finally reached (uncapped by the original
--                  SL) = the minimum SL width that survives to the win. Same unit
--                  as the SL input, so an SL sweep is a direct comparison. For a
--                  loss that never recovers in-day it is the deepest heat of the day.
--   sl_pts       : the original SL width from entry, in points (reference).
--   tp1_after_sl : true for a LOSS whose price later reached TP1 within the same
--                  Bangkok trading day → a "would have recovered with a wider SL".
--   recover_bars : bars from entry to that eventual TP1 (how long you'd endure).
--
-- Derived data — safe to run anytime; re-run fibo-eval?write=1 to backfill.
-- ============================================================================
begin;

alter table public.fibo_outcomes
  add column if not exists heat_pts     int,
  add column if not exists sl_pts       int,
  add column if not exists tp1_after_sl boolean,
  add column if not exists recover_bars int;

commit;

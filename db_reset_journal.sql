-- ─────────────────────────────────────────────────────────────────────────────
-- KP56 Trade Journal — FULL RESET (start fresh with a new setup)
--
-- Created 2026-08-11. Wipes ALL trade/journal data across EVERY account
-- (87464504, SmartGrid 135173655, etc.) and keeps ONLY the Fibo tables.
--
-- ⚠️  PERMANENT DELETE. A full backup was taken first:
--     ~/Documents/KP56/backups/kp56_full_20260811_1445.sql.gz
--
-- KEEPS (untouched):  fibo_snapshots, fibo_events, fibo_outcomes
-- WIPES (empties):    mt5_trades, balance_snapshots, trade_events,
--                     trade_ideas, positions, market_sitreps, trade_plans
--
-- RESTART IDENTITY resets serial IDs back to 1 for a clean slate.
-- CASCADE follows FKs (positions→trade_ideas, trade_plans→market_sitreps);
-- verified: NO Fibo table references any table below, so Fibo is safe.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction — if anything
-- looks wrong, ROLLBACK before COMMIT.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

truncate table
  public.trade_events,
  public.positions,
  public.trade_ideas,
  public.mt5_trades,
  public.balance_snapshots,
  public.trade_plans,
  public.market_sitreps
restart identity cascade;

-- Sanity check — every count below should be 0:
select 'trade_events'      as tbl, count(*) from public.trade_events
union all select 'positions',        count(*) from public.positions
union all select 'trade_ideas',      count(*) from public.trade_ideas
union all select 'mt5_trades',       count(*) from public.mt5_trades
union all select 'balance_snapshots',count(*) from public.balance_snapshots
union all select 'trade_plans',      count(*) from public.trade_plans
union all select 'market_sitreps',   count(*) from public.market_sitreps
-- Fibo must be UNCHANGED (non-zero if you had data):
union all select 'fibo_snapshots (KEEP)', count(*) from public.fibo_snapshots
union all select 'fibo_events (KEEP)',    count(*) from public.fibo_events
union all select 'fibo_outcomes (KEEP)',  count(*) from public.fibo_outcomes;

commit;

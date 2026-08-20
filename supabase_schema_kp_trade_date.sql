-- supabase_schema_kp_trade_date.sql
-- Adds a TRADING-DAY column to the co-pilot tables so they can be grouped by day
-- in the Supabase table view (and in SQL) without parsing timestamps by hand.
--
-- WHY NOT date(ts): the trading day is NOT the calendar day. The broker's daily
-- bar rolls over at 04:00 UTC (GBE gold), so a read at 01:54 UTC belongs to the
-- PREVIOUS trading day. Signal 13 is exactly that case: ts 2026-08-20 01:54 UTC,
-- trading day 2026-08-19. date(ts) would file it under the wrong day and quietly
-- split one trading session across two rows in any group-by.
--
-- GENERATED ALWAYS ... STORED: Postgres derives the value itself, for rows that
-- already exist and for every future insert. No application change, and nothing
-- can forget to populate it. `ts at time zone 'UTC'` keeps the expression
-- immutable (a bare ::date on timestamptz depends on the session TimeZone and
-- Postgres will reject it here).
--
-- ⚠️ The 4-hour offset mirrors _kp_config.eval.dayCutUtcHour. If that config
-- changes (a different broker, or tomorrow's first real indicator alert shows the
-- GBE cut is not 04:00 UTC), this column must be dropped and re-added to match,
-- or the DB and the evaluator will disagree about which day a read belongs to.
--
-- Safe to re-run.

begin;

-- ── the read log ────────────────────────────────────────────────────────────
alter table public.kp_signals
  add column if not exists trade_date date
  generated always as (((ts at time zone 'UTC') - interval '4 hours')::date) stored;

comment on column public.kp_signals.trade_date is
  'Broker trading day (04:00 UTC rollover), derived from ts. Not the calendar date: a read before 04:00 UTC belongs to the previous trading day.';

create index if not exists kp_signals_trade_date_idx
  on public.kp_signals (trade_date desc, ts desc);

-- ── the merged market snapshots ─────────────────────────────────────────────
alter table public.kp_market_state
  add column if not exists trade_date date
  generated always as (((ts at time zone 'UTC') - interval '4 hours')::date) stored;

comment on column public.kp_market_state.trade_date is
  'Broker trading day (04:00 UTC rollover), derived from ts.';

create index if not exists kp_market_state_trade_date_idx
  on public.kp_market_state (trade_date desc, ts desc);

-- ── graded outcomes ─────────────────────────────────────────────────────────
-- This table already carries the trading day, but under a misleading name: the
-- column is called bkk_date while it actually holds the CHART day (04:00 UTC cut),
-- not the Bangkok civil date. Renaming it would break readers, so document it and
-- expose a correctly-named generated twin alongside.
comment on column public.kp_read_outcomes.bkk_date is
  'MISNOMER kept for compatibility: holds the broker CHART trading day (04:00 UTC cut), not the Bangkok civil date. Prefer trade_date.';

alter table public.kp_read_outcomes
  add column if not exists trade_date date
  generated always as (((read_ts at time zone 'UTC') - interval '4 hours')::date) stored;

comment on column public.kp_read_outcomes.trade_date is
  'Broker trading day (04:00 UTC rollover), derived from read_ts. Correctly-named replacement for bkk_date.';

create index if not exists kp_read_outcomes_trade_date_idx
  on public.kp_read_outcomes (trade_date desc, read_ts desc);

commit;

-- Check after running:
--   select trade_date, count(*) reads, min(ts) first, max(ts) last
--   from kp_signals group by 1 order by 1 desc;

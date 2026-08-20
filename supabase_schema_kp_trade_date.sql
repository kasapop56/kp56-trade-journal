-- supabase_schema_kp_trade_date.sql
-- Trading-day column for the co-pilot tables, so they group by day in the Supabase
-- table view (and in SQL) without parsing timestamps by hand.
--
-- WHY NOT date(ts): the trading day is not the calendar day. The broker's daily bar
-- rolls over at 04:00 UTC (GBE gold), so a read at 01:54 UTC belongs to the PREVIOUS
-- trading day — signal 13 is exactly that case (ts 2026-08-20 01:54 UTC → trading
-- day 2026-08-19). date(ts) would split one session across two rows in any group-by.
--
-- GENERATED ALWAYS ... STORED: Postgres derives the value itself, for existing rows
-- and every future insert. No application change, nothing that can forget to fill it.
-- `ts at time zone 'UTC'` keeps the expression immutable (a bare ::date on timestamptz
-- depends on the session TimeZone and Postgres rejects it in a generated column).
--
-- The COMMENT statements are split into a second block on purpose: pasting long
-- quoted strings into the SQL editor truncated them mid-string once already, which
-- fails the whole transaction. The comments are cosmetic — skip them if in doubt.
--
-- ⚠️ The 4-hour offset mirrors _kp_config.eval.dayCutUtcHour. If that changes (a
-- different broker, or the first real indicator alert shows the GBE cut is not
-- 04:00 UTC), drop and re-add these columns to match, or the DB and the evaluator
-- will disagree about which day a read belongs to.
--
-- Safe to re-run.

begin;

alter table public.kp_signals
  add column if not exists trade_date date
  generated always as (((ts at time zone 'UTC') - interval '4 hours')::date) stored;

alter table public.kp_market_state
  add column if not exists trade_date date
  generated always as (((ts at time zone 'UTC') - interval '4 hours')::date) stored;

alter table public.kp_read_outcomes
  add column if not exists trade_date date
  generated always as (((read_ts at time zone 'UTC') - interval '4 hours')::date) stored;

create index if not exists kp_signals_trade_date_idx
  on public.kp_signals (trade_date desc, ts desc);

create index if not exists kp_market_state_trade_date_idx
  on public.kp_market_state (trade_date desc, ts desc);

create index if not exists kp_read_outcomes_trade_date_idx
  on public.kp_read_outcomes (trade_date desc, read_ts desc);

commit;

-- ── optional: column documentation (run separately; cosmetic only) ───────────
comment on column public.kp_signals.trade_date is 'Broker trading day, 04:00 UTC rollover';
comment on column public.kp_market_state.trade_date is 'Broker trading day, 04:00 UTC rollover';
comment on column public.kp_read_outcomes.trade_date is 'Broker trading day, from read_ts';
comment on column public.kp_read_outcomes.bkk_date is 'MISNOMER: chart day, not Bangkok date. Use trade_date';

-- Check after running:
--   select trade_date, count(*) as reads, min(ts) as first, max(ts) as last
--   from kp_signals group by 1 order by 1 desc;

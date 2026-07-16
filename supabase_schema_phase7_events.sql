-- ── Phase 7: manual-trade study events (RainbowPilot data logger) ────────────
-- Run in Supabase SQL editor. New table only — touches nothing existing.
--
-- Raw event stream from the RainbowPilot EA on both accounts (real 87464504,
-- demo 49754423): OPEN / MODIFY / CLOSE / BAR, each with the full market
-- context (EMA stack, zone, spread, ATR, MFE/MAE...) as one jsonb payload.
-- Schema-on-read: the EA may add payload fields at any time, no migration.
--
-- Joins: trade_events.ticket is the MT5 POSITION id → matches
-- mt5_trades.position_id for closed trades (per account_login).
--
-- t_srv is broker-server time as TEXT on purpose (broker TZ is not UTC and
-- shifts with DST; raw string preserves exactly what the terminal saw).
-- created_at (UTC, arrival time) is the sortable timestamp.
--
-- Retention note: BAR events are ~288/day/account (~30 MB/yr). If the study
-- outgrows the free tier, prune old BAR rows first — never OPEN/MODIFY/CLOSE.

begin;

create table public.trade_events (
  id            bigint generated always as identity primary key,
  account_login bigint      not null,
  symbol        text,
  ticket        bigint,
  event         text        not null,
  t_srv         text,
  payload       jsonb       not null,
  created_at    timestamptz not null default now()
);

create index trade_events_acc_ticket_idx on public.trade_events (account_login, ticket);
create index trade_events_acc_time_idx   on public.trade_events (account_login, created_at);
create index trade_events_event_idx      on public.trade_events (event);

-- Service-role only (webhook writes, analysis reads via service key).
-- RLS on with no policies = anon/authenticated see nothing. When a journal
-- UI page needs this table, add a SELECT policy for authenticated then.
alter table public.trade_events enable row level security;

commit;

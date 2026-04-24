-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 schema: MT5 live sync + balance snapshots
--
-- Safe to run on existing Phase 1 database — only creates new tables.
-- Run in Supabase SQL editor after Phase 1 is already set up.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── mt5_trades ─────────────────────────────────────────────────────────────
-- One row per closed MT5 position (sent by the EA on OnTradeTransaction).
-- deal_ticket is the MT5 out-deal ticket — UNIQUE so webhook retries upsert
-- cleanly and never create duplicates.
create table if not exists mt5_trades (
  id              uuid default gen_random_uuid() primary key,
  account_login   bigint        not null,
  deal_ticket     bigint        not null unique,
  position_id     bigint,
  symbol          text          not null,
  type            text          not null,            -- 'buy' | 'sell'
  volume          numeric(12,2) not null,            -- lots
  open_time       timestamptz   not null,
  close_time      timestamptz   not null,
  open_price      numeric(14,5) not null,
  close_price     numeric(14,5) not null,
  sl              numeric(14,5),
  tp              numeric(14,5),
  profit          numeric(14,2) not null,            -- net profit (broker currency)
  swap            numeric(14,2) default 0,
  commission      numeric(14,2) default 0,
  magic           bigint        default 0,
  comment         text,
  balance_after   numeric(14,2),                     -- account balance at close
  equity_after    numeric(14,2),
  created_at      timestamptz   default now()
);

create index if not exists mt5_trades_close_time_idx on mt5_trades (close_time desc);
create index if not exists mt5_trades_account_idx    on mt5_trades (account_login, close_time desc);
create index if not exists mt5_trades_symbol_idx     on mt5_trades (symbol);

-- ── balance_snapshots ──────────────────────────────────────────────────────
-- Time-series of balance + equity. Written by EA on hourly timer and right
-- after each close. ~9k rows/year — tiny.
create table if not exists balance_snapshots (
  id              bigserial primary key,
  account_login   bigint        not null,
  balance         numeric(14,2) not null,
  equity          numeric(14,2) not null,
  margin          numeric(14,2) default 0,
  free_margin     numeric(14,2),
  margin_level    numeric(14,2),                     -- percent, null if no open positions
  open_positions  int           default 0,
  recorded_at     timestamptz   not null,
  created_at      timestamptz   default now()
);

create index if not exists balance_snapshots_recorded_idx
  on balance_snapshots (account_login, recorded_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Browser (anon key) reads only. Writes go through the Vercel webhook, which
-- uses the service-role key and bypasses RLS.
alter table mt5_trades        enable row level security;
alter table balance_snapshots enable row level security;

drop policy if exists "Anon read mt5_trades"        on mt5_trades;
drop policy if exists "Anon read balance_snapshots" on balance_snapshots;

create policy "Anon read mt5_trades"
  on mt5_trades for select using (true);

create policy "Anon read balance_snapshots"
  on balance_snapshots for select using (true);

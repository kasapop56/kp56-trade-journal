-- ── KP56 Trading Co-pilot (Phase 1) ─────────────────────────────────────────
-- Run in the Supabase SQL editor. NEW tables only (kp_ prefix) — touches
-- nothing existing. The co-pilot is a LAYER on top of the already-live ingest:
--   MT5 SITREP  → market_sitreps   (api/sitrep.js)
--   TradingView → fibo_snapshots   (api/fibo-snapshot.js)
-- It reads those, merges them into a single market state, decides whether the
-- moment is worth commenting on, calls Claude, and logs commentary here.
--
-- Two tables:
--   kp_market_state — one row per merged snapshot the co-pilot evaluated. Kept
--                     as a short history so triggers like sweep-and-reclaim and
--                     confluence-flip can look back N states. Written by the
--                     server (service-role) on each evaluation.
--   kp_signals      — the co-pilot's commentary log (what it said, when, why,
--                     where it was delivered). Drives the dashboard feed +
--                     Telegram fan-out + per-trigger debounce.
--
-- Both are anon-SELECT (read-only) so the static dashboard can subscribe via
-- the anon key, exactly like fibo_snapshots. Writes always use the service-role
-- key, which bypasses RLS.

begin;

-- ── Merged market-state snapshots ───────────────────────────────────────────
create table if not exists public.kp_market_state (
  id             bigint generated always as identity primary key,
  ts             timestamptz not null default now(),
  symbol         text,
  price          numeric,

  -- provenance: which source rows this snapshot was merged from
  sitrep_id      bigint,                 -- market_sitreps.id (soft link)
  fibo_id        bigint,                 -- fibo_snapshots.id (soft link)
  sitrep_age_min numeric,                -- freshness of the MT5 side at merge
  fibo_age_min   numeric,                -- freshness of the TV side at merge

  -- MT5 (Mario) side
  bias_m15       text,
  bias_m5        text,
  vp_position    text,                   -- "AT POC" / "ABOVE VAH" / ...
  poc            numeric,
  vah            numeric,
  val            numeric,

  -- TradingView (Fibo / MTF) side  — h4_trend/day_high/day_low stay NULL until
  -- the Pine indicator is extended to emit them (see notes at bottom).
  h4_trend       text,
  day_high       numeric,
  day_low        numeric,
  fibo_side       text,                  -- active Fibo side: 'S' | 'B' | 'BOTH'

  -- nearest actionable zones to current price (edges, scores, tags, source)
  nearest_supply jsonb,                  -- { lo, hi, score, tags[], source }
  nearest_demand jsonb,

  raw            jsonb,                   -- full merged state object (see js/copilot.js)

  created_at     timestamptz not null default now()
);

create index if not exists kp_market_state_ts_idx on public.kp_market_state (ts desc);

-- ── Co-pilot commentary log ─────────────────────────────────────────────────
create table if not exists public.kp_signals (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  trigger_type     text not null,        -- 'zone_entry' | 'sweep_reclaim' |
                                          -- 'confluence_flip' | 'momentum_flag' | 'manual'
  message          text not null,        -- Claude's commentary (what the user reads)
  headline         text,                 -- short one-liner for the feed / Telegram title
  price            numeric,
  bias_call        text,                 -- 'Buy' | 'Sell' | 'No trade' (parsed convenience)
  zones_referenced jsonb,                -- zones the read hangs on
  market_state_id  bigint,               -- kp_market_state.id this was based on
  delivered_to     text[] not null default '{}',  -- {'dashboard','telegram'}
  meta             jsonb,                -- model, tokens, debounce reason, etc.
  created_at       timestamptz not null default now()
);

create index if not exists kp_signals_ts_idx      on public.kp_signals (ts desc);
create index if not exists kp_signals_trigger_idx on public.kp_signals (trigger_type, ts desc);

-- ── RLS: read-only for the dashboard (anon), writes via service-role ────────
alter table public.kp_market_state enable row level security;
alter table public.kp_signals      enable row level security;

drop policy if exists kp_market_state_read on public.kp_market_state;
create policy kp_market_state_read
  on public.kp_market_state for select
  to anon, authenticated using (true);

drop policy if exists kp_signals_read on public.kp_signals;
create policy kp_signals_read
  on public.kp_signals for select
  to anon, authenticated using (true);

grant select on public.kp_market_state to anon, authenticated;
grant select on public.kp_signals      to anon, authenticated;

-- ── Realtime: push new rows to the dashboard ────────────────────────────────
-- Safe to run repeatedly; ignore "already member of publication" if it errors.
do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_market_state;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.kp_signals;
  exception when duplicate_object then null;
  end;
end $$;

commit;

-- ── NOTE ─ MTF gap (for Phase 2/3) ──────────────────────────────────────────
-- The live FiboFocusSignals.pine emits ZONES only. The co-pilot's
-- confluence-flip trigger (MT5 bias vs TV h4_trend) and momentum-flag trigger
-- (RBE/SBE) need the multi-timeframe panel + flags + day_high/day_low that the
-- prompt's sample TV payload shows but the live indicator does NOT send yet.
-- Until the Pine is extended, h4_trend / day_high / day_low remain NULL and
-- those two triggers stay dormant; zone_entry + sweep_reclaim + manual work now.

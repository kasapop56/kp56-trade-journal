-- ── KP56 Co-pilot · Read outcomes (Phase 9) ─────────────────────────────────
-- One row per co-pilot read (kp_signals). Written by api/kp-eval.js, which
-- REPLAYS each read against the intraday BAR feed (trade_events, event='BAR',
-- payload.ctx.bar1 OHLC) capped to the read's Bangkok trading day, and classifies
-- what price ACTUALLY did — not just win/loss:
--   • day_type      — was it a balance / trend / outsized day (via ATR ladder)
--   • fav_atr/adv_atr — how far price ran WITH vs AGAINST the call, in daily-ATR
--   • zone_behavior — did the zone the read leaned on HOLD / BREAK / get swept
--   • verdict       — WIN/LOSS/STALL/PARTIAL/OK_NOTRADE/MISSED/PENDING/EXPIRED
--   • behavior_note — one Thai line describing the move in ATR-ladder language
-- The nightly report reads this for the co-pilot accuracy block; runAnalysis
-- reads yesterday's rows to carry key levels forward into the new day's read.
--
-- No Pine/EA change. anon-read; writes via service-role.

begin;

create table if not exists public.kp_read_outcomes (
  signal_id        bigint primary key,     -- kp_signals.id (1:1)
  read_ts          timestamptz,
  bkk_date         date,                   -- Bangkok trading day of the read
  symbol           text,
  call             text,                   -- Buy | Sell | No trade
  read_price       numeric,

  -- daily ATR frame used (from kp_atr, or computed fallback)
  day_open         numeric,
  atr              numeric,
  atr_source       text,                   -- 'indicator' | 'computed' | 'none'

  -- day-level behavior (from day_open, whole Bangkok day)
  day_type         text,                   -- BALANCE | NORMAL | TREND | OUTSIZED | UNKNOWN
  day_travel_up_atr numeric,               -- (day_high - day_open) / atr
  day_travel_dn_atr numeric,               -- (day_open - day_low)  / atr
  direction_actual text,                   -- UP | DOWN | RANGE

  -- read-level excursion from read_price, in the CALL direction
  fav_atr          numeric,                -- favorable move / atr
  adv_atr          numeric,                -- adverse move   / atr
  fav_pts          numeric,                -- favorable move in XAUUSD points
  adv_pts          numeric,
  reached_band     numeric,                -- farthest ATR band reached toward target

  -- zone the read leaned on
  target_zone      jsonb,                  -- { side, lo, hi, label, source }
  reached_target   boolean,
  zone_behavior    text,                   -- HELD | BROKE | SWEEP_RECLAIM | UNTESTED | NA

  verdict          text,                   -- see header
  behavior_note    text,                   -- Thai one-liner
  bars_seen        int,
  meta             jsonb,
  updated_at       timestamptz not null default now()
);

create index if not exists kp_read_outcomes_date_idx    on public.kp_read_outcomes (bkk_date desc);
create index if not exists kp_read_outcomes_verdict_idx on public.kp_read_outcomes (verdict, bkk_date desc);

alter table public.kp_read_outcomes enable row level security;

drop policy if exists kp_read_outcomes_read on public.kp_read_outcomes;
create policy kp_read_outcomes_read on public.kp_read_outcomes for select to anon, authenticated using (true);

grant select on public.kp_read_outcomes to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_read_outcomes;
  exception when duplicate_object then null;
  end;
end $$;

commit;

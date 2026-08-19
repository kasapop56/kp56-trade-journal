-- ── Live open-positions snapshot (ground-truth mirror) ─────────────────────
-- Run once in the Supabase SQL editor. NEW table only.
--
-- Why this exists: the co-pilot used to rebuild open positions by REPLAYING the
-- trade_events log (OPEN→MODIFY→CLOSE). That model drifts whenever an event is
-- missed — PC terminal asleep while trading from mobile, an EA restart/recompile,
-- or the 3000-row fetch cap pushing an old OPEN out of the window. The result was
-- co-pilot positions that didn't match MT5 (wrong lots / missing tickets).
--
-- Fix: JournalSync (api/positions.js) posts the WHOLE live open-position set for
-- the account every ~10s. One row per account (upserted) = self-healing: every
-- push overwrites with the broker's truth, so any missed event corrects itself on
-- the next push. The co-pilot reads this as ground truth and only falls back to
-- the replay when no snapshot row exists (pre-migration / EA not yet patched).
--
-- anon-read for the dashboard; writes via service-role only.

begin;

create table if not exists public.kp_positions (
  account_login bigint primary key,
  ts        timestamptz not null default now(),
  symbol    text,
  positions jsonb not null default '[]'::jsonb,   -- array of {ticket,dir,lots,entry,sl,tp,magic,profit,swap}
  count     int,
  net_lots  numeric,
  buy_lots  numeric,
  sell_lots numeric,
  float_usd numeric                               -- sum of broker POSITION_PROFIT (exact P&L)
);

alter table public.kp_positions enable row level security;

drop policy if exists kp_positions_read on public.kp_positions;
create policy kp_positions_read
  on public.kp_positions for select
  to anon, authenticated using (true);

grant select on public.kp_positions to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_positions;
  exception when duplicate_object then null;
  end;
end $$;

commit;

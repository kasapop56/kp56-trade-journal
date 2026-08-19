-- ── Live price heartbeat (Option B) ─────────────────────────────────────────
-- Run once in the Supabase SQL editor. NEW table only. JournalSync posts the
-- live XAUUSD price every ~30s (api/price.js), so the co-pilot always has a
-- near-live reference price instead of a stale SITREP snapshot. One row per
-- symbol (upserted). anon-read for the dashboard; writes via service-role.

begin;

create table if not exists public.kp_price (
  symbol   text primary key,
  price    numeric,
  bid      numeric,
  ask      numeric,
  spread   numeric,
  ts       timestamptz not null default now()
);

alter table public.kp_price enable row level security;

drop policy if exists kp_price_read on public.kp_price;
create policy kp_price_read
  on public.kp_price for select
  to anon, authenticated using (true);

grant select on public.kp_price to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_price;
  exception when duplicate_object then null;
  end;
end $$;

commit;

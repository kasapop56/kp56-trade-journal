-- ── Let the dashboard read MT5 SITREPs (anon) ───────────────────────────────
-- Run once in the Supabase SQL editor. market_sitreps had no anon SELECT policy,
-- so the co-pilot dashboard (which reads with the public anon key, like it does
-- for fibo_snapshots) saw nothing and showed "MT5 · ไม่มีข้อมูล" — even though the
-- server (service-role) reads it fine and every Claude read already includes the
-- MT5 bias/POC. This mirrors the fibo_snapshots read policy exactly.
--
-- Read-only exposure of market analysis text/zones to the anon key — same
-- sensitivity level as fibo_snapshots, which is already anon-readable. Writes
-- still go through the service-role key (bypasses RLS). No code change needed;
-- the dashboard query starts returning rows as soon as this runs.

begin;

alter table public.market_sitreps enable row level security;

drop policy if exists market_sitreps_read on public.market_sitreps;
create policy market_sitreps_read
  on public.market_sitreps for select
  to anon, authenticated
  using (true);

grant select on public.market_sitreps to anon, authenticated;

commit;

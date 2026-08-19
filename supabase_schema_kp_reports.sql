-- ── KP56 Co-pilot nightly reports (Phase 5 loop-closer) ─────────────────────
-- Run once in the Supabase SQL editor. NEW table only. Persists the daily
-- retrospective the co-pilot posts to Telegram (api/report.js → _kp_report.js)
-- so nothing is lost and a dashboard "รายงาน" tab is trivial to add later.
-- anon-SELECT (read-only) like the other kp_ tables; writes via service-role.

begin;

create table if not exists public.kp_reports (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  report_date   text,                    -- "19/8" Bangkok label
  window_start  timestamptz,             -- day window start (UTC) the report covered
  trades_count  int,
  net_usd       numeric,
  win_count     int,
  loss_count    int,
  summary       jsonb,                   -- computed day totals (winrate, no_sl_count, ...)
  message       text,                    -- Claude's report body (Thai)
  delivered_to  text[] not null default '{}',
  meta          jsonb,                   -- model, usage, telegram id/err, source
  created_at    timestamptz not null default now()
);

create index if not exists kp_reports_ts_idx on public.kp_reports (ts desc);

alter table public.kp_reports enable row level security;

drop policy if exists kp_reports_read on public.kp_reports;
create policy kp_reports_read
  on public.kp_reports for select
  to anon, authenticated using (true);

grant select on public.kp_reports to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_reports;
  exception when duplicate_object then null;
  end;
end $$;

commit;

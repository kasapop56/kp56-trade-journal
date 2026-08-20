-- ── KP56 Co-pilot · Daily ATR frame (Phase 9) ───────────────────────────────
-- One row per (symbol, Bangkok trading day). Fed by the "Daily ATR Zones"
-- TradingView indicator, which fires ONE alert at each new day carrying the
-- day's open + the ATR value it draws its ±multiplier ladder from → the
-- type-routed webhook api/fibo-snapshot.js ("daily_atr") upserts here. The read evaluator (api/kp-eval.js) reads this so its price-
-- behavior classification uses the SAME ladder the trader sees on the chart.
--
-- If the alert is missing for a day, the evaluator falls back to computing a
-- rough daily ATR from the intraday BAR feed — kp_atr just makes it exact.
--
-- anon-read (dashboard may show the frame); writes via service-role only.

begin;

create table if not exists public.kp_atr (
  id         bigint generated always as identity primary key,
  symbol     text not null,
  atr_date   date not null,           -- Bangkok civil date this ATR/open applies to
  day_open   numeric,                 -- daily open (anchor of the ± ladder)
  atr        numeric,                 -- daily ATR the indicator draws bands from
  atr_len    int,                     -- ATR length (indicator input, e.g. 10)
  method     text,                    -- RMA/SMA/EMA/… (indicator input)
  day_high   numeric,                 -- optional live extreme (may be updated intraday)
  day_low    numeric,
  bands      jsonb,                   -- optional {"0.5": px, "-0.5": px, ...}
  raw        jsonb,                   -- full alert payload for provenance
  ts         timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, atr_date)
);

create index if not exists kp_atr_symbol_date_idx on public.kp_atr (symbol, atr_date desc);

alter table public.kp_atr enable row level security;

drop policy if exists kp_atr_read on public.kp_atr;
create policy kp_atr_read on public.kp_atr for select to anon, authenticated using (true);

grant select on public.kp_atr to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.kp_atr;
  exception when duplicate_object then null;
  end;
end $$;

commit;

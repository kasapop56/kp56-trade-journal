-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5: Scheduled market analysis pipeline.
--
-- TG Helper EA (v5.2+) dual-writes hourly SITREP messages:
--   1. Telegram (existing — chart screenshot + structured text)
--   2. POST /api/sitrep → this table + sitrep-images Storage bucket
--
-- A scheduled Anthropic agent (cron 02/07/14 UTC = Thai 09/14/21) reads the
-- latest row, fetches the image, analyses, posts a trade plan to a separate
-- Telegram group via /api/post-plan.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── market_sitreps: hourly market snapshot from TG Helper ─────────────────
create table if not exists market_sitreps (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  -- Source metadata
  source        text not null default 'tg_helper',  -- room for other sources later
  symbol        text,                                -- "XAUUSDr"
  session       text,                                -- "LONDON" / "NY" / "ASIAN" (from [SCREENSHOT:HOURLY|<SESSION>])
  -- Bias (Mario v5)
  price         numeric,
  bias_m5       text,                                -- "Bull" / "Bear" / "Neutral"
  bias_m15      text,
  -- Order Block / context counts
  ob_summary    text,                                -- raw "M5+M15+H1"
  zones_count   smallint,
  htf_conf      smallint,
  h1_count      smallint,
  -- Volume profile position
  vp_position   text,                                -- "Lower VA" / "Upper VA" / etc
  poc           numeric,
  vah           numeric,
  val           numeric,
  ppoc          numeric,
  pvah          numeric,
  pval          numeric,
  -- Supply / demand zones (parsed; full structure in jsonb for agent)
  supply_zones  jsonb,                               -- [{tier, type, lo, hi, points, tags:[...]}]
  demand_zones  jsonb,
  -- Fallback + image
  raw_text      text not null,                       -- full SITREP message verbatim
  image_url     text,                                -- public URL to PNG in sitrep-images bucket
  image_path    text                                 -- storage path (for later cleanup)
);

create index if not exists market_sitreps_created_at_idx on market_sitreps (created_at desc);
create index if not exists market_sitreps_session_idx    on market_sitreps (session);
create index if not exists market_sitreps_symbol_idx     on market_sitreps (symbol);

-- ── trade_plans: outputs from the scheduled analysis agent ────────────────
create table if not exists trade_plans (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  -- Linkage
  sitrep_id       bigint references market_sitreps(id) on delete set null,
  schedule_slot   text,                              -- "09:00" / "14:00" / "21:00" Thai
  -- Plan
  bias_call       text,                              -- "Bull" / "Bear" / "Wait"
  summary         text,                              -- short headline
  full_text       text not null,                     -- full plan as posted to Telegram
  -- Telegram tracking
  telegram_msg_id bigint,                            -- message_id from posted plan (if available)
  telegram_chat   text                               -- chat_id (string for safety vs leading 0)
);

create index if not exists trade_plans_created_at_idx on trade_plans (created_at desc);
create index if not exists trade_plans_sitrep_id_idx  on trade_plans (sitrep_id);

-- ── Storage bucket for SITREP chart screenshots ───────────────────────────
-- Public read (cloud agent can fetch image without auth header).
-- Service role uploads. Free tier: ~1GB, more than enough for 24/day @ ~100KB.
insert into storage.buckets (id, name, public)
values ('sitrep-images', 'sitrep-images', true)
on conflict (id) do nothing;

-- Public read policy on the bucket (idempotent)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'sitrep_images_public_read'
  ) then
    create policy sitrep_images_public_read
      on storage.objects for select
      to public
      using (bucket_id = 'sitrep-images');
  end if;
end$$;

notify pgrst, 'reload schema';

-- ── Fibo Focus Snapshots (Phase 8) ──────────────────────────────────────────
-- Run in Supabase SQL editor. New table only — touches nothing existing.
--
-- One row per "กรอบใหม่" drawn by the Fibo Focus Zone [B/S] Pine indicator.
-- The indicator fires alert() with a JSON body on each new frame; TradingView
-- posts it to /api/fibo-snapshot, which writes here and pings Telegram.
--
-- A frame is two-sided (S sell-above + B buy-below), so each snapshot carries
-- BOTH sides' levels. seq resets to 1 each new trading day (per the indicator).
-- Win/Loss is NOT tracked yet — this is a pure record of what was drawn.
--
-- bar_time = the ms-epoch of the Pine bar that created the frame (from Pine
-- time). created_at = arrival time at the webhook (UTC), the sortable column.

begin;

create table public.fibo_snapshots (
  id          bigint generated always as identity primary key,
  symbol      text        not null,
  tf          text,                       -- calc timeframe (e.g. "15")
  seq         int,                        -- ลำดับกรอบในวัน (reset รายวัน)
  frame_no    bigint,                     -- ตัวนับกรอบสะสม (unique per chart session)
  entry_mode  text,                       -- "Focus 2.0" | "Test 1.272"
  frame_mode  text,                       -- "SYM" (สมมาตร เดิม) | "DIR" (fibo ตามทิศขา)
  leg_dir     text,                       -- "UP" | "DOWN" (ทิศขา swing ล่าสุด)
  active_side text,                       -- "S" | "B" | "BOTH" (ฝั่งที่ active ในโหมด DIR)
  zone_pts    numeric,
  price       numeric,                    -- close ตอนตีกรอบ
  bar_time    bigint,                     -- ms epoch ของแท่งที่ตีกรอบ (Pine time)
  -- โครงสร้างกรอบ
  fh          numeric,                    -- 1.0 High
  fl          numeric,                    -- 0.0 Low
  mid         numeric,                    -- 0.5 Mid (TP2)
  -- ฝั่ง S (ขาย บน)
  s_focus     numeric,
  s_test      numeric,
  s_tp1       numeric,
  s_tp3       numeric,
  s_sl        numeric,
  -- ฝั่ง B (ซื้อ ล่าง)
  b_focus     numeric,
  b_test      numeric,
  b_tp1       numeric,
  b_tp3       numeric,
  b_sl        numeric,
  raw         jsonb,                       -- payload ดิบทั้งก้อน เผื่อเพิ่มฟิลด์ทีหลัง
  created_at  timestamptz not null default now()
);

create index fibo_snapshots_created_idx  on public.fibo_snapshots (created_at desc);
create index fibo_snapshots_symbol_idx   on public.fibo_snapshots (symbol, created_at desc);

-- RLS: webhook writes with the service-role key (bypasses RLS). The journal UI
-- reads with the anon key, so allow anon/authenticated SELECT only.
alter table public.fibo_snapshots enable row level security;

create policy fibo_snapshots_read
  on public.fibo_snapshots for select
  to anon, authenticated
  using (true);

grant select on public.fibo_snapshots to anon, authenticated;

commit;

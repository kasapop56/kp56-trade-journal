-- ── Fibo Snapshots: frame-mode columns (Phase 8d) ───────────────────────────
-- Run in Supabase SQL editor. Additive migration — safe on the existing
-- fibo_snapshots table (columns are nullable, no backfill needed).
--
-- Adds the A/B fields the Pine indicator now sends on every snapshot so we can
-- separate the two frame-drawing modes in analysis instead of digging in raw:
--   frame_mode  "SYM" = symmetric (เดิม: วาด S+B ทุกกรอบ)
--               "DIR" = directional (fibo ปกติ: วาดเฉพาะฝั่งตามทิศขา swing)
--   leg_dir     "UP" | "DOWN"  — ทิศขา swing ล่าสุด (high ใหม่กว่า = UP)
--   active_side "S" | "B" | "BOTH" — ฝั่งที่ active (BOTH เมื่อโหมด SYM)
--
-- Old rows (pre-migration) keep NULL here → treat NULL frame_mode as "SYM".

begin;

alter table public.fibo_snapshots
  add column if not exists frame_mode  text,
  add column if not exists leg_dir     text,
  add column if not exists active_side text;

-- Handy filter for A/B queries (e.g. compare DIR vs SYM outcomes downstream).
create index if not exists fibo_snapshots_mode_idx
  on public.fibo_snapshots (symbol, frame_mode, created_at desc);

commit;

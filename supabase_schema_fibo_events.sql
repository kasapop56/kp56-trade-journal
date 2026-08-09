-- ── Fibo Focus Win/Loss events (Phase 8b) ───────────────────────────────────
-- Run in Supabase SQL editor. New table only — touches nothing existing.
--
-- Append-only lifecycle events for each side of a Fibo frame:
--   ENTER  — price reached the entry zone (Test = close in zone, Focus = touch)
--   WIN    — TP1 hit before SL
--   LOSS   — SL hit before TP1
-- (VOID / no-entry is NOT emitted; the UI infers it: a frame side with no ENTER
--  by the time the next frame is drawn = never entered.)
--
-- frame_id = the ms-epoch of the bar that CREATED the frame = fibo_snapshots.bar_time.
-- Join back to the drawn frame on (symbol, frame_id).
--
-- mfe = max favorable price since entry (lowest low for S, highest high for B).
-- The UI maps mfe against the snapshot's TP1..TP4 to show "best TP reached".

begin;

create table public.fibo_events (
  id          bigint generated always as identity primary key,
  symbol      text        not null,
  frame_id    bigint,                     -- = fibo_snapshots.bar_time
  seq         int,                        -- ลำดับกรอบในวัน (จาก snapshot)
  side        text,                       -- 'S' | 'B'
  event       text        not null,       -- 'ENTER' | 'WIN' | 'LOSS'
  entry_mode  text,
  entry       numeric,                    -- ระดับเข้า
  tp1         numeric,
  sl          numeric,
  mfe         numeric,                    -- max favorable price since entry
  price       numeric,                    -- close ตอน event
  bar_time    bigint,                     -- ms epoch ของแท่งที่เกิด event
  raw         jsonb,
  created_at  timestamptz not null default now()
);

create index fibo_events_frame_idx   on public.fibo_events (symbol, frame_id);
create index fibo_events_created_idx  on public.fibo_events (created_at desc);
create index fibo_events_event_idx    on public.fibo_events (event);

-- RLS: webhook writes with service-role (bypasses RLS); journal UI reads anon.
alter table public.fibo_events enable row level security;

create policy fibo_events_read
  on public.fibo_events for select
  to anon, authenticated
  using (true);

grant select on public.fibo_events to anon, authenticated;

commit;

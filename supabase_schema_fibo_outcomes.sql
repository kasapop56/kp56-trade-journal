-- ── Phase 8c: data-driven Fibo # outcomes ───────────────────────────────────
-- Derived by /api/fibo-eval: it replays each fibo_snapshots frame's stored
-- levels against the RainbowPilot BAR price feed (trade_events.payload.ctx.bar1
-- OHLC). Unlike fibo_events (append-only, Pine-fired, active-frame-only), this
-- is UPSERT keyed on (frame_id, side): every run recomputes the current state,
-- so a side can move PENDING → ENTERED → WIN/LOSS as more bars arrive — and it
-- tracks ALL frames, including ones a newer frame superseded.
--
-- status: 'pending' (zone not yet touched) · 'entered' (in trade, unresolved)
--         · 'win' (TP1 before SL) · 'loss' (SL before TP1, ties count LOSS)
-- best_tp: deepest TP reached by MFE (0 none · 1 TP1 · 2 TP2/mid · 3 TP3 · 4 TP4)

create table if not exists public.fibo_outcomes (
  frame_id     bigint      not null,   -- = fibo_snapshots.bar_time (ms epoch)
  side         text        not null,   -- 'S' | 'B'
  status       text        not null,   -- pending | entered | win | loss
  entered_at   bigint,                 -- ms epoch of the bar that entered
  resolved_at  bigint,                 -- ms epoch of the bar that hit TP1/SL
  result       text,                   -- 'win' | 'loss' | null (unresolved)
  mfe          double precision,       -- best price reached since entry
  best_tp      int         not null default 0,
  bars_seen    int         not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (frame_id, side)
);

create index if not exists fibo_outcomes_status_idx on public.fibo_outcomes (status);

-- Anon read (the Fibo tab reads outcomes with the anon key). Writes happen only
-- server-side via the service role, which bypasses RLS.
alter table public.fibo_outcomes enable row level security;
drop policy if exists "fibo_outcomes anon read" on public.fibo_outcomes;
create policy "fibo_outcomes anon read" on public.fibo_outcomes
  for select to anon using (true);

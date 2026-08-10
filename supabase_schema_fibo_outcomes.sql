-- ── Phase 8c: data-driven Fibo # outcomes (Focus + Test, both modes) ─────────
-- Derived by /api/fibo-eval: it replays each fibo_snapshots frame's stored levels
-- against the RainbowPilot BAR price feed (trade_events.payload.ctx.bar1 OHLC).
-- Every run recomputes and UPSERTs, keyed on (frame_id, side, mode) — so a side
-- can move PENDING → ENTERED → WIN/LOSS as more bars arrive, and BOTH entry modes
-- (Focus 2.0 / Test 1.272) are evaluated for every #, from the same price data,
-- so we can compare which entry wins more. Tracks ALL frames incl. superseded.
--
-- status : pending (zone not touched) · entered · win (TP1<SL) · loss (SL<TP1, tie=LOSS)
-- mfe    : favorable extreme, tracked to SL-close (not stopped at TP1) → best_tp
-- mae    : adverse extreme (heat) BEFORE the trade resolved
-- best_tp: deepest TP reached by MFE (0 none · 1 TP1 · 2 TP2/mid · 3 TP3 · 4 TP4)

-- Derived data — safe to drop & recreate when the shape changes.
drop table if exists public.fibo_outcomes;

create table public.fibo_outcomes (
  frame_id     bigint      not null,   -- = fibo_snapshots.bar_time (ms epoch)
  side         text        not null,   -- 'S' | 'B'
  mode         text        not null,   -- 'focus' | 'test'
  status       text        not null,
  entered_at   bigint,
  resolved_at  bigint,
  result       text,                   -- 'win' | 'loss' | null
  mfe          double precision,
  mae          double precision,
  best_tp      int         not null default 0,
  bars_seen    int         not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (frame_id, side, mode)
);

create index if not exists fibo_outcomes_status_idx on public.fibo_outcomes (status);

-- Anon read (the Fibo tab reads outcomes with the anon key). Writes are
-- server-side via the service role, which bypasses RLS.
alter table public.fibo_outcomes enable row level security;
drop policy if exists "fibo_outcomes anon read" on public.fibo_outcomes;
create policy "fibo_outcomes anon read" on public.fibo_outcomes
  for select to anon using (true);

-- ── Fibo Snapshots: frame-state columns (Phase 8g) ──────────────────────────
-- Run in Supabase SQL editor. Additive migration — safe on the existing
-- fibo_snapshots table (columns are nullable, no backfill needed).
--
-- Why: a frame whose SL has been traded through is dead — the swing it was
-- drawn from is broken — but the indicator used to keep drawing and sending it
-- as if it were live. It now invalidates on SL and re-anchors to a finer swing
-- degree (M5) when the main TF has no fresh pivot to offer. In a one-way move
-- a new pivot HIGH literally cannot form on M15 (every earlier bar is higher),
-- so the main frame's FH would otherwise stay pinned to the pre-impulse top.
--
--   state      "MAIN"     = main-TF frame, SL intact → tradeable
--              "FALLBACK" = main frame died on SL; levels come from src_tf
--                           (a finer degree, confirmed pivots, no repaint)
--              "WAIT"     = dead and no fresh leg anywhere → levels in this row
--                           are the last (dead) set, kept only so the payload
--                           shape stays stable. DO NOT trade or quote them.
--   src_tf     timeframe the levels were actually anchored on ("15" | "5").
--              tf still carries the CONFIGURED main TF, unchanged.
--   dead_side  which SL killed the main frame: "S" | "B" | "BOTH" | "".
--
-- Old rows (pre-migration) keep NULL → treat NULL state as "MAIN".

begin;

alter table public.fibo_snapshots
  add column if not exists state     text,
  add column if not exists src_tf    text,
  add column if not exists dead_side text;

-- "what did the co-pilot actually have in front of it" queries + the
-- degree A/B (do FALLBACK frames trade as well as MAIN ones?).
create index if not exists fibo_snapshots_state_idx
  on public.fibo_snapshots (symbol, state, created_at desc);

commit;

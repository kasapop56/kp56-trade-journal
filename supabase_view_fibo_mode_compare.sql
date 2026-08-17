-- ── View: fibo_mode_compare (Phase 8e) ──────────────────────────────────────
-- Run in Supabase SQL editor. Read-only view — creates nothing that writes.
--
-- Answers "Symmetric vs Directional — อันไหนดีกว่า?" from the SAME data stream.
-- No second chart needed: fibo-eval already replays BOTH sides of every frame,
-- and Pine now stamps leg_dir (UP/DOWN) on every snapshot. So the DIR mode is
-- just a post-hoc filter on the side that matches the swing leg:
--     leg_dir = UP   → active side = S   (extension ต้านขาขึ้น)
--     leg_dir = DOWN → active side = B   (extension ต้านขาลง)
--
-- Three groups per (mode):
--   DIR     — leg-aligned side  = what Directional would trade
--   counter — opposite side     = what Directional drops
--   SYM     — DIR + counter     = current behaviour (trade both)
--
-- Decision rule: if `counter` expectancy is negative / much worse → DIR wins
-- (drops a losing side). If `counter` is still positive & comparable → SYM wins
-- on total profit (both sides earn).
--
-- Only frames with leg_dir set are included → pre-migration frames are ignored
-- (they never carried the label). Data starts accruing from 2026-08-17 onward.
--
-- Expectancy:  WIN = +tp1_pts,  LOSS = -sl_pts   (per-frame, from the snapshot).
--   exp_pts = average points per resolved trade
--   exp_r   = average R per trade  (WIN = tp1/sl,  LOSS = -1)
-- mode = 'ALL' row rolls up focus+test together.

begin;

create or replace view public.fibo_mode_compare as
with j as (
  select
    o.mode,
    o.result,
    case when (s.leg_dir = 'UP'   and o.side = 'S')
           or (s.leg_dir = 'DOWN' and o.side = 'B')
         then 'DIR' else 'counter' end                       as leg_grp,
    coalesce((s.raw->>'tp1_pts')::numeric, 500)              as tp1_pts,
    coalesce((s.raw->>'sl_pts')::numeric,  550)              as sl_pts
  from public.fibo_outcomes  o
  join public.fibo_snapshots s on s.bar_time = o.frame_id
  where s.leg_dir is not null
    and o.result in ('win', 'loss')
),
-- DIR + counter as themselves, plus a SYM copy that unions both groups.
u as (
  select leg_grp as grp, mode, result, tp1_pts, sl_pts from j
  union all
  select 'SYM'   as grp, mode, result, tp1_pts, sl_pts from j
)
select
  grp,
  coalesce(mode, 'ALL')                                                 as mode,
  count(*)                                                              as trades,
  count(*) filter (where result = 'win')                               as wins,
  count(*) filter (where result = 'loss')                              as losses,
  round(100.0 * count(*) filter (where result = 'win')
        / nullif(count(*), 0), 1)                                      as winrate_pct,
  round(avg(case when result = 'win' then tp1_pts else -sl_pts end), 1) as exp_pts,
  round(avg(case when result = 'win' then tp1_pts / sl_pts else -1 end), 3) as exp_r,
  round(sum(case when result = 'win' then tp1_pts else -sl_pts end), 0) as net_pts
from u
group by grouping sets ((grp, mode), (grp))
order by mode, grp;

-- Let the Journal UI (anon key) read it later without extra work.
grant select on public.fibo_mode_compare to anon, authenticated;

commit;

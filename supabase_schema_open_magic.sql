-- open_magic: magic number of the deal that OPENED the position.
-- The existing `magic` column comes from the CLOSING deal (JournalSync reads
-- DEAL_MAGIC off close_deal), so attribution flips whenever opener ≠ closer:
--   • EA-opened trade closed by hand  → magic 0,  open_magic 56
--   • manual trade closed by the EA   → magic 56, open_magic 0
-- Needed by the Manual Trade Study to measure whether hand-overrides of the
-- SmartGrid exit stack add or destroy value.
-- NULL = row synced by JournalSync ≤ v1.20 (pre-open_magic) — unknowable.
--
-- Run once in Supabase SQL Editor.

alter table mt5_trades
  add column if not exists open_magic bigint;

comment on column mt5_trades.open_magic is
  'DEAL_MAGIC of the opening deal (JournalSync v1.21+). magic = closing deal. NULL = synced before v1.21.';

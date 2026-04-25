-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4: Thai astrology numerology context.
--
-- Applied to TWO tables:
--   mt5_trades   — live EA sync (timestamptz open_time, UTC)
--   trade_ideas  — manual journal (date + entry_time in Asia/Bangkok)
--
-- Day-of-week → day star mapping (อาทิตย์=1 … เสาร์=7).
-- pair_middle = last digit of hour × 10 + first digit of minute
--   e.g. 14:32 → (4×10)+3 = 43
--
-- Filled by:
--   1. api/ingest.js            — new trade_closed events (mt5_trades)
--   2. numerology/backfill.py   — one-shot backfill for both tables
--
-- Idempotent: each ADD COLUMN uses IF NOT EXISTS, safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── mt5_trades (UTC open_time → convert to Asia/Bangkok) ──────────────────
alter table mt5_trades add column if not exists trade_date_th    date;
alter table mt5_trades add column if not exists day_star         text;
alter table mt5_trades add column if not exists day_star_num     smallint;
alter table mt5_trades add column if not exists open_hour_th     smallint;
alter table mt5_trades add column if not exists open_minute_th   smallint;
alter table mt5_trades add column if not exists open_pair_middle smallint;

create index if not exists mt5_trades_day_star_idx        on mt5_trades (day_star);
create index if not exists mt5_trades_trade_date_th_idx   on mt5_trades (trade_date_th);
create index if not exists mt5_trades_open_hour_th_idx    on mt5_trades (open_hour_th);

-- ── trade_ideas (date + entry_time already in Asia/Bangkok) ───────────────
alter table trade_ideas add column if not exists day_star          text;
alter table trade_ideas add column if not exists day_star_num      smallint;
-- entry_pair_middle from entry_time (BKK local): e.g. 09:32 → 93
alter table trade_ideas add column if not exists entry_pair_middle smallint;

create index if not exists trade_ideas_day_star_idx on trade_ideas (day_star);
create index if not exists trade_ideas_result_idx   on trade_ideas (result);

notify pgrst, 'reload schema';

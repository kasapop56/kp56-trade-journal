-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3b: Mario context columns on mt5_trades.
--
-- Captures the Mario v5 indicator's state at the moment a position closed,
-- handed off from the indicator to JournalSync EA via MT5 GlobalVariables
-- (numeric encoding) and decoded into text on the EA before POSTing.
--
-- Idempotent: each ADD COLUMN uses IF NOT EXISTS, safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table mt5_trades add column if not exists bias_m15        text;
alter table mt5_trades add column if not exists bias_m5         text;
alter table mt5_trades add column if not exists ob_status       text;
alter table mt5_trades add column if not exists svp_poc         numeric;
alter table mt5_trades add column if not exists svp_vah         numeric;
alter table mt5_trades add column if not exists svp_val         numeric;
alter table mt5_trades add column if not exists mario_session   text;
alter table mt5_trades add column if not exists mario_decision  text;
alter table mt5_trades add column if not exists capture_method  text;

notify pgrst, 'reload schema';

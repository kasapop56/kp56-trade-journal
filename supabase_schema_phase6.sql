-- ── Phase 6: multi-account support ───────────────────────────────────────────
-- Run in Supabase SQL editor (or psql). Safe on live data — single account
-- 87464504 exists today, so the constraint swap cannot hit duplicates.
--
-- 1. deal_ticket uniqueness becomes per-account. Deal tickets from different
--    brokers/servers live in separate number spaces; a global UNIQUE would let
--    a demo-account ticket silently overwrite a real-account trade on upsert.
-- 2. v_trades_unified gains account_login + magic (appended at the end so
--    CREATE OR REPLACE VIEW is allowed). Manual trade_ideas rows are tagged
--    with the real account 87464504 — the manual journal IS the real account.
-- 3. v_accounts: tiny directory view the UI account switcher reads.

begin;

alter table public.mt5_trades
  drop constraint mt5_trades_deal_ticket_key;

alter table public.mt5_trades
  add constraint mt5_trades_account_deal_key unique (account_login, deal_ticket);

create or replace view public.v_trades_unified as
 SELECT 'MANUAL'::text AS source,
    ti.id AS row_id,
    ti.date AS display_date,
        CASE
            WHEN ti.entry_time IS NOT NULL THEN to_char(ti.entry_time::interval, 'HH24:MI'::text)
            ELSE NULL::text
        END AS entry_time,
        CASE
            WHEN ti.exit_time IS NOT NULL THEN to_char(ti.exit_time::interval, 'HH24:MI'::text)
            ELSE NULL::text
        END AS exit_time,
    ti.direction,
        CASE
            WHEN ti.result = 'BE'::text THEN 'BE'::text
            WHEN ti.total_pnl IS NULL THEN NULL::text
            WHEN ti.total_pnl > 0::numeric THEN 'WIN'::text
            WHEN ti.total_pnl < 0::numeric THEN 'LOSS'::text
            ELSE NULL::text
        END AS outcome,
    ti.total_pnl,
    NULL::text AS symbol,
    pa.first_lot AS volume,
    ti.session,
    ti.bias_h1,
    ti.bias_m5,
    ti.result AS manual_result,
    ti.sl_level,
    ti.max_drawdown,
    COALESCE(pa.cnt, 0) AS positions_count,
    lower(concat_ws(' '::text, ti.key_levels, ti.memo, ti.post_trade_notes, 'manual')) AS search_blob,
    ti.date::timestamp without time zone + COALESCE(ti.exit_time, ti.entry_time, '00:00:00'::time without time zone)::interval AS sort_key,
    87464504::bigint AS account_login,
    NULL::bigint AS magic
   FROM trade_ideas ti
     LEFT JOIN ( SELECT positions.trade_idea_id,
            count(*)::integer AS cnt,
            (array_agg(positions.lot_size ORDER BY positions.id))[1] AS first_lot
           FROM positions
          GROUP BY positions.trade_idea_id) pa ON pa.trade_idea_id = ti.id
UNION ALL
 SELECT 'MT5'::text AS source,
    mt.id AS row_id,
    ((mt.close_time AT TIME ZONE 'UTC'::text) + '03:00:00'::interval)::date AS display_date,
    to_char((mt.open_time AT TIME ZONE 'UTC'::text) + '03:00:00'::interval, 'HH24:MI'::text) AS entry_time,
    to_char((mt.close_time AT TIME ZONE 'UTC'::text) + '03:00:00'::interval, 'HH24:MI'::text) AS exit_time,
        CASE
            WHEN lower(mt.type) = 'buy'::text THEN 'BUY'::text
            ELSE 'SELL'::text
        END AS direction,
        CASE
            WHEN abs(mt.close_price - mt.open_price) <= 0.50 THEN 'BE'::text
            WHEN (mt.profit + COALESCE(mt.swap, 0::numeric) + COALESCE(mt.commission, 0::numeric)) > 0::numeric THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS outcome,
    mt.profit + COALESCE(mt.swap, 0::numeric) + COALESCE(mt.commission, 0::numeric) AS total_pnl,
    mt.symbol,
    mt.volume,
    NULL::text AS session,
    NULL::text AS bias_h1,
    NULL::text AS bias_m5,
    NULL::text AS manual_result,
    mt.sl AS sl_level,
    NULL::numeric AS max_drawdown,
    1 AS positions_count,
    lower(concat_ws(' '::text, mt.symbol, mt.comment, 'mt5', mt.deal_ticket::text, mt.position_id::text)) AS search_blob,
    (mt.close_time AT TIME ZONE 'UTC'::text) + '03:00:00'::interval AS sort_key,
    mt.account_login,
    mt.magic
   FROM mt5_trades mt;

-- Account directory for the UI switcher: every account that has ever posted a
-- trade or a balance snapshot, with last-seen time for ordering.
create or replace view public.v_accounts as
 SELECT account_login,
        max(last_seen) AS last_seen,
        sum(trades)::integer AS trades
   FROM (
     SELECT account_login, max(close_time) AS last_seen, count(*) AS trades
       FROM public.mt5_trades GROUP BY account_login
     UNION ALL
     SELECT account_login, max(recorded_at), 0
       FROM public.balance_snapshots GROUP BY account_login
   ) u
  GROUP BY account_login;

grant select on public.v_accounts to anon, authenticated;

commit;

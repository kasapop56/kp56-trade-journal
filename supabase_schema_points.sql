-- ============================================================================
-- Points column + bias passthrough for v_trades_unified  (2026-08-13)
-- ----------------------------------------------------------------------------
-- Two view fixes, no data added:
--
--   1. Adds a lot-independent "points" measure so trade quality can be judged
--      apart from position sizing (user varies lot 0.05–0.3). USD stays
--      untouched — points is an ADDITIONAL dimension, not a replacement.
--   2. Passes through bias_m15 / bias_m5 for MT5 rows. mt5_trades already
--      stores these (populated on every synced trade) but the old view nulled
--      them, leaving the Bias Win Rate chart empty. Now surfaced as bias_h1 /
--      bias_m5 (same slots the manual side uses).
--
--   1 point = $0.01 of XAUUSD price (MT5 2-digit point). A $1.00 gold move = 100
--   points. Contract size 100 oz/lot is irrelevant here — points is pure price
--   travel in the trade's favour (positive = win, negative = loss).
--
-- MT5 rows:   signed price travel, direction-aware.
-- MANUAL rows: NULL (trade_ideas stores no single open/close price).
--
-- Column is APPENDED at the very end (after `magic`) so CREATE OR REPLACE VIEW
-- is allowed without dropping the view. Run in the Supabase SQL editor.
-- ============================================================================
begin;

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
    NULL::bigint AS magic,
    NULL::numeric AS points
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
    mt.bias_m15 AS bias_h1,
    mt.bias_m5 AS bias_m5,
    NULL::text AS manual_result,
    mt.sl AS sl_level,
    NULL::numeric AS max_drawdown,
    1 AS positions_count,
    lower(concat_ws(' '::text, mt.symbol, mt.comment, 'mt5', mt.deal_ticket::text, mt.position_id::text)) AS search_blob,
    (mt.close_time AT TIME ZONE 'UTC'::text) + '03:00:00'::interval AS sort_key,
    mt.account_login,
    mt.magic,
    round((CASE
            WHEN lower(mt.type) = 'buy'::text THEN mt.close_price - mt.open_price
            ELSE mt.open_price - mt.close_price
        END) * 100::numeric)::numeric AS points
   FROM mt5_trades mt;

grant select on public.v_trades_unified to anon, authenticated;

commit;

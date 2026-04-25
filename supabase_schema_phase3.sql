-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 schema: unified trades view for server-side pagination + filter
-- pushdown on the History page.
--
-- Safe to run on existing Phase 2 database. Creates a view only — no table
-- changes, no data migration. Re-runnable (CREATE OR REPLACE).
--
-- Hardcoded broker TZ offset: +3 hours (HF Markets summer time).
-- Switch to +2 in winter (CET) by editing the two `INTERVAL '3 hours'` lines.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop first because CREATE OR REPLACE VIEW can't add or reorder columns —
-- it can only swap implementations with the same column list. Safe to drop:
-- views hold no data.
drop view if exists v_trades_unified;

create view v_trades_unified
with (security_invoker = on) as
select
  'MANUAL'::text                                             as source,
  ti.id                                                      as row_id,
  ti.date                                                    as display_date,
  case when ti.entry_time is not null
       then to_char(ti.entry_time, 'HH24:MI') end            as entry_time,
  case when ti.exit_time  is not null
       then to_char(ti.exit_time,  'HH24:MI') end            as exit_time,
  ti.direction                                               as direction,
  case
    when ti.result = 'BE'         then 'BE'
    when ti.total_pnl is null     then null
    when ti.total_pnl > 0         then 'WIN'
    when ti.total_pnl < 0         then 'LOSS'
    else null
  end                                                        as outcome,
  ti.total_pnl                                               as total_pnl,
  null::text                                                 as symbol,
  (select p.lot_size from positions p
     where p.trade_idea_id = ti.id order by p.id limit 1)    as volume,
  ti.session                                                 as session,
  ti.bias_h1                                                 as bias_h1,
  ti.bias_m5                                                 as bias_m5,
  ti.result                                                  as manual_result,
  ti.sl_level                                                as sl_level,
  ti.max_drawdown                                            as max_drawdown,
  (select count(*)::int from positions p
     where p.trade_idea_id = ti.id)                          as positions_count,
  lower(concat_ws(' ',
    ti.key_levels, ti.memo, ti.post_trade_notes, 'manual'))  as search_blob,
  -- Sort key: naive timestamp from date + exit_time (fallback entry_time,
  -- fallback midnight). Matches the client-side lexicographic ordering of
  -- `${date}T${time}` in normalizeManualTrade.
  (ti.date::timestamp
     + coalesce(ti.exit_time, ti.entry_time, '00:00:00'::time))
    ::timestamp                                              as sort_key
from trade_ideas ti

union all

select
  'MT5'::text                                                as source,
  mt.id                                                      as row_id,
  -- Broker-local date: shift UTC close_time by +3h, take date part.
  ((mt.close_time at time zone 'UTC')
     + interval '3 hours')::date                             as display_date,
  to_char(((mt.open_time  at time zone 'UTC')
     + interval '3 hours'), 'HH24:MI')                       as entry_time,
  to_char(((mt.close_time at time zone 'UTC')
     + interval '3 hours'), 'HH24:MI')                       as exit_time,
  case when lower(mt.type) = 'buy' then 'BUY' else 'SELL' end as direction,
  -- Outcome: BE detected via $0.50 price window (matches normalizeMT5Trade
  -- in js/app.js) — a close within $0.50 of entry on XAUUSDr is treated as
  -- flat, regardless of the P&L sign after spread/commission.
  case
    when abs(mt.close_price - mt.open_price) <= 0.50 then 'BE'
    when (mt.profit + coalesce(mt.swap,0) + coalesce(mt.commission,0)) > 0 then 'WIN'
    else 'LOSS'
  end                                                        as outcome,
  (mt.profit + coalesce(mt.swap,0) + coalesce(mt.commission,0))
                                                             as total_pnl,
  mt.symbol                                                  as symbol,
  mt.volume                                                  as volume,
  null::text                                                 as session,
  null::text                                                 as bias_h1,
  null::text                                                 as bias_m5,
  null::text                                                 as manual_result,
  mt.sl                                                      as sl_level,
  null::numeric                                              as max_drawdown,
  1::int                                                     as positions_count,
  lower(concat_ws(' ',
    mt.symbol, mt.comment, 'mt5',
    mt.deal_ticket::text, mt.position_id::text))             as search_blob,
  ((mt.close_time at time zone 'UTC')
     + interval '3 hours')::timestamp                        as sort_key
from mt5_trades mt;

-- Expose the view to PostgREST via the Supabase anon/authenticated roles.
-- Underlying RLS on trade_ideas + mt5_trades already allow anon read,
-- and `security_invoker = on` makes the view honor those policies.
grant select on v_trades_unified to anon;
grant select on v_trades_unified to authenticated;

-- ── Anon write access to mt5_trades (for HTML-report backfill import) ─────
-- Phase 2 only allowed anon SELECT; the History-page importer now writes
-- directly to mt5_trades when the user uploads an HTML report to fill VPS
-- gaps. Same trust model as trade_ideas (already "for all" to anon).
drop policy if exists "Anon insert mt5_trades" on mt5_trades;
drop policy if exists "Anon update mt5_trades" on mt5_trades;
create policy "Anon insert mt5_trades"
  on mt5_trades for insert with check (true);
create policy "Anon update mt5_trades"
  on mt5_trades for update using (true) with check (true);

-- Nudge PostgREST to reload its schema cache so the new view shows up in
-- the REST API immediately (otherwise it can take ~60s).
notify pgrst, 'reload schema';

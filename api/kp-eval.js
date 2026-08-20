// api/kp-eval.js — KP56 Co-pilot read evaluator (Phase 9 feedback loop).
//
// REPLAYS every co-pilot read (kp_signals) against the intraday BAR feed
// (trade_events, event='BAR', payload.ctx.bar1 = [o,h,l,c], payload.t_gmt), capped
// to the read's Bangkok trading day, and classifies what price ACTUALLY did — in
// the language of the DAILY ATR ladder the trader sees on the chart (from kp_atr /
// the "Daily ATR Zones" indicator; a rough ATR is computed from the feed if the
// indicator's alert is missing for that day). Not just win/loss:
//   • day_type   — BALANCE / NORMAL / TREND / OUTSIZED via ATR travel from open
//   • fav_atr / adv_atr — run WITH vs AGAINST the call, in daily-ATR units
//   • zone_behavior — did the zone the read leaned on HOLD / BREAK / get swept
//   • verdict    — WIN/LOSS/STALL/PARTIAL/OK_NOTRADE/MISSED/PENDING/EXPIRED/NO_BARS
//
// GET /api/kp-eval            → diagnostics only (read-only, default)
// GET /api/kp-eval?write=1    → replay + upsert kp_read_outcomes, return tally
// GET /api/kp-eval?days=30    → lookback window for reads (default from config)
//
// No Pine/EA change. Writes via service-role. Mirrors api/fibo-eval.js.

const { createClient } = require('@supabase/supabase-js');
const CFG = require('./_kp_config');

const POINT = 0.01;                 // XAUUSD 1 point in price
const SYM   = 'XAUUSD';

let _db;
function db() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isGold = (s) => typeof s === 'string' && s.toUpperCase().replace(/[^A-Z]/g, '').startsWith(SYM);
const bkkDay = (ms) => Math.floor((ms + 7 * 3600e3) / 86400e3);       // Bangkok civil-day index
function bkkDateStr(ms) {
  const t = new Date(ms + 7 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
function parseGmt(s) {
  const m = typeof s === 'string' && s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Pull ALL matching BAR bars since sinceISO (PostgREST caps each page at 1000).
async function loadBars(sinceISO) {
  const page = 1000;
  let from = 0, out = [];
  for (;;) {
    const { data, error } = await db()
      .from('trade_events').select('symbol, payload, created_at')
      .eq('event', 'BAR').gte('created_at', sinceISO)
      .order('created_at', { ascending: true }).range(from, from + page - 1);
    if (error) throw new Error('bars: ' + error.message);
    if (!data || !data.length) break;
    for (const b of data) {
      if (!isGold(b.symbol)) continue;
      const bar1 = b.payload?.ctx?.bar1;
      const t = parseGmt(b.payload?.t_gmt) ?? Date.parse(b.created_at);
      if (Array.isArray(bar1) && bar1.length === 4 && t != null)
        out.push({ t, o: +bar1[0], h: +bar1[1], l: +bar1[2], c: +bar1[3] });
    }
    if (data.length < page) break;
    from += page;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Group bars into Bangkok trading days: open/high/low/close + the day's bar list.
function buildDays(bars) {
  const m = new Map();
  for (const b of bars) {
    const d = bkkDay(b.t);
    let e = m.get(d);
    if (!e) { e = { day: d, open: b.o, high: b.h, low: b.l, close: b.c, bars: [b] }; m.set(d, e); }
    else { e.high = Math.max(e.high, b.h); e.low = Math.min(e.low, b.l); e.close = b.c; e.bars.push(b); }
  }
  return m;
}

// Rough daily ATR fallback (SMA of true range over `len` days before targetDay).
// Only used when the indicator's alert didn't land for that day.
function computeAtr(daysArr, targetDay, len) {
  const idx = daysArr.findIndex(d => d.day === targetDay);
  if (idx < 1) return null;
  const trs = [];
  for (let i = Math.max(1, idx - len); i < idx; i++) {
    const d = daysArr[i], p = daysArr[i - 1];
    trs.push(Math.max(d.high - d.low, Math.abs(d.high - p.close), Math.abs(d.low - p.close)));
  }
  if (!trs.length) return null;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function normCall(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'buy') return 'buy';
  if (v === 'sell') return 'sell';
  if (v.includes('no') || v.includes('trade')) return 'none';
  return null;
}

const DAY_WORD  = { BALANCE: 'วันทรงตัว', NORMAL: 'วันปกติ', TREND: 'วันเทรนด์', OUTSIZED: 'วันเหวี่ยงแรง', UNKNOWN: '—' };
const ZONE_WORD = { HELD: 'โซนยืน', BROKE: 'โซนแตก', SWEEP_RECLAIM: 'กวาดแล้วกลับ', UNTESTED: 'ยังไม่แตะ', NA: '' };

// Classify one read against its Bangkok trading day.
function classify(sig, stateRow, atrRow, dayMap, daysArr) {
  const E = CFG.eval;
  const P0 = num(sig.price);
  const t0 = Date.parse(sig.ts);
  const day = bkkDay(t0);
  const today = bkkDay(Date.now());
  const call = normCall(sig.bias_call);
  const dayEntry = dayMap.get(day) || null;

  const base = {
    signal_id: sig.id, read_ts: sig.ts, bkk_date: bkkDateStr(t0),
    symbol: sig.symbol || CFG.symbol, call: sig.bias_call || null, read_price: P0,
    updated_at: new Date().toISOString(),
  };

  // ── ATR frame ──
  let atr = num(atrRow?.atr), atrSource = atr != null ? 'indicator' : null;
  let dayOpen = num(atrRow?.day_open);
  if (atr == null) { atr = computeAtr(daysArr, day, atrRow?.atr_len || 10); atrSource = atr != null ? 'computed' : 'none'; }
  if (dayOpen == null) dayOpen = dayEntry ? dayEntry.open : null;

  const dayHigh = dayEntry ? dayEntry.high : null;
  const dayLow  = dayEntry ? dayEntry.low  : null;

  // No bars for the read's day at all → can't say anything yet.
  if (!dayEntry || P0 == null) {
    return { ...base, day_open: dayOpen, atr, atr_source: atrSource || 'none',
      verdict: day < today ? 'EXPIRED' : 'PENDING', behavior_note: 'ยังไม่มีข้อมูลแท่งราคาของวันนี้',
      bars_seen: 0, day_type: 'UNKNOWN', direction_actual: 'RANGE', reached_target: false, zone_behavior: 'NA' };
  }

  // ── day-level behavior (whole Bangkok day, from open) ──
  const up = dayOpen != null ? dayHigh - dayOpen : null;
  const dn = dayOpen != null ? dayOpen - dayLow  : null;
  const upAtr = (atr && up != null) ? up / atr : null;
  const dnAtr = (atr && dn != null) ? dn / atr : null;
  let day_type = 'UNKNOWN', direction_actual = 'RANGE';
  if (atr && up != null && dn != null) {
    const travelAtr = Math.max(up, dn) / atr;
    day_type = travelAtr >= E.dayOutsizedAtr ? 'OUTSIZED'
             : travelAtr >= E.dayTrendAtr ? 'TREND'
             : travelAtr <  E.dayBalanceAtr ? 'BALANCE' : 'NORMAL';
    direction_actual = (up > dn && up / atr >= E.dayBalanceAtr) ? 'UP'
                     : (dn > up && dn / atr >= E.dayBalanceAtr) ? 'DOWN' : 'RANGE';
  }

  // ── read-level excursion from P0, in the CALL direction, after the read ──
  const after = dayEntry.bars.filter(b => b.t > t0);
  let maxH = null, minL = null, result = null;
  const dir = call === 'buy' ? 1 : call === 'sell' ? -1 : 0;   // +1 up-favorable
  const winLvl  = atr && dir ? P0 + dir * E.winAtr  * atr : null;
  const lossLvl = atr && dir ? P0 - dir * E.lossAtr * atr : null;
  for (const b of after) {
    maxH = maxH == null ? b.h : Math.max(maxH, b.h);
    minL = minL == null ? b.l : Math.min(minL, b.l);
    if (result === null && dir && atr) {
      const hitWin  = dir === 1 ? b.h >= winLvl  : b.l <= winLvl;
      const hitLoss = dir === 1 ? b.l <= lossLvl : b.h >= lossLvl;
      if (hitLoss && hitWin) result = 'loss';        // tie in one bar → conservative LOSS
      else if (hitLoss) result = 'loss';
      else if (hitWin) result = 'win';
    }
  }
  const favExt = dir === 1 ? maxH : minL;   // favorable extreme
  const advExt = dir === 1 ? minL : maxH;   // adverse extreme
  const fav = (dir && favExt != null) ? (dir === 1 ? favExt - P0 : P0 - favExt) : null;
  const adv = (dir && advExt != null) ? (dir === 1 ? P0 - advExt : advExt - P0) : null;
  const fav_atr = (atr && fav != null) ? Math.round((fav / atr) * 100) / 100 : null;
  const adv_atr = (atr && adv != null) ? Math.round((adv / atr) * 100) / 100 : null;
  const fav_pts = fav != null ? Math.round(fav / POINT) : null;
  const adv_pts = adv != null ? Math.round(adv / POINT) : null;
  const reached_band = (fav_atr != null) ? Math.round((fav_atr / 0.25)) * 0.25 : null;

  // ── zone the read leaned on (nearest opposing edge from the market state) ──
  const zone = call === 'buy' ? stateRow?.nearest_demand : call === 'sell' ? stateRow?.nearest_supply : null;
  let reached_target = false, zone_behavior = 'NA', target_zone = null;
  if (zone && num(zone.lo) != null && num(zone.hi) != null) {
    const lo = num(zone.lo), hi = num(zone.hi), buf = E.zoneBufferPrice;
    target_zone = { side: zone.side || (call === 'buy' ? 'demand' : 'supply'), lo, hi, label: zone.label || `${lo}-${hi}`, source: zone.source || null };
    const closeAfter = after.length ? after[after.length - 1].c : null;
    if (call === 'buy') {
      reached_target = minL != null && minL <= hi;
      if (!reached_target) zone_behavior = 'UNTESTED';
      else if (minL < lo - buf) zone_behavior = (closeAfter != null && closeAfter > lo) ? 'SWEEP_RECLAIM' : 'BROKE';
      else zone_behavior = 'HELD';
    } else if (call === 'sell') {
      reached_target = maxH != null && maxH >= lo;
      if (!reached_target) zone_behavior = 'UNTESTED';
      else if (maxH > hi + buf) zone_behavior = (closeAfter != null && closeAfter < hi) ? 'SWEEP_RECLAIM' : 'BROKE';
      else zone_behavior = 'HELD';
    }
  }

  // ── verdict ──
  let verdict;
  if (!after.length) verdict = day < today ? 'EXPIRED' : 'PENDING';
  else if (call === 'none') {
    verdict = (day_type === 'BALANCE' || direction_actual === 'RANGE') ? 'OK_NOTRADE'
            : (day < today ? 'MISSED' : 'PENDING');
  } else if (!atr) {
    verdict = day < today ? 'EXPIRED' : 'PENDING';   // can't grade without an ATR frame
  } else if (result === 'win') verdict = 'WIN';
  else if (result === 'loss') verdict = 'LOSS';
  else if (day < today) {
    const moved = Math.max(fav_atr || 0, adv_atr || 0);
    verdict = moved < E.stallAtr ? 'STALL' : 'PARTIAL';
  } else verdict = 'PENDING';

  // ── behavior note (Thai, ATR-ladder language) ──
  const dirWord = direction_actual === 'UP' ? 'ขึ้น' : direction_actual === 'DOWN' ? 'ลง' : 'ออกข้าง';
  const parts = [];
  if (call === 'none') {
    parts.push(`อ่าน "ไม่เทรด" · ${DAY_WORD[day_type]} ราคา${dirWord}`);
  } else if (fav_atr != null) {
    parts.push(`ไป ${fav_atr}ATR(${fav_pts}pt) สวน ${adv_atr}ATR`);
    parts.push(DAY_WORD[day_type]);
    if (target_zone) parts.push(`${target_zone.label} ${ZONE_WORD[zone_behavior] || ''}`.trim());
  } else {
    parts.push(`${DAY_WORD[day_type]} ราคา${dirWord}`);
  }
  const behavior_note = parts.filter(Boolean).join(' · ');

  return {
    ...base,
    day_open: dayOpen, atr: atr != null ? Math.round(atr * 100) / 100 : null, atr_source: atrSource || 'none',
    day_type, day_travel_up_atr: upAtr != null ? Math.round(upAtr * 100) / 100 : null,
    day_travel_dn_atr: dnAtr != null ? Math.round(dnAtr * 100) / 100 : null, direction_actual,
    fav_atr, adv_atr, fav_pts, adv_pts, reached_band,
    target_zone, reached_target, zone_behavior,
    verdict, behavior_note, bars_seen: after.length,
    meta: { day_high: dayHigh, day_low: dayLow, fav_ext: favExt, adv_ext: advExt, first_touch: result },
  };
}

// Core: (re)evaluate reads over a lookback window. Shared by the HTTP handler and
// the nightly report (so the report always grades against fresh outcomes).
async function runEval({ days = CFG.eval.lookbackDays, write = false } = {}) {
  {
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    // reads to grade
    const sigRes = await db().from('kp_signals')
      .select('id, ts, symbol, price, bias_call, market_state_id')
      .gte('ts', sinceISO).order('ts', { ascending: true }).limit(2000);
    if (sigRes.error) throw new Error('kp_signals: ' + sigRes.error.message);
    const signals = sigRes.data || [];

    // market states (zones) for those reads
    const stateIds = [...new Set(signals.map(s => s.market_state_id).filter(v => v != null))];
    const stateById = new Map();
    if (stateIds.length) {
      const stRes = await db().from('kp_market_state')
        .select('id, nearest_supply, nearest_demand').in('id', stateIds);
      if (!stRes.error) for (const r of stRes.data || []) stateById.set(r.id, r);
    }

    // daily ATR frames (indicator-fed); may be empty pre-setup → fallback compute
    const atrByDate = new Map();
    const atrRes = await db().from('kp_atr')
      .select('atr_date, day_open, atr, atr_len, method')
      .gte('atr_date', bkkDateStr(Date.now() - days * 86400e3));
    if (!atrRes.error) for (const r of atrRes.data || []) atrByDate.set(r.atr_date, r);

    const bars = await loadBars(sinceISO);
    const dayMap = buildDays(bars);
    const daysArr = [...dayMap.values()].sort((a, b) => a.day - b.day);

    if (!write) {
      return { status: 200, body: {
        ok: true, mode: 'dry', window_days: days,
        reads: signals.length, atr_days: atrByDate.size,
        bar_feed: { usable_gold_bars: bars.length, oldest: bars[0]?.t, newest: bars.at(-1)?.t, days: daysArr.length },
        verdict: bars.length === 0 ? 'NO_USABLE_BARS' : signals.length === 0 ? 'NO_READS' : 'OK_add_write=1_to_derive',
      } };
    }

    const rows = signals.map(s =>
      classify(s, stateById.get(s.market_state_id) || null, atrByDate.get(bkkDateStr(Date.parse(s.ts))) || null, dayMap, daysArr));

    const up = await db().from('kp_read_outcomes').upsert(rows, { onConflict: 'signal_id' });
    if (up.error) {
      const missing = up.error.code === '42P01';
      return { status: missing ? 424 : 500, body: {
        ok: false,
        error: missing ? 'kp_read_outcomes table missing — run supabase_schema_kp_read_outcomes.sql' : up.error.message,
      } };
    }

    const tally = {};
    for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    return { status: 200, body: {
      ok: true, mode: 'write', window_days: days,
      reads: signals.length, rows_upserted: rows.length, bars_used: bars.length,
      atr_days: atrByDate.size, tally,
    } };
  }
}

module.exports = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || CFG.eval.lookbackDays, 1), 120);
    const write = req.query.write === '1';
    const { status, body } = await runEval({ days, write });
    return res.status(status).json(body);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
module.exports.runEval = runEval;

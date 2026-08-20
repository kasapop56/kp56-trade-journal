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
// Not a route itself (underscore prefix → not a serverless function, to stay under
// the Hobby-plan 12-function cap). Invoked via /api/fibo-eval?target=reads and by
// the nightly report (both call runEval), e.g.:
//   GET /api/fibo-eval?target=reads            → diagnostics only (read-only)
//   GET /api/fibo-eval?target=reads&write=1    → replay + upsert kp_read_outcomes
//   GET /api/fibo-eval?target=reads&days=30    → lookback window (default from config)
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
// Trading-day boundary — selectable (see _kp_config.eval.dayWindow):
//   'chart'   → day starts at dayCutUtcHour UTC (align to the broker's daily bar)
//   'session' → Bangkok civil day (00:00 +07)
// The whole evaluator (day grouping, read-capping, ATR-date lookup) runs through
// these two helpers, so switching mode is one config change.
function dayShiftMs() {
  const e = CFG.eval || {};
  return (e.dayWindow === 'session' ? 7 : -(e.dayCutUtcHour || 0)) * 3600e3;
}
const bkkDay = (ms) => Math.floor((ms + dayShiftMs()) / 86400e3);     // trading-day index
function bkkDateStr(ms) {
  const t = new Date(ms + dayShiftMs());
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

// buy/sell direction implied by a bias/leg/side word (Bull/Bear/UP/DOWN/S/B/…)
function dirOf(s) {
  const v = String(s || '').toLowerCase();
  if (v.startsWith('bull') || v === 'up' || v === 'b' || v.startsWith('buy')) return 'buy';
  if (v.startsWith('bear') || v === 'down' || v === 's' || v.startsWith('sell')) return 'sell';
  return null;
}
// XAUUSD trading session from a read's UTC hour (rough, London/NY overlap→NY).
function sessionOf(ms) {
  const h = new Date(ms).getUTCHours();
  if (h >= 0 && h < 7) return 'asia';
  if (h >= 7 && h < 13) return 'london';
  if (h >= 13 && h < 21) return 'ny';
  return 'off';
}
function scoreBucket(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'na';
  return n >= 70 ? 'high' : n >= 40 ? 'mid' : 'low';
}

// The "ingredients" present at read time, tagged with alignment flags, so the
// attribution layer can tell WHICH factors (Mario / Fibo / structure / ATR / session)
// went with wins vs losses. Read from the linked kp_market_state row.
function buildFactors(sig, stateRow, out) {
  const call = out.call_dir;                       // 'buy' | 'sell' | null (none)
  const raw = stateRow?.raw || {};
  const biasM15 = stateRow?.bias_m15 ?? raw.bias_m15 ?? null;
  const biasM5  = stateRow?.bias_m5  ?? raw.bias_m5  ?? null;
  const fiboSide = stateRow?.fibo_side ?? raw.fibo_side ?? null;
  const legDir   = raw.fibo_leg_dir ?? null;
  const vp = String(stateRow?.vp_position ?? raw.vp_position ?? '').toUpperCase();
  const vpBucket = vp.includes('VAH') || vp.includes('PREMIUM') ? 'premium'
                 : vp.includes('VAL') || vp.includes('DISCOUNT') ? 'discount'
                 : vp.includes('POC') || vp.includes('BALANCE') ? 'balance' : (vp ? 'mid' : 'na');
  const d15 = dirOf(biasM15), dSide = dirOf(fiboSide), dLeg = dirOf(legDir);
  const withOrAgainst = (a) => (!call || !a) ? 'na' : (call === a ? 'with' : 'against');
  const zone = out.target_zone || null;
  return {
    call: sig.bias_call || null,
    bias_m15: biasM15, bias_m5: biasM5,
    bias_conflict: (dirOf(biasM15) && dirOf(biasM5)) ? (dirOf(biasM15) !== dirOf(biasM5)) : null,
    call_vs_m15: withOrAgainst(d15),
    call_vs_fibo_leg: withOrAgainst(dLeg),
    mario_fibo_aligned: (d15 && dSide) ? (d15 === dSide) : null,   // M15 bias vs Fibo active side
    vp_bucket: vpBucket,
    htf_conf: raw.htf_conf ?? null,
    ob_summary: raw.ob_summary ?? null,
    zone_source: zone?.source ?? null,
    zone_tier: zone?.tier ?? null,
    zone_score_bucket: scoreBucket(zone?.score),
    zone_tags: Array.isArray(zone?.tags) ? zone.tags.slice(0, 6) : (zone?.tags ? [zone.tags] : []),
    atr_day_type: out.day_type,
    reached_band: out.reached_band,
    session: sessionOf(Date.parse(sig.ts)),
  };
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
  // ATR is used ONLY as a size yardstick — daily volatility is ~broker-independent,
  // so its value is robust. The DAY is measured on OUR consistent window (the
  // Bangkok trading day, same cut as the report + Fibo) anchored to THAT window's
  // OWN open. So the ATR source broker's daily-bar cut time is irrelevant and can
  // no longer skew day_type. The chart's day_open (GBE, from kp_atr) is kept only
  // as the ladder-level reference (meta.ladder_open) so on-chart levels still match.
  let atr = num(atrRow?.atr), atrSource = atr != null ? 'indicator' : null;
  if (atr == null) { atr = computeAtr(daysArr, day, atrRow?.atr_len || 10); atrSource = atr != null ? 'computed' : 'none'; }
  const ladderOpen = num(atrRow?.day_open);
  // Anchor for day_type/travel: in 'chart' mode use the broker's exact daily open
  // (matches the indicator); otherwise the trading-day window's own first-bar open.
  const chartMode = (CFG.eval.dayWindow === 'chart');
  const dayOpen = (chartMode && ladderOpen != null) ? ladderOpen
                : (dayEntry ? dayEntry.open : ladderOpen);

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

  const outObj = {
    ...base,
    day_open: dayOpen, atr: atr != null ? Math.round(atr * 100) / 100 : null, atr_source: atrSource || 'none',
    day_type, day_travel_up_atr: upAtr != null ? Math.round(upAtr * 100) / 100 : null,
    day_travel_dn_atr: dnAtr != null ? Math.round(dnAtr * 100) / 100 : null, direction_actual,
    fav_atr, adv_atr, fav_pts, adv_pts, reached_band,
    target_zone, reached_target, zone_behavior,
    verdict, behavior_note, bars_seen: after.length,
    meta: { day_high: dayHigh, day_low: dayLow, fav_ext: favExt, adv_ext: advExt, first_touch: result, ladder_open: ladderOpen, atr_source: atrSource || 'none' },
  };
  // Attach the read's ingredients (Mario/Fibo/structure/ATR/session) so the
  // attribution layer can learn which factors drive wins. Stored in meta (no
  // schema change) — aggregated in JS by runAttribution().
  outObj.meta.factors = buildFactors(sig, stateRow, {
    call_dir: dir === 1 ? 'buy' : dir === -1 ? 'sell' : null,
    target_zone, day_type, reached_band,
  });
  return outObj;
}

// Core: (re)evaluate reads over a lookback window. Shared by the HTTP handler and
// the nightly report (so the report always grades against fresh outcomes).
async function runEval({ days = CFG.eval.lookbackDays, write = false } = {}) {
  {
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    // reads to grade
    const sigRes = await db().from('kp_signals')
      .select('id, ts, price, bias_call, market_state_id')   // no symbol col on kp_signals → default in classify
      .gte('ts', sinceISO).order('ts', { ascending: true }).limit(2000);
    if (sigRes.error) throw new Error('kp_signals: ' + sigRes.error.message);
    const signals = sigRes.data || [];

    // market states (zones) for those reads
    const stateIds = [...new Set(signals.map(s => s.market_state_id).filter(v => v != null))];
    const stateById = new Map();
    if (stateIds.length) {
      const stRes = await db().from('kp_market_state')
        .select('id, nearest_supply, nearest_demand, bias_m15, bias_m5, vp_position, poc, vah, val, fibo_side, raw')
        .in('id', stateIds);
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

// ── Factor attribution ───────────────────────────────────────────────────────
// Reads stored outcomes (kp_read_outcomes.meta.factors) and asks, for each factor
// dimension: what did price do when THIS ingredient was present? Groups verdicts
// per bucket and computes a directional hit-rate (WIN / (WIN+LOSS)). Pure JS
// aggregation — no new table. Meaningful only once enough reads accumulate.
function runAttributionRows(rows, minSamples) {
  const dims = {};
  const bump = (dim, value, verdict) => {
    if (value == null || value === 'na' || value === '') return;
    const key = String(value);
    dims[dim] = dims[dim] || {};
    const b = dims[dim][key] || (dims[dim][key] = { n: 0, win: 0, loss: 0, stall: 0, partial: 0, ok_notrade: 0, missed: 0, other: 0 });
    b.n++;
    const v = verdict === 'WIN' ? 'win' : verdict === 'LOSS' ? 'loss' : verdict === 'STALL' ? 'stall'
            : verdict === 'PARTIAL' ? 'partial' : verdict === 'OK_NOTRADE' ? 'ok_notrade'
            : verdict === 'MISSED' ? 'missed' : 'other';
    b[v]++;
  };

  let total = 0, decided = 0;
  for (const r of rows) {
    const f = r.meta && r.meta.factors;
    if (!f) continue;
    total++;
    if (r.verdict === 'WIN' || r.verdict === 'LOSS') decided++;
    bump('call', f.call, r.verdict);
    bump('call_vs_m15', f.call_vs_m15, r.verdict);
    bump('call_vs_fibo_leg', f.call_vs_fibo_leg, r.verdict);
    bump('mario_fibo_aligned', f.mario_fibo_aligned == null ? null : (f.mario_fibo_aligned ? 'aligned' : 'conflict'), r.verdict);
    bump('bias_conflict', f.bias_conflict == null ? null : (f.bias_conflict ? 'm15≠m5' : 'm15=m5'), r.verdict);
    bump('vp_bucket', f.vp_bucket, r.verdict);
    bump('zone_source', f.zone_source, r.verdict);
    bump('zone_score', f.zone_score_bucket, r.verdict);
    bump('atr_day_type', f.atr_day_type, r.verdict);
    bump('session', f.session, r.verdict);
    for (const tag of (f.zone_tags || [])) bump('zone_tag', tag, r.verdict);
  }

  // finalize: hit_rate + sort each dim by hit_rate (buckets with a decided base first)
  const out = {};
  for (const [dim, buckets] of Object.entries(dims)) {
    out[dim] = Object.entries(buckets).map(([value, b]) => {
      const base = b.win + b.loss;
      return {
        value, n: b.n,
        hit_rate_pct: base >= 1 ? Math.round((b.win / base) * 100) : null,
        win: b.win, loss: b.loss, stall: b.stall, ok_notrade: b.ok_notrade, missed: b.missed,
        small_sample: b.n < minSamples,
      };
    }).sort((a, z) => (z.hit_rate_pct ?? -1) - (a.hit_rate_pct ?? -1) || z.n - a.n);
  }
  return { total_with_factors: total, decided, min_samples: minSamples, dims: out };
}

async function runAttribution({ days = CFG.eval.lookbackDays, minSamples = 3 } = {}) {
  const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await db().from('kp_read_outcomes')
    .select('verdict, call, meta').gte('read_ts', sinceISO)
    .order('read_ts', { ascending: false }).limit(2000);
  if (error) {
    const missing = error.code === '42P01';
    return { status: missing ? 424 : 500, body: { ok: false, error: missing ? 'kp_read_outcomes table missing' : error.message } };
  }
  const agg = runAttributionRows(data || [], minSamples);
  return { status: 200, body: { ok: true, window_days: days, ...agg } };
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
module.exports.runAttribution = runAttribution;

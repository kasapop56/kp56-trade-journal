// api/_kp_lib.js — KP56 Co-pilot engine (Phase 3). Not a route.
//
// Shared by api/analyze.js (trigger-driven / cron) and api/analyze/now.js
// (manual). Responsibilities:
//   buildState()       — merge latest market_sitreps + fibo_snapshots
//   evaluateTriggers() — decide if this moment is worth commenting on
//   callClaude()       — disciplined co-pilot read (verbatim system prompt below)
//   runAnalysis()      — orchestrate: record state, debounce, analyze, deliver
//
// Writes use the service-role key (bypasses RLS). Reads here also use it.

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const CFG = require('./_kp_config');

// ── clients ──────────────────────────────────────────────────────────────────
let _db;
function getDb() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

let _anthropic;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

// ── small helpers ──────────────────────────────────────────────────────────────
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function ageMin(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
function round(n, d = 2) {
  if (n == null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
// Bangkok (UTC+7) civil date "YYYY-MM-DD" for a ms epoch.
function bkkDateStr(ms) {
  const t = new Date(ms + 7 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
// Most frequent non-null value in a list (ties → first seen).
function mode(arr) {
  const c = new Map();
  for (const v of arr) { if (v == null) continue; c.set(v, (c.get(v) || 0) + 1); }
  let best = null, n = 0;
  for (const [k, v] of c) if (v > n) { n = v; best = k; }
  return best;
}

// ── zone freshness (read-time) ───────────────────────────────────────────────
// How many times price already TESTED each nearest zone earlier today, from the
// BAR feed — so the read can flag a re-used zone as weaker (fresh = strongest;
// each retest consumes liquidity). Reuses the evaluator's bar loader + helpers.
async function buildZoneUsage(state) {
  if (!CFG.zoneFreshness) return null;
  const zones = [state.nearestSupply, state.nearestDemand]
    .filter(z => z && num(z.lo) != null && num(z.hi) != null);
  if (!zones.length) return null;
  let loadBars, bkkDay, zoneFreshness;
  try { ({ loadBars, bkkDay, zoneFreshness } = require('./_kp_eval')); }
  catch { return null; }
  let bars;
  try { bars = await loadBars(new Date(Date.now() - 36 * 3600e3).toISOString()); }
  catch { return null; }
  if (!bars || !bars.length) return null;
  const today = bkkDay(Date.now());
  return zones.map(z => {
    const f = zoneFreshness(bars, { side: z.side, lo: num(z.lo), hi: num(z.hi) }, today, null);
    return { side: z.side, label: z.label || `${z.lo}-${z.hi}`, tested: !f.fresh, tests: f.tests, broke: f.broke, source: z.source || null };
  });
}

// ── carry-forward digest (Phase 9) ───────────────────────────────────────────
// Descriptive context for the NEW day's read: today's ATR ladder frame + a short
// summary of what price did on the most recent completed day (day type, key zones
// that held/broke, the co-pilot's lean vs how the day actually resolved). Fed into
// callClaude so today's read layers on top of yesterday's structure. Informational
// only — it does not change the call by rule; the score-driven adjust is deferred.
async function buildCarryForward(db) {
  if (!CFG.carryForward) return null;
  const today = bkkDateStr(Date.now());
  const sinceDate = bkkDateStr(Date.now() - CFG.carryLookbackDays * 86400e3);
  const [atrRes, outRes] = await Promise.all([
    db.from('kp_atr').select('atr_date, day_open, atr, bands, day_high, day_low')
      .gte('atr_date', sinceDate).order('atr_date', { ascending: false }),
    db.from('kp_read_outcomes')
      .select('bkk_date, read_ts, call, verdict, day_type, direction_actual, target_zone, zone_behavior, behavior_note')
      .gte('bkk_date', sinceDate).order('read_ts', { ascending: true }),
  ]);
  const atrRows = atrRes.error ? [] : (atrRes.data || []);
  const outs = outRes.error ? [] : (outRes.data || []);
  const todayAtr = atrRows.find(r => r.atr_date === today) || null;

  const priorDays = [...new Set(outs.map(o => o.bkk_date))].filter(d => d < today).sort();
  const lastDay = priorDays[priorDays.length - 1] || null;
  let yesterday = null;
  if (lastDay) {
    const d = outs.filter(o => o.bkk_date === lastDay);
    const labels = (bhv) => [...new Set(d.filter(o => o.zone_behavior === bhv && o.target_zone).map(o => o.target_zone.label))].slice(0, 4);
    const calls = { buy: 0, sell: 0, no_trade: 0 };
    for (const o of d) { const c = String(o.call || '').toLowerCase(); if (c === 'buy') calls.buy++; else if (c === 'sell') calls.sell++; else calls.no_trade++; }
    const atrRow = atrRows.find(r => r.atr_date === lastDay) || null;
    yesterday = {
      date: lastDay, day_type: mode(d.map(o => o.day_type)), direction: mode(d.map(o => o.direction_actual)),
      day_high: atrRow ? atrRow.day_high : null, day_low: atrRow ? atrRow.day_low : null,
      held_zones: labels('HELD'), broke_zones: labels('BROKE'), swept_zones: labels('SWEEP_RECLAIM'),
      reads: d.length, lean: calls,
      wins: d.filter(o => o.verdict === 'WIN').length, losses: d.filter(o => o.verdict === 'LOSS').length,
      stalled: d.filter(o => o.verdict === 'STALL').length,
    };
  }
  if (!todayAtr && !yesterday) return null;
  return {
    today_frame: todayAtr ? { day_open: num(todayAtr.day_open), atr: num(todayAtr.atr), ladder: todayAtr.bands || null } : null,
    yesterday,
  };
}

// ── merged market state ────────────────────────────────────────────────────────
// Reads the two live tables and folds them into one object the trigger engine
// and Claude both consume. A source older than maxStateAgeMin is dropped to null.
async function buildState(db) {
  const [sitRes, fiboRes, priceRes, posRes] = await Promise.all([
    db.from('market_sitreps')
      .select('id, created_at, symbol, price, bias_m15, bias_m5, vp_position, poc, vah, val, ppoc, pvah, pval, htf_conf, h1_count, ob_summary, supply_zones, demand_zones')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('fibo_snapshots')
      .select('id, created_at, symbol, price, active_side, entry_mode, frame_mode, leg_dir, s_focus, s_test, s_tp1, s_sl, b_focus, b_test, b_tp1, b_sl, fh, fl, mid')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    // live price heartbeat (JournalSync → api/price); table may not exist yet
    db.from('kp_price').select('symbol, price, ts').order('ts', { ascending: false }).limit(1).maybeSingle(),
    // live open-positions snapshot (JournalSync → api/positions); table may not exist yet
    db.from('kp_positions').select('account_login, ts, symbol, positions')
      .eq('account_login', CFG.studyAccount).order('ts', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (sitRes.error && sitRes.error.code !== 'PGRST116') throw sitRes.error;
  if (fiboRes.error && fiboRes.error.code !== 'PGRST116') throw fiboRes.error;
  const livePrice = (priceRes.error) ? null : (priceRes.data || null);   // 42P01 pre-migration → null
  const posSnap = (posRes.error) ? null : (posRes.data || null);          // 42P01 pre-migration → null

  let sitrep = sitRes.data || null;
  let fibo = fiboRes.data || null;
  const sitAge = sitrep ? ageMin(sitrep.created_at) : null;
  const fibAge = fibo ? ageMin(fibo.created_at) : null;
  // stale → treat as absent for decision-making (still noted in raw)
  const sitFresh = sitrep && sitAge <= CFG.maxStateAgeMin;
  const fibFresh = fibo && fibAge <= CFG.maxStateAgeMin;

  // Reference price = the snapshot from whichever source fired MOST RECENTLY
  // (not always the SITREP — the Fibo webhook often fires later and is closer to
  // the live tick). Still a snapshot, so we also carry its age for honesty.
  const sitPx = num(sitrep?.price), fibPx = num(fibo?.price);
  const livePx = num(livePrice?.price);
  const liveAge = livePrice ? ageMin(livePrice.ts) : null;
  let price = null, priceSource = null, priceAgeMin = null;
  const cand = [];
  if (livePx != null) cand.push({ px: livePx, src: 'live', age: liveAge, at: livePrice.ts, fresh: liveAge <= CFG.maxStateAgeMin });
  if (sitPx != null) cand.push({ px: sitPx, src: 'mt5', age: sitAge, at: sitrep.created_at, fresh: sitFresh });
  if (fibPx != null) cand.push({ px: fibPx, src: 'fibo', age: fibAge, at: fibo.created_at, fresh: fibFresh });
  if (cand.length) {
    const fresh = cand.filter(c => c.fresh);
    const pool = fresh.length ? fresh : cand;   // prefer non-stale; else use what we have
    pool.sort((a, b) => new Date(b.at) - new Date(a.at));  // most recent first
    price = pool[0].px; priceSource = pool[0].src;
    priceAgeMin = pool[0].age == null ? null : round(pool[0].age, 1);
  }
  const symbol = sitrep?.symbol || fibo?.symbol || CFG.symbol;

  // build actionable zones (edges + score/tags + source)
  const zones = [];
  if (sitFresh) {
    const push = (arr, side) => {
      for (const z of (arr || [])) {
        const lo = num(z.lo), hi = num(z.hi);
        if (lo == null || hi == null) continue;
        zones.push({ side, source: 'MT5', lo, hi, mid: (lo + hi) / 2, score: z.score ?? null, tier: z.tier ?? null, tags: Array.isArray(z.tags) ? z.tags : [], label: `${lo}-${hi}` });
      }
    };
    push(sitrep.supply_zones, 'supply');
    push(sitrep.demand_zones, 'demand');
  }
  if (fibFresh) {
    const line = (px, side, name) => {
      const n = num(px);
      if (n == null) return;
      zones.push({ side, source: 'Fibo', lo: n, hi: n, mid: n, score: null, tier: name, tags: [name], label: String(n) });
    };
    line(fibo.s_focus, 'supply', 'S·Focus');
    line(fibo.s_test,  'supply', 'S·Test');
    line(fibo.b_focus, 'demand', 'B·Focus');
    line(fibo.b_test,  'demand', 'B·Test');
  }

  let nearestSupply = null, nearestDemand = null;
  if (price != null) {
    nearestSupply = zones.filter(z => z.side === 'supply' && z.hi >= price).sort((a, b) => a.mid - b.mid)[0] || null;
    nearestDemand = zones.filter(z => z.side === 'demand' && z.lo <= price).sort((a, b) => b.mid - a.mid)[0] || null;
  }

  // live open positions — prefer the direct JournalSync snapshot (ground truth,
  // self-healing). Only replay trade_events when no snapshot row exists yet
  // (pre-migration / EA not patched). A stale snapshot is still used (a direct
  // broker read beats a replay) but carries its age so the read can warn.
  let positions = [], positionsSource = 'none', positionsAgeMin = null;
  if (posSnap && Array.isArray(posSnap.positions)) {
    positions = posSnap.positions.map(normSnapPos).filter(Boolean);
    positionsSource = 'snapshot';
    const a = ageMin(posSnap.ts);
    positionsAgeMin = a == null ? null : round(a, 1);
  } else if (CFG.coachPositions) {
    positions = await getOpenPositions(db, CFG.studyAccount);
    positionsSource = 'replay';
  }
  const pos = positionView(positions, price);

  return {
    ts: new Date().toISOString(),
    symbol, price, price_source: priceSource, price_age_min: priceAgeMin,
    positions, pos,
    positions_source: positionsSource, positions_age_min: positionsAgeMin,
    sitrep: sitFresh ? sitrep : null,
    fibo: fibFresh ? fibo : null,
    sitrep_id: sitrep?.id ?? null,
    fibo_id: fibo?.id ?? null,
    sitrep_age_min: sitAge == null ? null : round(sitAge, 1),
    fibo_age_min: fibAge == null ? null : round(fibAge, 1),
    bias_m15: sitFresh ? sitrep.bias_m15 : null,
    bias_m5: sitFresh ? sitrep.bias_m5 : null,
    vp_position: sitFresh ? sitrep.vp_position : null,
    poc: sitFresh ? num(sitrep.poc) : null,
    vah: sitFresh ? num(sitrep.vah) : null,
    val: sitFresh ? num(sitrep.val) : null,
    h4_trend: null,          // not in live Fibo feed yet (see schema note)
    day_high: null,
    day_low: null,
    fibo_side: fibFresh ? (fibo.active_side || null) : null,
    zones, nearestSupply, nearestDemand,
  };
}

// ── live open positions (reconstructed from trade_events) ───────────────────────
// StudyLog streams OPEN (entry/sl/tp/lots/dir), MODIFY (new sl/tp), CLOSE per
// ticket. We replay them into the set of positions still open. sl/tp of 0 in MT5
// means "not set" → normalized to null so Claude flags a missing stop.
//
// IMPORTANT ordering: Supabase/PostgREST silently caps a response at ~1000 rows
// regardless of .limit(). We therefore fetch NEWEST-first so the cap, if hit,
// drops the OLDEST (long-closed, irrelevant) events — never the live ones. A
// prior ascending sort here returned the oldest 1000 and truncated the most
// recent events: a still-open trade's CLOSE and newer trades' OPENs got dropped,
// so the co-pilot reported a phantom position (already closed) and missed the
// real ones. We reverse the fetched page back to chronological order before the
// OPEN→MODIFY→CLOSE replay below.
// Normalize one kp_positions snapshot entry into the shape positionView expects.
// The snapshot is the broker's live truth, so it carries exact P&L (broker_profit)
// which positionView surfaces instead of the price-derived estimate.
function normSnapPos(p) {
  if (!p || p.ticket == null) return null;
  const dir = (p.dir === 'sell') ? 'sell' : (p.dir === 'buy') ? 'buy' : (num(p.type) === 1 ? 'sell' : 'buy');
  const sl = num(p.sl), tp = num(p.tp);
  return {
    ticket: p.ticket, dir,
    lots: num(p.lots), entry: num(p.entry),
    sl: sl && sl > 0 ? sl : null,
    tp: tp && tp > 0 ? tp : null,
    magic: p.magic ?? null,
    broker_profit: num(p.profit),
    kind: null, partial: false, orig_lots: null, opened_at: null,
  };
}

async function getOpenPositions(db, account) {
  const sinceIso = new Date(Date.now() - CFG.positionLookbackDays * 86400000).toISOString();
  const { data, error } = await db.from('trade_events')
    .select('ticket, event, payload, created_at')
    .eq('account_login', account)
    .in('event', ['OPEN', 'MODIFY', 'CLOSE'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(3000);
  if (error) { console.warn('trade_events read failed:', error.message); return []; }

  const chrono = (data || []).slice().reverse();   // newest-first fetch → replay oldest-first
  const posN = (v) => { const n = num(v); return n && n > 0 ? n : null; };
  const byTicket = new Map();
  for (const ev of chrono) {
    const t = ev.ticket;
    if (t == null) continue;
    let rec = byTicket.get(String(t));
    if (!rec) { rec = { ticket: t, closed: false, seenOpen: false, partial: false, orig_lots: null }; byTicket.set(String(t), rec); }
    const p = ev.payload || {};
    if (ev.event === 'OPEN') {
      rec.seenOpen = true; rec.closed = false;
      rec.dir = p.dir || null; rec.lots = num(p.lots); rec.entry = num(p.price);
      rec.orig_lots = rec.lots; rec.partial = false;
      rec.sl = posN(p.sl); rec.tp = posN(p.tp);
      rec.kind = p.kind || null; rec.origin = p.origin || null; rec.opened_at = ev.created_at;
    } else if (ev.event === 'MODIFY') {
      if ('sl' in p) rec.sl = posN(p.sl);
      if ('tp' in p) rec.tp = posN(p.tp);
      // partial close: same ticket stays open with reduced volume (EA emits
      // lots + partial:true). Resize so P&L/risk reflect the remaining lots.
      if ('lots' in p) {
        const nl = num(p.lots);
        if (nl != null && nl > 0) {
          if (rec.lots != null && nl < rec.lots - 0.005) rec.partial = true;
          rec.lots = nl;
        }
      }
    } else if (ev.event === 'CLOSE') {
      rec.closed = true;
    }
  }
  return [...byTicket.values()]
    .filter(r => r.seenOpen && !r.closed && r.dir)
    .sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
}

// Enrich each position with distance-to-SL/TP and unrealized direction (in $),
// computed at the current price so Claude reasons about real risk not just levels.
function positionView(positions, price) {
  const CONTRACT = CFG.usdPerDollarPerLot || 100;   // $/($1 move · 1 lot); XAUUSD=100
  const rows = positions.map(p => {
    const isBuy = p.dir === 'buy';
    const lots = num(p.lots) || 0;
    const usd = (priceDist) => priceDist == null ? null : round(priceDist * lots * CONTRACT, 2);
    const unreal = (price != null && p.entry != null) ? (isBuy ? price - p.entry : p.entry - price) : null;  // price
    const toSL = (price != null && p.sl != null) ? (isBuy ? price - p.sl : p.sl - price) : null;   // price; + = room left
    const toTP = (price != null && p.tp != null) ? (isBuy ? p.tp - price : price - p.tp) : null;   // price; + = TP not yet hit
    const risk = (p.entry != null && p.sl != null) ? Math.abs(p.entry - p.sl) : null;
    const reward = (p.entry != null && p.tp != null) ? Math.abs(p.tp - p.entry) : null;
    const rr = (risk && reward) ? Math.round((reward / risk) * 100) / 100 : null;
    return {
      ticket: p.ticket, dir: p.dir, lots: p.lots, entry: p.entry, sl: p.sl, tp: p.tp,
      has_sl: p.sl != null, has_tp: p.tp != null,
      partial_closed: !!p.partial,                       // true = already scaled out (default 50%)
      orig_lots: p.partial ? p.orig_lots : undefined,    // size before the partial, for context
      unrealized_usd: p.broker_profit != null ? round(p.broker_profit, 2) : usd(unreal),  // exact broker P&L when from snapshot, else price-derived
      broker_profit: p.broker_profit != null ? round(p.broker_profit, 2) : undefined,     // present = exact (not an estimate)
      sl_dist_price: toSL == null ? null : round(toSL, 2),   // how far price is from SL
      tp_dist_price: toTP == null ? null : round(toTP, 2),   // how far price is from TP
      risk_to_sl_usd: usd(toSL),             // $ still at risk if SL hits (neg = profit locked past BE)
      reward_to_tp_usd: usd(toTP),           // $ remaining to TP
      rr, kind: p.kind, opened_at: p.opened_at,
    };
  });
  let netLots = 0, buyLots = 0, sellLots = 0, floatUsd = 0, haveProfit = positions.length > 0;
  for (const p of positions) {
    const l = num(p.lots) || 0;
    if (p.dir === 'buy') { buyLots += l; netLots += l; } else { sellLots += l; netLots -= l; }
    if (p.broker_profit == null) haveProfit = false; else floatUsd += p.broker_profit;
  }
  const netSide = netLots > 0 ? 'net long' : netLots < 0 ? 'net short' : 'flat/hedged';
  return { rows, count: rows.length, net_lots: round(netLots, 2), buy_lots: round(buyLots, 2), sell_lots: round(sellLots, 2), net_side: netSide, float_usd: haveProfit ? round(floatUsd, 2) : null };
}

// Persist a snapshot row (history for sweep/flip triggers + provenance).
async function recordState(db, state) {
  const row = {
    ts: state.ts, symbol: state.symbol, price: state.price,
    sitrep_id: state.sitrep_id, fibo_id: state.fibo_id,
    sitrep_age_min: state.sitrep_age_min, fibo_age_min: state.fibo_age_min,
    bias_m15: state.bias_m15, bias_m5: state.bias_m5, vp_position: state.vp_position,
    poc: state.poc, vah: state.vah, val: state.val,
    h4_trend: state.h4_trend, day_high: state.day_high, day_low: state.day_low,
    fibo_side: state.fibo_side,
    nearest_supply: state.nearestSupply, nearest_demand: state.nearestDemand,
    raw: {
      zones: state.zones, bias_m15: state.bias_m15, bias_m5: state.bias_m5,
      poc: state.poc, vah: state.vah, val: state.val,
      // full factor set so the read evaluator can attribute wins/losses to WHAT
      // was present at read time (Mario + Fibo + structure). Captured now so we
      // never have to backfill — every future read carries its ingredients.
      vp_position: state.vp_position, fibo_side: state.fibo_side,
      fibo_leg_dir: state.fibo ? state.fibo.leg_dir : null,
      htf_conf: state.sitrep ? state.sitrep.htf_conf : null,
      h1_count: state.sitrep ? state.sitrep.h1_count : null,
      ob_summary: state.sitrep ? state.sitrep.ob_summary : null,
    },
  };
  const { data, error } = await db.from('kp_market_state').insert(row).select('id').single();
  if (error) { console.warn('kp_market_state insert failed:', error.message); return null; }
  return data.id;
}

// ── trigger engine ─────────────────────────────────────────────────────────────
function inZone(price, z, buf) {
  return price >= (z.lo - buf) && price <= (z.hi + buf);
}

async function evaluateTriggers(db, state) {
  const price = state.price;
  if (price == null) return { fire: false, reason: 'no_price' };
  const buf = CFG.zoneBufferPrice;

  // previous snapshots (most recent first) for look-back triggers
  const { data: prevRows } = await db.from('kp_market_state')
    .select('price, raw, created_at')
    .order('created_at', { ascending: false }).limit(CFG.sweepLookback + 1);
  const prev = (prevRows && prevRows[0]) || null;   // the one just recorded is not here yet
  const history = prevRows || [];

  // 1) zone_entry — price newly inside a zone (± buffer)
  if (CFG.triggers.zone_entry) {
    const hit = state.zones.find(z => inZone(price, z, buf));
    if (hit) {
      const wasInside = prev && prev.price != null && inZone(prev.price, hit, buf);
      if (!wasInside) {
        return { fire: true, trigger_type: 'zone_entry', reason: `price ${price} entered ${hit.side} ${hit.label} (${hit.source})`, zones: [hit] };
      }
    }
  }

  // 2) sweep_reclaim — recent state pierced a demand low / supply high, now back inside
  if (CFG.triggers.sweep_reclaim && history.length >= 2) {
    const nd = state.nearestDemand, ns = state.nearestSupply;
    if (nd) {
      const swept = history.some(h => h.price != null && h.price < nd.lo - buf);
      if (swept && price >= nd.lo - buf) {
        return { fire: true, trigger_type: 'sweep_reclaim', reason: `swept below demand ${nd.label} then reclaimed`, zones: [nd] };
      }
    }
    if (ns) {
      const swept = history.some(h => h.price != null && h.price > ns.hi + buf);
      if (swept && price <= ns.hi + buf) {
        return { fire: true, trigger_type: 'sweep_reclaim', reason: `swept above supply ${ns.label} then reclaimed`, zones: [ns] };
      }
    }
  }

  // 3) confluence_flip — MT5 bias vs TV h4_trend agree after disagreeing.
  //    Dormant until h4_trend is fed (guard).
  if (CFG.triggers.confluence_flip && state.h4_trend && state.bias_m15) {
    const agree = (t) => {
      const b = String(state.bias_m15).toLowerCase(), h = String(state.h4_trend).toLowerCase();
      const up = s => s.startsWith('bull') || s.startsWith('buy') || s === 'up';
      const dn = s => s.startsWith('bear') || s.startsWith('sell') || s === 'down';
      return (up(b) && up(h)) || (dn(b) && dn(h));
    };
    const prevDisagree = prev && prev.raw && prev.raw.bias_m15 && !(String(prev.raw.bias_m15).toLowerCase()[0] === String(state.h4_trend).toLowerCase()[0]);
    if (agree() && prevDisagree) {
      return { fire: true, trigger_type: 'confluence_flip', reason: `M15 ${state.bias_m15} now agrees with H4 ${state.h4_trend}`, zones: [] };
    }
  }

  return { fire: false, reason: 'no_trigger' };
}

// Debounce: skip Claude if same trigger fired recently without material move.
async function isDebounced(db, triggerType, price) {
  const sinceIso = new Date(Date.now() - CFG.debounceMin * 60000).toISOString();
  const { data } = await db.from('kp_signals')
    .select('price, ts').eq('trigger_type', triggerType)
    .gte('ts', sinceIso).order('ts', { ascending: false }).limit(1);
  const last = data && data[0];
  if (!last) return false;
  if (price != null && last.price != null && Math.abs(price - Number(last.price)) >= CFG.materialMovePrice) return false;
  return true;   // recent + no material move → debounce
}

// ── Claude ─────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a disciplined XAUUSD trading co-pilot sitting beside an experienced discretionary trader. You receive merged market state from MT5 (Mario: bias, order blocks, supply/demand zones with confluence scores, POC/VAH/VAL) and TradingView (multi-timeframe RSI/Stoch/trend/EMA150, fibo zones, momentum flags).
Your job: give a short, direct read and a concrete plan. You advise; the trader executes.
Rules:
- Never suggest entering at mid-range / POC. Only at zone edges (supply above, demand below) with confirmation.
- Respect timeframe conflicts. If lower TFs are sideways and H4 is UP, lean toward buying demand over selling supply, and keep any counter-H4 sell targets short (partial fast).
- Prefer sweep-and-reclaim at demand: wait for price to wick below the zone / day-low and close back inside before buying, SL below the swept wick.
- Always structure entries with SL and TP. In range conditions, always recommend taking partial profit at the first target.
- Flag invalidation explicitly (what would kill the setup).
- Warn against FOMO, revenge entries, and chasing green/red candles mid-range.
- When price is mid-range with conflicting bias, the correct call is often "no trade — wait for the edge."
- Keep it mobile-readable and free of filler. End with one brief discipline reminder.
- MANDATORY LAST LINE: every reply ends with a machine-readable "PLAN:" line in the format given in the output instructions. It is never optional and never skipped — not when you are unsure, not when the answer is "no trade" (use PLAN: [] then), not when the read is short. The user never sees this line; it is stripped before display and used to score whether your levels were any good. A reply without it is incomplete.

MARKET STRUCTURE (read this first, every time): synthesize Mario + Fibo into ONE structural picture before any plan. Use the "structure" block:
- HTF direction: M15/M5 bias + Fibo leg direction (fibo_leg_dir UP/DOWN = current swing) + which side Fibo is active (S=looking to sell above, B=looking to buy below). Say whether they agree or conflict.
- Structure state from Mario zone tags: BOS = trend continuation, CHoCH = potential reversal/shift. Note the freshest BOS/CHoCH near price.
- Where price sits in value: vs POC/VAH/VAL (today) and prev-day ppoc/pvah/pval. Above VAH = premium, below VAL = discount, at POC = balance/mid.
- Fibo frame: price inside the frame (high/low/mid) tells premium vs discount within the swing.
Do this synthesis INTERNALLY, then express it in the read as ONE short, punchy sentence (or two at most) — do NOT dump every level/tag. The read stays crisp; the value goes into a sharper zone-level plan. When Mario and Fibo disagree, say so in a few words and favor the higher-timeframe / higher-confluence side.

CARRY-FORWARD (if a "carry_forward" block is present): use it as CONTEXT to layer today's read on top of, not as a command.
- today_frame = today's daily-open ± ATR ladder (the same frame the trader sees on the chart). Anchor your levels to it: state whether price is in the balance zone (±0.25 ATR of open), stretched (near ±1 ATR = late to chase), and which ATR band a target/stop sits near. If a plausible target is already >1 ATR away, flag it as an extended/greedy target.
- yesterday = what price actually did on the last completed day (day_type, direction, zones that HELD/BROKE/were swept, and the co-pilot's own lean vs how it resolved). Carry the still-relevant levels forward (a demand that HELD is a live buy reference; a zone that BROKE flips role). If yesterday was a BALANCE/stall day, warn against expecting a big move today without a catalyst. Keep this to a few words folded into the read — do not recite the whole block.

ZONE FRESHNESS (if a "zone_usage" block is present): it lists, per nearest zone, how many times price has ALREADY TESTED it TODAY (tests) and whether it has closed THROUGH it (broke). A FRESH zone (tests=0) is the strongest; each retest consumes liquidity → weaker. When you put a zone in the plan:
- tests=0 → treat as a clean first-touch setup.
- tests≥1 (already used today) → say so and manage it TIGHTER: take partial faster, tighten SL, and require a FRESH rejection signal before entering again — a level that already gave its move is a worse re-entry.
- broke=true → the zone is compromised; its role likely flipped (a broken supply becomes support, a broken demand becomes resistance) — do NOT keep trading it in the old direction.
- If price is CONSOLIDATING inside a zone (grinding, not rejecting) on a retest, warn that it is likely to break through (continuation), not hold. Fold this into one short phrase in the plan/invalidation, do not lecture.

LIVE POSITIONS: If the trader already has open positions (provided as "positions"), the read is about MANAGING them, not hunting new entries. FIRST compare each position to the structure above using with_m15_bias / with_fibo_leg and its entry location:
- Alignment: is the position WITH structure (with the M15 bias and Fibo leg) or AGAINST it? A with-structure trade gets more room; an against-structure (counter-trend) trade should be managed tighter and taken partial faster.
- Entry quality: was it entered at a zone edge (good) or mid-range/at POC (chasing)? Say it plainly.
- Partial already taken: if partial_closed is true, the trader has already scaled out (typically 50%) — "lots" is the REMAINING size (orig_lots was the original). Do all P&L/risk math on the remaining lots, acknowledge the profit is partly banked, and do NOT tell them to "take partial" again — instead advise on the runner (trail / move to BE / hold to next zone / close the rest).
Then for each position judge:
- SL placement — a stop sitting INSIDE an opposing zone is likely to be wicked; suggest moving it just beyond the zone / swept wick. If a position has NO stop (has_sl false), that is the #1 priority — tell them to set one now.
- TP placement — a target parked in thin air beyond POC/into the next zone is greedy; suggest pulling it to the realistic zone edge. Flag when TP1 is close and a partial is due.
- R:R & risk — call out sub-1R setups and stops that are unreasonably wide/tight for the structure.
- Management — when in profit and price stalls at POC/a zone: move to breakeven, take partial, or trail. When the position runs with structure, let it.
- Invalidation/exit — if the thesis that justified the trade is broken (structure flipped, key level closed through), say so plainly and suggest reducing or closing. Never suggest averaging into a losing position against structure.
Be specific with levels. Do not invent positions that are not in the data.`;

// Scannable mobile format. HARD RULES: Thai, no markdown (no **, no #, no -),
// very short lines, use the exact emoji section labels below so the message
// reads as bite-size blocks on a phone. Parsed downstream (CALL line + first
// line = headline) then reformatted for Telegram/dashboard.
const OUTPUT_HINT = `ตอบเป็นภาษาไทย สั้นและสแกนง่ายบนมือถือ.
ห้ามใช้ markdown (ห้าม ** ## หรือ -). แต่ละบรรทัดสั้น. รวมทั้งหมดไม่เกิน ~14 บรรทัด.
ใช้รูปแบบนี้เป๊ะ ๆ ตามลำดับ:

CALL: Buy | Sell | No trade
<พาดหัวสั้นมาก 1 บรรทัด ไม่มี emoji>

📍 อ่าน
<1-2 บรรทัดสั้น กระชับ: ทิศ HTF (M15 + Fibo leg) · ราคาอยู่ตรงไหนของ value · Mario/Fibo ตรงหรือขัด. ห้ามยาวเป็นย่อหน้า ห้ามลิสต์ตัวเลขทุกตัว เอาแค่ใจความ>

🎯 แผน
ใช้รูปแบบระดับราคาเสมอ (ห้ามเขียนเป็นร้อยแก้ว):
🔴 Sell <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
🟢 Buy <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
(ใส่เฉพาะฝั่งที่ actionable จริง · ถ้าต้องรอ ให้บอกโซนที่รอ + เงื่อนไข confirm สั้น ๆ แต่ยังให้ SL/TP ของฝั่งนั้น)

🛑 เสียเมื่อ
<invalidation สั้น>

⚠️ <เตือนวินัย 1 บรรทัด>
PLAN: [{"kind":"entry","side":"sell","zone":[4340,4344],"sl":4348,"tp1":4325,"tp2":4310}]

บรรทัด PLAN เป็นส่วนหนึ่งของรูปแบบ ไม่ใช่ของแถม — ห้ามข้าม ห้ามจบก่อน (ไม่นับใน 14 บรรทัด · ผู้ใช้ไม่เห็นบรรทัดนี้ · ระบบตัดออกไปเก็บสถิติ)
กติกา PLAN: JSON array บรรทัดเดียว · 1 object ต่อ 1 ฝั่งที่ actionable · ต้องตรงกับ 🎯 แผน ข้างบนเป๊ะ ๆ · side ใช้ "buy"/"sell" · zone=[ล่าง,บน] (ราคาเดียวใส่ตัวเดียว) · ไม่มีแผน/ไม่เทรด = PLAN: []
kind สำคัญมาก: "entry" = ไม้ใหม่ที่แนะนำให้เข้า · "manage" = คำแนะนำจัดการไม้ที่เปิดอยู่แล้ว (ห้ามนับเป็นไม้ใหม่)`;

// ── plan capture (Phase 9c) ──────────────────────────────────────────────────
// The read's LEVEL PLAN — zone edge + SL + TP — is what the trader is actually
// advised to do. Until now only the CALL word (Buy/Sell/No trade) was stored, so
// the evaluator could grade nothing but a from-P0 directional lean, i.e. a trade
// the read explicitly tells the trader NOT to take (no mid-range entries). The
// plan cannot be reconstructed after the fact, so capture it structurally now.
// Two parsers, in order:
//   1. the model's own machine line — PLAN: [{side,zone,sl,tp1,tp2}, …]
//   2. fallback: the 🔴/🟢 level block in the visible message. This also parses
//      reads written BEFORE this change (the text lives in kp_signals.message),
//      so existing history can be backfilled.
const gold = (n) => Number.isFinite(n) && n > 100 && n < 100000;
const NUMRE = /\d{3,6}(?:\.\d+)?/g;

function planFromJson(line, managed) {
  const i = String(line).indexOf(':');
  if (i < 0) return null;
  const body = line.slice(i + 1).trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  const a = body.indexOf('['), z = body.lastIndexOf(']');
  if (a < 0 || z < a) return null;
  let arr;
  try { arr = JSON.parse(body.slice(a, z + 1)); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const legs = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const side = String(o.side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const zs = (Array.isArray(o.zone) ? o.zone : [o.zone]).map(Number).filter(gold);
    if (!zs.length) continue;
    const lvl = (v) => (gold(Number(v)) ? Number(v) : null);
    const k = String(o.kind || '').toLowerCase();
    legs.push({ kind: (k === 'entry' || k === 'manage') ? k : (managed ? 'manage' : 'entry'),
                side, zone_lo: Math.min.apply(null, zs), zone_hi: Math.max.apply(null, zs),
                sl: lvl(o.sl), tp1: lvl(o.tp1), tp2: lvl(o.tp2) });
  }
  // an explicitly empty array is a valid "no plan" answer, not a parse failure
  return legs.length ? legs : (arr.length === 0 ? [] : null);
}

// A leg starts ONLY on a 🔴/🟢 marker line. A bare "Sell …" line is NOT a plan:
// the read may open with the 🧾 live-position block ("Sell 0.01 @ 4340.36 · SL … ·
// TP …"), and treating that as advice invents an entry the read never gave — a
// false plan is worse than no plan. Section markers additionally close a leg, so
// SL/TP can never be picked up from a later block.
const SECTION = /^(🛑|⚠️|📍|🎯|🧾|🔎|📊)/;

function planFromText(text, managed) {
  const legs = [];
  let cur = null;
  // Once the invalidation / discipline section starts, no new legs: those lines say
  // things like "ถ้าปิดเหนือ 4366.75 หรือหลุด 4337.4 ยกเลิกทั้งสองฝั่ง" — two sides and
  // two prices, which the loose rule would otherwise read as an entry spanning both
  // zones (and a zone that wide is "touched" by everything).
  let inPlan = true;   // starts open: the oldest reads have no 🎯 header at all
  const flush = () => { if (cur) legs.push(cur); cur = null; };
  const g = (l, re) => { const m = l.match(re); const n = m ? Number(m[1]) : NaN; return gold(n) ? n : null; };
  // Tolerate words between the label and the price — the model writes things like
  // "SL ใต้ wick ~4337" and "TP1 ที่ 4355". A short window keeps an unrelated number
  // further down the line from being captured.
  const levels = (l, o) => {
    if (o.sl  == null) o.sl  = g(l, /\bSL\b[^0-9\n]{0,14}([\d.]+)/i);
    if (o.tp1 == null) o.tp1 = g(l, /\bTP1\b[^0-9\n]{0,14}([\d.]+)/i);
    if (o.tp2 == null) o.tp2 = g(l, /\bTP2\b[^0-9\n]{0,14}([\d.]+)/i);
    if (o.tp1 == null) o.tp1 = g(l, /\bTP\b(?![12])[^0-9\n]{0,14}([\d.]+)/i);
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    // A line is a leg when it carries a 🔴/🟢 marker, or — only in reads where NO
    // position was open — when it names a side together with a price. That second
    // rule recovers the older bullet format ("- Sell zone: 4363-4366.75 … SL … TP1 …")
    // and any future drift, and it is safe precisely because the 🧾 live-position
    // block that fooled the first version can only appear when a position is open.
    // section switches — emoji in the current format, plain words in the oldest reads
    if (/^\**\s*(🎯|แผน|plan\b)/i.test(l)) inPlan = true;
    else if (/^(🛑|⚠️|🧾|📍)/.test(l) || /^\**\s*(invalidation|invalid\b|เสียเมื่อ|ยกเลิกเมื่อ|อ่านสถานการณ์|เตือน)/i.test(l)) inPlan = false;
    const marked = /^(🔴|🟢)/.test(l);
    const loose = inPlan && !managed && !SECTION.test(l)
      && /sell|buy|ขาย|ซื้อ/i.test(l)
      && (l.split(/\bSL\b|\bTP\d?\b/i)[0].match(NUMRE) || []).some(v => gold(Number(v)));
    if (marked || loose) {
      flush();
      const side = /🔴/.test(l) ? 'sell' : /🟢/.test(l) ? 'buy'
                 : (/sell|ขาย/i.test(l) ? 'sell' : 'buy');
      // the entry zone is what's on the marker line BEFORE any SL/TP label
      const head = l.split(/\bSL\b|\bTP\d?\b/i)[0];
      const zs = (head.match(NUMRE) || []).map(Number).filter(gold);
      cur = zs.length
        ? { kind: managed ? 'manage' : 'entry', side,
            zone_lo: Math.min.apply(null, zs), zone_hi: Math.max.apply(null, zs), sl: null, tp1: null, tp2: null }
        : null;
      if (cur) levels(l, cur);            // model may inline SL/TP on the same line
      continue;
    }
    if (!cur) continue;
    if (SECTION.test(l)) { flush(); continue; }   // next section → leg done
    levels(l, cur);
  }
  flush();
  return legs;
}

// "No trade" collapses two different answers into one word: STAND ASIDE (no level,
// no opinion) and WAIT (a complete pending plan at a zone edge, which is what an
// edge-based Fibo/OB method produces most of the time). Grading them the same way
// records "the co-pilot had no opinion" for reads that in fact issued a limit plan.
function readStance(bias_call, legs, managed) {
  if (managed) return 'manage';
  const c = String(bias_call || '').toLowerCase();
  if (c === 'buy' || c === 'sell') return 'entry_now';
  return (legs && legs.length) ? 'wait' : 'stand_aside';
}

// planLine = the model's PLAN: line (may be ''), message = the visible body.
// `managed` = a position was already open at read time. It decides the DEFAULT leg
// kind, because with a position open the 🔴/🟢 markers are reused for existing
// trade groups ("🔴 ไม้เก่าทั้งหมด (entry 4386-4430)") — describing exposure the
// trader already has, not an entry being advised. Defaulting those to 'manage' is
// the conservative read; the model's explicit `kind` always wins.
function parsePlan(planLine, message, managed) {
  const j = planLine ? planFromJson(planLine, managed) : null;
  if (j) return { legs: j, source: j.length ? 'json' : 'json_empty' };
  const t = planFromText(message, managed);
  return { legs: t, source: t.length ? 'parsed' : 'none' };
}

// Identity of the read-GENERATING policy. Any edit to the prompts, the model, the
// effort, or the context blocks changes this hash — so attribution can be split
// per version instead of pooling reads produced by different policies (the
// nonstationary-policy trap: the loop's own carry-forward feeds back into calls).
const PROMPT_VERSION = crypto.createHash('sha1')
  .update([SYSTEM_PROMPT, OUTPUT_HINT, CFG.model, CFG.effort,
           CFG.carryForward ? 'cf1' : 'cf0', CFG.zoneFreshness ? 'zf1' : 'zf0'].join('\u0000'))
  .digest('hex').slice(0, 8);

// buy/sell direction implied by a bias/trend/leg word (Bull/Bear/UP/DOWN/…)
function dirOf(s) {
  const v = String(s || '').toLowerCase();
  if (v.startsWith('bull') || v === 'up' || v.startsWith('buy')) return 'buy';
  if (v.startsWith('bear') || v === 'down' || v.startsWith('sell')) return 'sell';
  return null;
}

async function callClaude(state, trigger) {
  const client = getAnthropic();

  // structure synthesis (Mario + Fibo) — the "how is the market built right now" layer
  const legDir = state.fibo ? state.fibo.leg_dir : null;                 // UP/DOWN swing
  const structure = (state.sitrep || state.fibo) ? {
    htf_bias_m15: state.bias_m15, bias_m5: state.bias_m5,
    htf_confluence: state.sitrep ? state.sitrep.htf_conf : null,
    h1_zone_count: state.sitrep ? state.sitrep.h1_count : null,
    ob_summary: state.sitrep ? state.sitrep.ob_summary : null,
    value_area: { poc: state.poc, vah: state.vah, val: state.val, price_position: state.vp_position },
    prev_day_value: state.sitrep ? { ppoc: num(state.sitrep.ppoc), pvah: num(state.sitrep.pvah), pval: num(state.sitrep.pval) } : null,
    fibo_leg_dir: legDir, fibo_active_side: state.fibo_side,
    fibo_frame: state.fibo ? { high: state.fibo.fh, low: state.fibo.fl, mid: state.fibo.mid, mode: state.fibo.frame_mode } : null,
  } : null;

  // per-position alignment vs structure (with/against M15 bias + Fibo swing leg)
  const posList = (state.pos && state.pos.count) ? state.pos.rows.map(p => {
    const m15d = dirOf(state.bias_m15), legd = dirOf(legDir);
    return {
      ...p,
      with_m15_bias: m15d ? (p.dir === m15d) : null,
      with_fibo_leg: legd ? (p.dir === legd) : null,
    };
  }) : null;

  const userPayload = {
    trigger: { type: trigger.trigger_type, reason: trigger.reason },
    symbol: state.symbol,
    price: state.price,
    freshness: { price_source: state.price_source, price_age_min: state.price_age_min, mt5_age_min: state.sitrep_age_min, fibo_age_min: state.fibo_age_min, positions_source: state.positions_source, positions_age_min: state.positions_age_min },
    carry_forward: state.carry || null,
    zone_usage: state.zone_usage || null,
    structure,
    mt5: state.sitrep ? {
      bias_m15: state.bias_m15, bias_m5: state.bias_m5, vp_position: state.vp_position,
      poc: state.poc, vah: state.vah, val: state.val,
      supply_zones: state.sitrep.supply_zones, demand_zones: state.sitrep.demand_zones,
    } : null,
    tradingview: state.fibo ? {
      active_side: state.fibo_side, entry_mode: state.fibo.entry_mode, leg_dir: legDir,
      s: { focus: state.fibo.s_focus, test: state.fibo.s_test, tp1: state.fibo.s_tp1, sl: state.fibo.s_sl },
      b: { focus: state.fibo.b_focus, test: state.fibo.b_test, tp1: state.fibo.b_tp1, sl: state.fibo.b_sl },
      frame: { high: state.fibo.fh, low: state.fibo.fl, mid: state.fibo.mid },
      h4_trend: state.h4_trend,   // null until Pine feeds it
    } : null,
    nearest_supply: state.nearestSupply,
    nearest_demand: state.nearestDemand,
    positions: posList ? { summary: { count: state.pos.count, net_side: state.pos.net_side, net_lots: state.pos.net_lots, buy_lots: state.pos.buy_lots, sell_lots: state.pos.sell_lots }, list: posList } : null,
    notes: [
      state.sitrep ? null : 'ไม่มี SITREP สด (MT5) — ใช้ Fibo อย่างเดียว',
      state.h4_trend ? null : 'ยังไม่มี H4 trend จาก TradingView',
      (state.price_age_min != null && state.price_age_min > 15)
        ? `ราคาอ้างอิงเป็น snapshot จาก ${state.price_source} เมื่อ ${state.price_age_min} นาทีก่อน — ราคาจริงตอนนี้อาจต่างไปแล้ว ให้เตือนผู้ใช้และให้ระดับ zone เป็นหลัก`
        : null,
      (state.positions_source === 'snapshot' && state.positions_age_min != null && state.positions_age_min > CFG.positionsStaleWarnMin)
        ? `ข้อมูลไม้เป็น snapshot เมื่อ ${state.positions_age_min} นาทีก่อน (PC อาจปิด/หลับ) — อาจไม่ตรงพอร์ตจริงตอนนี้ ให้เตือนผู้ใช้`
        : null,
      (state.positions_source === 'replay')
        ? 'ไม้สร้างจาก replay log (ยังไม่มี snapshot สด) — อาจไม่ครบทุกไม้ ให้ถือเป็นค่าประมาณและเตือนผู้ใช้'
        : null,
    ].filter(Boolean),
  };

  // When holding live orders, insert a coaching section before the plan.
  const hasPos = !!(state.pos && state.pos.count);
  const posHint = hasPos ? `\n\n⚠️ มีโพสิชั่นเปิดอยู่ ${state.pos.count} ไม้ (${state.pos.net_side}). โฟกัสที่การจัดการไม้ที่ถืออยู่ ไม่ใช่หาไม้ใหม่. เพิ่มส่วนนี้ก่อน 🎯 แผน:

🧾 โพสิชั่นสด
<ต่อไม้: dir lots @ entry · ตาม/สวนโครงสร้าง (with_m15_bias/with_fibo_leg) · entry ขอบโซน/กลางกรอบ>
<SL x (โอเค/ควรเลื่อนเป็น y) · TP x (โอเค/ควรเป็น y) · R:R · P&L ตอนนี้>
<ถ้าไม่มี SL ให้เตือนเป็นอันดับแรก · ถ้าควร BE/ปิดบางส่วน/เลื่อน trail บอกชัด>
หน่วยตัวเลข: P&L ใช้ค่า unrealized_usd (เงินบัญชีจริง $, คิดตาม lot แล้ว). ระยะถึง SL/TP บอกเป็น "ราคา" (sl_dist_price/tp_dist_price) และถ้าจะพูดเป็นเงินให้ใช้ risk_to_sl_usd / reward_to_tp_usd. ห้ามสับสนระหว่างระยะราคา กับเงิน $.

แล้วใน 🎯 แผน ให้เป็นคำแนะนำจัดการ (ถือ/เลื่อน SL/ปิดบางส่วน/ปิด) ไม่ใช่ไม้เข้าใหม่` : '';

  const resp = await client.messages.create({
    model: CFG.model,
    max_tokens: CFG.maxTokens,
    output_config: { effort: CFG.effort },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${OUTPUT_HINT}${posHint}\n\nMARKET STATE (JSON):\n${JSON.stringify(userPayload, null, 2)}`,
    }],
  });

  let text = '';
  for (const block of resp.content) if (block.type === 'text') text += block.text;
  text = text.trim();

  // strip any stray markdown the model slips in (Telegram HTML ignores it)
  const demark = (s) => String(s)
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold** → bold
    .replace(/`([^`]*)`/g, '$1')       // `code` → code
    .replace(/^\s*#{1,6}\s*/gm, '')    // ## headings
    .replace(/^\s*[-*]\s+/gm, '');     // - / * bullet markers (we use emojis)

  let lines = text.split(/\r?\n/);

  // CALL: line → chip; then remove it from the body
  const callLine = lines.find(l => /^\s*CALL:/i.test(l)) || '';
  let bias_call = null;
  if (/no\s*trade|ไม่เทรด|ไม่เข้า/i.test(callLine)) bias_call = 'No trade';
  else if (/\bbuy\b|ซื้อ/i.test(callLine)) bias_call = 'Buy';
  else if (/\bsell\b|ขาย/i.test(callLine)) bias_call = 'Sell';
  lines = lines.filter(l => !/^\s*CALL:/i.test(l));

  // PLAN: <json> line → structured plan; stripped from the body so the user-facing
  // read (dashboard + Telegram) looks exactly as before.
  const planLine = lines.find(l => /^\s*PLAN\s*:/i.test(l)) || '';
  lines = lines.filter(l => !/^\s*PLAN\s*:/i.test(l));

  // first non-empty line = headline; the rest = body (no duplication anywhere)
  while (lines.length && !lines[0].trim()) lines.shift();
  const headline = demark(lines.shift() || 'อัปเดตตลาด').trim() || 'อัปเดตตลาด';
  const message = demark(lines.join('\n')).trim() || headline;

  // A read taken while a position is open is MANAGEMENT advice, not an entry call:
  // its CALL word echoes the exposure the trader already has. Recorded so the
  // evaluator can stop grading those as fresh directional calls.
  const managed = !!(state.pos && state.pos.count);
  const plan = parsePlan(planLine, message, managed);

  return {
    headline, message, bias_call,
    plan: plan.legs, plan_source: plan.source, read_kind: managed ? 'manage' : 'entry',
    read_stance: readStance(bias_call, plan.legs, managed),
    prompt_version: PROMPT_VERSION,
    usage: resp.usage ? { in: resp.usage.input_tokens, out: resp.usage.output_tokens } : null,
    model: CFG.model,
  };
}

// ── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const chatId = process.env.COPILOT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_PLAN_CHAT_ID;
  const token = process.env.COPILOT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_PLAN_BOT_TOKEN;
  if (!chatId || chatId === 'off' || !token) return { ok: false, error: 'telegram_not_configured' };
  const MAX = 4000;
  const body = text.length > MAX ? text.slice(0, MAX) + '\n…(truncated)' : text;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j.description || `http_${r.status}` };
    return { ok: true, message_id: j.result?.message_id ?? null };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

const TRIGGER_TH = {
  zone_entry: 'เข้าโซน', sweep_reclaim: 'กวาด+กลับ',
  confluence_flip: 'bias พลิก', momentum_flag: 'โมเมนตัม', manual: 'สั่งเอง',
};
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const CALL_EMOJI = { 'Buy': '🟢', 'Sell': '🔴', 'No trade': '⚪️' };

function buildTelegramMessage(commentary, state, trigger) {
  const badge = TRIGGER_TH[trigger.trigger_type] || trigger.trigger_type;
  const em = CALL_EMOJI[commentary.bias_call] || '';
  const call = commentary.bias_call ? ` · ${em} <b>${esc(commentary.bias_call)}</b>` : '';
  const px = state.price == null ? '–' : esc(state.price);
  const posChip = (state.pos && state.pos.count)
    ? `\n📌 <b>${state.pos.count} ไม้</b> · ${esc(state.pos.net_side)} ${esc(state.pos.net_lots)} lot`
    : '';
  return `🤖 <b>โคไพลอต</b> · ${esc(badge)}${call}\n` +
         `${esc(state.symbol)} @ <b>${px}</b>${posChip}\n` +
         `➖➖➖➖➖➖\n` +
         `<b>${esc(commentary.headline)}</b>\n\n` +
         `${esc(commentary.message)}`;
}

// ── orchestrator ───────────────────────────────────────────────────────────────
// opts: { force:bool, trigger_type?:string, source?:string }
async function runAnalysis(db, opts = {}) {
  const state = await buildState(db);
  const stateId = await recordState(db, state);

  if (state.price == null) {
    return { ok: true, fired: false, reason: 'no_data', state_id: stateId };
  }

  let trigger;
  if (opts.force) {
    trigger = { fire: true, trigger_type: opts.trigger_type || 'manual', reason: 'manual read' };
  } else {
    trigger = await evaluateTriggers(db, state);
    if (!trigger.fire) return { ok: true, fired: false, reason: trigger.reason, state_id: stateId };
    if (await isDebounced(db, trigger.trigger_type, state.price)) {
      return { ok: true, fired: false, reason: 'debounced', trigger_type: trigger.trigger_type, state_id: stateId };
    }
  }

  // carry-forward context (today's ATR ladder + yesterday's price behaviour) —
  // non-fatal: a missing kp_atr / kp_read_outcomes table just yields no context.
  try { state.carry = await buildCarryForward(db); }
  catch (e) { console.warn('buildCarryForward failed (non-fatal):', e.message); state.carry = null; }

  // zone freshness — how used/tested each nearest zone already is today
  try { state.zone_usage = await buildZoneUsage(state); }
  catch (e) { console.warn('buildZoneUsage failed (non-fatal):', e.message); state.zone_usage = null; }

  const commentary = await callClaude(state, trigger);

  // deliver
  const delivered = [];
  if (CFG.dashboard) delivered.push('dashboard');
  let tgResult = null;
  if (CFG.telegram) {
    tgResult = await sendTelegram(buildTelegramMessage(commentary, state, trigger));
    if (tgResult.ok) delivered.push('telegram');
  }

  const { data: sig, error } = await db.from('kp_signals').insert({
    trigger_type: trigger.trigger_type,
    message: commentary.message,
    headline: commentary.headline,
    price: state.price,
    bias_call: commentary.bias_call,
    zones_referenced: trigger.zones || null,
    market_state_id: stateId,
    delivered_to: delivered,
    meta: {
      reason: trigger.reason, model: commentary.model, usage: commentary.usage,
      // ── capture-now block (Phase 9c): none of this can be backfilled later ──
      // policy identity, the structured level plan the read actually gave, and how
      // stale the inputs were at read time (a read priced off a 40-min-old snapshot
      // must be excluded from excursion grading, not silently averaged in).
      prompt_version: commentary.prompt_version || null,
      plan: (commentary.plan && commentary.plan.length) ? commentary.plan : null,
      plan_source: commentary.plan_source || null,
      read_kind: commentary.read_kind || null,
      read_stance: commentary.read_stance || null,
      freshness: {
        price_source: state.price_source, price_age_min: state.price_age_min,
        sitrep_age_min: state.sitrep_age_min, fibo_age_min: state.fibo_age_min,
        positions_source: state.positions_source, positions_age_min: state.positions_age_min,
      },
      source: opts.source || (opts.force ? 'manual' : 'auto'),
      telegram: tgResult ? (tgResult.ok ? tgResult.message_id : tgResult.error) : null,
      positions: (state.pos && state.pos.count) ? { count: state.pos.count, net_side: state.pos.net_side, net_lots: state.pos.net_lots } : null,
    },
  }).select('id, ts').single();
  if (error) return { ok: false, error: 'kp_signals_insert: ' + error.message, commentary };

  return { ok: true, fired: true, trigger_type: trigger.trigger_type, signal_id: sig.id, delivered, commentary, positions: state.pos, state_id: stateId };
}

// ── one-off: backfill plans for reads written before Phase 9c ────────────────
// The 🔴/🟢 level block of every past read is still sitting in kp_signals.message,
// so the structured plan CAN be recovered for existing history (only the input
// freshness and the prompt identity are truly lost — those are marked 'pre-9c').
// Exposed at /api/fibo-eval?target=backfill_plans[&write=1]; safe to re-run.
async function runPlanBackfill({ days = 120, write = false, force = false } = {}) {
  const db = getDb();
  const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await db.from('kp_signals')
    .select('id, ts, bias_call, message, meta').gte('ts', sinceISO)
    .order('ts', { ascending: true }).limit(2000);
  if (error) return { status: 500, body: { ok: false, error: error.message } };

  const todo = [], skipped = [];
  for (const s of data || []) {
    // re-parse rows captured before read_stance existed (the parser's recall changed);
    // ?force=1 re-parses everything, for when the extraction rules improve again
    if (!force && s.meta && s.meta.plan_source && s.meta.read_stance) { skipped.push(s.id); continue; }
    const managed = !!(s.meta && s.meta.positions && s.meta.positions.count);
    const p = parsePlan('', s.message || '', managed);
    const stance = readStance(s.bias_call, p.legs, managed);
    todo.push({ id: s.id, ts: s.ts, call: s.bias_call, read_kind: managed ? 'manage' : 'entry',
                stance, legs: p.legs,
                meta: { ...(s.meta || {}),
                        plan: p.legs.length ? p.legs : null,
                        plan_source: p.legs.length ? 'parsed_backfill' : 'none_backfill',
                        read_kind: managed ? 'manage' : 'entry',
                        read_stance: stance,
                        prompt_version: (s.meta && s.meta.prompt_version) || 'pre-9c' } });
  }
  if (write) {
    for (const t of todo) {
      const { error: e } = await db.from('kp_signals').update({ meta: t.meta }).eq('id', t.id);
      if (e) return { status: 500, body: { ok: false, error: 'update ' + t.id + ': ' + e.message } };
    }
  }
  return { status: 200, body: {
    ok: true, mode: write ? 'write' : 'dry', window_days: days,
    scanned: (data || []).length, already_captured: skipped.length, updated: todo.length,
    with_plan: todo.filter(t => t.legs.length).length,
    read_kind: { entry: todo.filter(t => t.read_kind === 'entry').length,
                 manage: todo.filter(t => t.read_kind === 'manage').length },
    stance: todo.reduce((a, t) => { a[t.stance] = (a[t.stance] || 0) + 1; return a; }, {}),
    entry_legs: todo.reduce((n, t) => n + t.legs.filter(l => l.kind === 'entry').length, 0),
    sample: todo.slice(0, 5).map(t => ({ id: t.id, ts: t.ts, call: t.call, legs: t.legs })),
  } };
}

module.exports = { getDb, getAnthropic, buildState, evaluateTriggers, runAnalysis, callClaude, buildCarryForward, sendTelegram, num, round, CFG, parsePlan, readStance, PROMPT_VERSION, runPlanBackfill };

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

// ── merged market state ────────────────────────────────────────────────────────
// Reads the two live tables and folds them into one object the trigger engine
// and Claude both consume. A source older than maxStateAgeMin is dropped to null.
async function buildState(db) {
  const [sitRes, fiboRes] = await Promise.all([
    db.from('market_sitreps')
      .select('id, created_at, symbol, price, bias_m15, bias_m5, vp_position, poc, vah, val, ppoc, pvah, pval, htf_conf, h1_count, ob_summary, supply_zones, demand_zones')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('fibo_snapshots')
      .select('id, created_at, symbol, price, active_side, entry_mode, frame_mode, leg_dir, s_focus, s_test, s_tp1, s_sl, b_focus, b_test, b_tp1, b_sl, fh, fl, mid')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (sitRes.error && sitRes.error.code !== 'PGRST116') throw sitRes.error;
  if (fiboRes.error && fiboRes.error.code !== 'PGRST116') throw fiboRes.error;

  let sitrep = sitRes.data || null;
  let fibo = fiboRes.data || null;
  const sitAge = sitrep ? ageMin(sitrep.created_at) : null;
  const fibAge = fibo ? ageMin(fibo.created_at) : null;
  // stale → treat as absent for decision-making (still noted in raw)
  const sitFresh = sitrep && sitAge <= CFG.maxStateAgeMin;
  const fibFresh = fibo && fibAge <= CFG.maxStateAgeMin;

  const price = num(sitFresh ? sitrep.price : null) ?? num(fibFresh ? fibo.price : null) ?? num(sitrep?.price) ?? num(fibo?.price);
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

  // live open positions (server-side reconstruct from trade_events)
  const positions = CFG.coachPositions ? await getOpenPositions(db, CFG.studyAccount) : [];
  const pos = positionView(positions, price);

  return {
    ts: new Date().toISOString(),
    symbol, price,
    positions, pos,
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
async function getOpenPositions(db, account) {
  const sinceIso = new Date(Date.now() - CFG.positionLookbackDays * 86400000).toISOString();
  const { data, error } = await db.from('trade_events')
    .select('ticket, event, payload, created_at')
    .eq('account_login', account)
    .in('event', ['OPEN', 'MODIFY', 'CLOSE'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(3000);
  if (error) { console.warn('trade_events read failed:', error.message); return []; }

  const posN = (v) => { const n = num(v); return n && n > 0 ? n : null; };
  const byTicket = new Map();
  for (const ev of (data || [])) {
    const t = ev.ticket;
    if (t == null) continue;
    let rec = byTicket.get(String(t));
    if (!rec) { rec = { ticket: t, closed: false, seenOpen: false }; byTicket.set(String(t), rec); }
    const p = ev.payload || {};
    if (ev.event === 'OPEN') {
      rec.seenOpen = true; rec.closed = false;
      rec.dir = p.dir || null; rec.lots = num(p.lots); rec.entry = num(p.price);
      rec.sl = posN(p.sl); rec.tp = posN(p.tp);
      rec.kind = p.kind || null; rec.origin = p.origin || null; rec.opened_at = ev.created_at;
    } else if (ev.event === 'MODIFY') {
      if ('sl' in p) rec.sl = posN(p.sl);
      if ('tp' in p) rec.tp = posN(p.tp);
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
      unrealized_usd: usd(unreal),           // real account P&L (lot-scaled)
      sl_dist_price: toSL == null ? null : round(toSL, 2),   // how far price is from SL
      tp_dist_price: toTP == null ? null : round(toTP, 2),   // how far price is from TP
      risk_to_sl_usd: usd(toSL),             // $ still at risk if SL hits (neg = profit locked past BE)
      reward_to_tp_usd: usd(toTP),           // $ remaining to TP
      rr, kind: p.kind, opened_at: p.opened_at,
    };
  });
  let netLots = 0, buyLots = 0, sellLots = 0;
  for (const p of positions) {
    const l = num(p.lots) || 0;
    if (p.dir === 'buy') { buyLots += l; netLots += l; } else { sellLots += l; netLots -= l; }
  }
  const netSide = netLots > 0 ? 'net long' : netLots < 0 ? 'net short' : 'flat/hedged';
  return { rows, count: rows.length, net_lots: round(netLots, 2), buy_lots: round(buyLots, 2), sell_lots: round(sellLots, 2), net_side: netSide };
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

MARKET STRUCTURE (read this first, every time): synthesize Mario + Fibo into ONE structural picture before any plan. Use the "structure" block:
- HTF direction: M15/M5 bias + Fibo leg direction (fibo_leg_dir UP/DOWN = current swing) + which side Fibo is active (S=looking to sell above, B=looking to buy below). Say whether they agree or conflict.
- Structure state from Mario zone tags: BOS = trend continuation, CHoCH = potential reversal/shift. Note the freshest BOS/CHoCH near price.
- Where price sits in value: vs POC/VAH/VAL (today) and prev-day ppoc/pvah/pval. Above VAH = premium, below VAL = discount, at POC = balance/mid.
- Fibo frame: price inside the frame (high/low/mid) tells premium vs discount within the swing.
Lead the read with this structural sentence, THEN the zone-level plan. When Mario and Fibo disagree, say so and favor the higher-timeframe / higher-confluence side.

LIVE POSITIONS: If the trader already has open positions (provided as "positions"), the read is about MANAGING them, not hunting new entries. FIRST compare each position to the structure above using with_m15_bias / with_fibo_leg and its entry location:
- Alignment: is the position WITH structure (with the M15 bias and Fibo leg) or AGAINST it? A with-structure trade gets more room; an against-structure (counter-trend) trade should be managed tighter and taken partial faster.
- Entry quality: was it entered at a zone edge (good) or mid-range/at POC (chasing)? Say it plainly.
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

📍 อ่าน (โครงสร้าง)
<ทิศ HTF: M15/M5 + Fibo leg + ฝั่ง active · โครงสร้าง BOS/CHoCH · ราคาอยู่ตรงไหนของ value (POC/VAH/VAL, พรีเมียม/ดิสเคานต์)>
<Mario กับ Fibo เห็นตรงหรือขัดกัน>

🎯 แผน
🔴 Sell <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
🟢 Buy <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
(ใส่เฉพาะฝั่งที่มีจริง ถ้า No trade บอกสั้น ๆ ว่ารออะไร)

🛑 เสียเมื่อ
<invalidation สั้น>

⚠️ <เตือนวินัย 1 บรรทัด>`;

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
    freshness: { mt5_age_min: state.sitrep_age_min, fibo_age_min: state.fibo_age_min },
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

  // first non-empty line = headline; the rest = body (no duplication anywhere)
  while (lines.length && !lines[0].trim()) lines.shift();
  const headline = demark(lines.shift() || 'อัปเดตตลาด').trim() || 'อัปเดตตลาด';
  const message = demark(lines.join('\n')).trim() || headline;

  return {
    headline, message, bias_call,
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
      source: opts.source || (opts.force ? 'manual' : 'auto'),
      telegram: tgResult ? (tgResult.ok ? tgResult.message_id : tgResult.error) : null,
      positions: (state.pos && state.pos.count) ? { count: state.pos.count, net_side: state.pos.net_side, net_lots: state.pos.net_lots } : null,
    },
  }).select('id, ts').single();
  if (error) return { ok: false, error: 'kp_signals_insert: ' + error.message, commentary };

  return { ok: true, fired: true, trigger_type: trigger.trigger_type, signal_id: sig.id, delivered, commentary, positions: state.pos, state_id: stateId };
}

module.exports = { getDb, getAnthropic, buildState, evaluateTriggers, runAnalysis, callClaude, sendTelegram, num, round, CFG };

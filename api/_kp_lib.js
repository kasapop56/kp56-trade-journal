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
      .select('id, created_at, symbol, price, bias_m15, bias_m5, vp_position, poc, vah, val, ppoc, pvah, pval, supply_zones, demand_zones')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('fibo_snapshots')
      .select('id, created_at, symbol, price, active_side, entry_mode, s_focus, s_test, s_tp1, s_sl, b_focus, b_test, b_tp1, b_sl, fh, fl, mid')
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

  return {
    ts: new Date().toISOString(),
    symbol, price,
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
- Keep it mobile-readable and free of filler. End with one brief discipline reminder.`;

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
<1-2 ประโยคสั้น>

🎯 แผน
🔴 Sell <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
🟢 Buy <โซน>
   SL <x> · TP1 <x> ปิด50% · TP2 <x>
(ใส่เฉพาะฝั่งที่มีจริง ถ้า No trade บอกสั้น ๆ ว่ารออะไร)

🛑 เสียเมื่อ
<invalidation สั้น>

⚠️ <เตือนวินัย 1 บรรทัด>`;

async function callClaude(state, trigger) {
  const client = getAnthropic();
  const userPayload = {
    trigger: { type: trigger.trigger_type, reason: trigger.reason },
    symbol: state.symbol,
    price: state.price,
    freshness: { mt5_age_min: state.sitrep_age_min, fibo_age_min: state.fibo_age_min },
    mt5: state.sitrep ? {
      bias_m15: state.bias_m15, bias_m5: state.bias_m5, vp_position: state.vp_position,
      poc: state.poc, vah: state.vah, val: state.val,
      supply_zones: state.sitrep.supply_zones, demand_zones: state.sitrep.demand_zones,
    } : null,
    tradingview: state.fibo ? {
      active_side: state.fibo_side, entry_mode: state.fibo.entry_mode,
      s: { focus: state.fibo.s_focus, test: state.fibo.s_test, tp1: state.fibo.s_tp1, sl: state.fibo.s_sl },
      b: { focus: state.fibo.b_focus, test: state.fibo.b_test, tp1: state.fibo.b_tp1, sl: state.fibo.b_sl },
      frame: { high: state.fibo.fh, low: state.fibo.fl, mid: state.fibo.mid },
      h4_trend: state.h4_trend,   // null until Pine feeds it
    } : null,
    nearest_supply: state.nearestSupply,
    nearest_demand: state.nearestDemand,
    notes: [
      state.sitrep ? null : 'ไม่มี SITREP สด (MT5) — ใช้ Fibo อย่างเดียว',
      state.h4_trend ? null : 'ยังไม่มี H4 trend จาก TradingView',
    ].filter(Boolean),
  };

  const resp = await client.messages.create({
    model: CFG.model,
    max_tokens: CFG.maxTokens,
    output_config: { effort: CFG.effort },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${OUTPUT_HINT}\n\nMARKET STATE (JSON):\n${JSON.stringify(userPayload, null, 2)}`,
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
  return `🤖 <b>โคไพลอต</b> · ${esc(badge)}${call}\n` +
         `${esc(state.symbol)} @ <b>${px}</b>\n` +
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
    },
  }).select('id, ts').single();
  if (error) return { ok: false, error: 'kp_signals_insert: ' + error.message, commentary };

  return { ok: true, fired: true, trigger_type: trigger.trigger_type, signal_id: sig.id, delivered, commentary, state_id: stateId };
}

module.exports = { getDb, buildState, evaluateTriggers, runAnalysis, callClaude, sendTelegram, CFG };

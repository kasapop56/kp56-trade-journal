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
const crypto = require('crypto');
const CFG = require('./_kp_config');

const POINT = 0.01;                 // XAUUSD 1 point in price
const SYM   = 'XAUUSD';

// Identity of the SCORING RULE. Bump EVAL_REV whenever classify() itself changes;
// the hash covers every eval threshold + the day-window mode. Stamped on each
// outcome row so a later re-grade under different thresholds can never be silently
// mixed with old outcomes (verdicts are recomputed on every run, so without this
// a threshold tweak would rewrite all of history with no marker).
const EVAL_REV = '9k';
const EVAL_VERSION = EVAL_REV + '-' + crypto.createHash('sha1')
  .update(JSON.stringify(CFG.eval)).digest('hex').slice(0, 6);

let _db;
function db() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

// Number(null) === 0 and Number('') === 0 — both finite — so the naive version
// turned a MISSING level into a real-looking 0. A plan with no stop then got
// risk = |entry − 0| = the whole gold price, a stop that can never be hit, and an
// automatic WIN. Reject empty values before converting.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
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
// A BAR row is stamped at the bar's CLOSE (t_gmt = TimeGMT() when bar1 closed), so
// a bar with timestamp t covers [t − tf, t]. Without the timeframe we cannot tell
// which bar contains a read, and the bar containing the read carries up to a full
// bar of PRE-read movement — including the very wick that triggered the read.
const DEFAULT_TF_MS = 5 * 60e3;      // RainbowPilot runs on M5
function tfMs(s) {
  const m = String(s || '').match(/^([MHD])(\d+)$/i);
  if (!m) return null;
  const n = Number(m[2]), u = m[1].toUpperCase();
  return u === 'M' ? n * 60e3 : u === 'H' ? n * 3600e3 : u === 'D' ? n * 86400e3 : null;
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
        out.push({ t, o: +bar1[0], h: +bar1[1], l: +bar1[2], c: +bar1[3],
                   tf: tfMs(b.payload?.tf) || DEFAULT_TF_MS });
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

// Zone freshness: how many times price has already TESTED a zone earlier in the
// trading day, and whether it has closed THROUGH it (broken). A fresh (untested)
// zone is strongest; each retest consumes liquidity → weaker. `beforeMs` limits
// the count to bars strictly before a reference time (e.g. a read's timestamp).
//   zone = { side:'supply'|'demand', lo, hi }
function zoneFreshness(bars, zone, dayIdx, beforeMs) {
  const lo = num(zone.lo), hi = num(zone.hi);
  if (lo == null || hi == null) return { tests: 0, fresh: true, broke: false };
  const isSupply = String(zone.side) === 'supply';
  let tests = 0, inside = false, broke = false;
  for (const b of bars) {
    if (bkkDay(b.t) !== dayIdx) continue;
    if (beforeMs != null && b.t >= beforeMs) break;
    const touched = b.h >= lo && b.l <= hi;     // bar overlapped the zone band
    if (touched && !inside) { tests++; inside = true; }
    if (!touched) inside = false;
    if (isSupply ? b.c > hi : b.c < lo) broke = true;   // closed through = broken
  }
  return { tests, fresh: tests === 0, broke };
}

// ── plan replay ──────────────────────────────────────────────────────────────
// Grades what the read actually ADVISED: a pending limit at a zone edge, with a stop
// and a first target. This is the only honest yardstick for a "wait" read — the
// directional ±ATR measure grades a market order the read explicitly told the trader
// not to take. Mirrors replaySide() in fibo-eval.js so both evaluators agree.
//
//   entry   = the first bar that trades into the zone band (fill at the near edge,
//             or at the bar's open if it opened already through the zone)
//   outcome = TP1 or SL, whichever is touched first; a bar touching BOTH counts as
//             LOSS, because OHLC cannot order what happened inside the bar
//
// The entry bar is judged whole, so a bar that reaches into the zone and to the stop
// in one move is a loss. That is the conservative reading and it matches fibo-eval.
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
// Minimum distance from fill to stop for a plan to be tradeable at all ($ on gold).
// Below this the "risk" is spread noise and every R-multiple derived from it is junk.
const MIN_RISK = 0.5;

// WHERE in the zone the limit fills is genuinely ambiguous, and it is not a detail:
// on read 1 the same plan is RR 1.0 filled at the near edge and RR 7.0 filled at the
// far edge, because the stop sits just $1.25 beyond the far edge. It changes wins and
// losses too — a $1.25 stop is far easier to hit than a $5.00 one.
//   'near' = first touch of the band (most fills, worst prices)
//   'mid'  = the middle of the zone
//   'far'  = the deep edge (fewest fills, best prices — and the one the co-pilot's
//            own stop placement implies)
// Selectable so the sensitivity can be measured rather than assumed.
function fillPrice(mode, isBuy, zLo, zHi, b) {
  if (mode === 'far') return isBuy ? zLo : zHi;
  if (mode === 'mid') return (zLo + zHi) / 2;
  return (b.o >= zLo && b.o <= zHi) ? b.o : (isBuy ? zHi : zLo);
}
// has this bar traded deep enough for the chosen fill to happen?
function fillReached(mode, isBuy, zLo, zHi, b, buf) {
  const px = mode === 'near' ? null : fillPrice(mode, isBuy, zLo, zHi, b);
  if (px == null) return b.h >= zLo - buf && b.l <= zHi + buf;
  return isBuy ? b.l <= px + 1e-9 : b.h >= px - 1e-9;
}

function replayLeg(leg, bars, buf, mode) {
  const a = num(leg.zone_lo), b2 = num(leg.zone_hi) ?? num(leg.zone_lo);
  const zLo = Math.min(a, b2), zHi = Math.max(a, b2);
  const isBuy = String(leg.side) === 'buy';
  const sl = num(leg.sl), tp1 = num(leg.tp1);
  // TP1 is scored as a FULL exit: the "close 50%" in the read is trading advice, not
  // the measuring rule. So rr1 is the plan's reward-to-risk, full stop.
  const out = { side: leg.side, zone_lo: zLo, zone_hi: zHi, sl, tp1, status: 'NO_FILL',
                entry_at: null, entry_px: null, rr1: null, mfe_r: null, mae_r: null, bars_held: 0,
                // how much further price ran AFTER the exit, before coming back to the
                // entry price — what leaving at TP1 cost. Bounded at the return to
                // entry because past that a runner would be at breakeven anyway.
                beyond_tp1_pts: null, beyond_tp1_r: null, returned_to_entry: null };
  let entryPx = null, R = null, best = null, worst = null;
  let winAt = null, extBest = null, returned = false;
  for (const b of bars) {
    if (entryPx == null) {
      if (!fillReached(mode, isBuy, zLo, zHi, b, buf)) continue;   // not deep enough to fill
      // Fill INSIDE the zone, always: at the bar's open if it opened within the
      // band, otherwise at the edge the price approached (a buy limit sits at the
      // upper edge, a sell limit at the lower edge). Taking the bar's open when it
      // opened OUTSIDE the band let the fill land next to the stop — one read filled
      // a sell at 4366.7 against a 4366.75 stop, R = $0.05, and every R-multiple
      // downstream exploded (MFE 87R).
      entryPx = fillPrice(mode, isBuy, zLo, zHi, b);
      out.entry_at = b.t; out.entry_px = r2(entryPx);
      const risk = sl == null ? null : Math.abs(entryPx - sl);
      // A stop inside (or a hair from) the entry zone is not a tradeable plan.
      if (risk != null && risk >= MIN_RISK) R = risk;
      out.rr1 = (R && tp1 != null) ? r2(Math.abs(tp1 - entryPx) / R) : null;
      // A target sitting on the entry zone is not a target — it would "fill" on the
      // same tick that enters, so it must not be scored as a win.
      const reward = tp1 == null ? null : Math.abs(tp1 - entryPx);
      out.status = (sl == null || tp1 == null) ? 'NO_LEVELS'
                 : (R == null) ? 'SL_IN_ZONE'
                 : (reward < MIN_RISK) ? 'TP_IN_ZONE' : 'OPEN';
    }
    out.bars_held++;
    // MFE/MAE describe the trade, so they stop when the trade does — accumulating
    // to the end of the day reported 18R of "favourable excursion" on a plan that
    // had already been stopped out hours earlier.
    if (out.status === 'OPEN' || out.status === 'NO_LEVELS' || out.status === 'SL_IN_ZONE') {
      const fav = isBuy ? (b.h - entryPx) : (entryPx - b.l);
      const adv = isBuy ? (entryPx - b.l) : (b.h - entryPx);
      best  = best  == null ? fav : Math.max(best, fav);
      worst = worst == null ? adv : Math.max(worst, adv);
    }
    if (out.status === 'OPEN') {
      const hitSl = isBuy ? b.l <= sl  : b.h >= sl;
      const hitTp = isBuy ? b.h >= tp1 : b.l <= tp1;
      if (hitSl) out.status = 'LOSS';        // tie inside one bar → LOSS
      else if (hitTp) { out.status = 'WIN'; winAt = b.t; }
    }
    // ── extension after a win ──
    if (out.status === 'WIN' && !returned) {
      const beyond = isBuy ? (b.h - tp1) : (tp1 - b.l);
      if (beyond > 0) extBest = extBest == null ? beyond : Math.max(extBest, beyond);
      // don't let the entry bar's own wick count as "came back" when the whole trade
      // opened and hit target inside one bar
      const backToEntry = isBuy ? (b.l <= entryPx) : (b.h >= entryPx);
      if (b.t !== winAt && backToEntry) returned = true;
    }
  }
  if (R) { out.mfe_r = r2(best / R); out.mae_r = r2(worst / R); }
  if (out.status === 'WIN') {
    out.beyond_tp1_pts = extBest == null ? 0 : Math.round(extBest / POINT);
    out.beyond_tp1_r = (R && extBest != null) ? r2(extBest / R) : (R ? 0 : null);
    out.returned_to_entry = returned;    // false = still running when the day ended
  }
  return out;
}

// A read often advises both sides ("wait to sell up there / buy down there"). The
// side that actually filled FIRST is the trade that would have happened, so that leg
// carries the read's plan verdict.
function replayPlan(legs, bars, buf, dayOver, mode) {
  const results = legs.map(l => replayLeg(l, bars, buf, mode));
  const filled = results.filter(r => r.entry_at != null).sort((x, y) => x.entry_at - y.entry_at);
  for (const r of results) if (r.status === 'OPEN') r.status = dayOver ? 'OPEN_END' : 'PENDING';
  // a leg that filled but carried no usable levels can't be scored — don't let it
  // stand in for the read's plan verdict if another leg can be scored
  const scorable = (r) => !['NO_LEVELS', 'SL_IN_ZONE', 'TP_IN_ZONE'].includes(r.status);
  // The trade that would have happened is simply the leg that filled FIRST. Falling
  // through to a later leg when the first one can't be scored makes the read's
  // verdict depend on parse completeness: reads 1 and 2 were the same setup eight
  // minutes apart and came out WIN vs LOSS only because one leg's stop failed to
  // parse and the scorer quietly graded the other side instead. If the leg that
  // filled first isn't scorable, the read isn't scorable — say so.
  const first = filled[0] || null;
  return {
    fill_mode: mode, legs: results, filled: filled.length, legs_total: results.length,
    verdict: first ? first.status : (dayOver ? 'NO_FILL' : 'PENDING'),
    first_side: first ? first.side : null,
    rr1: first ? first.rr1 : null, mfe_r: first ? first.mfe_r : null, mae_r: first ? first.mae_r : null,
    beyond_tp1_r: first ? first.beyond_tp1_r : null,
    beyond_tp1_pts: first ? first.beyond_tp1_pts : null,
    returned_to_entry: first ? first.returned_to_entry : null,
  };
}

// buy/sell direction implied by a bias/leg/side word (Bull/Bear/UP/DOWN/S/B/…)
function dirOf(s) {
  const v = String(s || '').toLowerCase();
  if (v.startsWith('bull') || v === 'up' || v === 'b' || v.startsWith('buy')) return 'buy';
  if (v.startsWith('bear') || v === 'down' || v === 's' || v.startsWith('sell')) return 'sell';
  return null;
}
// XAUUSD trading session from a read's UTC hour (rough, London/NY overlap→NY).
// Sessions follow the exchanges' LOCAL clocks, so fixed UTC hours smear every
// bucket by an hour for part of the year (London and New York change on different
// dates, so there are weeks where both are off). Ask the timezones instead.
function hourIn(ms, tz) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false })
    .format(new Date(ms));
  return parseInt(h, 10);
}
function sessionOf(ms) {
  try {
    const ny = hourIn(ms, 'America/New_York');
    if (ny >= 8 && ny < 17) return 'ny';                 // NY cash session
    const ldn = hourIn(ms, 'Europe/London');
    if (ldn >= 8 && ldn < 16) return 'london';
    const tky = hourIn(ms, 'Asia/Tokyo');
    if (tky >= 9 && tky < 18) return 'asia';
    return 'off';
  } catch (e) {
    const h = new Date(ms).getUTCHours();               // Intl unavailable → old rule
    return h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'ny' : 'off';
  }
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
    // which swing degree the fibo levels came from at read time (Phase 8g):
    // MAIN = main-TF frame · FALLBACK = finer degree after the main frame's SL
    // broke · WAIT = no valid frame (read was built without fibo levels).
    // The question this answers: are FALLBACK-degree reads as good as MAIN ones?
    fibo_state: raw.fibo_state ?? 'MAIN',
    fibo_src_tf: raw.fibo_src_tf ?? null,
    vp_bucket: vpBucket,
    htf_conf: raw.htf_conf ?? null,
    ob_summary: raw.ob_summary ?? null,
    zone_source: zone?.source ?? null,
    zone_tier: zone?.tier ?? null,
    zone_score_bucket: scoreBucket(zone?.score),
    zone_tags: Array.isArray(zone?.tags) ? zone.tags.slice(0, 6) : (zone?.tags ? [zone.tags] : []),
    // freshness of the target zone at read time (Zone Freshness): fresh zones are
    // strongest; each prior retest consumes liquidity → weaker.
    zone_fresh: out.zone_freshness ? out.zone_freshness.fresh : null,
    zone_retest_count: out.zone_freshness ? out.zone_freshness.tests : null,
    zone_state: out.zone_freshness ? (out.zone_freshness.fresh ? 'fresh' : 'retested') : null,
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

  // ── entry read or management note? ──
  // A read taken while a position was open is live-order COACHING: its CALL word
  // echoes exposure the trader already has, it advises no entry, and grading it as
  // a fresh directional call measures the trader's open trade, not the co-pilot.
  // (Historically 100% of Buy/Sell reads were of this kind — see doc §13.2b.)
  const readPriceAgeMin = num(sig.meta?.freshness?.price_age_min);
  const readKind = sig.meta?.read_kind
    || ((sig.meta?.positions?.count) ? 'manage' : 'entry');
  // the entry legs the read actually advised (null for older/《manage》reads)
  const entryLegs = Array.isArray(sig.meta?.plan)
    ? sig.meta.plan.filter(l => l && l.kind !== 'manage' && num(l.zone_lo) != null)
    : [];

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
  // Strictly bars that OPENED at/after the read: a bar is stamped at its close, so
  // `b.t > t0` would admit the bar containing the read and count its pre-read wick
  // as post-read excursion — biased against the sweep-and-reclaim setups the system
  // is built around.
  const after = dayEntry.bars.filter(b => (b.t - (b.tf || DEFAULT_TF_MS)) >= t0);
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

  // Direction-free post-read travel — the honest yardstick for a "No trade" read
  // (the old one used the WHOLE day's travel from the day open, so a correct 20:00
  // "sit out" after a morning trend was scored MISSED for a move that had already
  // happened before the read existed).
  const postUp = (maxH != null) ? maxH - P0 : null;
  const postDn = (minL != null) ? P0 - minL : null;
  const postMaxAtr = (atr && postUp != null && postDn != null)
    ? Math.round((Math.max(postUp, postDn) / atr) * 100) / 100 : null;
  // Did price ever come to a level the read said to wait for? If a move happened but
  // never offered the advised entry, sitting it out was CORRECT, not a miss.
  const legTouched = entryLegs.length ? entryLegs.some(l => {
    const lo = Math.min(num(l.zone_lo), num(l.zone_hi) ?? num(l.zone_lo));
    const hi = Math.max(num(l.zone_lo), num(l.zone_hi) ?? num(l.zone_lo));
    const b = E.zoneBufferPrice;
    return after.some(x => x.h >= lo - b && x.l <= hi + b);
  }) : null;

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
  else if (readKind === 'manage') {
    // Not an entry call → excluded from WIN/LOSS and from attribution. Excursions
    // are still recorded; judging management advice needs its own yardstick (was
    // the SL/TP guidance good?), which is a separate piece of work.
    verdict = 'MANAGE';
  } else if (readPriceAgeMin != null && readPriceAgeMin > (E.maxReadPriceAgeMin || 5)) {
    // Excursions are measured FROM the read price. If that price was a stale
    // snapshot, the starting point is wrong and every distance derived from it is
    // wrong with it — better to refuse than to average the error in. (null age =
    // pre-9c read, unknown rather than stale, so it is still graded.)
    verdict = 'STALE_PRICE';
  } else if (call == null) {
    // the CALL line didn't parse — a malformed read must not become a fake STALL
    verdict = 'UNGRADEABLE';
  } else if (call === 'none') {
    if (!atr || postMaxAtr == null) verdict = day < today ? 'EXPIRED' : 'PENDING';
    else if (postMaxAtr >= E.winAtr) {
      // a real move happened AFTER the read — but only a miss if the read's own
      // level was actually offered
      verdict = (legTouched === false) ? 'NO_ENTRY_OFFERED'
              : (day < today ? 'MISSED' : 'PENDING');
    } else verdict = day < today ? 'OK_NOTRADE' : 'PENDING';
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
  if (readKind === 'manage') {
    parts.push(`อ่านตอนถือไม้อยู่ (คุมไม้ ไม่ใช่สัญญาณเข้าใหม่) · ${DAY_WORD[day_type]}`);
  } else if (verdict === 'NO_ENTRY_OFFERED') {
    parts.push(`ราคาไป ${postMaxAtr}ATR แต่ไม่เคยแตะโซนที่รอ — ไม่เข้าถูกแล้ว`);
  } else if (call === 'none') {
    parts.push(`อ่าน "ไม่เทรด" · ${DAY_WORD[day_type]} ราคา${dirWord}`);
  } else if (fav_atr != null) {
    parts.push(`ไป ${fav_atr}ATR(${fav_pts}pt) สวน ${adv_atr}ATR`);
    parts.push(DAY_WORD[day_type]);
    if (target_zone) parts.push(`${target_zone.label} ${ZONE_WORD[zone_behavior] || ''}`.trim());
  } else {
    parts.push(`${DAY_WORD[day_type]} ราคา${dirWord}`);
  }
  const behavior_note = parts.filter(Boolean).join(' · ');

  // ── plan replay: grade the advised pending order, not a market order at P0 ──
  const planReplay = (readKind !== 'manage' && entryLegs.length && after.length)
    ? replayPlan(entryLegs, after, E.zoneBufferPrice, day < today, E.entryFill || 'near')
    : null;

  const outObj = {
    ...base,
    day_open: dayOpen, atr: atr != null ? Math.round(atr * 100) / 100 : null, atr_source: atrSource || 'none',
    day_type, day_travel_up_atr: upAtr != null ? Math.round(upAtr * 100) / 100 : null,
    day_travel_dn_atr: dnAtr != null ? Math.round(dnAtr * 100) / 100 : null, direction_actual,
    fav_atr, adv_atr, fav_pts, adv_pts, reached_band,
    target_zone, reached_target, zone_behavior,
    verdict, behavior_note, bars_seen: after.length,
    meta: { day_high: dayHigh, day_low: dayLow, fav_ext: favExt, adv_ext: advExt, first_touch: result, ladder_open: ladderOpen, atr_source: atrSource || 'none',
            eval_version: EVAL_VERSION, read_price_age_min: num(sig.meta?.freshness?.price_age_min),
            prompt_version: sig.meta?.prompt_version ?? null, plan_source: sig.meta?.plan_source ?? null,
            read_kind: readKind, read_stance: sig.meta?.read_stance ?? null,
            post_max_atr: postMaxAtr, leg_touched: legTouched,
            entry_legs: entryLegs.length,
            // the plan the read actually gave, replayed as a pending limit order —
            // a SEPARATE track from `verdict` (which stays the directional lean)
            plan_replay: planReplay, plan_verdict: planReplay ? planReplay.verdict : null,
            // hours of runway the read had before its day closed — late reads are
            // structurally more likely to end STALL/EXPIRED, so any cross-bucket
            // comparison has to be able to control for it
            runway_h: Math.round(((bkkDay(t0) + 1) * 86400e3 - dayShiftMs() - t0) / 36e5 * 10) / 10 },
  };
  // Attach the read's ingredients (Mario/Fibo/structure/ATR/session) so the
  // attribution layer can learn which factors drive wins. Stored in meta (no
  // schema change) — aggregated in JS by runAttribution().
  // freshness of the target zone at read time — tests by price BEFORE this read today
  const zoneFresh = target_zone
    ? zoneFreshness(dayEntry.bars, { side: target_zone.side, lo: target_zone.lo, hi: target_zone.hi }, day, t0)
    : null;
  // NOTE: zone_fresh / zone_retest_count live INSIDE meta.factors only — the
  // kp_read_outcomes table has no such columns, so putting them at top level made
  // the whole upsert fail ("column not found"). Keep them in the jsonb.
  outObj.meta.factors = buildFactors(sig, stateRow, {
    call_dir: dir === 1 ? 'buy' : dir === -1 ? 'sell' : null,
    target_zone, day_type, reached_band, zone_freshness: zoneFresh,
  });
  return outObj;
}

// Core: (re)evaluate reads over a lookback window. Shared by the HTTP handler and
// the nightly report (so the report always grades against fresh outcomes).
async function runEval({ days = CFG.eval.lookbackDays, write = false, fill = null } = {}) {
  if (fill) CFG.eval.entryFill = fill;      // dry-run override for sensitivity checks
  {
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    // reads to grade
    const sigRes = await db().from('kp_signals')
      .select('id, ts, price, bias_call, market_state_id, meta')   // no symbol col on kp_signals → default in classify; meta carries plan + prompt_version + freshness
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

    // Daily ATR frames (indicator-fed); may be empty pre-setup → fallback compute.
    // Joined on a day INDEX derived from the alert's OWN timestamp through the same
    // day function the reads use — never on the date STRING. The ingest stamps
    // atr_date as a Bangkok civil date while the evaluator runs on the broker's
    // chart day (UTC−4): those two strings only agree between 11:00 and 24:00
    // Bangkok, so a string join silently loses the ATR row for a third of the clock
    // and falls back to the (systematically small) computed ATR.
    const atrByDay = new Map();
    const alertHours = [];
    const atrRes = await db().from('kp_atr')
      .select('atr_date, day_open, atr, atr_len, method, ts')
      .gte('atr_date', bkkDateStr(Date.now() - (days + 2) * 86400e3));
    if (!atrRes.error) for (const r of atrRes.data || []) {
      const ms = r.ts ? Date.parse(r.ts) : Date.parse(r.atr_date + 'T12:00:00Z');
      if (!Number.isFinite(ms)) continue;
      atrByDay.set(bkkDay(ms), r);
      alertHours.push(new Date(ms).getUTCHours());
    }

    const bars = await loadBars(sinceISO);
    const dayMap = buildDays(bars);
    const daysArr = [...dayMap.values()].sort((a, b) => a.day - b.day);

    const rows = signals.map(s =>
      classify(s, stateById.get(s.market_state_id) || null, atrByDay.get(bkkDay(Date.parse(s.ts))) || null, dayMap, daysArr));

    if (write) {
      const up = await db().from('kp_read_outcomes').upsert(rows, { onConflict: 'signal_id' });
      if (up.error) {
        const missing = up.error.code === '42P01';
        return { status: missing ? 424 : 500, body: {
          ok: false,
          error: missing ? 'kp_read_outcomes table missing — run supabase_schema_kp_read_outcomes.sql' : up.error.message,
        } };
      }
    }

    const tally = {};
    for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    const planTally = {};
    for (const r of rows) if (r.meta.plan_verdict) planTally[r.meta.plan_verdict] = (planTally[r.meta.plan_verdict] || 0) + 1;
    // Health: every failure mode here fails PLAUSIBLE, not loud (a deactivated Pine
    // alert, an EA that went down, a day the ATR row never arrived). Surface it in
    // the response so a red number is visible instead of clean-looking stats.
    const atrSrc = {};
    for (const r of rows) atrSrc[r.atr_source] = (atrSrc[r.atr_source] || 0) + 1;
    const daysWithBars = daysArr.map(d => d.day);
    const missingAtrDays = daysWithBars.filter(d => !atrByDay.has(d));
    return { status: 200, body: {
      ok: true, mode: write ? 'write' : 'dry', window_days: days,
      reads: signals.length, rows_upserted: write ? rows.length : 0, bars_used: bars.length,
      plan_tally: planTally,
      bar_feed: { oldest: bars[0]?.t ?? null, newest: bars.at(-1)?.t ?? null, days: daysArr.length },
      atr_days: atrByDay.size, tally, eval_version: EVAL_VERSION,
      prompt_versions: [...new Set(signals.map(s => s.meta?.prompt_version ?? 'pre-9c'))],
      plans_captured: signals.filter(s => s.meta?.plan).length,
      health: {
        atr_source: atrSrc,
        days_with_bars: daysWithBars.length,
        days_missing_atr: missingAtrDays.length,
        // confirms _kp_config.eval.dayCutUtcHour against reality: the indicator's
        // alert should land just after the broker's daily open
        atr_alert_utc_hours: [...new Set(alertHours)].sort((a, b) => a - b),
        day_cut_utc_hour: CFG.eval.dayCutUtcHour,
        warn: missingAtrDays.length
          ? `${missingAtrDays.length}/${daysWithBars.length} days have bars but no kp_atr row → computed ATR (understates volatility, inflates day_type)`
          : null,
      },
      preview: write ? undefined : rows.map(r => ({
        id: r.signal_id, call: r.call, kind: r.meta.read_kind, verdict: r.verdict,
        plan: r.meta.plan_verdict, filled: r.meta.plan_replay ? r.meta.plan_replay.filled : null,
        side: r.meta.plan_replay ? r.meta.plan_replay.first_side : null,
        rr1: r.meta.plan_replay ? r.meta.plan_replay.rr1 : null,
        mfe_r: r.meta.plan_replay ? r.meta.plan_replay.mfe_r : null,
        beyond_r: r.meta.plan_replay ? r.meta.plan_replay.beyond_tp1_r : null,
        beyond_pts: r.meta.plan_replay ? r.meta.plan_replay.beyond_tp1_pts : null,
        back_to_entry: r.meta.plan_replay ? r.meta.plan_replay.returned_to_entry : null,
        post: r.meta.post_max_atr, day: r.day_type, atr_src: r.atr_source,
      })),
    } };
  }
}

// ── Factor attribution ───────────────────────────────────────────────────────
// Reads stored outcomes (kp_read_outcomes.meta.factors) and asks, for each factor
// dimension: what did price do when THIS ingredient was present? Groups verdicts
// per bucket and computes a directional hit-rate (WIN / (WIN+LOSS)). Pure JS
// aggregation — no new table. Meaningful only once enough reads accumulate.
// basis 'lean' = the directional ±ATR measure (dense, symmetric, 50% null)
// basis 'plan' = the replayed pending order (sparse, but the advice actually given).
// Never mixed: they answer different questions and have different null rates.
function runAttributionRows(rows, minSamples, basis) {
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

  let total = 0, decided = 0, skipped_manage = 0, skipped_bad = 0;
  for (const r of rows) {
    // management notes advised no entry — they can never be a directional "hit"
    if ((r.meta && r.meta.read_kind) === 'manage') { skipped_manage++; continue; }
    if (r.verdict === 'STALE_PRICE' || r.verdict === 'UNGRADEABLE') { skipped_bad++; continue; }
    const f = r.meta && r.meta.factors;
    if (!f) continue;
    const verdict = basis === 'plan' ? (r.meta.plan_verdict || 'NONE') : r.verdict;
    if (basis === 'plan' && verdict === 'NONE') continue;
    total++;
    if (verdict === 'WIN' || verdict === 'LOSS') decided++;
    bump('call', f.call, verdict);
    bump('call_vs_m15', f.call_vs_m15, verdict);
    bump('call_vs_fibo_leg', f.call_vs_fibo_leg, verdict);
    bump('mario_fibo_aligned', f.mario_fibo_aligned == null ? null : (f.mario_fibo_aligned ? 'aligned' : 'conflict'), verdict);
    bump('fibo_state', f.fibo_state, verdict);   // MAIN vs FALLBACK degree vs WAIT (no frame)
    bump('bias_conflict', f.bias_conflict == null ? null : (f.bias_conflict ? 'm15≠m5' : 'm15=m5'), verdict);
    bump('vp_bucket', f.vp_bucket, verdict);
    bump('zone_source', f.zone_source, verdict);
    bump('zone_score', f.zone_score_bucket, verdict);
    bump('zone_state', f.zone_state, verdict);   // fresh vs retested (Zone Freshness)
    // atr_day_type is NOT aggregated: the realized day type is not knowable at read
    // time and is computed from the same travel that decides the verdict, so
    // "buy reads win on TREND days" is near-tautological and cannot be acted on
    // ex-ante. Kept as a descriptive column on the outcome row only.
    bump('session', f.session, verdict);
    for (const tag of (f.zone_tags || [])) bump('zone_tag', tag, verdict);
  }

  // finalize: hit_rate + sort each dim by hit_rate (buckets with a decided base first)
  const out = {};
  for (const [dim, buckets] of Object.entries(dims)) {
    out[dim] = Object.entries(buckets).map(([value, b]) => {
      // the percentage is computed over DECIDED reads only, so the small-sample
      // gate must count decided reads too — flagging on n (which includes PENDING /
      // STALL / MISSED) let "0% (n=4)" through as if it were trustworthy
      const base = b.win + b.loss;
      return {
        value, n: b.n, decided: base,
        hit_rate_pct: base >= 1 ? Math.round((b.win / base) * 100) : null,
        win: b.win, loss: b.loss, stall: b.stall, ok_notrade: b.ok_notrade, missed: b.missed,
        small_sample: base < minSamples,
      };
    // buckets that actually have a decided base first — never let a 1-sample 100%
    // bucket sort to the top, where the report prompt picks it up as an "edge"
    }).sort((a, z) => (a.small_sample ? 1 : 0) - (z.small_sample ? 1 : 0)
                   || (z.hit_rate_pct ?? -1) - (a.hit_rate_pct ?? -1) || z.decided - a.decided);
  }
  return { basis: basis || 'lean', total_with_factors: total, decided, skipped_manage, skipped_bad, min_samples: minSamples, dims: out };
}

async function runAttribution({ days = CFG.eval.lookbackDays, minSamples = 3, basis = 'lean' } = {}) {
  const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await db().from('kp_read_outcomes')
    .select('verdict, call, meta').gte('read_ts', sinceISO)
    .order('read_ts', { ascending: false }).limit(2000);
  if (error) {
    const missing = error.code === '42P01';
    return { status: missing ? 424 : 500, body: { ok: false, error: missing ? 'kp_read_outcomes table missing' : error.message } };
  }
  const agg = runAttributionRows(data || [], minSamples, basis);
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
// shared with _kp_lib for the read-time Zone Freshness context
module.exports.loadBars = loadBars;
module.exports.bkkDay = bkkDay;
module.exports.zoneFreshness = zoneFreshness;
module.exports.replayPlan = replayPlan;

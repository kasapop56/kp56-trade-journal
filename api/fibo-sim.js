// Vercel serverless — Fibo re-entry SIMULATOR (READ-ONLY, writes nothing).
//
// Answers one question with real bar data: "if a trade hits SL, then price comes
// back to the zone and we RE-ENTER, does the strategy do better or worse?"
//
// It replays every fibo_snapshots frame against the same BAR feed fibo-eval uses,
// but compares two rule sets side by side, under the SAME (honest) horizon:
//   BASE  — one entry, cut at SL (tie = loss). Same as production fibo-eval.
//   RE    — after an SL loss, re-arm; when price returns to the entry level and
//           re-touches the zone, take another entry (fresh TP1/SL from that level).
//           Up to `reentry` extra entries. Each entry counts as its own trade.
//
// Both run inside the frame's Bangkok trading DAY by default (expire=day) so we do
// not credit look-ahead entries days later. Pass expire=none to match the current
// production evaluator (no frame expiry) for reference.
//
// GET /api/fibo-sim                 → compare, default reentry=1, expire=day, days=60
// GET /api/fibo-sim?reentry=2       → allow up to 2 re-entries
// GET /api/fibo-sim?expire=none     → no frame expiry (production-parity horizon)
// GET /api/fibo-sim?days=90         → frame lookback window
//
// Nothing is upserted. This endpoint is safe to hit repeatedly.

const { createClient } = require('@supabase/supabase-js');

const POINT = 0.01;
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

const isGold = (s) => typeof s === 'string' && s.toUpperCase().replace(/[^A-Z]/g, '').startsWith(SYM);
const bkkDay = (ms) => Math.floor((ms + 7 * 3600e3) / 86400e3);

function parseGmt(s) {
  const m = typeof s === 'string' && s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

async function loadBars(sinceISO) {
  const page = 1000;
  let from = 0, out = [];
  for (;;) {
    const { data, error } = await db()
      .from('trade_events')
      .select('symbol, payload, created_at')
      .eq('event', 'BAR')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: true })
      .range(from, from + page - 1);
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

// Same level recovery as fibo-eval.sideLevels (point offsets → both modes).
function sideLevels(f, side, mode) {
  const isTest = mode === 'test';
  const focus = side === 'S' ? +f.s_focus : +f.b_focus;
  const test  = side === 'S' ? +f.s_test  : +f.b_test;
  const lvl = isTest ? test : focus;
  const raw = f.raw || {};
  let tp1, sl, tp1pts, slpts;
  if (raw.tp1_pts != null && raw.sl_pts != null) {
    tp1pts = Number(raw.tp1_pts); slpts = Number(raw.sl_pts);
    const t = tp1pts * POINT, s = slpts * POINT;
    if (side === 'S') { tp1 = lvl - t; sl = lvl + s; } else { tp1 = lvl + t; sl = lvl - s; }
  } else {
    const activeLvl = (f.entry_mode || '').indexOf('Test') >= 0 ? test : focus;
    if (side === 'S') {
      const tp1d = activeLvl - +f.s_tp1, sld = +f.s_sl - activeLvl;
      tp1 = lvl - tp1d; sl = lvl + sld; tp1pts = Math.round(tp1d / POINT); slpts = Math.round(sld / POINT);
    } else {
      const tp1d = +f.b_tp1 - activeLvl, sld = activeLvl - +f.b_sl;
      tp1 = lvl + tp1d; sl = lvl - sld; tp1pts = Math.round(tp1d / POINT); slpts = Math.round(sld / POINT);
    }
  }
  return { isTest, lvl, tp1, sl, tp1pts, slpts, Z: (Number(f.zone_pts) || 100) * POINT };
}

// enter test: close reached the zone edge and still short of SL. focus: wick touch.
function enterHit(side, isTest, b, zLo, zHi, sl) {
  return isTest
    ? (side === 'S' ? (b.c >= zLo && b.c < sl) : (b.c <= zHi && b.c > sl))
    : (side === 'S' ? b.h >= zLo : b.l <= zHi);
}

// Replay one (frame, side, mode). Returns array of trades: {result, pnl_pts, leg}.
// leg 0 = first entry, 1.. = re-entries. Cut at SL, tie = loss (SL checked first).
function replay(frame, side, mode, bars, maxReentry, expireDay) {
  const { isTest, lvl, tp1, sl, tp1pts, slpts, Z } = sideLevels(frame, side, mode);
  const zLo = lvl - Z, zHi = lvl + Z;
  const frameT = Number(frame.bar_time);
  const frameDay = bkkDay(frameT);
  const trades = [];

  let leg = 0;               // 0 = first, then re-entries
  let inTrade = false;
  let armed = true;          // may take an entry now (first leg armed from the start)
  let needReturn = false;    // after a loss: wait for price to return to `lvl` before re-arm

  for (const b of bars) {
    if (b.t <= frameT) continue;
    if (expireDay && bkkDay(b.t) !== frameDay) break;  // frame lives one Bangkok day

    if (!inTrade) {
      // re-arm gate: after an SL, price must trade back to the entry level first
      if (needReturn) {
        const back = side === 'S' ? b.l <= lvl : b.h >= lvl;
        if (back) { needReturn = false; armed = true; }
      }
      if (armed && enterHit(side, isTest, b, zLo, zHi, sl)) {
        inTrade = true; armed = false;
      }
      // a bar can both re-arm and enter; falls through to resolution next bar
      if (!inTrade) continue;
    }

    // resolution — check SL first (tie = loss), then TP
    const hitSl = side === 'S' ? b.h >= sl  : b.l <= sl;
    const hitTp = side === 'S' ? b.l <= tp1 : b.h >= tp1;
    if (hitSl) {
      trades.push({ result: 'loss', pnl_pts: -slpts, leg });
      inTrade = false;
      if (leg < maxReentry) { leg++; needReturn = true; armed = false; }
      else break;
    } else if (hitTp) {
      trades.push({ result: 'win', pnl_pts: tp1pts, leg });
      inTrade = false;
      break;   // target reached → done (re-entry is only for recovering an SL)
    }
  }
  return trades;
}

function tallyInit() { return { trades: 0, wins: 0, losses: 0, net_pts: 0, reentries: 0, reentry_wins: 0 }; }
function tallyAdd(t, trades) {
  for (const tr of trades) {
    t.trades++; t.net_pts += tr.pnl_pts;
    if (tr.result === 'win') t.wins++; else t.losses++;
    if (tr.leg > 0) { t.reentries++; if (tr.result === 'win') t.reentry_wins++; }
  }
}
function tallyFinal(t) {
  const dec = t.wins + t.losses;
  return {
    ...t,
    winrate_pct: dec ? Math.round(1000 * t.wins / dec) / 10 : null,
    exp_pts: dec ? Math.round(10 * t.net_pts / dec) / 10 : null,
  };
}

module.exports = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 120);
    const maxRe = Math.min(Math.max(parseInt(req.query.reentry, 10) || 1, 0), 5);
    const expireDay = String(req.query.expire || 'day') !== 'none';
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    const snapRes = await db().from('fibo_snapshots').select('*')
      .gte('created_at', sinceISO).order('created_at', { ascending: false });
    if (snapRes.error) throw new Error('snap: ' + snapRes.error.message);
    const frames = snapRes.data || [];
    const bars = await loadBars(sinceISO);
    if (!bars.length) return res.status(200).json({ ok: false, verdict: 'NO_USABLE_BARS' });

    // per side/mode buckets, for BASE (maxRe=0, same horizon) and RE (maxRe=N).
    const mk = () => ({ base: tallyInit(), re: tallyInit() });
    const cells = {}; const key = (s, m) => s + '/' + m;
    for (const s of ['S', 'B']) for (const m of ['focus', 'test']) cells[key(s, m)] = mk();
    const totBase = tallyInit(), totRe = tallyInit();

    for (const f of frames) for (const side of ['S', 'B']) for (const mode of ['focus', 'test']) {
      const base = replay(f, side, mode, bars, 0, expireDay);
      const re   = replay(f, side, mode, bars, maxRe, expireDay);
      tallyAdd(cells[key(side, mode)].base, base); tallyAdd(totBase, base);
      tallyAdd(cells[key(side, mode)].re, re);     tallyAdd(totRe, re);
    }

    const out = {};
    for (const k in cells) out[k] = { base: tallyFinal(cells[k].base), re: tallyFinal(cells[k].re) };
    return res.status(200).json({
      ok: true, mode: 'sim-readonly',
      params: { days, reentry: maxRe, expire: expireDay ? 'day' : 'none' },
      frames: frames.length, bars: bars.length,
      per_side_mode: out,
      total: { base: tallyFinal(totBase), re: tallyFinal(totRe) },
      note: 'READ-ONLY: nothing written. BASE = one entry cut at SL. RE = re-enter after SL up to `reentry` times, same horizon.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

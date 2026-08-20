// Vercel serverless — Fibo # outcome evaluator (data-driven, no Pine change).
//
// Every fibo_snapshots row (#) already stores all levels for both sides. The
// RainbowPilot EA already streams one BAR event per closed bar into trade_events
// (payload.ctx.bar1 = [open,high,low,close], payload.t_gmt = its GMT close time).
// So we REPLAY each frame's entry/TP1/SL rules against those bars — for ALL
// frames, including ones a newer frame superseded — with no change to Pine or EA.
//
// GET /api/fibo-eval               → diagnostics only (default, read-only)
// GET /api/fibo-eval?write=1       → replay + upsert fibo_outcomes, return summary
// GET /api/fibo-eval?days=30       → lookback window for frames (default 30)
//
// Entry/exit logic mirrors the Pine group ⑦ state machine:
//   entry level = Focus 2.0 or Test 1.272 (per frame.entry_mode); zone = ±zone_pts*0.01
//   S (sell):  ENTER  Test = close in zone / Focus = high >= zone_low
//              WIN low<=tp1 · LOSS high>=sl   MFE = lowest low since entry
//   B (buy):   ENTER  Test = close in zone / Focus = low  <= zone_high
//              WIN high>=tp1 · LOSS low<=sl   MFE = highest high since entry
//   Tie (one bar hits both TP1 and SL) = LOSS (conservative; OHLC can't order them).

const { createClient } = require('@supabase/supabase-js');
const { runEval: runReadEval, runAttribution } = require('./_kp_eval');   // co-pilot read evaluator + attribution (folded in to stay ≤12 fns)

const POINT = 0.01;                 // XAUUSD 1 point in price
const SYM   = 'XAUUSD';             // frame symbol; feed is 'XAUUSDr' (broker suffix)

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

// Bangkok (UTC+7) civil-day index. A frame's tradeable life is its own trading
// day: entries days later were look-ahead (a dead swing price wandered back to),
// so we cap entry+resolution to the frame's Bangkok day. Un-entered past frames
// become 'expired' (won't be traded), not perpetual 'pending'.
const bkkDay = (ms) => Math.floor((ms + 7 * 3600e3) / 86400e3);

// "2026.08.10 02:05:00" (GMT) → ms epoch
function parseGmt(s) {
  const m = typeof s === 'string' && s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Pull ALL matching BAR bars since `sinceMs` (Supabase caps each page at 1000).
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

// Deepest TP reached by MFE. tps = [tp1, tp2, tp3, tp4] in reach order.
function bestTp(side, mfe, tps) {
  let best = 0;
  for (let i = 0; i < tps.length; i++) {
    const hit = side === 'S' ? mfe <= tps[i] : mfe >= tps[i];
    if (hit) best = i + 1;
  }
  return best;
}

// Levels for a (frame, side, mode). TP1/SL are fixed point offsets from the entry
// level (Pine: SL = lvl±slPts, TP1 = lvl∓tp1pts). The snapshot only stored TP1/SL
// for the ACTIVE mode, so we recover those point distances from the active pair
// and re-apply them to the requested mode's level — matching whatever the user's
// tp1pts/slPts inputs were, for both Focus and Test.
// TP ladder (0.382 dropped — it clustered with Mid): TP1(fixed) · TP2 = near range
// boundary (S=High/B=Low) · TP3 = Mid 0.5 · TP4 = far boundary (S=Low/B=High).
function sideLevels(f, side, mode) {
  const isTest = mode === 'test';
  const focus = side === 'S' ? +f.s_focus : +f.b_focus;
  const test  = side === 'S' ? +f.s_test  : +f.b_test;
  const lvl = isTest ? test : focus;
  // Preferred: explicit point offsets sent by the (mode-less) Pine → tp1_pts/sl_pts.
  const raw = f.raw || {};
  let tp1, sl;
  if (raw.tp1_pts != null && raw.sl_pts != null) {
    const t = Number(raw.tp1_pts) * POINT, s = Number(raw.sl_pts) * POINT;
    if (side === 'S') { tp1 = lvl - t; sl = lvl + s; } else { tp1 = lvl + t; sl = lvl - s; }
  } else {
    // Legacy frames: recover the point distances from the active mode's stored TP1/SL.
    const activeLvl = (f.entry_mode || '').indexOf('Test') >= 0 ? test : focus;
    if (side === 'S') {
      const tp1d = activeLvl - +f.s_tp1, sld = +f.s_sl - activeLvl;
      tp1 = lvl - tp1d; sl = lvl + sld;
    } else {
      const tp1d = +f.b_tp1 - activeLvl, sld = activeLvl - +f.b_sl;
      tp1 = lvl + tp1d; sl = lvl - sld;
    }
  }
  return {
    isTest, lvl, tp1, sl,
    mid:  +f.mid,
    near: side === 'S' ? +f.fh : +f.fl,   // TP2 = range boundary price crosses first
    far:  side === 'S' ? +f.fl : +f.fh,   // TP4 = far boundary (full reversion)
    Z: (Number(f.zone_pts) || 100) * POINT,
  };
}

// Replay one (frame, side, mode) over the bar stream. Returns an outcome row.
function replaySide(frame, side, mode, bars) {
  const { isTest, lvl, tp1, sl, mid, near, far, Z } = sideLevels(frame, side, mode);
  const zLo = lvl - Z, zHi = lvl + Z;
  const frameT = Number(frame.bar_time);
  const frameDay = bkkDay(frameT);   // frame lives one Bangkok trading day

  // Three dimensions, deliberately on different windows:
  //   result  — WIN/LOSS = did TP1 come before SL (first touch; tie = LOSS).
  //   MFE     — favorable extent, tracked ENTER→SL-close (NOT stopped at TP1), so
  //             a winner shows the deepest TP it would have reached if held → best_tp.
  //   MAE     — adverse heat, tracked only ENTER→first resolution, i.e. how far it
  //             went against the trade BEFORE it won/lost (post-win giveback excluded,
  //             else MAE would just restate the SL distance for every trade).
  let status = 'pending', entered_at = null, resolved_at = null, result = null;
  let mfe = null, mae = null, seen = 0;

  for (const b of bars) {
    if (b.t <= frameT) continue;   // only bars after the frame was drawn
    if (bkkDay(b.t) !== frameDay) break;   // frame expired at end of its Bangkok day
    seen++;
    if (status === 'pending') {
      // Test now enters once close REACHES the zone edge and is still short of SL
      // (was: close strictly inside the ±Z band). S: [zLo, sl) · B: (sl, zHi].
      const enter = isTest
        ? (side === 'S' ? (b.c >= zLo && b.c < sl) : (b.c <= zHi && b.c > sl))
        : (side === 'S' ? b.h >= zLo : b.l <= zHi);
      if (enter) {
        status = 'entered'; entered_at = b.t;
        mfe = side === 'S' ? b.l : b.h;   // favorable extreme
        mae = side === 'S' ? b.h : b.l;   // adverse extreme
      }
    }
    if (status === 'entered' || status === 'win') {
      mfe = side === 'S' ? Math.min(mfe, b.l) : Math.max(mfe, b.h);  // favorable: track past TP1
      const hitTp = side === 'S' ? b.l <= tp1 : b.h >= tp1;
      const hitSl = side === 'S' ? b.h >= sl  : b.l <= sl;
      if (result === null) {
        // MAE = heat taken BEFORE the trade first resolves (not the post-win giveback).
        mae = side === 'S' ? Math.max(mae, b.h) : Math.min(mae, b.l);
        if (hitSl) { status = 'loss'; result = 'loss'; resolved_at = b.t; break; }  // tie → LOSS
        if (hitTp) { status = 'win';  result = 'win';  resolved_at = b.t; }          // keep tracking MFE
      } else if (hitSl) {
        break;   // already won; the original SL would now close it → stop the extent window
      }
    }
  }

  // Past frame that never reached a verdict → expired: either its zone was never
  // touched (pending), OR it entered but the Bangkok day closed before TP/SL hit
  // (entered) — a stale open that can never resolve, so it must not linger as
  // "เปิดอยู่". Only TODAY's frames stay live (pending = waiting, entered = open).
  if ((status === 'pending' || status === 'entered') && frameDay < bkkDay(Date.now()))
    status = 'expired';

  const best_tp = mfe == null ? 0 : bestTp(side, mfe, [tp1, near, mid, far]);

  // ── "Endure past SL" analysis (A) ──────────────────────────────────────────
  // Ignore the original SL and ask: how far against did price go before TP1 was
  // finally reached, and did a LOSS actually recover? Answers "would a wider SL
  // have won, and how wide?" purely from data — no guessing at 550/604/…
  //   heat_pts     = worst adverse distance from the entry level, in POINTS, from
  //                  entry until TP1 (uncapped by SL) = the minimum SL width that
  //                  survives to the win. (Same unit as the SL input, so an SL
  //                  sweep is a direct comparison.)
  //   sl_pts       = the original SL width from entry, in points (for reference).
  //   tp1_after_sl = a LOSS whose price later reached TP1 within the day.
  //   recover_bars = bars from entry to that eventual TP1 (the hold you'd endure).
  // Windowed to the entry's Bangkok trading day (the frame's natural intraday life).
  let heat_pts = null, tp1_after_sl = false, recover_bars = null;
  const sl_pts = Math.round(Math.abs(sl - lvl) / POINT);
  if (entered_at != null) {
    const eDay = bkkDay(entered_at);
    let worst = null, firstTp1 = null, nBars = 0;
    for (const b of bars) {
      if (b.t < entered_at) continue;
      if (b.t > entered_at && bkkDay(b.t) !== eDay) break;   // same-day window only
      worst = worst == null
        ? (side === 'S' ? b.h : b.l)
        : (side === 'S' ? Math.max(worst, b.h) : Math.min(worst, b.l));
      const hitTp = side === 'S' ? b.l <= tp1 : b.h >= tp1;
      if (hitTp) { firstTp1 = b.t; break; }   // reached TP1 with no SL in the way
      nBars++;
    }
    // adverse distance from the entry level, in points
    if (worst != null) heat_pts = Math.round((side === 'S' ? worst - lvl : lvl - worst) / POINT);
    if (result === 'loss' && firstTp1 != null && resolved_at != null && firstTp1 >= resolved_at) {
      tp1_after_sl = true;
      recover_bars = nBars;
    }
  }

  return {
    frame_id: frameT, side, mode, status, entered_at, resolved_at, result,
    mfe, mae, best_tp, bars_seen: seen,
    heat_pts, sl_pts, tp1_after_sl, recover_bars,
    updated_at: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  try {
    // Co-pilot read evaluator shares this route (?target=reads) so it isn't a
    // separate serverless function (Hobby-plan 12-fn cap). Same BAR-replay family.
    if (String(req.query.target || '') === 'reads') {
      const rdays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
      const fill = ['near', 'mid', 'far'].includes(req.query.fill) ? req.query.fill : null;
      const wantWrite = req.query.write === '1';
      // The dashboard calls this unauthenticated on every tab render, so it cannot
      // require a key — but that also means anyone with the URL can make it recompute.
      // Throttle the WRITE path on how recently outcomes were refreshed: cheap, and
      // it protects the free-tier quota without breaking the browser caller.
      if (wantWrite) {
        const { createClient } = require('@supabase/supabase-js');
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
                                { auth: { persistSession: false } });
        const { data } = await db.from('kp_read_outcomes')
          .select('updated_at').order('updated_at', { ascending: false }).limit(1);
        const last = data && data[0] && Date.parse(data[0].updated_at);
        const waitSec = 30;
        if (last && Date.now() - last < waitSec * 1000) {
          return res.status(200).json({ ok: true, mode: 'throttled',
            retry_in_sec: Math.ceil((waitSec * 1000 - (Date.now() - last)) / 1000) });
        }
      }
      const { status, body } = await runReadEval({ days: rdays, write: wantWrite, fill });
      return res.status(status).json(body);
    }
    // one-off maintenance: recover structured plans from past reads' message text
    // (lazy require — keeps the Anthropic SDK off the hot path of the Fibo eval)
    if (String(req.query.target || '') === 'backfill_plans') {
      const { runPlanBackfill } = require('./_kp_lib');
      const rdays = Math.min(Math.max(parseInt(req.query.days, 10) || 120, 1), 400);
      const { status, body } = await runPlanBackfill({ days: rdays, write: req.query.write === '1',
                                                       force: req.query.force === '1' });
      return res.status(status).json(body);
    }
    if (String(req.query.target || '') === 'attribution') {
      const rdays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
      // basis=plan grades the advised pending order; default 'lean' is the
      // directional ±ATR measure. Kept separate — they are different questions.
      const basis = req.query.basis === 'plan' ? 'plan' : 'lean';
      const { status, body } = await runAttribution({ days: rdays, basis });
      return res.status(status).json(body);
    }

    // An unknown ?target must NOT fall through to the Fibo frame evaluator: a typo
    // then returns a healthy-looking 200 from a completely different report (this
    // masked an un-deployed route once already).
    const tgt = String(req.query.target || '');
    if (tgt && !['reads', 'attribution', 'backfill_plans'].includes(tgt)) {
      return res.status(400).json({ ok: false, error: 'unknown target: ' + tgt,
        valid: ['(none = fibo frames)', 'reads', 'attribution', 'backfill_plans'] });
    }

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
    const write = req.query.write === '1';
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    const snapRes = await db()
      .from('fibo_snapshots').select('*')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: false });
    if (snapRes.error) throw new Error('snap: ' + snapRes.error.message);
    const frames = snapRes.data || [];

    const bars = await loadBars(sinceISO);

    // ── diagnostics (always) ──
    if (!write) {
      const bySym = {};
      for (const b of bars) bySym.XAUUSD = (bySym.XAUUSD || 0) + 1; // already gold-filtered
      return res.status(200).json({
        ok: true, mode: 'dry', window_days: days,
        frames: frames.length,
        bar_feed: { usable_gold_bars: bars.length, oldest: bars[0]?.t, newest: bars.at(-1)?.t },
        verdict: bars.length === 0 ? 'NO_USABLE_BARS'
          : frames.length === 0 ? 'NO_FRAMES' : 'OK_add_write=1_to_derive',
      });
    }

    // ── writer ── both sides × both entry modes for every frame
    const rows = [];
    for (const f of frames)
      for (const side of ['S', 'B'])
        for (const mode of ['focus', 'test'])
          rows.push(replaySide(f, side, mode, bars));

    const up = await db().from('fibo_outcomes').upsert(rows, { onConflict: 'frame_id,side,mode' });
    if (up.error) {
      const missing = up.error.code === '42P01';
      return res.status(missing ? 424 : 500).json({
        ok: false,
        error: missing ? 'fibo_outcomes table missing — run supabase_schema_fibo_outcomes.sql' : up.error.message,
      });
    }

    const tally = { focus: {}, test: {} };
    for (const r of rows) tally[r.mode][r.status] = (tally[r.mode][r.status] || 0) + 1;
    return res.status(200).json({
      ok: true, mode: 'write', window_days: days,
      frames: frames.length, rows_upserted: rows.length, bars_used: bars.length, tally,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

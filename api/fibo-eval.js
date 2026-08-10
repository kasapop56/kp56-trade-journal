// Vercel serverless — Fibo # outcome evaluator (data-driven, no Pine change).
//
// Idea: every fibo_snapshots row (#) already stores all levels for both sides.
// The RainbowPilot EA already streams one BAR event per closed bar into
// trade_events (payload.ctx.bar1 = [open,high,low,close]). So we can REPLAY each
// frame's entry/TP1/SL rules against those bars — for ALL frames, including ones
// a newer frame superseded — with no change to the Pine indicator or the EA.
//
// This first version is READ-ONLY diagnostics (?dry=1, the default): it reports
// whether the BAR price feed actually exists and overlaps the recorded frames,
// so we can confirm the source before wiring the writer. Set ?dry=0 later to
// derive + upsert fibo_events (not implemented yet — guarded off).
//
// GET /api/fibo-eval            → diagnostics JSON
// GET /api/fibo-eval?days=14    → widen the lookback window (default 7)

const { createClient } = require('@supabase/supabase-js');

let _db;
function db() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

module.exports = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString();

    // 1) Frames recorded in the window.
    const snapRes = await db()
      .from('fibo_snapshots')
      .select('bar_time, seq, symbol, created_at')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: false });
    if (snapRes.error) throw new Error('snap: ' + snapRes.error.message);
    const frames = snapRes.data || [];

    // 2) BAR price events in the window (the candidate price feed).
    const barRes = await db()
      .from('trade_events')
      .select('symbol, t_srv, created_at, payload')
      .eq('event', 'BAR')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (barRes.error) throw new Error('bar: ' + barRes.error.message);
    const bars = barRes.data || [];

    // Summarise the BAR feed.
    const bySymbol = {};
    let withBar1 = 0, minC = null, maxC = null;
    for (const b of bars) {
      const s = b.symbol || '?';
      bySymbol[s] = (bySymbol[s] || 0) + 1;
      const bar1 = b.payload && b.payload.ctx && b.payload.ctx.bar1;
      if (Array.isArray(bar1) && bar1.length === 4) withBar1++;
      if (!minC || b.created_at < minC) minC = b.created_at;
      if (!maxC || b.created_at > maxC) maxC = b.created_at;
    }
    const sample = bars.slice(0, 3).map(b => ({
      symbol: b.symbol,
      t_srv: b.t_srv,
      t_gmt: b.payload && b.payload.t_gmt,
      bar1: b.payload && b.payload.ctx && b.payload.ctx.bar1,
    }));

    // Do the recorded frames fall inside the BAR feed's coverage?
    const barMinTime = bars.length ? Math.min(...bars.map(b => Date.parse(b.created_at))) : null;
    const framesCovered = barMinTime
      ? frames.filter(f => Date.parse(f.created_at) >= barMinTime).length
      : 0;

    return res.status(200).json({
      ok: true,
      window_days: days,
      frames: { count: frames.length, symbols: [...new Set(frames.map(f => f.symbol))], newest: frames[0]?.created_at || null },
      bar_feed: {
        count: bars.length,
        with_bar1_ohlc: withBar1,
        by_symbol: bySymbol,
        oldest: minC,
        newest: maxC,
        sample,
      },
      overlap: {
        frames_within_bar_coverage: framesCovered,
        verdict: bars.length === 0
          ? 'NO_BAR_FEED — RainbowPilot not streaming BAR events (EA off, or InpLogBars off, or not on an XAUUSD chart)'
          : withBar1 === 0
            ? 'BAR_FEED_NO_OHLC — bars exist but payload.ctx.bar1 missing'
            : framesCovered === 0
              ? 'FEED_EXISTS_BUT_NO_FRAME_OVERLAP — bars started after the frames in this window'
              : 'OK — usable price feed overlaps recorded frames; evaluator can replay',
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

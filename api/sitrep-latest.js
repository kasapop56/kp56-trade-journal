// Vercel read endpoint — returns the latest SITREP + recent closed trades
// for the scheduled Anthropic analysis agent.
//
// Endpoint:  GET /api/sitrep-latest
// Headers:   X-Agent-Key: <AGENT_READ_KEY>
// Query:
//   max_age_min  (optional, default 90)   — reject if newest sitrep older than this
//   trades_hours (optional, default 24)   — window for recent closed trades
//
// Response:
//   {
//     ok: true,
//     sitrep: { id, created_at, symbol, session, price, bias_m5, bias_m15,
//               ob_summary, zones_count, htf_conf, h1_count,
//               vp_position, poc, vah, val, ppoc, pvah, pval,
//               supply_zones, demand_zones, raw_text, image_url },
//     recent_trades: [ ...mt5_trades rows (most recent first)... ],
//     server_time_utc: "2026-04-27T14:00:00.000Z"
//   }
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   AGENT_READ_KEY            — separate from SITREP_SHARED_SECRET; used by agent

const { createClient } = require('@supabase/supabase-js');

let _supabase;
function getClient() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.AGENT_READ_KEY;
  if (!expected) return bad(res, 500, 'server_missing_agent_key');
  if (req.headers['x-agent-key'] !== expected) return bad(res, 401, 'bad_agent_key');

  const maxAgeMin = Math.max(1, parseInt(req.query.max_age_min, 10) || 90);
  const tradesHours = Math.max(1, parseInt(req.query.trades_hours, 10) || 24);

  const db = getClient();

  // Latest SITREP
  const { data: sitrep, error: sitErr } = await db
    .from('market_sitreps')
    .select('id, created_at, symbol, session, price, bias_m5, bias_m15, ob_summary, zones_count, htf_conf, h1_count, vp_position, poc, vah, val, ppoc, pvah, pval, supply_zones, demand_zones, raw_text, image_url')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sitErr) return bad(res, 500, 'db_error_sitrep: ' + sitErr.message);
  if (!sitrep) return bad(res, 404, 'no_sitrep_yet');

  const ageMs = Date.now() - new Date(sitrep.created_at).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin > maxAgeMin) {
    return res.status(409).json({
      ok: false,
      error: 'sitrep_stale',
      newest_age_min: Math.round(ageMin),
      max_age_min: maxAgeMin,
      newest_created_at: sitrep.created_at,
    });
  }

  // Recent closed trades
  const sinceIso = new Date(Date.now() - tradesHours * 3600 * 1000).toISOString();
  const { data: trades, error: trErr } = await db
    .from('mt5_trades')
    .select('deal_ticket, position_id, symbol, type, volume, open_time, close_time, open_price, close_price, sl, tp, profit, swap, commission, magic, comment, bias_m15, bias_m5, ob_status, mario_session, mario_decision')
    .gte('close_time', sinceIso)
    .order('close_time', { ascending: false })
    .limit(50);
  if (trErr) return bad(res, 500, 'db_error_trades: ' + trErr.message);

  return res.status(200).json({
    ok: true,
    sitrep,
    sitrep_age_min: Math.round(ageMin * 10) / 10,
    recent_trades: trades || [],
    trades_window_hours: tradesHours,
    server_time_utc: new Date().toISOString(),
  });
};

// Vercel serverless webhook — receives manual-trade study events from the
// RainbowPilot EA (v1.04+ data logger) and stores them raw in Supabase.
//
// Endpoint:  POST /api/context
// Headers:   Content-Type: application/json
//            X-Journal-Secret: <JOURNAL_SHARED_SECRET>   (same secret as /api/ingest)
//
// Body: ONE event object, or an ARRAY of events (the EA's offline-retry
// flush posts a batch). Each event is stored as-is in trade_events.payload
// (jsonb) — schema-on-read by design: the EA can add fields at any time
// without a migration here. Only routing fields are lifted into columns.
//
// Event shapes the EA currently sends (payload.ev):
//   OPEN   — manual position appeared (kind FIRST/ADD/HEDGE/MIXED, origin)
//   MODIFY — SL/TP changed (src: user / ea_init / ea_be / ea_trail / btn_groupbe)
//   CLOSE  — position gone (reason, pl, MFE/MAE points, holding time)
//   BAR    — one line per closed bar (spread/ATR/zone — not recoverable later)
// All events carry a ctx block: EMAs 20..50 + 150, stack top/bot, zone,
// OUT/forecast levels, spread, ATR, equity, open-position summary.

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

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const MAX_BATCH = 500;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.JOURNAL_SHARED_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');
  if (req.headers['x-journal-secret'] !== expected) return bad(res, 401, 'bad_secret');

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0) return res.status(200).json({ ok: true, inserted: 0 });
  if (items.length > MAX_BATCH) return bad(res, 400, 'batch_too_large: ' + items.length);

  const rows = [];
  for (const p of items) {
    if (!p || typeof p !== 'object') return bad(res, 400, 'bad_item');
    if (p.acc === undefined || !p.ev) return bad(res, 400, 'missing_field: acc/ev');
    rows.push({
      account_login: p.acc,
      symbol:        p.sym ?? null,
      ticket:        p.ticket ?? null,
      event:         p.ev,
      t_srv:         p.t_srv ?? null,
      payload:       p,
    });
  }

  try {
    const { error } = await getClient().from('trade_events').insert(rows);
    if (error) return bad(res, 500, 'db_error: ' + error.message);
    return res.status(200).json({ ok: true, inserted: rows.length });
  } catch (e) {
    return bad(res, 500, 'unhandled: ' + e.message);
  }
};

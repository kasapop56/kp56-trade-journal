// api/price.js — live price heartbeat sink (Option B).
//
// POST /api/price   — from the JournalSync EA every ~30s.
// Headers: Content-Type: application/json · X-Journal-Secret: <JOURNAL_SHARED_SECRET>
// Body: { symbol, price, bid?, ask?, spread? }
//
// Upserts one row per symbol into kp_price. Deliberately tiny + cheap (no Claude,
// no heavy reads) so a frequent heartbeat costs almost nothing.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JOURNAL_SHARED_SECRET.

const { createClient } = require('@supabase/supabase-js');

let _db;
function getClient() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.JOURNAL_SHARED_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');
  if (req.headers['x-journal-secret'] !== expected) return bad(res, 401, 'bad_secret');

  let p;
  try { p = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  const symbol = (p.symbol || '').toString().trim();
  const price = num(p.price);
  if (!symbol) return bad(res, 400, 'missing_field: symbol');
  if (price == null) return bad(res, 400, 'missing_field: price');

  const row = {
    symbol, price,
    bid: num(p.bid), ask: num(p.ask), spread: num(p.spread),
    ts: new Date().toISOString(),
  };

  const { error } = await getClient().from('kp_price').upsert(row, { onConflict: 'symbol' });
  if (error) return bad(res, 500, 'db_error: ' + error.message);

  return res.status(200).json({ ok: true });
};

// api/kp-atr.js — receives the "Daily ATR Zones" indicator's once-a-day alert.
//
// TradingView webhook (can't set headers → secret is in the body):
//   POST /api/kp-atr
//   body (the indicator's alert JSON):
//     {
//       "type":     "daily_atr",
//       "secret":   "<FIBO_WEBHOOK_SECRET>",   // reused; or KP_ATR_SECRET
//       "symbol":   "XAUUSDr",
//       "atr":      41.23,                      // daily ATR the ladder is drawn from
//       "day_open": 4318.55,
//       "atr_len":  10,
//       "method":   "RMA",
//       "day_high": 4340.1,   // optional
//       "day_low":  4302.0,   // optional
//       "ts":       1730000000000               // optional (ms); defaults to now()
//     }
//
// Upserts one row per (symbol, Bangkok date) into kp_atr. The read evaluator
// (api/kp-eval.js) reads it so its price-behavior classification uses the exact
// ladder the trader sees on the chart.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FIBO_WEBHOOK_SECRET (or KP_ATR_SECRET).

const { createClient } = require('@supabase/supabase-js');

let _db;
function getDb() {
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
  // TradingView sometimes wraps the JSON in whitespace / stray chars
  raw = String(raw || '').trim();
  return raw ? JSON.parse(raw) : {};
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Bangkok (UTC+7) civil date "YYYY-MM-DD" for a ms epoch.
function bkkDateStr(ms) {
  const t = new Date(ms + 7 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.KP_ATR_SECRET || process.env.FIBO_WEBHOOK_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');

  let body;
  try { body = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  if (body.secret !== expected) return bad(res, 401, 'bad_secret');
  if (body.type && body.type !== 'daily_atr') return bad(res, 400, 'unexpected_type: ' + body.type);

  const atr = num(body.atr), dayOpen = num(body.day_open);
  if (atr == null || dayOpen == null) return bad(res, 400, 'missing_field: atr / day_open');

  const tsMs = num(body.ts) != null ? num(body.ts) : Date.now();
  const atrDate = bkkDateStr(tsMs);
  const symbol = body.symbol || 'XAUUSD';

  // ± ladder bands, so the dashboard could draw them without recomputing.
  const mults = [0.25, 0.5, 0.75, 1.0, 1.25, -0.25, -0.5, -0.75, -1.0, -1.25];
  const bands = {};
  for (const m of mults) bands[String(m)] = Math.round((dayOpen + atr * m) * 100) / 100;

  const row = {
    symbol, atr_date: atrDate, day_open: dayOpen, atr,
    atr_len: num(body.atr_len), method: body.method || null,
    day_high: num(body.day_high), day_low: num(body.day_low),
    bands, raw: body, ts: new Date(tsMs).toISOString(),
    updated_at: new Date().toISOString(),
  };

  const db = getDb();
  const { data, error } = await db.from('kp_atr')
    .upsert(row, { onConflict: 'symbol,atr_date' })
    .select('id, atr_date').single();
  if (error) {
    const missing = error.code === '42P01';
    return bad(res, missing ? 424 : 500,
      missing ? 'kp_atr table missing — run supabase_schema_kp_atr.sql' : error.message);
  }

  return res.status(200).json({ ok: true, id: data.id, atr_date: data.atr_date, atr, day_open: dayOpen });
};

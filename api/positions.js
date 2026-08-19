// api/positions.js — live open-positions snapshot sink (ground-truth mirror).
//
// POST /api/positions   — from the JournalSync EA every ~10s.
// Headers: Content-Type: application/json · X-Journal-Secret: <JOURNAL_SHARED_SECRET>
// Body: {
//   acc: <account_login>,               // required
//   symbol?: "XAUUSDr",
//   positions: [ { ticket, dir:"buy"|"sell", lots, entry, sl, tp, magic, profit, swap } ]
// }
//
// Upserts ONE row per account into kp_positions (onConflict account_login), so the
// table always holds the current live position set — self-healing vs the fragile
// trade_events replay. Deliberately tiny + cheap (no Claude, no heavy reads).
//
// Aggregates (count / net_lots / buy_lots / sell_lots / float_usd) are computed
// here from the array so the dashboard + co-pilot get them for free and the EA
// stays dumb.
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
function round(n, d = 2) {
  if (n == null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const MAX_POS = 200;   // sanity cap; a hedging account never holds this many

// Normalize one EA-sent position into a clean stored shape. sl/tp of 0 in MT5
// means "not set" → null so the co-pilot flags a missing stop.
function normPos(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.ticket === undefined || p.ticket === null) return null;
  const rawDir = String(p.dir ?? '').toLowerCase();
  const dir = rawDir === 'sell' ? 'sell' : rawDir === 'buy' ? 'buy'
            : (num(p.type) === 1 ? 'sell' : 'buy');   // MT5 POSITION_TYPE 0=buy 1=sell
  const sl = num(p.sl), tp = num(p.tp);
  return {
    ticket: p.ticket,
    dir,
    lots:  num(p.lots),
    entry: num(p.entry),
    sl: sl && sl > 0 ? sl : null,
    tp: tp && tp > 0 ? tp : null,
    magic: p.magic ?? null,
    profit: num(p.profit),
    swap: num(p.swap),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.JOURNAL_SHARED_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');
  if (req.headers['x-journal-secret'] !== expected) return bad(res, 401, 'bad_secret');

  let p;
  try { p = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  const acc = num(p.acc);
  if (acc == null) return bad(res, 400, 'missing_field: acc');

  const rawList = Array.isArray(p.positions) ? p.positions : [];
  if (rawList.length > MAX_POS) return bad(res, 400, 'too_many_positions: ' + rawList.length);
  const positions = rawList.map(normPos).filter(Boolean);

  // aggregates
  let netLots = 0, buyLots = 0, sellLots = 0, floatUsd = 0, haveProfit = true;
  for (const q of positions) {
    const l = num(q.lots) || 0;
    if (q.dir === 'buy') { buyLots += l; netLots += l; } else { sellLots += l; netLots -= l; }
    if (q.profit == null) haveProfit = false; else floatUsd += q.profit;
  }

  const row = {
    account_login: acc,
    ts: new Date().toISOString(),
    symbol: (p.symbol || '').toString().trim() || null,
    positions,
    count: positions.length,
    net_lots: round(netLots, 2),
    buy_lots: round(buyLots, 2),
    sell_lots: round(sellLots, 2),
    float_usd: haveProfit ? round(floatUsd, 2) : null,
  };

  const { error } = await getClient()
    .from('kp_positions')
    .upsert(row, { onConflict: 'account_login' });
  if (error) return bad(res, 500, 'db_error: ' + error.message);

  return res.status(200).json({ ok: true, count: positions.length });
};

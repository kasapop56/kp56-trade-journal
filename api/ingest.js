// Vercel serverless webhook — receives JSON from the MT5 JournalSync EA
// and writes into Supabase using the service-role key.
//
// Endpoint:  POST /api/ingest
// Headers:   Content-Type: application/json
//            X-Journal-Secret: <JOURNAL_SHARED_SECRET>
//
// Env vars (set in Vercel dashboard → Project → Settings → Environment Variables):
//   SUPABASE_URL                 — same URL used by the browser
//   SUPABASE_SERVICE_ROLE_KEY    — service-role key (NEVER expose to browser)
//   JOURNAL_SHARED_SECRET        — any long random string; matched against header
//
// Event types supported:
//   "trade_closed"     → upsert into mt5_trades (idempotent on deal_ticket)
//   "balance_snapshot" → insert into balance_snapshots

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.JOURNAL_SHARED_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');
  if (req.headers['x-journal-secret'] !== expected) return bad(res, 401, 'bad_secret');

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  const db = getClient();

  try {
    if (payload.event === 'trade_closed') {
      const row = {
        account_login: payload.account_login,
        deal_ticket:   payload.deal_ticket,
        position_id:   payload.position_id ?? null,
        symbol:        payload.symbol,
        type:          payload.type,
        volume:        payload.volume,
        open_time:     payload.open_time,
        close_time:    payload.close_time,
        open_price:    payload.open_price,
        close_price:   payload.close_price,
        sl:            payload.sl ?? null,
        tp:            payload.tp ?? null,
        profit:        payload.profit,
        swap:          payload.swap ?? 0,
        commission:    payload.commission ?? 0,
        magic:         payload.magic ?? 0,
        comment:       payload.comment ?? null,
        balance_after: payload.balance_after ?? null,
        equity_after:  payload.equity_after ?? null,
      };
      for (const k of ['account_login','deal_ticket','symbol','type','volume','open_time','close_time','open_price','close_price','profit']) {
        if (row[k] === undefined || row[k] === null) return bad(res, 400, 'missing_field: ' + k);
      }
      const { error } = await db.from('mt5_trades').upsert(row, { onConflict: 'deal_ticket' });
      if (error) return bad(res, 500, 'db_error: ' + error.message);
      return res.status(200).json({ ok: true, event: 'trade_closed', deal_ticket: row.deal_ticket });
    }

    if (payload.event === 'balance_snapshot') {
      const row = {
        account_login:  payload.account_login,
        balance:        payload.balance,
        equity:         payload.equity,
        margin:         payload.margin ?? 0,
        free_margin:    payload.free_margin ?? null,
        margin_level:   payload.margin_level ?? null,
        open_positions: payload.open_positions ?? 0,
        recorded_at:    payload.recorded_at,
      };
      for (const k of ['account_login','balance','equity','recorded_at']) {
        if (row[k] === undefined || row[k] === null) return bad(res, 400, 'missing_field: ' + k);
      }
      const { error } = await db.from('balance_snapshots').insert(row);
      if (error) return bad(res, 500, 'db_error: ' + error.message);
      return res.status(200).json({ ok: true, event: 'balance_snapshot' });
    }

    return bad(res, 400, 'unknown_event: ' + payload.event);
  } catch (e) {
    return bad(res, 500, 'unhandled: ' + e.message);
  }
};

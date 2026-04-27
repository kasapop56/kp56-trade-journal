// Vercel write endpoint — posts a trade plan to the Telegram analysis group
// AND records the plan in trade_plans for history.
//
// Endpoint:  POST /api/post-plan
// Headers:   Content-Type: application/json
//            X-Agent-Key: <AGENT_WRITE_KEY>
//
// Body (JSON):
//   {
//     sitrep_id:     12345,                  // optional FK to market_sitreps
//     schedule_slot: "14:00",                // "09:00" / "14:00" / "21:00" Thai
//     bias_call:     "Bear",                 // optional summary classification
//     summary:       "London open — fade...", // short headline (optional)
//     full_text:     "<full plan markdown>"  // posted as Telegram message
//   }
//
// Side effects:
//   1. POST to https://api.telegram.org/bot<TOKEN>/sendMessage with chat_id
//      = TELEGRAM_PLAN_CHAT_ID, parse_mode = HTML, body = full_text
//   2. Insert row into trade_plans (with telegram_msg_id from response).
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   AGENT_WRITE_KEY            — separate from SITREP_SHARED_SECRET / AGENT_READ_KEY
//   TELEGRAM_PLAN_BOT_TOKEN    — bot token that owns the analysis group
//   TELEGRAM_PLAN_CHAT_ID      — chat_id of the analysis group

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

async function sendTelegram(token, chatId, text) {
  // Telegram caps single sendMessage at 4096 chars. Trim with notice.
  const MAX = 4000;
  let body = text;
  if (body.length > MAX) body = body.slice(0, MAX) + '\n…(truncated)';

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    return { ok: false, status: r.status, error: j.description || `http_${r.status}` };
  }
  return { ok: true, message_id: j.result?.message_id ?? null };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.AGENT_WRITE_KEY;
  if (!expected) return bad(res, 500, 'server_missing_agent_write_key');
  if (req.headers['x-agent-key'] !== expected) return bad(res, 401, 'bad_agent_key');

  const token  = process.env.TELEGRAM_PLAN_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_PLAN_CHAT_ID;
  if (!token || !chatId) return bad(res, 500, 'server_missing_telegram_config');

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  if (!payload.full_text) return bad(res, 400, 'missing_field: full_text');

  // Send to Telegram first — if this fails, don't write a row claiming success.
  const tg = await sendTelegram(token, chatId, payload.full_text);
  if (!tg.ok) return bad(res, 502, 'telegram_send_failed: ' + tg.error);

  const db = getClient();
  const row = {
    sitrep_id:       payload.sitrep_id ?? null,
    schedule_slot:   payload.schedule_slot ?? null,
    bias_call:       payload.bias_call ?? null,
    summary:         payload.summary ?? null,
    full_text:       payload.full_text,
    telegram_msg_id: tg.message_id,
    telegram_chat:   String(chatId),
  };
  const { data, error } = await db
    .from('trade_plans')
    .insert(row)
    .select('id, created_at')
    .single();
  if (error) {
    // Telegram already posted — log and still return ok so agent doesn't retry-post.
    console.warn('post-plan db insert failed after telegram send:', error.message);
    return res.status(200).json({
      ok: true,
      telegram_message_id: tg.message_id,
      db_warning: error.message,
    });
  }

  return res.status(200).json({
    ok: true,
    plan_id: data.id,
    created_at: data.created_at,
    telegram_message_id: tg.message_id,
  });
};

// Vercel write endpoint — receives a Fibo Focus Zone snapshot from the Pine
// indicator (via TradingView alert webhook), records it in fibo_snapshots,
// and posts a short "วาดใหม่แล้ว" update to Telegram.
//
// Endpoint:  POST /api/fibo-snapshot
// Body (JSON, built by the Pine alert() message):
//   {
//     "secret":     "<FIBO_WEBHOOK_SECRET>",   // required — TradingView can't
//                                              //   set headers, so auth is in body
//     "symbol":     "XAUUSD", "tf": "15",
//     "seq":        1, "frame_no": 12,
//     "entry_mode": "Focus 2.0", "zone_pts": 100,
//     "price":      3345.67, "bar_time": 1723200000000,
//     "fh": .., "fl": .., "mid": ..,
//     "s_focus": .., "s_test": .., "s_tp1": .., "s_tp3": .., "s_sl": ..,
//     "b_focus": .., "b_test": .., "b_tp1": .., "b_tp3": .., "b_sl": ..
//   }
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   FIBO_WEBHOOK_SECRET        — shared secret; must equal body.secret
//   TELEGRAM_PLAN_BOT_TOKEN    — reused; or FIBO_TELEGRAM_BOT_TOKEN to override
//   TELEGRAM_PLAN_CHAT_ID      — reused; or FIBO_TELEGRAM_CHAT_ID to override
//                                (set FIBO_TELEGRAM_CHAT_ID="off" to skip Telegram)

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
  if (!raw) return {};
  // TradingView sends the alert message verbatim; it should be pure JSON.
  return JSON.parse(raw);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v) {
  const n = num(v);
  return n === null ? '-' : String(n);
}

async function sendTelegram(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
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

function buildMessage(p) {
  const sym  = p.symbol || 'XAUUSD';
  const tf   = p.tf ? `TF${p.tf}` : '';
  const seq  = p.seq == null ? '?' : p.seq;
  const mode = p.entry_mode || '';
  const zone = p.zone_pts == null ? '' : `Zone ±${p.zone_pts}p`;
  const px   = p.price == null ? '' : `@ ${fmt(p.price)}`;

  const head = `🟧 <b>Fibo Focus — วาดใหม่</b>\n` +
               `${sym} · ${tf} · <b>Seq #${seq}</b>\n` +
               `เข้า: ${mode} · ${zone} ${px}`.trim();

  const sBlock = `\n\n🔴 <b>S ขาย</b>\n` +
                 ` Focus ${fmt(p.s_focus)} | Test ${fmt(p.s_test)}\n` +
                 ` TP1 ${fmt(p.s_tp1)} · TP3 ${fmt(p.s_tp3)} · SL ${fmt(p.s_sl)}`;

  const bBlock = `\n\n🟢 <b>B ซื้อ</b>\n` +
                 ` Focus ${fmt(p.b_focus)} | Test ${fmt(p.b_test)}\n` +
                 ` TP1 ${fmt(p.b_tp1)} · TP3 ${fmt(p.b_tp3)} · SL ${fmt(p.b_sl)}`;

  return head + sBlock + bBlock;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const secret = process.env.FIBO_WEBHOOK_SECRET;
  if (!secret) return bad(res, 500, 'server_missing_fibo_webhook_secret');

  let p;
  try { p = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  if (p.secret !== secret) return bad(res, 401, 'bad_secret');
  if (!p.symbol) return bad(res, 400, 'missing_field: symbol');

  // 1) Record the snapshot.
  const row = {
    symbol:     String(p.symbol),
    tf:         p.tf ? String(p.tf) : null,
    seq:        num(p.seq),
    frame_no:   num(p.frame_no),
    entry_mode: p.entry_mode ? String(p.entry_mode) : null,
    zone_pts:   num(p.zone_pts),
    price:      num(p.price),
    bar_time:   num(p.bar_time),
    fh:         num(p.fh),
    fl:         num(p.fl),
    mid:        num(p.mid),
    s_focus:    num(p.s_focus),
    s_test:     num(p.s_test),
    s_tp1:      num(p.s_tp1),
    s_tp3:      num(p.s_tp3),
    s_sl:       num(p.s_sl),
    b_focus:    num(p.b_focus),
    b_test:     num(p.b_test),
    b_tp1:      num(p.b_tp1),
    b_tp3:      num(p.b_tp3),
    b_sl:       num(p.b_sl),
    raw:        p,
  };

  let snapId = null;
  try {
    const db = getClient();
    const { data, error } = await db
      .from('fibo_snapshots')
      .insert(row)
      .select('id, created_at')
      .single();
    if (error) return bad(res, 500, 'db_insert_failed: ' + error.message);
    snapId = data.id;
  } catch (e) {
    return bad(res, 500, 'db_error: ' + e.message);
  }

  // 2) Ping Telegram (best-effort — never fail the request over a TG hiccup).
  let tg = { ok: false, skipped: true };
  const chatId = process.env.FIBO_TELEGRAM_CHAT_ID || process.env.TELEGRAM_PLAN_CHAT_ID;
  const token  = process.env.FIBO_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_PLAN_BOT_TOKEN;
  if (chatId && chatId !== 'off' && token) {
    try {
      tg = await sendTelegram(token, chatId, buildMessage(p));
    } catch (e) {
      tg = { ok: false, error: e.message };
    }
    if (!tg.ok) console.warn('fibo-snapshot telegram send failed:', tg.error);
  }

  return res.status(200).json({
    ok: true,
    snapshot_id: snapId,
    telegram_message_id: tg.message_id ?? null,
    telegram_ok: !!tg.ok,
  });
};

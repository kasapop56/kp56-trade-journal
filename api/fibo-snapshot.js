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

function buildSnapshotMessage(p) {
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

// Which TP did price reach, from mfe vs the frame's TP ladder (from the snapshot
// row). S: lower price = further; B: higher price = further. Returns "TP1".."TP4"
// or null. TP2 = mid (0.5), TP4 = fl(S)/fh(B).
function computeBestTP(side, mfe, snap) {
  if (mfe == null || !snap) return null;
  const S = side === 'S';
  const ladder = S
    ? [['TP1', snap.s_tp1], ['TP2', snap.mid], ['TP3', snap.s_tp3], ['TP4', snap.fl]]
    : [['TP1', snap.b_tp1], ['TP2', snap.mid], ['TP3', snap.b_tp3], ['TP4', snap.fh]];
  let best = null, bestPx = null;
  for (const [label, px] of ladder) {
    if (px == null) continue;
    const reached = S ? mfe <= px : mfe >= px;
    if (!reached) continue;
    if (bestPx == null || (S ? px < bestPx : px > bestPx)) { best = label; bestPx = px; }
  }
  return best;
}

function buildEventMessage(p, bestTP) {
  const sym  = p.symbol || 'XAUUSD';
  const side = p.side === 'S' ? 'S ขาย' : 'B ซื้อ';
  const seq  = p.seq == null ? '?' : p.seq;
  const tag  = `${side} · Seq #${seq}`;
  if (p.event === 'ENTER') {
    return `🎯 <b>Fibo — เข้าไม้</b>\n${sym} · ${tag}\nEntry ${fmt(p.entry)} · TP1 ${fmt(p.tp1)} · SL ${fmt(p.sl)}`;
  }
  if (p.event === 'WIN') {
    const extra = bestTP && bestTP !== 'TP1' ? ` (ไปไกลถึง ${bestTP})` : '';
    return `✅ <b>Fibo — ชนะ</b> 🎉\n${sym} · ${tag}\nแตะ TP1 ${fmt(p.tp1)}${extra}`;
  }
  if (p.event === 'LOSS') {
    const extra = bestTP ? ` (เคยไปถึง ${bestTP})` : '';
    return `❌ <b>Fibo — แพ้</b>\n${sym} · ${tag}\nโดน SL ${fmt(p.sl)}${extra}`;
  }
  return `Fibo event ${p.event} · ${sym} · ${tag}`;
}

// Resolve the Telegram bot/chat once (Fibo override, else reuse the plan bot).
function telegramTarget() {
  const chatId = process.env.FIBO_TELEGRAM_CHAT_ID || process.env.TELEGRAM_PLAN_CHAT_ID;
  const token  = process.env.FIBO_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_PLAN_BOT_TOKEN;
  const on = chatId && chatId !== 'off' && token;
  return { on, chatId, token };
}

async function pingTelegram(text) {
  const { on, chatId, token } = telegramTarget();
  if (!on) return { ok: false, skipped: true };
  try {
    const tg = await sendTelegram(token, chatId, text);
    if (!tg.ok) console.warn('fibo telegram send failed:', tg.error);
    return tg;
  } catch (e) {
    console.warn('fibo telegram threw:', e.message);
    return { ok: false, error: e.message };
  }
}

// ENTER / WIN / LOSS lifecycle event.
async function handleEvent(res, p) {
  const db = getClient();

  // For WIN/LOSS, enrich with best-TP from the matching snapshot (best-effort).
  let bestTP = null;
  if ((p.event === 'WIN' || p.event === 'LOSS') && p.frame_id != null) {
    try {
      const { data: snap } = await db
        .from('fibo_snapshots')
        .select('mid, fl, fh, s_tp1, s_tp3, b_tp1, b_tp3')
        .eq('symbol', String(p.symbol))
        .eq('bar_time', num(p.frame_id))
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      bestTP = computeBestTP(p.side, num(p.mfe), snap);
    } catch (_) { /* non-fatal */ }
  }

  const row = {
    symbol:     String(p.symbol),
    frame_id:   num(p.frame_id),
    seq:        num(p.seq),
    side:       p.side ? String(p.side) : null,
    event:      String(p.event),
    entry_mode: p.entry_mode ? String(p.entry_mode) : null,
    entry:      num(p.entry),
    tp1:        num(p.tp1),
    sl:         num(p.sl),
    mfe:        num(p.mfe),
    price:      num(p.price),
    bar_time:   num(p.bar_time),
    raw:        p,
  };

  let evId = null;
  try {
    const { data, error } = await db
      .from('fibo_events')
      .insert(row)
      .select('id')
      .single();
    if (error) return bad(res, 500, 'db_insert_failed: ' + error.message);
    evId = data.id;
  } catch (e) {
    return bad(res, 500, 'db_error: ' + e.message);
  }

  const tg = await pingTelegram(buildEventMessage(p, bestTP));

  return res.status(200).json({
    ok: true,
    event_id: evId,
    best_tp: bestTP,
    telegram_message_id: tg.message_id ?? null,
    telegram_ok: !!tg.ok,
  });
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

  // Route by type: lifecycle events go to fibo_events, everything else is a frame.
  const type = String(p.type || 'SNAPSHOT').toUpperCase();
  if (type === 'ENTER' || type === 'WIN' || type === 'LOSS') {
    if (!p.event) p.event = type;   // Pine sends type; keep event in sync
    return handleEvent(res, p);
  }

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
  const tg = await pingTelegram(buildSnapshotMessage(p));

  return res.status(200).json({
    ok: true,
    snapshot_id: snapId,
    telegram_message_id: tg.message_id ?? null,
    telegram_ok: !!tg.ok,
  });
};

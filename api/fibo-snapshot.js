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
//     "frame_mode": "SYM"|"DIR", "leg_dir": "UP"|"DOWN", "active_side": "S"|"B"|"BOTH",
//     "state": "MAIN"|"FALLBACK"|"WAIT",   // frame validity (Phase 8g)
//     "src_tf": "15"|"5",                  // TF the levels are anchored on
//     "dead_side": "S"|"B"|"BOTH"|"",      // which SL killed the main frame
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

// Bangkok (UTC+7) civil date "YYYY-MM-DD" for a ms epoch.
function bkkDateStr(ms) {
  const t = new Date(ms + 7 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// The alert fires on the first bar of the new day, so it can also report the day
// that just CLOSED — the indicator tracks it on the chart's own bars rather than
// through request.security("D"), which is still a day behind at that instant.
// Those values belong on the PREVIOUS day's row, not today's.
//
// Deliberately not part of the main upsert: a failure here (migration not run
// yet, no previous day tracked on a fresh chart) must never reject the webhook —
// TradingView would surface it as a failing alert and the ATR frame, which the
// evaluator actually depends on, would be lost over a nice-to-have column.
async function writePrevDay(db, symbol, atrDate, p) {
  const o = num(p.prev_o), h = num(p.prev_h), l = num(p.prev_l), c = num(p.prev_c);
  const c2 = num(p.prev2_c), pts = num(p.prev_ts);
  if (o == null || h == null || l == null || c == null || pts == null) return 'no_prev_in_payload';

  const prevDate = bkkDateStr(pts);
  if (prevDate === atrDate) return 'skipped: prev_ts lands on the same Bangkok day';

  // TR needs the close before the previous day; without it fall back to the plain
  // range, which only understates a gap day.
  const tr = c2 == null ? h - l : Math.max(h - l, Math.abs(h - c2), Math.abs(l - c2));
  const patch = {
    day_high: h, day_low: l, day_close: c, tr,
    prev_close: c2, updated_at: new Date().toISOString(),
  };

  try {
    const upd = await db.from('kp_atr').update(patch)
      .eq('symbol', symbol).eq('atr_date', prevDate).select('id');
    if (upd.error) {
      if (upd.error.code === '42703') return 'skipped: run db_kp_atr_daily_tr.sql';
      return 'skipped: ' + upd.error.message;
    }
    if (upd.data && upd.data.length) return { atr_date: prevDate, tr: Math.round(tr * 100) / 100, updated: true };

    // No row for that day (alert was down, or this is the chart's first rollover)
    // — insert what we know. `atr` stays null, so tr_ratio is simply unavailable
    // for that day rather than wrong.
    const ins = await db.from('kp_atr').insert({
      symbol, atr_date: prevDate, day_open: o, ...patch,
      raw: { source: 'prev_day_from_daily_atr', prev_ts: pts },
      ts: new Date(pts).toISOString(),
    }).select('id');
    if (ins.error) return 'skipped: ' + ins.error.message;
    return { atr_date: prevDate, tr: Math.round(tr * 100) / 100, inserted: true };
  } catch (e) {
    return 'skipped: ' + e.message;
  }
}

// Daily ATR frame from the "Daily ATR Zones" indicator's once-a-day alert.
// Merged here (instead of a separate api/kp-atr.js) to stay under the Hobby-plan
// 12-function cap — it's just another TradingView webhook. Upserts one row per
// (symbol, Bangkok date) into kp_atr; the read evaluator (_kp_eval) reads it.
async function handleDailyAtr(res, p) {
  const atr = num(p.atr), dayOpen = num(p.day_open);
  if (atr == null || dayOpen == null) return bad(res, 400, 'missing_field: atr / day_open');

  const tsMs = num(p.ts) != null ? num(p.ts) : Date.now();
  const atrDate = bkkDateStr(tsMs);
  const symbol = p.symbol || 'XAUUSD';

  const mults = [0.25, 0.5, 0.75, 1.0, 1.25, -0.25, -0.5, -0.75, -1.0, -1.25];
  const bands = {};
  for (const m of mults) bands[String(m)] = Math.round((dayOpen + atr * m) * 100) / 100;

  const row = {
    symbol, atr_date: atrDate, day_open: dayOpen, atr,
    atr_len: num(p.atr_len), method: p.method || null,
    day_high: num(p.day_high), day_low: num(p.day_low),
    bands, raw: p, ts: new Date(tsMs).toISOString(), updated_at: new Date().toISOString(),
  };

  try {
    const db = getClient();
    const { data, error } = await db.from('kp_atr')
      .upsert(row, { onConflict: 'symbol,atr_date' }).select('id, atr_date').single();
    if (error) {
      const missing = error.code === '42P01';
      return bad(res, missing ? 424 : 500,
        missing ? 'kp_atr table missing — run supabase_schema_kp_atr.sql' : error.message);
    }
    const prev_day = await writePrevDay(db, symbol, atrDate, p);
    return res.status(200).json({ ok: true, type: 'DAILY_ATR', id: data.id, atr_date: data.atr_date, atr, day_open: dayOpen, prev_day });
  } catch (e) {
    return bad(res, 500, 'db_error: ' + e.message);
  }
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
  const state = String(p.state || 'MAIN').toUpperCase();
  const side  = p.dead_side ? ` ${p.dead_side}` : '';

  // WAIT = the frame is dead and nothing has replaced it. Posting levels here
  // would be the exact lie this state exists to stop, so the message says so
  // and stops. (A dead frame used to keep broadcasting as if it were live.)
  if (state === 'WAIT') {
    return `⛔ <b>Fibo Focus — กรอบตาย</b>\n` +
           `${sym} · ${tf} ${px}\n` +
           `เสีย SL${side} · TF รองยังไม่มี pivot ใหม่\n` +
           `<i>รอขาใหม่ — ยังไม่มีโซนให้ใช้</i>`;
  }

  const badge = state === 'FALLBACK'
    ? `\n↩ <b>ขาสำรอง TF${p.src_tf || '?'}</b> (TF${p.tf || '?'} เสีย SL${side})`
    : '';

  const head = `🟧 <b>Fibo Focus — วาดใหม่</b>\n` +
               `${sym} · ${tf} · <b>Seq #${seq}</b>${badge}\n` +
               `เข้า: ${mode} · ${zone} ${px}`.trim();

  const sBlock = `\n\n🔴 <b>S ขาย</b>\n` +
                 ` Focus ${fmt(p.s_focus)} | Test ${fmt(p.s_test)}\n` +
                 ` TP1 ${fmt(p.s_tp1)} · SL ${fmt(p.s_sl)}`;

  const bBlock = `\n\n🟢 <b>B ซื้อ</b>\n` +
                 ` Focus ${fmt(p.b_focus)} | Test ${fmt(p.b_test)}\n` +
                 ` TP1 ${fmt(p.b_tp1)} · SL ${fmt(p.b_sl)}`;

  // Shared ladder targets: TP2 = near boundary, TP3 = Mid, TP4 = far boundary.
  const ladder = `\n\n🎯 TP2/4 ขอบ: High ${fmt(p.fh)} · Low ${fmt(p.fl)} · TP3 Mid ${fmt(p.mid)}`;

  return head + sBlock + bBlock + ladder;
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

// Lightweight "price entered a zone" heads-up (no DB, Telegram only). Fired by
// Pine once per (side, zone) per frame — for manual awareness; win/loss is derived
// separately by /api/fibo-eval.
function buildZoneMessage(p) {
  const sym  = p.symbol || 'XAUUSD';
  const side = p.side === 'S' ? '🔴 S ขาย' : '🟢 B ซื้อ';
  const zone = String(p.zone || '').indexOf('Test') >= 0 ? 'Test 1.272' : 'Focus 2.0';
  const seq  = p.seq == null ? '?' : p.seq;
  return `🎯 <b>Fibo — ราคาเข้าโซน</b>\n${sym} · ${side} · <b>Seq #${seq}</b>\n${zone} @ ${fmt(p.level)} (ราคา ${fmt(p.price)})`;
}

async function handleZone(res, p) {
  const tg = await pingTelegram(buildZoneMessage(p));
  return res.status(200).json({ ok: true, type: 'ZONE', telegram_ok: !!tg.ok, telegram_message_id: tg.message_id ?? null });
}

// Actionable entry signal (Telegram only, no DB). Carries the full trade plan
// (Entry/SL/TP1/TP3). Focus 2.0 = primary/safer; Test 1.272 = flagged as riskier.
// Win/loss is still derived separately by /api/fibo-eval.
function buildSignalMessage(p) {
  const sym    = p.symbol || 'XAUUSD';
  const isS    = p.side === 'S';
  const dir    = isS ? '🔴 SELL ขาย' : '🟢 BUY ซื้อ';
  const isTest = String(p.zone || '').indexOf('Test') >= 0;
  const zone   = isTest ? '⚠️ Test 1.272 (เสี่ยงกว่า)' : 'Focus 2.0 (หลัก)';
  const head   = isTest ? '⚠️ <b>Fibo — เข้าไม้ (aggressive)</b>' : '⚡️ <b>Fibo — เข้าไม้</b>';
  const seq    = p.seq == null ? '?' : p.seq;
  // A signal off a fallback-degree leg is a finer (noisier) swing than the main
  // TF one — flag it so the trader sizes it knowing which degree it came from.
  const deg    = String(p.state || 'MAIN').toUpperCase() === 'FALLBACK'
    ? ` · ↩ ขาสำรอง TF${p.src_tf || '?'}` : '';
  return `${head}\n${sym} · ${dir} · <b>Seq #${seq}</b>${deg}\nโซน ${zone}\n` +
         `Entry ${fmt(p.entry)} · 🛑 SL ${fmt(p.sl)}\n🎯 TP1 ${fmt(p.tp1)} · TP3 ${fmt(p.tp3)}`;
}

async function handleSignal(res, p) {
  const tg = await pingTelegram(buildSignalMessage(p));
  return res.status(200).json({ ok: true, type: 'SIGNAL', telegram_ok: !!tg.ok, telegram_message_id: tg.message_id ?? null });
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
  if (type === 'DAILY_ATR') return handleDailyAtr(res, p);  // KP56 co-pilot ATR frame
  if (type === 'ZONE') return handleZone(res, p);      // heads-up ping, no DB
  if (type === 'SIGNAL') return handleSignal(res, p);  // entry signal, Telegram only
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
    frame_mode: p.frame_mode ? String(p.frame_mode) : null,   // "SYM" | "DIR"
    leg_dir:    p.leg_dir ? String(p.leg_dir) : null,          // "UP" | "DOWN"
    active_side: p.active_side ? String(p.active_side) : null, // "S" | "B" | "BOTH"
    // Frame validity (Phase 8g). MAIN = main-TF frame with its SL intact ·
    // FALLBACK = main frame died on SL, levels re-anchored to a finer degree
    // (src_tf) · WAIT = dead with no fresh leg — the levels below are the last
    // dead set and must not be traded or quoted. NULL on pre-8g rows = MAIN.
    state:      p.state ? String(p.state) : null,
    src_tf:     p.src_tf ? String(p.src_tf) : null,
    dead_side:  p.dead_side ? String(p.dead_side) : null,
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

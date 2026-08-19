// api/_kp_report.js — KP56 Co-pilot nightly report (loop-closer). Not a route.
//
// Called by api/report.js (Vercel cron 23:30 Asia/Bangkok, or manual). Grades
// the day's CLOSED trades on the study account: per-trade review, discipline
// scorecard, co-pilot loop check (adherence + the co-pilot's own accuracy), and
// lessons. Reads mt5_trades + trade_events + kp_signals via service-role; posts
// to Telegram; persists to kp_reports (non-fatal).
//
// IMPORTANT: grades ALL trades, including ones the trader took independently of
// the co-pilot's suggestion — each is evaluated on its own merit.

const { getDb, getAnthropic, sendTelegram, num, round, CFG } = require('./_kp_lib');

// Bangkok "trading day" start (00:00 local) as a UTC ISO string.
function dayStartIso(tzHours) {
  const tz = tzHours * 3600 * 1000;
  const local = new Date(Date.now() + tz);
  const midnightLocalMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0) - tz;
  return new Date(midnightLocalMs).toISOString();
}
function bkkDateLabel(tzHours) {
  const t = new Date(Date.now() + tzHours * 3600 * 1000);
  return `${t.getUTCDate()}/${t.getUTCMonth() + 1}`;
}

const REPORT_SYSTEM = `You are the nightly performance coach for a disciplined XAUUSD discretionary trader. You review the day's CLOSED trades and grade them HONESTLY — the trader wants to improve, not to be flattered. Never invent trades or numbers not in the data.

You receive: each closed trade (side, entry/exit, SL/TP, P&L in account USD, MFE/MAE in points, hold time, whether an SL was set at open, entry origin, and the Mario bias/session captured at trade time), the day's co-pilot reads (what the co-pilot advised and when), and day totals.

CRITICAL: the trader ALSO opens trades independently of the co-pilot's suggestions. Evaluate EVERY trade on its own merit. For each, note whether it MATCHED, DIVERGED FROM, or had NO co-pilot read at that time — and grade divergent trades fairly (an independent call can be right or wrong; say which).

Grade on:
1. Per-trade review — with/against structure (use the captured bias), SL/TP placement, entry quality; use MFE (profit left on the table) and MAE (heat taken / near-stop) to judge management.
2. Discipline scorecard — was an SL always set? hold time reasonable? any averaging-down or revenge (ADD/HEDGE against a loser)? Give a short daily grade A–F.
3. Co-pilot loop check — split the day's trades into FOLLOWED vs DIVERGED (vs the nearest co-pilot read before the trade opened). For the DIVERGED trades, this is the key learning: report each one's OUTCOME field (SL_hit / TP_hit / manual exit) and P&L, then draw the honest conclusion — did ignoring the co-pilot lead to stops or targets today? Also flag any trade where the trader FOLLOWED the co-pilot but it still lost (the co-pilot was wrong). Over time this teaches what to follow and what to trust your own read on. Be concrete: "สวนคำแนะนำ 2 ไม้ → โดน SL ทั้งคู่ (−$X)" or "สวน 1 ไม้ แต่ได้ TP (+$Y) — จังหวะนี้อ่านเองแม่นกว่า".
4. Lessons — 1–2 concrete, specific things to do differently tomorrow.
Be specific with numbers and levels. Thai output, mobile-readable, no filler.`;

const REPORT_OUTPUT = `ตอบเป็นภาษาไทย สั้น อ่านบนมือถือได้ ห้ามใช้ markdown (** ## -). ใช้รูปแบบนี้ตามลำดับ:

<พาดหัวสรุปวัน 1 บรรทัด>

📊 สรุป
<P&L รวม · W/L · winrate · ไม้ดีสุด/แย่สุด>

🔍 รีวิวรายไม้
<ต่อไม้: side @ entry→exit · ผล$ · ตาม/สวนโครงสร้าง · SL/TP โอเคไหม · (ตาม/สวน/ไม่มี co-pilot)>

🎯 วินัย
<SL ครบไหม · ถือนานไป/รีบไป · มีถัวขาดทุน/แก้แค้นไหม · เกรดวันนี้ A-F>

🤖 เช็ค co-pilot (ตาม vs สวน)
<ไม้ที่ตามคำแนะนำ: ผลเป็นไง>
<ไม้ที่สวนคำแนะนำ: กี่ไม้ → โดน SL กี่ไม้ / ได้ TP กี่ไม้ + ผล$ · สรุปวันนี้ควร "ตาม" หรือ "อ่านเอง">
<ไม้ที่ตาม co-pilot แต่ยังเสีย = co-pilot อ่านผิด บอกตรง ๆ>

📌 บทเรียนพรุ่งนี้
<1-2 ข้อ ชัดเจน ทำได้จริง>`;

// Merge a closed trade (mt5_trades) with its OPEN/CLOSE study events by ticket.
function buildTrade(t, evByTicket) {
  const evs = evByTicket.get(String(t.position_id)) || {};
  const open = evs.open || null, close = evs.close || null;
  const pl = (num(t.profit) || 0) + (num(t.swap) || 0) + (num(t.commission) || 0);
  // how the trade ended — the key learning signal for "SL or TP?"
  const reason = close ? close.reason : null;
  const outcome = reason === 'sl' ? 'SL_hit'
                : reason === 'tp' ? 'TP_hit'
                : reason === 'stopout' ? 'stopout'
                : reason ? ('manual_' + reason)              // desktop/mobile/web = hand-closed
                : (pl >= 0 ? 'manual_win' : 'manual_loss');  // no close event logged → infer by P&L
  const heldMin = (t.open_time && t.close_time)
    ? Math.round((new Date(t.close_time) - new Date(t.open_time)) / 60000)
    : (close && close.held_sec != null ? Math.round(close.held_sec / 60) : null);
  return {
    ticket: t.position_id, side: t.type, lots: num(t.volume),
    entry: num(t.open_price), exit: num(t.close_price),
    sl: num(t.sl) || null, tp: num(t.tp) || null,
    pl_usd: round(pl, 2),
    outcome,                                 // SL_hit / TP_hit / manual_* / stopout
    mfe_pts: close ? num(close.mfe_pts) : null,
    mae_pts: close ? num(close.mae_pts) : null,
    held_min: heldMin,
    close_reason: reason,
    had_sl_at_open: open ? (num(open.sl) > 0) : (num(t.sl) > 0),
    entry_origin: open ? open.origin : null,
    add_kind: open ? open.kind : null,     // FIRST/ADD/HEDGE/MIXED — averaging signal
    ctx_at_trade: { bias_m15: t.bias_m15, bias_m5: t.bias_m5, ob_status: t.ob_status, session: t.mario_session, mario_decision: t.mario_decision },
    open_time: t.open_time, close_time: t.close_time,
  };
}

async function runReport(db, opts = {}) {
  const sinceIso = dayStartIso(CFG.reportTzOffsetHours);
  const account = CFG.studyAccount;

  const [trRes, evRes, sigRes] = await Promise.all([
    db.from('mt5_trades')
      .select('position_id, type, volume, open_time, close_time, open_price, close_price, sl, tp, profit, swap, commission, bias_m15, bias_m5, ob_status, mario_session, mario_decision')
      .eq('account_login', account).gte('close_time', sinceIso)
      .order('close_time', { ascending: true }).limit(CFG.reportMaxTrades),
    db.from('trade_events')
      .select('ticket, event, payload, created_at')
      .eq('account_login', account).gte('created_at', sinceIso)
      .in('event', ['OPEN', 'MODIFY', 'CLOSE']).order('created_at', { ascending: true }).limit(2000),
    db.from('kp_signals')
      .select('ts, trigger_type, headline, bias_call, price, message')
      .gte('ts', sinceIso).order('ts', { ascending: true }).limit(60),
  ]);
  if (trRes.error) return { ok: false, error: 'mt5_trades read: ' + trRes.error.message };

  const trades = trRes.data || [];
  const signals = (sigRes.error ? [] : (sigRes.data || []));

  // index events by ticket → { open, close }
  const evByTicket = new Map();
  for (const ev of (evRes.error ? [] : (evRes.data || []))) {
    const k = String(ev.ticket);
    let rec = evByTicket.get(k);
    if (!rec) { rec = {}; evByTicket.set(k, rec); }
    if (ev.event === 'OPEN' && !rec.open) rec.open = ev.payload || {};
    if (ev.event === 'CLOSE') rec.close = ev.payload || {};
  }

  // quiet day → skip on the auto cron (avoids weekend/no-trade noise); on a
  // manual run, still post a short note.
  if (trades.length === 0) {
    if (!opts.force) return { ok: true, posted: false, reason: 'no_trades' };
    const msg = `🌙 <b>รายงานคืนนี้</b> · ${bkkDateLabel(CFG.reportTzOffsetHours)}\nXAUUSD · ${account}\n➖➖➖➖➖➖\nวันนี้ไม่มีการเทรด — รักษาวินัยดี ไม่ FOMO 👍`;
    const tg = await sendTelegram(msg);
    return { ok: true, posted: tg.ok, reason: 'no_trades_manual' };
  }

  const rows = trades.map(t => buildTrade(t, evByTicket));
  let net = 0, wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
  for (const r of rows) {
    net += r.pl_usd;
    if (r.pl_usd >= 0) { wins++; grossWin += r.pl_usd; } else { losses++; grossLoss += r.pl_usd; }
  }
  const winrate = rows.length ? Math.round((wins / rows.length) * 100) : 0;
  const summary = {
    trades: rows.length, net_usd: round(net, 2), wins, losses, winrate_pct: winrate,
    gross_win_usd: round(grossWin, 2), gross_loss_usd: round(grossLoss, 2),
    no_sl_count: rows.filter(r => !r.had_sl_at_open).length,
    averaged_count: rows.filter(r => r.add_kind === 'ADD').length,
  };

  const payload = {
    date: bkkDateLabel(CFG.reportTzOffsetHours), account, symbol: 'XAUUSD',
    day_window_start: sinceIso,
    summary,
    trades: rows,
    copilot_reads: signals.map(s => ({ time: s.ts, trigger: s.trigger_type, call: s.bias_call, headline: s.headline })),
    note: 'trader also trades independently of the co-pilot — grade every trade on merit, mark matched/diverged/no-read.',
  };

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CFG.reportModel || CFG.model,
    max_tokens: 1600,
    output_config: { effort: CFG.reportEffort },
    system: REPORT_SYSTEM,
    messages: [{ role: 'user', content: `${REPORT_OUTPUT}\n\nDAY DATA (JSON):\n${JSON.stringify(payload, null, 2)}` }],
  });
  let body = '';
  for (const b of resp.content) if (b.type === 'text') body += b.text;
  body = body.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^\s*#{1,6}\s*/gm, '').replace(/^\s*[-*]\s+/gm, '').trim();

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sign = net >= 0 ? '+' : '';
  const header = `🌙 <b>รายงานคืนนี้</b> · ${esc(payload.date)}\n` +
                 `XAUUSD · ${account}\n` +
                 `P&L <b>${sign}${esc(summary.net_usd)}$</b> · ${wins}W/${losses}L (${winrate}%)\n` +
                 `➖➖➖➖➖➖\n`;
  const tg = await sendTelegram(header + esc(body));

  // persist (non-fatal — table may not exist yet)
  let reportId = null;
  const { data: rec, error: insErr } = await db.from('kp_reports').insert({
    report_date: payload.date, window_start: sinceIso,
    trades_count: summary.trades, net_usd: summary.net_usd, win_count: wins, loss_count: losses,
    summary, message: body, delivered_to: tg.ok ? ['telegram'] : [],
    meta: { model: CFG.reportModel || CFG.model, usage: resp.usage || null, telegram: tg.ok ? tg.message_id : tg.error, source: opts.source || 'cron' },
  }).select('id').single();
  if (insErr) console.warn('kp_reports insert failed (non-fatal):', insErr.message);
  else reportId = rec.id;

  return { ok: true, posted: tg.ok, report_id: reportId, summary, telegram: tg.ok ? tg.message_id : tg.error };
}

module.exports = { runReport };

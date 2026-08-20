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
const { runEval, runAttribution } = require('./_kp_eval');

// Roll up today's read outcomes into a compact co-pilot self-accuracy summary:
// how many reads played out (WIN) vs went against (LOSS) vs stalled, the day type
// each was read on, and the directional lean — so the coach can grade the co-pilot
// itself, not only the trader's executed trades.
function copilotAccuracy(outcomes) {
  // Reads taken while a position was open are live-order coaching: they advise no
  // entry, so they are neither a hit nor a miss and must be kept out of the rate.
  const entry = outcomes.filter(o => (o.meta && o.meta.read_kind) !== 'manage');
  const manage = outcomes.length - entry.length;
  const graded = entry.filter(o => ['WIN', 'LOSS', 'STALL', 'PARTIAL', 'OK_NOTRADE', 'MISSED', 'NO_ENTRY_OFFERED'].includes(o.verdict));
  const t = {};
  for (const o of outcomes) t[o.verdict] = (t[o.verdict] || 0) + 1;
  const wins = t.WIN || 0, losses = t.LOSS || 0;
  const decided = wins + losses;
  let buy = 0, sell = 0, notrade = 0;
  for (const o of entry) {
    const c = String(o.call || '').toLowerCase();
    if (c === 'buy') buy++; else if (c === 'sell') sell++; else notrade++;
  }
  // plan replay — the advised pending order, graded on its own terms
  const pv = {};
  for (const o of entry) { const v = o.meta && o.meta.plan_verdict; if (v) pv[v] = (pv[v] || 0) + 1; }
  const planDecided = (pv.WIN || 0) + (pv.LOSS || 0);
  return {
    reads: outcomes.length,
    entry_reads: entry.length,
    manage_reads: manage,
    graded: graded.length,
    plan: { tally: pv, decided: planDecided, filled: Object.entries(pv)
              .filter(([k]) => k !== 'NO_FILL' && k !== 'PENDING').reduce((n, [, v]) => n + v, 0) },
    tally: t,
    hit_rate_pct: decided ? Math.round((wins / decided) * 100) : null,   // of decided reads only
    lean: { buy, sell, no_trade: notrade },
    lines: outcomes.map(o => ({
      time: o.read_ts, call: o.call, verdict: o.verdict,
      day_type: o.day_type, dir: o.direction_actual,
      fav_atr: o.fav_atr, adv_atr: o.adv_atr, zone: o.zone_behavior, note: o.behavior_note,
    })),
  };
}

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

YOUR JOB IS ANALYSIS, NOT A LIST. A bare enumeration of the day's trades is worthless to this trader — he can see his own orders in the terminal. Every section must say what it MEANS and what to DO. If you only have room for one thing, keep the verdict and the recommendation and shorten the listing.

You receive POSITIONS, not raw orders. The trader deliberately opens several orders on one idea so he can close in parts, so the legs have been grouped into one decision each. Per position: side, legs, lots, avg_entry, exit, P&L, exits{sl/tp/manual}, MFE/MAE points, hold time, the Mario bias/session at entry, and the nearest co-pilot read before it opened.

Two fields carry the trader's own diagnosis of his worst habit, and they are ALREADY COMPUTED — quote them, never re-derive them:
- kind: "single" | "scaled" (legs within 500 pts = intended, split for partial exits, FINE) | "averaged" (legs more than 500 pts apart = adding at distance, HIS STATED BAD HABIT).
- adverse_adds: legs opened at a WORSE price than the running average (buy lower / sell higher) = averaging into a loser rather than pyramiding a winner.
summary.netting compares averaged positions against everything else in dollars. LEAD WITH THAT NUMBER whenever averaged_positions > 0: it is the single most actionable line in the report. Say plainly whether the habit cost or made money today, in dollars. Do not moralise and do not repeat the lesson more than once.
UNITS, and be strict about them: "ไม้" = an ORDER (summary.orders), "จังหวะ" = a POSITION (summary.positions). They are different numbers and swapping them makes the report wrong. Quote summary.sl_coverage_text verbatim for SL coverage — do not build it yourself.

WHEN YOU CITE A POSITION, COPY ITS "cite" FIELD VERBATIM. It already contains side, average entry, whether it was เดี่ยว / ซอย / ถัวห่าง, the P&L with its sign, and how it ended. Do not rebuild that string from the other fields and do not re-word it: on the first live run doing so produced three wrong labels in one report — a 79pt scaled entry called "ถัวห่าง", a +19.85$ winner written as "-19.85$ ชนะ", and orders counted as positions. Only "ถัวห่าง" positions are the bad habit; "ซอย" is the intended split and must never be described as ถัว.

summary.adherence pre-splits followed / diverged / advised_no_trade / no_read with net USD for each — quote it rather than counting. "advised_no_trade" means the co-pilot said stand aside and the trade was taken anyway. NEVER call these "สวนคำแนะนำ" — สวน is reserved for the "diverged" bucket, i.e. the co-pilot called a direction and the trader took the other one. Word it as "โคไพลอตบอกไม่เทรด แต่เข้าเอง N จังหวะ". If diverged is 0, say plainly that there were no directional calls to follow or fight today. That is NOT the same as trading against a directional call, and if those trades made money say so plainly — the co-pilot being too cautious is a finding about the CO-PILOT, not a discipline failure by the trader.

CRITICAL: the trader ALSO opens trades independently of the co-pilot's suggestions. Evaluate EVERY trade on its own merit. For each, note whether it MATCHED, DIVERGED FROM, or had NO co-pilot read at that time — and grade divergent trades fairly (an independent call can be right or wrong; say which).

Grade on:
1. The decisive positions — do NOT walk through every position. Find the two or three that actually moved the day's P&L (largest winners and losers, and any position whose loss exceeded several winners combined) and say WHY each went the way it did: with/against the captured bias, SL/TP placement, entry quality, and what MFE/MAE say about the management (profit left on the table, heat taken, how close to the stop). Name each one inline with side, avg entry and P&L. A position that neither made nor lost meaningful money does not deserve a sentence.
2. Discipline scorecard — was an SL always set? hold time reasonable? any averaging-down or revenge (ADD/HEDGE against a loser)? Give a short daily grade A–F.
3. Co-pilot loop check — split the day's trades into FOLLOWED vs DIVERGED (vs the nearest co-pilot read before the trade opened). For the DIVERGED trades, this is the key learning: report each one's OUTCOME field (SL_hit / TP_hit / manual exit) and P&L, then draw the honest conclusion — did ignoring the co-pilot lead to stops or targets today? Also flag any trade where the trader FOLLOWED the co-pilot but it still lost (the co-pilot was wrong). Over time this teaches what to follow and what to trust your own read on. Be concrete: "สวนคำแนะนำ 2 ไม้ → โดน SL ทั้งคู่ (−$X)" or "สวน 1 ไม้ แต่ได้ TP (+$Y) — จังหวะนี้อ่านเองแม่นกว่า".
4. Co-pilot accuracy (INDEPENDENT of trades) — you also receive "copilot_accuracy": how each of today's co-pilot READS actually played out on the ATR ladder, whether or not the trader acted on it. Use it to grade the co-pilot ITSELF: hit_rate (of decided reads), how many STALLED (นิ่ง = read a move that never came) vs went AGAINST, what day_type the day turned out to be (BALANCE/NORMAL/TREND/OUTSIZED), and the directional lean (was the co-pilot too bull/bear vs what price did). Call out the pattern honestly, e.g. "co-pilot อ่าน buy 4/5 แต่วันทรงตัว → เอียง bull เกินไป โซนไม่วิ่ง" or "โซน sell ยืน 3/3 แม่น". This is observational — describe the tendency, don't overclaim from one day.
4a. Data health — "data_health" says whether today's numbers rest on complete data: atr_source (indicator vs computed), days_missing_atr, and a warn line. If warn is non-null or atr_source.computed outnumbers indicator, open the co-pilot section with ONE short Thai line saying the data is incomplete and the day-type/ATR numbers should not be trusted today (e.g. "⚠️ วันนี้ยังไม่มี ATR จริงจาก indicator — ตัวเลข day type ยังเชื่อไม่ได้"). Do not elaborate; one line, then continue.

4b. Plan replay — "copilot_accuracy.plan" grades what each read actually ADVISED: a pending order at the zone edge with SL and TP1 (entry = price reached the zone, then TP1 vs SL, first touch wins). This is the honest score for a "wait" read; the older verdict field is only a directional lean and is NOT the plan's result. Report it as plain counts in one or two lines (e.g. "แผนที่ราคามาถึงโซน 3 ไม้ · ถึง TP1 ก่อน 2 · โดน SL ก่อน 1 · ไม่ได้เข้า 4"). NO_FILL means price never came to the level — that is neither a win nor a loss, say so plainly. TP1 is scored as a FULL exit here (the "ปิด 50%" in a read is advice, not the measuring rule). For any WIN, "beyond_tp1_pts" is how far price kept running past TP1 before coming back to the entry price, and returned_to_entry false means it never came back that day — report it in one plain line when it is large (e.g. "ชนะ 2 ไม้ แต่ราคาไปต่ออีก ~530pt หลัง TP1 ทั้งคู่ ไม่ย้อนกลับมาที่ entry เลย") because it is the signal that targets are set too close. Do NOT call it a rule or an edge; it is a description of what happened. If plan.decided is 0, write one line: "ยังไม่มีแผนไหนที่ราคามาถึงโซนแล้วจบผล" and move on.

5. Factor attribution (ROLLING, multi-day) — you also receive "factor_attribution": across the last ~30 days, verdict counts grouped by the INGREDIENTS present at each read — call_vs_m15 (with/against the M15 bias), call_vs_fibo_leg, mario_fibo_aligned, bias_conflict (M15 vs M5), vp_bucket, zone_source (MT5/Fibo), zone_score, zone_state (fresh vs retested), zone_tag (BOS/CHoCH), session. HARD RULE — the data is far too thin to name an edge, and a confident wrong lesson is worse than no lesson: report this block as COUNTS ONLY (e.g. "ตามทิศ M15: ชนะ 3 แพ้ 1 · สวน: ชนะ 0 แพ้ 2"), never as a percentage, and NEVER call anything an edge, a rule, a trap, or a pattern. Any bucket with small_sample=true is omitted entirely. If "decided" across all reads is under 20, write exactly one line — "ยังเก็บข้อมูลอยู่ ยังสรุปไม่ได้" — plus the raw counts, and nothing more. Never fabricate a number not in the data. Reads with read_kind "manage" are excluded upstream (they advised no entry, so they are neither hit nor miss); if manage_reads is non-zero, mention in one short line how many reads were position-coaching rather than entry calls.
6. Lessons — 1–2 concrete, specific things to do differently tomorrow, and 1 note on how much to trust the co-pilot given today's accuracy + the strongest proven factor edge.
Be specific with numbers and levels. Thai output, mobile-readable, no filler.

FORMAT: NO per-position listing. The trader can see his own orders in the terminal and has asked for it removed — every line you write must be analysis. Because there is no list to point at, NEVER refer to a position by number ("#3"): name it inline the one time you cite it, e.g. "buy 4495.33 ถัวห่าง 501pt -83.25$". Cite only the positions that actually decided the day — usually two or three. Keep it glanceable on a phone.`;

// Per-trade review is BACK — but ONE tight line per trade, scannable like the
// plan (emoji + levels + short tags). Not paragraphs, not an ultra-short digest.
const REPORT_OUTPUT = `ตอบเป็นภาษาไทย อ่านง่ายบนมือถือ ห้าม markdown (** ## -).
ห้ามไล่รายการไม้/จังหวะทั้งวัน — เทรดเดอร์ดูออเดอร์เองได้จาก terminal อยู่แล้ว
ทุกบรรทัดต้องเป็น "การประเมิน" ไม่ใช่การรายงานว่าเทรดอะไรบ้าง
พูดถึงเฉพาะจังหวะที่ตัดสินผลของวันจริงๆ (ปกติ 2-3 จังหวะ) และเรียกชื่อไม้เต็มๆ ในบรรทัดนั้น
ใช้รูปแบบนี้:

⚡️ <2-3 บรรทัด: วันนี้ "อะไร" ตัดสินผล ไม่ใช่เล่าว่าเทรดอะไรบ้าง — จังหวะไหนทำเงิน/เสียเงินจริง (เรียกชื่อไม้เต็มๆ ในบรรทัด เช่น "buy 4495.33 ถัวห่าง 501pt -83.25$" ห้ามอ้างเป็นเลขลำดับ), ถ้าไม่มีจังหวะแย่ 1-2 อันนั้นวันนี้จะเป็นยังไง>

🎯 วินัย: <เกรด A-F> — <SL ครบกี่/กี่ไม้>
ถัวห่าง >500pt: <กี่จังหวะ> <รวม$> · ที่เหลือ: <กี่จังหวะ> <รวม$>
<1 บรรทัด: นิสัยถัวห่างวันนี้ได้หรือเสีย บอกเป็นเงิน ไม่ต้องสั่งสอนซ้ำ>

🤖 ตาม vs สวน
<สวน co-pilot: กี่ไม้ → โดน SL กี่ / ได้ TP กี่ · รวม$>
<ตาม co-pilot: กี่ไม้ → ผล · มีอันไหน co-pilot อ่านผิดไหม>
<สรุป 1 บรรทัด: วันนี้ควร "ตาม" หรือ "อ่านเอง">

🎯 แม่นของโคไพลอต (จาก copilot_accuracy · แยกจากการเทรด)
<อ่านกี่ครั้ง · เข้าเป้ากี่ / นิ่งกี่ / สวนกี่ · hit-rate% · วันนี้เป็นวันแบบไหน (ทรงตัว/เทรนด์)>
<1 บรรทัด: เอียง bull/bear เกินไปไหม · โซนไหนแม่น/พลาด>

📊 อะไรเวิร์ก (จาก factor_attribution · ~30 วัน)
<2-3 บรรทัด: ปัจจัยที่ชนะสูงสุด vs กับดัก เช่น "ตาม M15 ชนะ X% · สวน Fibo leg แพ้ Y%" ใส่ n กำกับ>
<ถ้า small_sample/ข้อมูลน้อย บอกตรงๆ 1 บรรทัดว่ายังเชื่อไม่ได้ แล้วข้ามส่วนที่เหลือ>

📌 พรุ่งนี้
<ข้อ 1: สิ่งที่ต้องทำต่างจากวันนี้ ชัดเจนพอที่จะทำตามได้จริง อ้างตัวเลขของวันนี้>
<ข้อ 2: อีกข้อ (ถ้ามีของจริง — ถ้าไม่มีอย่ายัด)>
<เชื่อโคไพลอตแค่ไหนจากวันนี้>`;

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

// ── position grouping ────────────────────────────────────────────────────────
// The trader deliberately opens SEVERAL orders on one idea so partial closes are
// easy. Those legs are ONE decision, and reporting them as N separate trades is
// what made the old report an unreadable 40-line dump with no insight in it.
//
// A position = consecutive same-side orders whose lifetimes overlap (a leg opened
// before the previous one closed). Within a position the ENTRY SPREAD tells the
// two apart, per the trader's own rule:
//   spread <= ADD_NEAR_PTS  -> "scaled"   : intended, split for partial exits
//   spread >  ADD_NEAR_PTS  -> "averaged" : adding at distance, the bad habit
// "adverse_adds" counts legs opened at a WORSE price than the running average
// (buy lower / sell higher) — averaging into a loser rather than pyramiding a
// winner. Both are computed here, not by the model: it is arithmetic, and making
// the model derive it is what blew the thinking budget.
const ADD_NEAR_PTS = 500;
const PT = 0.01;

function groupPositions(rows, signals) {
  const sorted = rows.slice().sort((a, b) => new Date(a.open_time) - new Date(b.open_time));
  const groups = [];
  for (const r of sorted) {
    const g = groups.find(g => g.side === r.side && new Date(r.open_time) < new Date(g.last_close));
    if (g) {
      g.legs.push(r);
      if (new Date(r.close_time) > new Date(g.last_close)) g.last_close = r.close_time;
    } else groups.push({ side: r.side, legs: [r], last_close: r.close_time });
  }
  return groups.map((g, i) => {
    const es = g.legs.map(l => l.entry).filter(v => v != null);
    const lots = g.legs.reduce((n, l) => n + (l.lots || 0), 0) || 1;
    const avgEntry = g.legs.reduce((n, l) => n + l.entry * (l.lots || 0), 0) / lots;
    const spread = es.length > 1 ? Math.round((Math.max(...es) - Math.min(...es)) / PT) : 0;
    let adverse = 0, run = g.legs[0].entry, runLots = g.legs[0].lots || 1;
    for (const l of g.legs.slice(1)) {
      if (g.side === 'buy' ? l.entry < run : l.entry > run) adverse++;
      run = (run * runLots + l.entry * (l.lots || 0)) / (runLots + (l.lots || 0));
      runLots += l.lots || 0;
    }
    const exits = { sl: 0, tp: 0, manual: 0 };
    for (const l of g.legs) {
      if (l.outcome === 'SL_hit') exits.sl++;
      else if (l.outcome === 'TP_hit') exits.tp++;
      else exits.manual++;
    }
    // nearest co-pilot read BEFORE the position opened → followed / diverged
    const openMs = new Date(g.legs[0].open_time).getTime();
    let read = null;
    for (const sg of signals) {
      const t = new Date(sg.ts).getTime();
      if (t <= openMs && (!read || t > new Date(read.ts).getTime())) read = sg;
    }
    // "No trade" is the co-pilot's most common call, and folding it into
    // "diverged" would conflate two different things: taking the opposite
    // direction to a directional call, versus trading at all when the co-pilot
    // said to stand aside. They carry different lessons, so they stay separate.
    const call = read ? String(read.bias_call || '').toLowerCase() : null;
    const isDir = call === 'buy' || call === 'sell';
    const alignment = !read ? 'no_read'
                    : !isDir ? 'advised_no_trade'
                    : call === g.side ? 'followed' : 'diverged';
    // Ready-to-quote citation. The model gets every field it would need to build
    // this itself, and on the first live run it built it WRONG three separate
    // ways: it called a 79pt scaled entry "ถัวห่าง", it flipped the sign on a
    // +19.85$ winner, and it mixed up orders with positions. So the string is
    // assembled here and the prompt tells it to copy this verbatim.
    const kindTh = g.legs.length === 1 ? 'เดี่ยว'
                 : (spread <= ADD_NEAR_PTS ? `ซอย ${g.legs.length} ไม้ ห่าง ${spread}pt`
                                           : `ถัวห่าง ${spread}pt`);
    const plUsd = round(g.legs.reduce((n, l) => n + l.pl_usd, 0), 2);
    const endTh = exits.sl ? (exits.sl === g.legs.length ? 'โดน SL' : `โดน SL ${exits.sl}/${g.legs.length} ไม้`)
                : exits.tp ? 'ได้ TP' : 'ปิดมือ';
    const cite = `${g.side} ${round(avgEntry, 2)} ${kindTh} ${plUsd >= 0 ? '+' : ''}${plUsd}$ · ${endTh}`;

    return {
      cite,
      n: i + 1, side: g.side, legs: g.legs.length, lots: round(lots, 2),
      avg_entry: round(avgEntry, 2), exit: g.legs[g.legs.length - 1].exit,
      spread_pts: spread,
      kind: g.legs.length === 1 ? 'single' : (spread <= ADD_NEAR_PTS ? 'scaled' : 'averaged'),
      adverse_adds: adverse,
      pl_usd: round(g.legs.reduce((n, l) => n + l.pl_usd, 0), 2),
      exits,
      had_sl_at_open: g.legs.every(l => l.had_sl_at_open),
      mfe_pts: Math.max(...g.legs.map(l => l.mfe_pts || 0)) || null,
      mae_pts: Math.max(...g.legs.map(l => l.mae_pts || 0)) || null,
      open: g.legs[0].open_time, close: g.last_close,
      held_min: Math.round((new Date(g.last_close) - new Date(g.legs[0].open_time)) / 60000),
      ctx: g.legs[0].ctx_at_trade,
      copilot: read ? { call, headline: read.headline, min_before: Math.round((openMs - new Date(read.ts).getTime()) / 60000) } : null,
      alignment,
    };
  });
}

async function runReport(db, opts = {}) {
  const sinceIso = dayStartIso(CFG.reportTzOffsetHours);
  const account = CFG.studyAccount;

  // Refresh the read outcomes first so the accuracy block grades today's reads —
  // including the last ones of the day — not a stale snapshot. Non-fatal.
  // …and keep the evaluator's health block: every failure mode in this pipeline
  // fails PLAUSIBLE rather than loud (a deactivated Pine alert, an EA that went
  // down, a day with no ATR row), so the report has to say when the numbers it is
  // about to quote are standing on thin data.
  let evalHealth = null;
  try {
    const ev = await runEval({ days: 2, write: true });
    evalHealth = ev && ev.body ? ev.body.health : null;
  } catch (e) { console.warn('runEval (report) failed (non-fatal):', e.message); }

  // Rolling factor attribution (which Mario/Fibo/ATR/session ingredients drove
  // wins) over a wider window — the "what works" learning layer. Non-fatal.
  let attribution = null;
  try {
    // Plan basis: the replayed pending order is what the read actually advised. The
    // lean basis grades a market order the prompt forbids, so it is not what the
    // trader should be shown.
    const r = await runAttribution({ days: CFG.attributionLookbackDays || 30, basis: 'plan' });
    if (r.status === 200 && r.body.ok) attribution = r.body;
  } catch (e) { console.warn('runAttribution (report) failed (non-fatal):', e.message); }

  const [trRes, evRes, sigRes, outRes] = await Promise.all([
    db.from('mt5_trades')
      .select('position_id, type, volume, open_time, close_time, open_price, close_price, sl, tp, profit, swap, commission, bias_m15, bias_m5, ob_status, mario_session, mario_decision')
      .eq('account_login', account).gte('close_time', sinceIso)
      .order('close_time', { ascending: true }).limit(CFG.reportMaxTrades),
    db.from('trade_events')
      .select('ticket, event, payload, created_at')
      .eq('account_login', account).gte('created_at', sinceIso)
      // newest-first: PostgREST caps ~1000 rows, so drop OLDEST if a busy day
      // overflows — never the recent events. Reversed to chronological below.
      .in('event', ['OPEN', 'MODIFY', 'CLOSE']).order('created_at', { ascending: false }).limit(2000),
    db.from('kp_signals')
      .select('ts, trigger_type, headline, bias_call, price, message')
      .gte('ts', sinceIso).order('ts', { ascending: true }).limit(60),
    db.from('kp_read_outcomes')
      .select('signal_id, read_ts, call, verdict, day_type, direction_actual, fav_atr, adv_atr, zone_behavior, behavior_note, meta')
      .gte('read_ts', sinceIso).order('read_ts', { ascending: true }).limit(60),
  ]);
  if (trRes.error) return { ok: false, error: 'mt5_trades read: ' + trRes.error.message };

  const trades = trRes.data || [];
  const signals = (sigRes.error ? [] : (sigRes.data || []));
  const outcomes = (outRes.error ? [] : (outRes.data || []));   // table may not exist pre-migration

  // index events by ticket → { open, close }
  const evByTicket = new Map();
  const evChrono = (evRes.error ? [] : (evRes.data || [])).slice().reverse();
  for (const ev of evChrono) {
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

  // group the orders into decisions, and score the trader's own netting rule:
  // does adding at distance actually cost money? Computed, never asserted.
  const positions = groupPositions(rows, signals);
  const avgPos = positions.filter(p => p.kind === 'averaged');
  const restPos = positions.filter(p => p.kind !== 'averaged');
  const sum = (a) => round(a.reduce((n, p) => n + p.pl_usd, 0), 2);
  const posWins = positions.filter(p => p.pl_usd >= 0).length;

  const summary = {
    orders: rows.length,
    positions: positions.length,
    net_usd: round(net, 2), wins, losses, winrate_pct: winrate,
    position_wins: posWins, position_losses: positions.length - posWins,
    gross_win_usd: round(grossWin, 2), gross_loss_usd: round(grossLoss, 2),
    no_sl_count: rows.filter(r => !r.had_sl_at_open).length,
    // pre-rendered so the model cannot mix up orders and positions here
    sl_coverage_text: `${rows.length - rows.filter(r => !r.had_sl_at_open).length}/${rows.length} ไม้`,
    // the netting scorecard — "averaged" = entries more than 500 pts apart
    netting: {
      threshold_pts: ADD_NEAR_PTS,
      averaged_positions: avgPos.length, averaged_net_usd: sum(avgPos),
      other_positions: restPos.length, other_net_usd: sum(restPos),
      worst_averaged_usd: avgPos.length ? Math.min(...avgPos.map(p => p.pl_usd)) : null,
      scaled_positions: positions.filter(p => p.kind === 'scaled').length,
    },
    adherence: {
      followed: positions.filter(p => p.alignment === 'followed').length,
      followed_net_usd: sum(positions.filter(p => p.alignment === 'followed')),
      diverged: positions.filter(p => p.alignment === 'diverged').length,
      diverged_net_usd: sum(positions.filter(p => p.alignment === 'diverged')),
      // co-pilot said stand aside and the trade was taken anyway — its own bucket
      advised_no_trade: positions.filter(p => p.alignment === 'advised_no_trade').length,
      advised_no_trade_net_usd: sum(positions.filter(p => p.alignment === 'advised_no_trade')),
      no_read: positions.filter(p => p.alignment === 'no_read').length,
      no_read_net_usd: sum(positions.filter(p => p.alignment === 'no_read')),
    },
  };

  const payload = {
    date: bkkDateLabel(CFG.reportTzOffsetHours), account, symbol: 'XAUUSD',
    day_window_start: sinceIso,
    summary,
    // positions, NOT raw orders: one decision per line. Raw legs are deliberately
    // NOT sent — 40 order objects cost ~8k tokens and taught the model nothing the
    // grouped view does not already say.
    positions,
    copilot_reads: signals.map(s => ({ time: s.ts, trigger: s.trigger_type, call: s.bias_call, headline: s.headline })),
    copilot_accuracy: outcomes.length ? copilotAccuracy(outcomes) : null,
    data_health: evalHealth,
    factor_attribution: attribution,   // rolling multi-day: which ingredients drove wins
    note: 'trader also trades independently of the co-pilot — grade every trade on merit, mark matched/diverged/no-read. copilot_accuracy grades the READS themselves on the ATR ladder, independent of whether the trader acted.',
  };

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CFG.reportModel || CFG.model,
    // Thinking is billed out of this same budget. On 2026-08-20 a 40-order day
    // produced output_tokens 2400 of which thinking_tokens 2400 — the model
    // reasoned right up to the ceiling and emitted NO text, so the report fell
    // back to a raw list. Grouping cut the input, and this ceiling gives the text
    // room even when a busy day needs real thinking.
    max_tokens: 6000,
    output_config: { effort: CFG.reportEffort },
    system: REPORT_SYSTEM,
    // compact JSON: pretty-printing this payload wasted ~25% of the input budget
    messages: [{ role: 'user', content: `${REPORT_OUTPUT}\n\nDAY DATA (JSON):\n${JSON.stringify(payload)}` }],
  });
  let body = '';
  for (const b of resp.content) if (b.type === 'text') body += b.text;
  body = body.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^\s*#{1,6}\s*/gm, '').replace(/^\s*[-*]\s+/gm, '').trim();

  // guard: never post a header-only message. If the model returned no text
  // (e.g. thinking consumed the whole budget), fall back to a compact per-trade
  // list built from the computed data so the report is still useful.
  if (!body) {
    console.warn('report: empty model text, stop_reason=', resp.stop_reason, 'usage=', JSON.stringify(resp.usage));
    const em = { buy: '🟢', sell: '🔴' };
    const lines = positions.map((p) => {
      const s = p.pl_usd >= 0 ? '+' : '';
      const tag = p.kind === 'averaged' ? ` · ถัวห่าง ${p.spread_pts}pt` : p.kind === 'scaled' ? ` · ซอย ${p.legs} ไม้` : '';
      return `${p.n}) ${em[p.side] || ''} ${p.side} ${p.avg_entry}→${p.exit} ${s}${p.pl_usd}$${tag}`;
    });
    const nt = summary.netting;
    body = `สรุปอัตโนมัติ (โมเดลไม่ส่งข้อความ)\n\n🔍 รายโพซิชัน (${rows.length} ไม้ = ${positions.length} จังหวะ)\n${lines.join('\n')}\n\n` +
           `🎯 SL ครบ ${rows.length - summary.no_sl_count}/${rows.length}\n` +
           `ถัวห่าง >${nt.threshold_pts}pt: ${nt.averaged_positions} จังหวะ ${nt.averaged_net_usd}$ · ที่เหลือ ${nt.other_positions} จังหวะ ${nt.other_net_usd}$`;
  }

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
    trades_count: summary.orders, net_usd: summary.net_usd, win_count: wins, loss_count: losses,
    summary, message: body, delivered_to: tg.ok ? ['telegram'] : [],
    meta: { model: CFG.reportModel || CFG.model, usage: resp.usage || null, telegram: tg.ok ? tg.message_id : tg.error, source: opts.source || 'cron' },
  }).select('id').single();
  if (insErr) console.warn('kp_reports insert failed (non-fatal):', insErr.message);
  else reportId = rec.id;

  return { ok: true, posted: tg.ok, report_id: reportId, summary, telegram: tg.ok ? tg.message_id : tg.error };
}

module.exports = { runReport };

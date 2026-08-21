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
UNITS, and be strict about them: "ไม้" = an ORDER (summary.orders), "จังหวะ" = a POSITION (summary.positions). summary.deals is the raw MT5 deal count and is NEVER quoted — a position closed in parts books several deals, and quoting it reports orders the trader never placed. They are different numbers and swapping them makes the report wrong. Quote summary.sl_coverage_text verbatim for SL coverage — do not build it yourself.

WHICH positions were decisive is ALREADY RANKED for you in summary.decisive (top_winners / top_losers, biggest first). Name only those. NEVER scan the positions list and pick your own "biggest" — on a previous run that produced a claim that the 3rd and 4th largest winners were the largest, because they happened to suit the narrative that had already been started. If the biggest winner contradicts the story you were about to tell, the story is wrong, not the number: say so.

WHEN YOU CITE A POSITION, COPY ITS "cite" FIELD VERBATIM. It already contains side, average entry, whether it was เดี่ยว / ซอย / ถัวห่าง, the P&L with its sign, and how it ended. Do not rebuild that string from the other fields and do not re-word it: on the first live run doing so produced three wrong labels in one report — a 79pt scaled entry called "ถัวห่าง", a +19.85$ winner written as "-19.85$ ชนะ", and orders counted as positions. Only "ถัวห่าง" positions are the bad habit; "ซอย" is the intended split and must never be described as ถัว.
An exit reading "โดน SL" is a real stop-out — a loss. "ปิดที่ BE/trail" is the OPPOSITE: the stop had already been moved to entry or beyond, so it fired at breakeven or in profit. NEVER describe a BE/trail exit as getting stopped out or as risk that materialised (on 2026-08-21 a +0.40$ trailed exit was written up as "โดน SL" and became the centrepiece of a risk story). exits.sl / exits.be / exits.tp carry the counts.

summary.adherence pre-splits followed / diverged / advised_no_trade / no_read with net USD for each — quote it rather than counting. "advised_no_trade" means the co-pilot said stand aside and the trade was taken anyway. Only ENTRY reads are advice: reads taken while a position was already open (adherence.manage_reads_excluded) are live-order coaching and are excluded from every bucket, exactly as the accuracy block excludes them — the two can no longer disagree. Advice also EXPIRES: a position whose nearest entry read was more than adherence.max_read_age_min minutes old is scored "no_read" (adherence.stale_read counts them). NEVER describe a no_read position as following or fighting the co-pilot — there was no live read to act on, and it is not evidence about whose read is better. If followed + diverged is 0, say in one line that the co-pilot made no directional entry call the trader could act on today, and do not draw a "ตามหรืออ่านเอง" verdict from a day with no calls in it. NEVER call these "สวนคำแนะนำ" — สวน is reserved for the "diverged" bucket, i.e. the co-pilot called a direction and the trader took the other one. Word it as "โคไพลอตบอกไม่เทรด แต่เข้าเอง N จังหวะ". That is NOT the same as trading against a directional call, and if those trades made money say so plainly — the co-pilot being too cautious is a finding about the CO-PILOT, not a discipline failure by the trader.

CRITICAL: the trader ALSO opens trades independently of the co-pilot's suggestions. Evaluate EVERY trade on its own merit. For each, note whether it MATCHED, DIVERGED FROM, or had NO co-pilot read at that time — and grade divergent trades fairly (an independent call can be right or wrong; say which).

Grade on:
1. The decisive positions — do NOT walk through every position. Find the two or three that actually moved the day's P&L (largest winners and losers, and any position whose loss exceeded several winners combined) and say WHY each went the way it did: with/against the captured bias, SL/TP placement, entry quality, and what MFE/MAE say about the management (profit left on the table, heat taken, how close to the stop). Name each one inline with side, avg entry and P&L. A position that neither made nor lost meaningful money does not deserve a sentence.
2. Discipline scorecard — was an SL always set, and HOW BIG was it? hold time reasonable? any averaging-down or revenge (ADD/HEDGE against a loser)? Give a short daily grade A–F.
   SL coverage only says a stop EXISTED. "summary.risk" says what it was worth: risk.worst is the position that put the most on the line (risk_usd, risk_pct of risk.equity_ref_usd, and the pl_usd it earned for carrying that), and risk.heavy lists every position that risked 10%+ of the account. QUOTE risk.worst in dollars AND percent whenever risk_pct >= 10, in the same sentence as what it made — "เสี่ยง X$ (Y% ของพอร์ต) เพื่อกำไร Z$" is the whole point. HARD RULE: if risk.worst.risk_pct >= 20 the grade cannot be above C, however complete SL coverage was; if >= 50 it cannot be above D. A day that made money on 60%-of-account risk is a day that got away with it, and the report must say so in those words rather than praising the P&L. risk.unbounded_positions counts positions with no stop at all — those are worse than any number here. risk_usd is the WIDEST stop the position ever carried, which is not what it opened with: risk.worst.risk_at_open_usd is that, and risk.widened lists every position whose stop was pushed FURTHER from entry after the trade was on (from_usd → to_usd). When risk.widened is non-empty that is the single most damning fact of the day and it goes in the discipline block in one line — "เปิดด้วย SL X$ แล้วขยายเป็น Y$ (Z% ของพอร์ต)" — because moving a stop away is the ถัวห่าง habit in its purest form: the risk was never the one that was accepted at entry. Grade on the widened number, never on the opening one.
3. Co-pilot loop check — split the day's trades into FOLLOWED vs DIVERGED (vs the nearest co-pilot read before the trade opened). For the DIVERGED trades, this is the key learning: report each one's OUTCOME field (SL_hit / TP_hit / manual exit) and P&L, then draw the honest conclusion — did ignoring the co-pilot lead to stops or targets today? Also flag any trade where the trader FOLLOWED the co-pilot but it still lost (the co-pilot was wrong). Over time this teaches what to follow and what to trust your own read on. Be concrete: "สวนคำแนะนำ 2 ไม้ → โดน SL ทั้งคู่ (−$X)" or "สวน 1 ไม้ แต่ได้ TP (+$Y) — จังหวะนี้อ่านเองแม่นกว่า".
4. Co-pilot accuracy (INDEPENDENT of trades) — you also receive "copilot_accuracy": how each of today's co-pilot READS actually played out on the ATR ladder, whether or not the trader acted on it. Use it to grade the co-pilot ITSELF: hit_rate (of decided reads), how many STALLED (นิ่ง = read a move that never came) vs went AGAINST, what day_type the day turned out to be (BALANCE/NORMAL/TREND/OUTSIZED), and the directional lean (was the co-pilot too bull/bear vs what price did). Call out the pattern honestly, e.g. "co-pilot อ่าน buy 4/5 แต่วันทรงตัว → เอียง bull เกินไป โซนไม่วิ่ง" or "โซน sell ยืน 3/3 แม่น". This is observational — describe the tendency, don't overclaim from one day.
4a. Data health — ONLY "data_health.today" describes today: it counts the ATR source behind today's own reads. If today.atr_from_indicator is FALSE, open the co-pilot section with ONE short Thai line saying today's day-type/ATR numbers are not trustworthy (e.g. "⚠️ วันนี้ยังไม่มี ATR จริงจาก indicator — ตัวเลข day type ยังเชื่อไม่ได้"), then continue — one line, no elaboration. If it is TRUE, say NOTHING about ATR data quality at all. The top-level warn / days_missing_atr / atr_source fields count days across the whole evaluation WINDOW, i.e. earlier days, and must never be reported as a problem with today: on 2026-08-21 every read was graded on the real indicator ATR and the report still opened by warning the trader off its own day-type.

4b. Plan replay — "copilot_accuracy.plan" grades what each read actually ADVISED: a pending order at the zone edge with SL and TP1 (entry = price reached the zone, then TP1 vs SL, first touch wins). This is the honest score for a "wait" read; the older verdict field is only a directional lean and is NOT the plan's result. Report it as plain counts in one or two lines (e.g. "แผนที่ราคามาถึงโซน 3 ไม้ · ถึง TP1 ก่อน 2 · โดน SL ก่อน 1 · ไม่ได้เข้า 4"). NO_FILL means price never came to the level — that is neither a win nor a loss, say so plainly. TP1 is scored as a FULL exit here (the "ปิด 50%" in a read is advice, not the measuring rule). For any WIN, "beyond_tp1_pts" is how far price kept running past TP1 before coming back to the entry price, and returned_to_entry false means it never came back that day — report it in one plain line when it is large (e.g. "ชนะ 2 ไม้ แต่ราคาไปต่ออีก ~530pt หลัง TP1 ทั้งคู่ ไม่ย้อนกลับมาที่ entry เลย") because it is the signal that targets are set too close. Do NOT call it a rule or an edge; it is a description of what happened. If plan.decided is 0, write one line: "ยังไม่มีแผนไหนที่ราคามาถึงโซนแล้วจบผล" and move on.

5. Factor attribution (ROLLING, multi-day) — you also receive "factor_attribution": across the last ~30 days, verdict counts grouped by the INGREDIENTS present at each read — call_vs_m15 (with/against the M15 bias), call_vs_fibo_leg, mario_fibo_aligned, bias_conflict (M15 vs M5), vp_bucket, zone_source (MT5/Fibo), zone_score, zone_state (fresh vs retested), zone_tag (BOS/CHoCH), session. HARD RULE — the data is far too thin to name an edge, and a confident wrong lesson is worse than no lesson: report this block as COUNTS ONLY (below 20 decided reads the hit-rate field is stripped from the data entirely and hit_rate_withheld says so — do NOT reconstruct the percentage yourself from win/loss, that is the same forbidden number by another route) (e.g. "ตามทิศ M15: ชนะ 3 แพ้ 1 · สวน: ชนะ 0 แพ้ 2"), never as a percentage, and NEVER call anything an edge, a rule, a trap, or a pattern. Any bucket with small_sample=true is omitted entirely. If "decided" across all reads is under 20, write exactly one line — "ยังเก็บข้อมูลอยู่ ยังสรุปไม่ได้" — plus the raw counts, and nothing more. Never fabricate a number not in the data. Reads with read_kind "manage" are excluded upstream (they advised no entry, so they are neither hit nor miss); if manage_reads is non-zero, mention in one short line how many reads were position-coaching rather than entry calls.
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
เสี่ยงหนักสุด: <cite ของ risk.worst> เสี่ยง <risk_usd>$ (<risk_pct>% ของพอร์ต) เพื่อ <pl_usd>$   ← ตัดบรรทัดนี้ทิ้งได้เฉพาะตอน risk_pct < 10 และ risk.widened ว่าง
<ถ้า risk.widened ไม่ว่าง: ขยาย SL: <cite> เปิด <from_usd>$ → <to_usd>$ (<to_pct>%)>
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

// ── deal → order ─────────────────────────────────────────────────────────────
// MT5 books one mt5_trades row per CLOSING DEAL, so a position closed in parts
// arrives as SEVERAL rows sharing one position_id. Counting those rows as orders
// inflates the day (22 "ไม้" for 21 real orders on 2026-08-21) and — worse — made
// groupPositions read a partial close as a scaled entry: "buy 4567.62 ซอย 2 ไม้
// ห่าง 0pt" was one 0.05 lot buy closed 0.03 + 0.02. A 0pt spread is the tell.
// Merge the deals back into the order they came from: volume and money add up,
// the exit is volume-weighted, the order lives until its LAST deal closes, and
// SL/TP come from that last deal. Context columns come from the earliest deal
// (later ones carry null *_open context), with any leftover nulls filled in from
// the rest. A position whose earlier parts closed on a previous day keeps only
// today's deals here — that is the report's day window, not a merge artifact.
function mergeDeals(trades) {
  const byPos = new Map();
  for (const t of trades) {
    const k = String(t.position_id);
    const prev = byPos.get(k);
    if (!prev) { byPos.set(k, { ...t }); continue; }
    const vPrev = num(prev.volume) || 0, vNew = num(t.volume) || 0, vTot = vPrev + vNew;
    for (const f of ['profit', 'swap', 'commission']) prev[f] = (num(prev[f]) || 0) + (num(t[f]) || 0);
    if (vTot) prev.close_price = round(((num(prev.close_price) || 0) * vPrev + (num(t.close_price) || 0) * vNew) / vTot, 2);
    prev.volume = round(vTot, 2);
    if (new Date(t.close_time) > new Date(prev.close_time)) {
      prev.close_time = t.close_time; prev.sl = t.sl; prev.tp = t.tp;
    }
    if (new Date(t.open_time) < new Date(prev.open_time)) prev.open_time = t.open_time;
    for (const [f, v] of Object.entries(t)) if (prev[f] == null && v != null) prev[f] = v;
  }
  return [...byPos.values()];
}

// Merge a closed trade (mt5_trades) with its OPEN/CLOSE study events by ticket.
function buildTrade(t, evByTicket) {
  const evs = evByTicket.get(String(t.position_id)) || {};
  const open = evs.open || null, close = evs.close || null;
  const pl = (num(t.profit) || 0) + (num(t.swap) || 0) + (num(t.commission) || 0);
  // how the trade ended — the key learning signal for "SL or TP?"
  const reason = close ? close.reason : null;
  // A stop sitting at or beyond entry is PROTECTION, not risk: when it fires the
  // trade ended at breakeven or better. Calling that "โดน SL" is how the report
  // for 2026-08-21 built a whole risk narrative on ticket 7292554177 — sell 4599,
  // stop trailed to 4598.92, closed +0.40$. Split it out so a real stop-out and a
  // trailed exit can never read the same.
  const slPx = num(t.sl) || null;
  const entryPx = num(t.open_price);
  const stopProtected = reason === 'sl' && slPx != null && entryPx
    ? (t.type === 'buy' ? slPx >= entryPx : slPx <= entryPx)
    : false;
  const outcome = reason === 'sl' ? (stopProtected ? 'SL_be' : 'SL_hit')
                : reason === 'tp' ? 'TP_hit'
                : reason === 'stopout' ? 'stopout'
                : reason ? ('manual_' + reason)              // desktop/mobile/web = hand-closed
                : (pl >= 0 ? 'manual_win' : 'manual_loss');  // no close event logged → infer by P&L
  // The stop that mattered is not the one it opened with. On 2026-08-21 the
  // 8-leg ถัวห่าง basket opened every leg with a ~5.50$ stop (220$ across the
  // basket, 8.6% of the account) and then pushed the stops OUT to 4620.37 as
  // price went against it — 1,579.90$, 61.6%. Measuring at open reports the
  // small number and hides the habit the risk block exists to expose, so take
  // the stop that sat FURTHEST on the losing side across the trade's whole life:
  // the opening stop, every MODIFY, and the stop it finally closed with.
  // Distance is signed by side, so a stop parked in profit counts as no risk
  // rather than as risk equal to the locked-in gain.
  const adverse = (sl) => (sl && entryPx) ? (t.type === 'buy' ? entryPx - sl : sl - entryPx) : null;
  const stops = [];
  if (open && num(open.sl)) stops.push({ sl: num(open.sl), src: 'open' });
  for (const m of (evs.mods || [])) if (num(m.sl)) stops.push({ sl: num(m.sl), src: 'modify' });
  if (num(t.sl)) stops.push({ sl: num(t.sl), src: 'close' });
  let worst = null;
  for (const c of stops) if (!worst || adverse(c.sl) > adverse(worst.sl)) worst = c;

  const heldMin = (t.open_time && t.close_time)
    ? Math.round((new Date(t.close_time) - new Date(t.open_time)) / 60000)
    : (close && close.held_sec != null ? Math.round(close.held_sec / 60) : null);
  return {
    ticket: t.position_id, side: t.type, lots: num(t.volume),
    entry: num(t.open_price), exit: num(t.close_price),
    sl: num(t.sl) || null, tp: num(t.tp) || null,
    pl_usd: round(pl, 2),
    outcome,                                 // SL_hit / SL_be / TP_hit / manual_* / stopout
    mfe_pts: close ? num(close.mfe_pts) : null,
    mae_pts: close ? num(close.mae_pts) : null,
    held_min: heldMin,
    close_reason: reason,
    had_sl_at_open: open ? (num(open.sl) > 0) : (num(t.sl) > 0),
    // the stop as first placed — what the trade actually risked. mt5_trades.sl is
    // the LAST known stop, so on a trailed trade it understates the heat carried.
    sl_at_open: open ? (num(open.sl) || null) : null,
    sl_worst: worst ? worst.sl : null,        // furthest stop on the losing side
    sl_worst_src: worst ? worst.src : null,   // open / modify / close
    balance_after: num(t.balance_after) || null,
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

// ── which reads count as advice ──────────────────────────────────────────────
// A read taken while a position was already open is live-order COACHING: it
// advises no entry, so it cannot be "followed" or "diverged from". The accuracy
// block already excludes those (read_kind "manage"); the adherence split did not,
// and on 2026-08-21 the day's ONLY directional call was a manage read — which the
// report then used to score three trades as "ตาม co-pilot" while the accuracy
// block, reading the same row, threw it away. Same rule in both places now
// (mirrors _kp_eval.js: sig.meta.read_kind, falling back to positions.count).
function isEntryRead(sg) {
  const m = sg && sg.meta;
  const kind = (m && m.read_kind) || ((m && m.positions && m.positions.count) ? 'manage' : 'entry');
  return kind !== 'manage';
}
// ── what a position actually risked ──────────────────────────────────────────
// "SL ครบ 22/22 ไม้" grades whether a stop EXISTS. It says nothing about how big
// it is, and on 2026-08-21 that produced a discipline grade of B on a day whose
// worst position would have given back 1,580$ — 62% of a 2,546$ account — to earn
// 17.70$. Risk is arithmetic, so it is computed here: stop distance × lots × the
// contract multiplier, per leg, summed over the position. Measured from the stop
// as FIRST placed where the study log has it (sl_at_open), else the last known
// stop — which, on a trade whose stop was trailed up, understates the real heat.
const USD_PER_DOLLAR_PER_LOT = CFG.usdPerDollarPerLot || 100;
// Money at risk if THIS stop had been hit. Signed by side, floored at zero: a
// stop sitting in profit is protection, not exposure.
function riskAt(l, sl) {
  if (!sl || !l.entry || !l.lots) return null;      // no stop → risk is not bounded
  const adverse = l.side === 'buy' ? (l.entry - sl) : (sl - l.entry);
  return Math.max(0, adverse) * l.lots * USD_PER_DOLLAR_PER_LOT;
}
// What the leg actually carried (worst stop it ever had) vs what it was opened
// with. The GAP between them is the finding: a stop moved away is the ถัวห่าง
// habit made visible, and it is invisible in either number on its own.
const legRisk     = (l) => riskAt(l, l.sl_worst || l.sl_at_open || l.sl);
const legRiskOpen = (l) => riskAt(l, l.sl_at_open || l.sl_worst || l.sl);

// …and advice expires. Beyond this the nearest read is not what the trader acted
// on, it is just the last row in the table before his trade.
const READ_MAX_AGE_MIN = CFG.reportMaxReadAgeMin || 90;

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
    const exits = { sl: 0, be: 0, tp: 0, manual: 0 };
    for (const l of g.legs) {
      if (l.outcome === 'SL_hit') exits.sl++;
      else if (l.outcome === 'SL_be') exits.be++;      // stop fired at/above entry
      else if (l.outcome === 'TP_hit') exits.tp++;
      else exits.manual++;
    }
    // nearest co-pilot ENTRY read BEFORE the position opened → followed / diverged
    const openMs = new Date(g.legs[0].open_time).getTime();
    let read = null;
    for (const sg of signals) {
      if (!isEntryRead(sg)) continue;
      const t = new Date(sg.ts).getTime();
      if (t <= openMs && (!read || t > new Date(read.ts).getTime())) read = sg;
    }
    const readAgeMin = read ? Math.round((openMs - new Date(read.ts).getTime()) / 60000) : null;
    const readStale = read ? readAgeMin > READ_MAX_AGE_MIN : false;
    // "No trade" is the co-pilot's most common call, and folding it into
    // "diverged" would conflate two different things: taking the opposite
    // direction to a directional call, versus trading at all when the co-pilot
    // said to stand aside. They carry different lessons, so they stay separate.
    const call = read ? String(read.bias_call || '').toLowerCase() : null;
    const isDir = call === 'buy' || call === 'sell';
    // a stale read is not advice the trader could have acted on → no_read
    const alignment = (!read || readStale) ? 'no_read'
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
    const n = g.legs.length;
    const endParts = [];
    if (exits.sl) endParts.push(exits.sl === n ? 'โดน SL' : `โดน SL ${exits.sl}/${n} ไม้`);
    if (exits.be) endParts.push(exits.be === n ? 'ปิดที่ BE/trail' : `ปิดที่ BE/trail ${exits.be}/${n} ไม้`);
    if (exits.tp) endParts.push(exits.tp === n ? 'ได้ TP' : `ได้ TP ${exits.tp}/${n} ไม้`);
    const endTh = endParts.length ? endParts.join(' · ') : 'ปิดมือ';
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
      risk_usd: g.legs.some(l => legRisk(l) == null) ? null
              : round(g.legs.reduce((sum, l) => sum + legRisk(l), 0), 2),
      risk_at_open_usd: g.legs.some(l => legRiskOpen(l) == null) ? null
              : round(g.legs.reduce((sum, l) => sum + legRiskOpen(l), 0), 2),
      // where the worst stop came from: the entry, a later move, or the exit
      risk_basis: [...new Set(g.legs.map(l => l.sl_worst_src).filter(Boolean))].join('+') || 'none',
      had_sl_at_open: g.legs.every(l => l.had_sl_at_open),
      mfe_pts: Math.max(...g.legs.map(l => l.mfe_pts || 0)) || null,
      mae_pts: Math.max(...g.legs.map(l => l.mae_pts || 0)) || null,
      open: g.legs[0].open_time, close: g.last_close,
      held_min: Math.round((new Date(g.last_close) - new Date(g.legs[0].open_time)) / 60000),
      ctx: g.legs[0].ctx_at_trade,
      copilot: read ? { call, headline: read.headline, min_before: readAgeMin, stale: readStale } : null,
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
    // The prompt bans percentages here in capitals ("COUNTS ONLY") because the
    // sample is far too thin to carry one — and the report printed "hit 23% ·
    // hit 25% · hit 14% · hit 33%" anyway, off n=6 and n=7. It was printing what
    // it was handed. Below the reporting threshold the field simply does not
    // travel: a number that must not be shown should not be in the payload.
    if (attribution && (attribution.decided || 0) < 20) {
      for (const buckets of Object.values(attribution.dims || {})) {
        for (const b of buckets) delete b.hit_rate_pct;
      }
      attribution.hit_rate_withheld = 'sample below 20 decided reads';
    }
  } catch (e) { console.warn('runAttribution (report) failed (non-fatal):', e.message); }

  const [trRes, evRes, sigRes, outRes] = await Promise.all([
    db.from('mt5_trades')
      .select('position_id, type, volume, open_time, close_time, open_price, close_price, sl, tp, profit, swap, commission, balance_after, bias_m15, bias_m5, ob_status, mario_session, mario_decision')
      .eq('account_login', account).gte('close_time', sinceIso)
      .order('close_time', { ascending: true }).limit(CFG.reportMaxTrades),
    db.from('trade_events')
      .select('ticket, event, payload, created_at')
      .eq('account_login', account).gte('created_at', sinceIso)
      // newest-first: PostgREST caps ~1000 rows, so drop OLDEST if a busy day
      // overflows — never the recent events. Reversed to chronological below.
      .in('event', ['OPEN', 'MODIFY', 'CLOSE']).order('created_at', { ascending: false }).limit(2000),
    db.from('kp_signals')
      .select('ts, trigger_type, headline, bias_call, price, message, meta')   // meta.read_kind → isEntryRead
      .gte('ts', sinceIso).order('ts', { ascending: true }).limit(60),
    db.from('kp_read_outcomes')
      .select('signal_id, read_ts, call, verdict, day_type, direction_actual, fav_atr, adv_atr, zone_behavior, behavior_note, atr_source, meta')
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
    // MODIFY was fetched and thrown away. It carries every stop the trade ever
    // had, which is the only way to see a stop being MOVED AWAY — see sl_worst.
    if (ev.event === 'MODIFY') (rec.mods = rec.mods || []).push(ev.payload || {});
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

  // deals → orders first: several rows can share one position_id (partial close)
  const orders = mergeDeals(trades);
  const rows = orders.map(t => buildTrade(t, evByTicket));
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

  // Account size for the risk block: the balance the day actually ended on.
  // trades come back close_time-ascending, so the last non-null wins.
  let equityRef = null;
  for (const t of trades) if (num(t.balance_after)) equityRef = num(t.balance_after);
  const pctOf = (usd) => (equityRef && usd != null) ? round((usd / equityRef) * 100, 1) : null;
  for (const p of positions) {
    p.risk_pct = pctOf(p.risk_usd);
    p.risk_at_open_pct = pctOf(p.risk_at_open_usd);
    // stop moved away from entry after the trade was on — the habit, in one flag
    p.stop_widened_usd = (p.risk_usd != null && p.risk_at_open_usd != null)
      ? round(p.risk_usd - p.risk_at_open_usd, 2) : null;
  }
  const byRisk = positions.filter(p => p.risk_usd != null).sort((a, b) => b.risk_usd - a.risk_usd);

  const summary = {
    orders: rows.length,
    deals: trades.length,          // > orders when a position was closed in parts
    positions: positions.length,
    net_usd: round(net, 2), wins, losses, winrate_pct: winrate,
    position_wins: posWins, position_losses: positions.length - posWins,
    gross_win_usd: round(grossWin, 2), gross_loss_usd: round(grossLoss, 2),
    no_sl_count: rows.filter(r => !r.had_sl_at_open).length,
    // pre-rendered so the model cannot mix up orders and positions here
    sl_coverage_text: `${rows.length - rows.filter(r => !r.had_sl_at_open).length}/${rows.length} ไม้`,
    // The decisive positions, RANKED HERE. On the second live run the model
    // ranked them itself and named the 3rd and 4th biggest winners as "the
    // biggest" — because they were the two that fitted the story it had already
    // started telling (that the day was won by small single entries). The actual
    // top earner was a 6-leg scaled position and the runner-up an averaged one,
    // which cut against that narrative. Ranking is arithmetic; it is done here.
    decisive: {
      top_winners: positions.slice().sort((a, b) => b.pl_usd - a.pl_usd).slice(0, 3)
        .filter(p => p.pl_usd > 0).map(p => ({ cite: p.cite, pl_usd: p.pl_usd })),
      top_losers: positions.slice().sort((a, b) => a.pl_usd - b.pl_usd).slice(0, 3)
        .filter(p => p.pl_usd < 0).map(p => ({ cite: p.cite, pl_usd: p.pl_usd })),
    },
    // the netting scorecard — "averaged" = entries more than 500 pts apart
    netting: {
      threshold_pts: ADD_NEAR_PTS,
      averaged_positions: avgPos.length, averaged_net_usd: sum(avgPos),
      other_positions: restPos.length, other_net_usd: sum(restPos),
      worst_averaged_usd: avgPos.length ? Math.min(...avgPos.map(p => p.pl_usd)) : null,
      scaled_positions: positions.filter(p => p.kind === 'scaled').length,
    },
    // What the day RISKED, not what it made. A stop that exists but is sized at a
    // fifth of the account is not discipline, and the SL-coverage line cannot see
    // that. worst = the position that had the most on the line, with what it earned
    // for carrying it — the two numbers belong in one sentence.
    risk: {
      equity_ref_usd: equityRef,
      usd_per_dollar_per_lot: USD_PER_DOLLAR_PER_LOT,
      worst: byRisk.length ? {
        cite: byRisk[0].cite, risk_usd: byRisk[0].risk_usd,
        risk_pct: byRisk[0].risk_pct, pl_usd: byRisk[0].pl_usd,
        lots: byRisk[0].lots, basis: byRisk[0].risk_basis,
        risk_at_open_usd: byRisk[0].risk_at_open_usd,
        risk_at_open_pct: byRisk[0].risk_at_open_pct,
        stop_widened_usd: byRisk[0].stop_widened_usd,
      } : null,
      // every position that put 10%+ of the account on the line, biggest first
      heavy: byRisk.filter(p => p.risk_pct != null && p.risk_pct >= 10)
        .map(p => ({ cite: p.cite, risk_usd: p.risk_usd, risk_pct: p.risk_pct, pl_usd: p.pl_usd })),
      // positions whose stop was pushed further from entry after opening, worst first
      widened: positions.filter(p => p.stop_widened_usd != null && p.stop_widened_usd > 0)
        .sort((a, b) => b.stop_widened_usd - a.stop_widened_usd)
        .map(p => ({ cite: p.cite, from_usd: p.risk_at_open_usd, to_usd: p.risk_usd,
                     to_pct: p.risk_pct, pl_usd: p.pl_usd })),
      unbounded_positions: positions.filter(p => p.risk_usd == null).length,
      total_risk_usd: round(byRisk.reduce((n, p) => n + p.risk_usd, 0), 2),
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
      // why a position can land in no_read even though reads exist
      max_read_age_min: READ_MAX_AGE_MIN,
      stale_read: positions.filter(p => p.copilot && p.copilot.stale).length,
      manage_reads_excluded: signals.filter(s => !isEntryRead(s)).length,
    },
  };

  // evalHealth.warn counts days across the whole evaluation window, so on 2026-08-21
  // it said "1/3 days have no ATR row" and the report opened the co-pilot section by
  // telling the trader today's day-type could not be trusted — while every one of
  // that day's reads had been graded on the real indicator ATR. The missing day was
  // an EARLIER one. So the report gets a block that only describes TODAY, built from
  // the ATR source recorded on today's own reads.
  const todaySrc = {};
  for (const o of outcomes) todaySrc[o.atr_source || 'none'] = (todaySrc[o.atr_source || 'none'] || 0) + 1;
  const dataHealth = (evalHealth || outcomes.length) ? {
    ...(evalHealth || {}),
    today: {
      reads: outcomes.length,
      atr_source: todaySrc,
      // true = every read today was graded on the indicator's real ATR
      atr_from_indicator: outcomes.length > 0 && (todaySrc.indicator || 0) === outcomes.length,
    },
  } : null;

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
    data_health: dataHealth,
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
           `🎯 SL ครบ ${rows.length - summary.no_sl_count}/${rows.length}` +
           (summary.risk.worst ? ` · เสี่ยงหนักสุด ${summary.risk.worst.risk_usd}$ (${summary.risk.worst.risk_pct}%) เพื่อ ${summary.risk.worst.pl_usd}$` : '') + `\n` +
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

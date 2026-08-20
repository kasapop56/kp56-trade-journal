// js/copilot.js — KP56 Trading Co-pilot (Phase 1: live merged market state)
//
// Reads the two LIVE ingest tables via the anon `db` client (same pattern as
// fibo.js) and merges them into one market-state view:
//   market_sitreps  → MT5 Mario: bias, POC/VAH/VAL, scored supply/demand zones
//   fibo_snapshots  → TradingView Fibo: S (sell-above) / B (buy-below) levels
// Then renders a header, a price-anchored zone ladder, and the co-pilot's
// commentary feed (kp_signals). No server call needed to READ — the dashboard
// subscribes to Supabase Realtime for live refresh.
//
// Phases 2/3 (trigger engine + Claude analysis + Telegram) write kp_signals;
// this page just displays them. The "อ่านให้หน่อย" button calls /api/analyze/now
// once that route exists (Phase 3) and degrades gracefully until then.

let _cpInit = false;
let _cpChannel = null;

// ── small local helpers (self-contained; no cross-file globals) ──────────────
function cpNum(v, d = 2) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function cpFmt(v, d = 2) {
  const n = cpNum(v);
  return n === null ? '–' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function cpAgeMin(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}
function cpBkkTime(iso) {
  const t = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
function cpAgeLabel(min) {
  if (min == null) return 'ไม่มีข้อมูล';
  if (min < 1) return 'เมื่อกี้';
  if (min < 60) return `${min} นาทีก่อน`;
  const h = Math.floor(min / 60);
  return `${h} ชม.${min % 60 ? ' ' + (min % 60) + ' น.' : ''}ก่อน`;
}
function cpFreshClass(min) {
  if (min == null) return 'cp-stale';
  if (min <= 20) return 'cp-fresh';
  if (min <= 90) return 'cp-aging';
  return 'cp-stale';
}
function cpBiasClass(b) {
  const s = String(b || '').toLowerCase();
  if (s.startsWith('bull') || s.startsWith('buy') || s === 'up') return 'cp-bull';
  if (s.startsWith('bear') || s.startsWith('sell') || s === 'down') return 'cp-bear';
  return 'cp-flat';
}

// Reference price = whichever snapshot (SITREP / Fibo) is MOST RECENT, not always
// the SITREP (which can be an hour stale while Fibo just redrew near the live tick).
function cpFreshestPrice(sitrep, fibo, live) {
  const cand = [];
  if (cpNum(live?.price) != null) cand.push({ px: cpNum(live.price), at: live.ts });
  if (cpNum(sitrep?.price) != null) cand.push({ px: cpNum(sitrep.price), at: sitrep.created_at });
  if (cpNum(fibo?.price) != null) cand.push({ px: cpNum(fibo.price), at: fibo.created_at });
  if (!cand.length) return null;
  cand.sort((a, b) => new Date(b.at) - new Date(a.at));
  return cand[0].px;
}

// ── data load ────────────────────────────────────────────────────────────────
async function cpLoadLatest() {
  const [sitRes, fiboRes, sigRes, priceRes, outRes] = await Promise.all([
    db.from('market_sitreps')
      .select('id, created_at, symbol, price, bias_m15, bias_m5, vp_position, poc, vah, val, ppoc, pvah, pval, supply_zones, demand_zones')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('fibo_snapshots')
      .select('id, created_at, symbol, price, active_side, s_focus, s_test, s_tp1, s_sl, b_focus, b_test, b_tp1, b_sl, fh, fl, mid')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('kp_signals')
      .select('*')
      .order('ts', { ascending: false }).limit(30),
    db.from('kp_price').select('symbol, price, ts').order('ts', { ascending: false }).limit(1).maybeSingle(),
    db.from('kp_read_outcomes')
      .select('signal_id, verdict, day_type, direction_actual, fav_atr, adv_atr, zone_behavior, behavior_note, meta')
      .order('read_ts', { ascending: false }).limit(30),
  ]);
  if (sitRes.error && sitRes.error.code !== 'PGRST116') throw sitRes.error;
  if (fiboRes.error && fiboRes.error.code !== 'PGRST116') throw fiboRes.error;
  // kp_signals / kp_price / kp_read_outcomes may not exist until the migration is run — treat "table missing" as empty.
  const signals = (sigRes.error && sigRes.error.code === '42P01') ? [] : (sigRes.data || []);
  const live = (priceRes && !priceRes.error) ? (priceRes.data || null) : null;
  const outcomes = new Map();
  if (!outRes.error) for (const o of (outRes.data || [])) outcomes.set(o.signal_id, o);
  return { sitrep: sitRes.data || null, fibo: fiboRes.data || null, signals, live, outcomes };
}

// Verdict → compact Thai badge (how the READ actually played out on the ATR ladder).
function cpVerdictBadge(o) {
  if (!o) return '';
  const map = {
    WIN:        ['✅ เข้าเป้า', 'cp-vd-win'],
    LOSS:       ['❌ สวน', 'cp-vd-loss'],
    STALL:      ['⏸ นิ่ง', 'cp-vd-stall'],
    PARTIAL:    ['◐ บางส่วน', 'cp-vd-partial'],
    OK_NOTRADE: ['✅ ไม่เทรดถูก', 'cp-vd-win'],
    MISSED:     ['· พลาดจังหวะ', 'cp-vd-partial'],
    // a read taken while a position was open = coaching the trade you already had,
    // not an entry call → it is neither a hit nor a miss
    MANAGE:     ['🧾 คุมไม้', 'cp-vd-pending'],
    // price moved, but never came to the level the read said to wait for
    NO_ENTRY_OFFERED: ['✅ ไม่มีจังหวะให้เข้า', 'cp-vd-win'],
    UNGRADEABLE:['— อ่านไม่ออก', 'cp-vd-pending'],
    PENDING:    ['⏳ รอผล', 'cp-vd-pending'],
    EXPIRED:    ['— หมดวัน', 'cp-vd-pending'],
    NO_BARS:    ['— ไม่มีแท่ง', 'cp-vd-pending'],
  };
  const [label, cls] = map[o.verdict] || [o.verdict, 'cp-vd-pending'];
  const title = o.behavior_note ? ` title="${String(o.behavior_note).replace(/"/g, '&quot;')}"` : '';
  let out = `<span class="cp-vd ${cls}"${title}>${label}</span>`;
  // Plan replay is the score for what the read ADVISED (a pending order at the zone),
  // as opposed to the badge above, which is only the directional lean. Shown next to
  // it, never instead of it.
  const pr = o.meta && o.meta.plan_replay, pv = o.meta && o.meta.plan_verdict;
  if (pv) {
    const pmap = {
      WIN:      ['🎯 แผนเข้าเป้า', 'cp-vd-win'],
      LOSS:     ['🎯 แผนโดน SL', 'cp-vd-loss'],
      NO_FILL:  ['🎯 ราคาไม่มาถึงโซน', 'cp-vd-pending'],
      OPEN_END: ['🎯 เข้าแล้วค้าง', 'cp-vd-stall'],
      PENDING:  ['🎯 รอราคามา', 'cp-vd-pending'],
      NO_LEVELS:['🎯 ไม่มี SL/TP', 'cp-vd-pending'],
    };
    const [pl, pc] = pmap[pv] || [pv, 'cp-vd-pending'];
    const rr = (pr && pr.rr1) ? ` · RR ${pr.rr1}` : '';
    out += ` <span class="cp-vd ${pc}" title="แผนที่อ่านให้ไว้ (รอที่โซน + SL/TP)${rr}">${pl}</span>`;
  }
  return out;
}

// Merge the two sources into a price-anchored ladder of levels.
// Supply (sell) levels sit ABOVE price; demand (buy) levels BELOW.
function cpBuildLadder(sitrep, fibo, price) {
  const levels = [];

  // MT5 scored zones (ranges) — richest source: tier, score, confluence tags.
  const pushZones = (arr, side) => {
    for (const z of (arr || [])) {
      const lo = cpNum(z.lo), hi = cpNum(z.hi);
      if (lo == null || hi == null) continue;
      levels.push({
        side, source: 'MT5', mid: (lo + hi) / 2, lo, hi,
        score: z.score ?? null, tier: z.tier ?? null,
        tags: Array.isArray(z.tags) ? z.tags : [],
        label: `${cpFmt(lo)}–${cpFmt(hi)}`,
      });
    }
  };
  if (sitrep) {
    pushZones(sitrep.supply_zones, 'supply');
    pushZones(sitrep.demand_zones, 'demand');
  }

  // Fibo single-price entry lines (Focus = primary, Test = aggressive).
  if (fibo) {
    const fpush = (px, side, name) => {
      const n = cpNum(px);
      if (n == null) return;
      levels.push({ side, source: 'Fibo', mid: n, lo: n, hi: n, score: null, tier: name, tags: [name], label: cpFmt(n) });
    };
    fpush(fibo.s_focus, 'supply', 'S·Focus');
    fpush(fibo.s_test,  'supply', 'S·Test');
    fpush(fibo.b_focus, 'demand', 'B·Focus');
    fpush(fibo.b_test,  'demand', 'B·Test');
  }

  // POC / VAH / VAL as reference lines (not tradable edges).
  const refs = [];
  if (sitrep) {
    if (cpNum(sitrep.vah) != null) refs.push({ ref: 'VAH', mid: cpNum(sitrep.vah) });
    if (cpNum(sitrep.poc) != null) refs.push({ ref: 'POC', mid: cpNum(sitrep.poc) });
    if (cpNum(sitrep.val) != null) refs.push({ ref: 'VAL', mid: cpNum(sitrep.val) });
  }

  // nearest actionable edges to price
  let nearestSupply = null, nearestDemand = null;
  if (price != null) {
    const sup = levels.filter(l => l.side === 'supply' && l.mid > price).sort((a, b) => a.mid - b.mid);
    const dem = levels.filter(l => l.side === 'demand' && l.mid < price).sort((a, b) => b.mid - a.mid);
    nearestSupply = sup[0] || null;
    nearestDemand = dem[0] || null;
  }

  return { levels, refs, nearestSupply, nearestDemand };
}

// ── render ───────────────────────────────────────────────────────────────────
function cpRenderHeader(sitrep, fibo, live) {
  const price = cpFreshestPrice(sitrep, fibo, live);
  const sitAge = cpAgeMin(sitrep?.created_at);
  const fibAge = cpAgeMin(fibo?.created_at);
  const liveAge = cpAgeMin(live?.ts);
  const sym = sitrep?.symbol || fibo?.symbol || 'XAUUSD';

  const biasChip = (label, val) =>
    `<span class="cp-bias ${cpBiasClass(val)}">${label} <b>${val || '–'}</b></span>`;

  return `
    <div class="cp-header">
      <div class="cp-price-row">
        <div class="cp-symbol">${sym}</div>
        <div class="cp-price">${price == null ? '–' : cpFmt(price)}</div>
      </div>
      <div class="cp-bias-row">
        ${biasChip('M15', sitrep?.bias_m15)}
        ${biasChip('M5', sitrep?.bias_m5)}
        ${sitrep?.vp_position ? `<span class="cp-vp">${sitrep.vp_position}</span>` : ''}
      </div>
      <div class="cp-fresh-row">
        ${live ? `<span class="cp-pill ${cpFreshClass(liveAge)}">Live · ${cpAgeLabel(liveAge)}</span>` : ''}
        <span class="cp-pill ${cpFreshClass(sitAge)}">MT5 · ${cpAgeLabel(sitAge)}</span>
        <span class="cp-pill ${cpFreshClass(fibAge)}">Fibo · ${cpAgeLabel(fibAge)}</span>
      </div>
    </div>`;
}

function cpRenderLadder(ladder, price) {
  // Build one sorted column: levels + ref lines + a PRICE marker, price-desc.
  const rows = [];
  for (const l of ladder.levels) rows.push({ kind: 'zone', sort: l.mid, l });
  for (const r of ladder.refs)   rows.push({ kind: 'ref',  sort: r.mid, r });
  if (price != null) rows.push({ kind: 'price', sort: price });
  rows.sort((a, b) => b.sort - a.sort);

  const near = ladder;
  const rowHtml = (row) => {
    if (row.kind === 'price') {
      return `<div class="cp-ladder-row cp-now"><span class="cp-now-dot"></span>ราคาปัจจุบัน <b>${cpFmt(price)}</b></div>`;
    }
    if (row.kind === 'ref') {
      return `<div class="cp-ladder-row cp-ref"><span class="cp-ref-tag">${row.r.ref}</span><span class="cp-ref-px">${cpFmt(row.r.mid)}</span></div>`;
    }
    const l = row.l;
    const isNear = (l === near.nearestSupply) || (l === near.nearestDemand);
    const scoreBadge = l.score != null ? `<span class="cp-score">${l.tier ? l.tier + ':' : ''}${l.score}</span>` : `<span class="cp-src">${l.source}</span>`;
    const tags = (l.tags || []).slice(0, 5).map(t => `<span class="cp-tag">${t}</span>`).join('');
    return `<div class="cp-ladder-row cp-${l.side}${isNear ? ' cp-near' : ''}">
        <div class="cp-lvl-main">${scoreBadge}<span class="cp-lvl-px">${l.label}</span></div>
        <div class="cp-lvl-tags">${tags}</div>
      </div>`;
  };

  return `<div class="cp-ladder">${rows.map(rowHtml).join('') || '<div class="cp-empty">ยังไม่มี zone</div>'}</div>`;
}

function cpTriggerBadge(t) {
  const map = {
    zone_entry:      ['เข้าโซน', 'cp-tb-zone'],
    sweep_reclaim:   ['กวาด+กลับ', 'cp-tb-sweep'],
    confluence_flip: ['bias พลิก', 'cp-tb-flip'],
    momentum_flag:   ['โมเมนตัม', 'cp-tb-mom'],
    manual:          ['สั่งเอง', 'cp-tb-manual'],
  };
  const [label, cls] = map[t] || [t, 'cp-tb-manual'];
  return `<span class="cp-tb ${cls}">${label}</span>`;
}

function cpRenderFeed(signals, outcomes) {
  if (!signals.length) {
    return `<div class="cp-feed-empty">
      ยังไม่มีคอมเมนต์จากโคไพลอต — Phase 1 แสดง market state สด ๆ<br>
      Phase 3 (trigger + Claude) จะเริ่มพิมพ์ที่นี่เมื่อถึงจังหวะสำคัญ
    </div>`;
  }
  const out = outcomes || new Map();
  return signals.map(s => {
    const bias = s.bias_call ? `<span class="cp-bias ${cpBiasClass(s.bias_call)}">${s.bias_call}</span>` : '';
    const delivered = (s.delivered_to || []).map(d => `<span class="cp-deliv">${d === 'telegram' ? '📨 TG' : '🖥️ Dash'}</span>`).join('');
    const msg = String(s.message || '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    const o = out.get(s.id);
    const note = (o && o.behavior_note) ? `<div class="cp-sig-outcome">📈 ${String(o.behavior_note).replace(/</g, '&lt;')}</div>` : '';
    return `<div class="cp-sig">
      <div class="cp-sig-top">
        ${cpTriggerBadge(s.trigger_type)}
        ${bias}
        ${cpVerdictBadge(o)}
        ${s.price != null ? `<span class="cp-sig-px">@ ${cpFmt(s.price)}</span>` : ''}
        <span class="cp-sig-time">${cpBkkTime(s.ts)}</span>
      </div>
      ${s.headline ? `<div class="cp-sig-head">${String(s.headline).replace(/</g, '&lt;')}</div>` : ''}
      <div class="cp-sig-msg">${msg}</div>
      ${note}
      ${delivered ? `<div class="cp-sig-deliv">${delivered}</div>` : ''}
    </div>`;
  }).join('');
}

// Kick the read evaluator (replay → kp_read_outcomes), fire-and-forget, throttled.
// Mirrors fibo.js's tab-render trigger — no cron. The realtime subscription then
// repaints the feed with the fresh verdict badges when the upsert lands.
let _cpEvalAt = 0;
function cpKickEval() {
  if (Date.now() - _cpEvalAt < 60000) return;   // at most once per minute
  _cpEvalAt = Date.now();
  fetch('/api/fibo-eval?target=reads&write=1&days=7')
    .then(r => r.json())
    .then(d => cpShowHealth(d && d.health))
    .catch(() => { /* offline / cold start */ });
}

// Surface the evaluator's health where it is actually seen. Every failure here is
// silent by nature — a Pine alert that stopped firing, an EA that went down — so
// clean-looking verdict badges can sit on top of missing data indefinitely.
function cpShowHealth(h) {
  const root = document.getElementById('copilotBody');
  if (!root) return;
  const old = document.getElementById('cpHealth');
  if (old) old.remove();
  if (!h || !h.warn) return;
  const src = h.atr_source || {};
  const el = document.createElement('div');
  el.id = 'cpHealth';
  el.className = 'cp-health';
  el.textContent = `⚠️ ข้อมูลยังไม่ครบ · ${h.warn}` +
    (src.computed ? ` · ATR จริง ${src.indicator || 0} / ประมาณเอง ${src.computed}` : '');
  root.prepend(el);
}

// Debounced repaint for the outcomes realtime feed. A batch upsert emits many row
// events; coalesce them into one re-render (which itself won't re-fire the eval —
// cpKickEval is throttled — so there's no loop).
let _cpFeedTimer = null;
function cpRenderFeedOnly() {
  clearTimeout(_cpFeedTimer);
  _cpFeedTimer = setTimeout(cpRender, 400);
}

async function cpRender() {
  const root = document.getElementById('copilotBody');
  if (!root) return;
  cpKickEval();
  try {
    const { sitrep, fibo, signals, live, outcomes } = await cpLoadLatest();
    if (!sitrep && !fibo) {
      root.innerHTML = `<div class="cp-empty">ยังไม่มีข้อมูล market state (รอ SITREP / Fibo webhook แรก)</div>`;
      return;
    }
    const price = cpFreshestPrice(sitrep, fibo, live);
    const ladder = cpBuildLadder(sitrep, fibo, price);

    // nearest-edge summary line
    const ns = ladder.nearestSupply, nd = ladder.nearestDemand;
    const nearLine = `
      <div class="cp-near">
        <div class="cp-near-cell cp-supply">▲ Supply ใกล้สุด<br><b>${ns ? ns.label : '–'}</b>${ns && ns.score != null ? ` <span class="cp-score">${ns.score}</span>` : ''}</div>
        <div class="cp-near-cell cp-demand">▼ Demand ใกล้สุด<br><b>${nd ? nd.label : '–'}</b>${nd && nd.score != null ? ` <span class="cp-score">${nd.score}</span>` : ''}</div>
      </div>`;

    root.innerHTML =
      cpRenderHeader(sitrep, fibo, live) +
      nearLine +
      `<h3 class="cp-sub">Zone Ladder</h3>` +
      cpRenderLadder(ladder, price) +
      `<h3 class="cp-sub">คอมเมนต์โคไพลอต</h3>` +
      cpRenderFeed(signals, outcomes);
  } catch (e) {
    root.innerHTML = `<div class="cp-empty">โหลดไม่สำเร็จ: ${String(e.message || e)}</div>`;
  }
}

// ── manual "read now" — Phase 3 endpoint; degrade gracefully until it exists ──
async function cpReadNow() {
  const btn = document.getElementById('cpReadNow');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังอ่าน…'; }
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual: true }),
    });
    if (r.status === 404) {
      showToast('ยังไม่ได้สร้าง /api/analyze (Phase 3)', 'error');
    } else {
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.fired) showToast('โคไพลอตอ่านแล้ว ✓', 'success');
      else if (j.ok && !j.fired) showToast('อ่านแล้ว — ' + (j.reason || 'ไม่มีสัญญาณ'), '');
      else showToast('ผิดพลาด: ' + (j.error || r.status), 'error');
      await cpRender();
    }
  } catch (e) {
    showToast('เรียกไม่สำเร็จ: ' + String(e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 อ่านให้หน่อย'; }
  }
}

// ── nightly report on demand ─────────────────────────────────────────────────
async function cpReportNow() {
  const btn = document.getElementById('cpReport');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ สรุป…'; }
  try {
    const r = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual: true }),
    });
    if (r.status === 404) { showToast('ยังไม่ได้ deploy /api/report', 'error'); return; }
    const j = await r.json().catch(() => ({}));
    if (j.ok && j.posted) showToast('ส่งรายงานเข้า Telegram แล้ว 🌙', 'success');
    else if (j.ok && !j.posted) showToast('วันนี้ยังไม่มีเทรด', '');
    else showToast('ผิดพลาด: ' + (j.error || r.status), 'error');
  } catch (e) {
    showToast('เรียกไม่สำเร็จ: ' + String(e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌙 รายงานวันนี้'; }
  }
}

// ── realtime + init ──────────────────────────────────────────────────────────
function cpSubscribe() {
  if (_cpChannel) return;
  _cpChannel = db.channel('kp_copilot')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'kp_signals' }, cpRender)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'market_sitreps' }, cpRender)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fibo_snapshots' }, cpRender)
    // verdict badges land here after the evaluator upserts — repaint the feed.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kp_read_outcomes' }, cpRenderFeedOnly)
    .subscribe();
}

function initCopilotPage() {
  cpRender();
  if (_cpInit) return;
  _cpInit = true;
  document.getElementById('cpReadNow')?.addEventListener('click', cpReadNow);
  document.getElementById('cpReport')?.addEventListener('click', cpReportNow);
  document.getElementById('cpRefresh')?.addEventListener('click', cpRender);
  cpSubscribe();
}

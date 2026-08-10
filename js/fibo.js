// js/fibo.js — Fibo Focus snapshot log + Win/Loss (Phase 8 / 8b / 8c)
// Reads fibo_snapshots (frames drawn) + fibo_outcomes (per-#/side status derived
// by /api/fibo-eval, which replays stored levels against the BAR price feed).
// On each render it first pings the evaluator so outcomes are fresh, then reads
// them via the anon `db` client from app.js. Tracks ALL frames — including ones a
// newer frame superseded — so old #'s still resolve to WIN/LOSS if price gets there.

let _fiboInit = false;
let _fiboDay  = 'today';   // 'today' | '7' | 'all'

// ── Bangkok day helpers (UTC+7, no DST) ──────────────────────────────────────
function bkkDayStartUTC(daysBack = 0) {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  bkk.setUTCHours(0, 0, 0, 0);
  bkk.setUTCDate(bkk.getUTCDate() - daysBack);
  return new Date(bkk.getTime() - 7 * 3600 * 1000);
}
function bkkTimeStr(iso) {
  const t = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
function bkkDateStr(iso) {
  const t = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${t.getUTCDate()}/${t.getUTCMonth() + 1}`;
}
function fnum(v, d = 2) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-';
}

// ── Data load ────────────────────────────────────────────────────────────────
function rangeGte(q) {
  if (_fiboDay === 'today')  return q.gte('created_at', bkkDayStartUTC(0).toISOString());
  if (_fiboDay === '7')      return q.gte('created_at', bkkDayStartUTC(6).toISOString());
  return q.limit(300);
}

// Ask the server to (re)derive outcomes from stored # levels + the BAR price
// feed. Non-fatal: if the table is missing or the feed is down, we still render
// whatever outcomes already exist. Fire-and-await so the read below is fresh.
async function triggerEval() {
  try { await fetch('/api/fibo-eval?write=1&days=60'); } catch (_) { /* offline / cold start */ }
}

async function loadFiboData() {
  const [snapRes, outRes] = await Promise.all([
    rangeGte(db.from('fibo_snapshots').select('*').order('created_at', { ascending: false })),
    db.from('fibo_outcomes').select('*'),
  ]);
  if (snapRes.error) throw snapRes.error;
  if (outRes.error && outRes.error.code !== '42P01') throw outRes.error; // ignore "table missing" pre-migration
  const outcomes = {};
  for (const o of (outRes.data || [])) outcomes[Number(o.frame_id) + '|' + o.side] = o;
  return { rows: snapRes.data || [], outcomes };
}

// Status for one (frame, side), read from the derived outcomes map.
// Values: pending (zone not touched) · entered · win · loss. Every recorded
// frame is tracked — no VOID inference; an old frame stays PENDING until its
// zone is touched, exactly what "track old # too" asks for.
function sideStatus(row, side, outcomes) {
  const o = outcomes[Number(row.bar_time) + '|' + side];
  return o ? o.status : 'pending';
}

// ── Session + day-star classification (per frame) ────────────────────────────
// Session boundaries mirror app.js deriveSession() (UTC-hour based). We use the
// frame's bar_time (exchange ms-epoch, UTC) when present, else created_at.
const FB_STARS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
function frameEpoch(r) {
  const bt = Number(r.bar_time);
  return Number.isFinite(bt) && bt > 0 ? bt : Date.parse(r.created_at);
}
function frameSession(r) {
  const h = new Date(frameEpoch(r)).getUTCHours();
  if (h < 6) return 'ASIA';
  if (h < 12) return 'LONDON';
  if (h < 16) return 'OVERLAP';
  if (h < 21) return 'NY';
  return 'QUIET';
}
function frameStar(r) {
  const dow = new Date(frameEpoch(r) + 7 * 3600 * 1000).getUTCDay(); // Bangkok day
  return FB_STARS[dow];
}

const STATUS = {
  win:     ['✅ ชนะ',   'fb-win'],
  loss:    ['❌ แพ้',    'fb-loss'],
  entered: ['🎯 เข้า',   'fb-open'],
  pending: ['⏳ รอ',    'fb-pend'],
  void:    ['⚪ ไม่เข้า', 'fb-void'],
};
function badge(st) {
  const [txt, cls] = STATUS[st] || STATUS.void;
  return `<span class="fb-badge ${cls}">${txt}</span>`;
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderFiboStats(rows, outcomes) {
  const el = document.getElementById('fiboStats');
  if (!el) return;
  let wins = 0, losses = 0, open = 0;
  for (const r of rows) for (const side of ['S', 'B']) {
    const st = sideStatus(r, side, outcomes);
    if (st === 'win') wins++; else if (st === 'loss') losses++; else if (st === 'entered') open++;
  }
  const decided = wins + losses;
  const wr = decided ? Math.round((wins / decided) * 100) : null;
  el.innerHTML = `
    <div class="fibo-stat"><div class="fs-num">${rows.length}</div><div class="fs-lbl">กรอบ</div></div>
    <div class="fibo-stat"><div class="fs-num fs-win">${wins}</div><div class="fs-lbl">ชนะ</div></div>
    <div class="fibo-stat"><div class="fs-num fs-loss">${losses}</div><div class="fs-lbl">แพ้</div></div>
    <div class="fibo-stat"><div class="fs-num">${wr === null ? '–' : wr + '%'}</div><div class="fs-lbl">Winrate</div></div>
    <div class="fibo-stat"><div class="fs-num">${Math.max(open, 0)}</div><div class="fs-lbl">เปิดอยู่</div></div>`;
}

// ── Breakdown: W/L grouped by session and by day-star ────────────────────────
// Walk every (frame, side); count only decided outcomes (win/loss). Group key is
// taken from the FRAME, so both sides of one frame share its session/star.
function fiboBreakdownGroups(rows, outcomes) {
  const bySession = {}, byStar = {};
  const bump = (map, key) => (map[key] || (map[key] = { win: 0, loss: 0 }));
  for (const r of rows) {
    const sess = frameSession(r), star = frameStar(r);
    for (const side of ['S', 'B']) {
      const st = sideStatus(r, side, outcomes);
      if (st !== 'win' && st !== 'loss') continue;
      bump(bySession, sess)[st]++;
      bump(byStar, star)[st]++;
    }
  }
  return { bySession, byStar };
}

function fiboBreakdownTable(title, map, order) {
  const keys = (order || Object.keys(map)).filter(k => map[k]);
  if (!keys.length) return '';
  let rows = '';
  for (const k of keys) {
    const g = map[k], dec = g.win + g.loss;
    const wr = dec ? Math.round((g.win / dec) * 100) : 0;
    const cls = wr >= 50 ? 'fb-wr-good' : 'fb-wr-bad';
    rows += `<tr>
      <td>${k}</td>
      <td class="fb-bd-num fs-win">${g.win}</td>
      <td class="fb-bd-num fs-loss">${g.loss}</td>
      <td class="fb-bd-num ${cls}">${wr}%</td></tr>`;
  }
  return `<div class="fibo-bd-table">
    <div class="fibo-bd-title">${title}</div>
    <table><thead><tr><th>${title.includes('ดาว') ? 'วัน' : 'Session'}</th>
      <th>ชนะ</th><th>แพ้</th><th>WR</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function renderFiboBreakdown(rows, outcomes) {
  const el = document.getElementById('fiboBreakdown');
  if (!el) return;
  const { bySession, byStar } = fiboBreakdownGroups(rows, outcomes);
  const hasAny = Object.keys(bySession).length || Object.keys(byStar).length;
  if (!hasAny) { el.innerHTML = ''; return; } // stay quiet until W/L data exists
  const sessTbl = fiboBreakdownTable('แยกตาม Session', bySession,
    ['ASIA', 'LONDON', 'OVERLAP', 'NY', 'QUIET']);
  const starTbl = fiboBreakdownTable('แยกตามดาว ⭐', byStar, FB_STARS);
  el.innerHTML = sessTbl + starTbl;
}

function getO(r, side, outcomes) {
  return outcomes[Number(r.bar_time) + '|' + side] || null;
}
// The entry level the evaluator used (Focus 2.0 or Test 1.272 per entry_mode).
function entryLvl(r, side) {
  const focusMode = (r.entry_mode || '').indexOf('Test') < 0;
  if (side === 'S') return Number(focusMode ? r.s_focus : r.s_test);
  return Number(focusMode ? r.b_focus : r.b_test);
}
// Extent line: how far the trade ran (deepest TP reached by MFE) + how much heat
// it took against it (MAE, in points). Only for sides that actually entered.
function extentLine(r, side, o) {
  if (!o || o.status === 'pending') return '';
  const tp = o.best_tp > 0 ? 'TP' + o.best_tp : '<TP1';
  let mae = '';
  if (o.mae != null) {
    const lvl = entryLvl(r, side);
    const pts = (side === 'S' ? o.mae - lvl : lvl - o.mae) / 0.01;
    mae = ' · ทน ' + Math.max(0, Math.round(pts)) + 'p';
  }
  return `<div class="fibo-extent">ไกลสุด ${tp}${mae}</div>`;
}

function fiboCard(r, sO, bO) {
  const sSt = sO ? sO.status : 'pending';
  const bSt = bO ? bO.status : 'pending';
  return `
  <div class="fibo-card">
    <div class="fibo-card-head">
      <span class="fibo-seq">#${r.seq ?? '?'}</span>
      <span class="fibo-sym">${r.symbol}${r.tf ? ' · TF' + r.tf : ''}</span>
      <span class="fibo-mode">${r.entry_mode || ''}${r.zone_pts != null ? ' · ±' + r.zone_pts + 'p' : ''}</span>
      <span class="fibo-time">${bkkDateStr(r.created_at)} ${bkkTimeStr(r.created_at)}</span>
    </div>
    <div class="fibo-card-body">
      <div class="fibo-side fibo-sell">
        <div class="fibo-side-h">🔴 S ขาย ${badge(sSt)}</div>
        ${extentLine(r, 'S', sO)}
        <div class="fibo-lv"><span>Focus</span><b>${fnum(r.s_focus)}</b></div>
        <div class="fibo-lv"><span>Test</span><b>${fnum(r.s_test)}</b></div>
        <div class="fibo-lv"><span>TP1</span><b>${fnum(r.s_tp1)}</b></div>
        <div class="fibo-lv"><span>TP3</span><b>${fnum(r.s_tp3)}</b></div>
        <div class="fibo-lv fibo-sl"><span>SL</span><b>${fnum(r.s_sl)}</b></div>
      </div>
      <div class="fibo-mid">
        <div class="fibo-lv"><span>0/px</span><b>${fnum(r.price)}</b></div>
        <div class="fibo-lv"><span>Mid</span><b>${fnum(r.mid)}</b></div>
        <div class="fibo-lv"><span>H</span><b>${fnum(r.fh)}</b></div>
        <div class="fibo-lv"><span>L</span><b>${fnum(r.fl)}</b></div>
      </div>
      <div class="fibo-side fibo-buy">
        <div class="fibo-side-h">🟢 B ซื้อ ${badge(bSt)}</div>
        ${extentLine(r, 'B', bO)}
        <div class="fibo-lv"><span>Focus</span><b>${fnum(r.b_focus)}</b></div>
        <div class="fibo-lv"><span>Test</span><b>${fnum(r.b_test)}</b></div>
        <div class="fibo-lv"><span>TP1</span><b>${fnum(r.b_tp1)}</b></div>
        <div class="fibo-lv"><span>TP3</span><b>${fnum(r.b_tp3)}</b></div>
        <div class="fibo-lv fibo-sl"><span>SL</span><b>${fnum(r.b_sl)}</b></div>
      </div>
    </div>
  </div>`;
}

async function renderFibo() {
  const list = document.getElementById('fiboList');
  if (list) list.innerHTML = '<div class="fibo-empty">กำลังโหลด…</div>';
  try {
    await triggerEval();
    const { rows, outcomes } = await loadFiboData();
    renderFiboStats(rows, outcomes);
    renderFiboBreakdown(rows, outcomes);
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<div class="fibo-empty">ยังไม่มีกรอบในช่วงนี้ — พอ Pine ตีกรอบใหม่จะเด้งเข้ามาเอง</div>';
      return;
    }
    list.innerHTML = rows.map(r =>
      fiboCard(r, getO(r, 'S', outcomes), getO(r, 'B', outcomes))
    ).join('');
  } catch (e) {
    if (list) list.innerHTML = `<div class="fibo-empty">โหลดไม่สำเร็จ: ${e.message}</div>`;
  }
}

// ── Init (called by navigate('fibo') in app.js) ──────────────────────────────
function initFiboPage() {
  if (!_fiboInit) {
    _fiboInit = true;
    document.querySelectorAll('#fibo [data-fday]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#fibo [data-fday]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _fiboDay = btn.dataset.fday;
        renderFibo();
      });
    });
    const refresh = document.getElementById('fiboRefresh');
    if (refresh) refresh.addEventListener('click', renderFibo);
  }
  renderFibo();
}

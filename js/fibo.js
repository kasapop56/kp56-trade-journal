// js/fibo.js — Fibo Focus snapshot log + Win/Loss (Phase 8 / 8b)
// Reads fibo_snapshots (frames drawn) + fibo_events (ENTER/WIN/LOSS lifecycle),
// both written by /api/fibo-snapshot. Uses `db` from app.js (anon key).

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

async function loadFiboData() {
  const [snapRes, evtRes] = await Promise.all([
    rangeGte(db.from('fibo_snapshots').select('*').order('created_at', { ascending: false })),
    rangeGte(db.from('fibo_events').select('*').order('created_at', { ascending: true })),
  ]);
  if (snapRes.error) throw snapRes.error;
  if (evtRes.error && evtRes.error.code !== '42P01') throw evtRes.error; // ignore "table missing" pre-migration
  return { rows: snapRes.data || [], events: evtRes.data || [] };
}

// Reduce events for one (frame, side) into a status.
// win > loss > entered; else pending (newest frame) / void (older, never entered).
function sideStatus(row, side, events, newestBarTime) {
  const evs = events.filter(e => Number(e.frame_id) === Number(row.bar_time) && e.side === side);
  if (evs.some(e => e.event === 'WIN'))  return 'win';
  if (evs.some(e => e.event === 'LOSS')) return 'loss';
  if (evs.some(e => e.event === 'ENTER')) return 'entered';
  return Number(row.bar_time) === Number(newestBarTime) ? 'pending' : 'void';
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
function renderFiboStats(rows, events) {
  const el = document.getElementById('fiboStats');
  if (!el) return;
  const wins   = events.filter(e => e.event === 'WIN').length;
  const losses = events.filter(e => e.event === 'LOSS').length;
  const open   = events.filter(e => e.event === 'ENTER').length - wins - losses;
  const decided = wins + losses;
  const wr = decided ? Math.round((wins / decided) * 100) : null;
  el.innerHTML = `
    <div class="fibo-stat"><div class="fs-num">${rows.length}</div><div class="fs-lbl">กรอบ</div></div>
    <div class="fibo-stat"><div class="fs-num fs-win">${wins}</div><div class="fs-lbl">ชนะ</div></div>
    <div class="fibo-stat"><div class="fs-num fs-loss">${losses}</div><div class="fs-lbl">แพ้</div></div>
    <div class="fibo-stat"><div class="fs-num">${wr === null ? '–' : wr + '%'}</div><div class="fs-lbl">Winrate</div></div>
    <div class="fibo-stat"><div class="fs-num">${Math.max(open, 0)}</div><div class="fs-lbl">เปิดอยู่</div></div>`;
}

function fiboCard(r, sSt, bSt) {
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
    const { rows, events } = await loadFiboData();
    renderFiboStats(rows, events);
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<div class="fibo-empty">ยังไม่มีกรอบในช่วงนี้ — พอ Pine ตีกรอบใหม่จะเด้งเข้ามาเอง</div>';
      return;
    }
    const newest = rows.reduce((m, r) => Math.max(m, Number(r.bar_time) || 0), 0);
    list.innerHTML = rows.map(r =>
      fiboCard(r, sideStatus(r, 'S', events, newest), sideStatus(r, 'B', events, newest))
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

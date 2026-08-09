// js/fibo.js — Fibo Focus snapshot log
// Reads fibo_snapshots (written by /api/fibo-snapshot from the Pine indicator).
// Uses `db` from app.js (already initialized). Record only — no Win/Loss yet.

let _fiboInit = false;
let _fiboDay  = 'today';   // 'today' | '7' | 'all'

// ── Bangkok day helpers (UTC+7, no DST) ──────────────────────────────────────
function bkkDayStartUTC(daysBack = 0) {
  // 00:00 Bangkok, `daysBack` days ago, expressed as a UTC Date.
  const now  = new Date();
  const bkk  = new Date(now.getTime() + 7 * 3600 * 1000);
  bkk.setUTCHours(0, 0, 0, 0);
  bkk.setUTCDate(bkk.getUTCDate() - daysBack);
  return new Date(bkk.getTime() - 7 * 3600 * 1000);
}

function bkkTimeStr(iso) {
  const t = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
async function loadFiboRows() {
  let q = db.from('fibo_snapshots').select('*').order('created_at', { ascending: false });
  if (_fiboDay === 'today')  q = q.gte('created_at', bkkDayStartUTC(0).toISOString());
  else if (_fiboDay === '7') q = q.gte('created_at', bkkDayStartUTC(6).toISOString());
  else                       q = q.limit(300);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderFiboStats(rows) {
  const el = document.getElementById('fiboStats');
  if (!el) return;
  const total = rows.length;
  const days  = new Set(rows.map(r => bkkDateStr(r.created_at))).size;
  const syms  = new Set(rows.map(r => r.symbol)).size;
  el.innerHTML = `
    <div class="fibo-stat"><div class="fs-num">${total}</div><div class="fs-lbl">กรอบ</div></div>
    <div class="fibo-stat"><div class="fs-num">${days}</div><div class="fs-lbl">วัน</div></div>
    <div class="fibo-stat"><div class="fs-num">${syms}</div><div class="fs-lbl">สัญลักษณ์</div></div>`;
}

function fiboCard(r) {
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
        <div class="fibo-side-h">🔴 S ขาย</div>
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
        <div class="fibo-side-h">🟢 B ซื้อ</div>
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
    const rows = await loadFiboRows();
    renderFiboStats(rows);
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<div class="fibo-empty">ยังไม่มีกรอบในช่วงนี้ — พอ Pine ตีกรอบใหม่จะเด้งเข้ามาเอง</div>';
      return;
    }
    list.innerHTML = rows.map(fiboCard).join('');
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

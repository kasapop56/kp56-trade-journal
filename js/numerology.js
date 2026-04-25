// js/numerology.js — Thai astrology numerology dashboard
// Reads trade_ideas (day_star, entry_pair_middle, total_pnl, session) via Supabase.
// Uses `db` from app.js (already initialized).

const NUM_STARS = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];

let _numRows  = null;   // raw rows cache (all sessions)
let _numClock = null;
let _numSession = 'ALL'; // active session filter

// ── Bangkok time (UTC+7, no DST) ─────────────────────────────────────────────
function bkkNow() {
  const t = new Date();
  return new Date(t.getTime() + 7 * 3600 * 1000);
}
function nowInfo() {
  const t = bkkNow();
  const h = t.getUTCHours(), m = t.getUTCMinutes(), dow = t.getUTCDay();
  return {
    timeStr: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
    star: NUM_STARS[dow],
    pair: (h % 10) * 10 + Math.floor(m / 10),
  };
}

// ── Data load ─────────────────────────────────────────────────────────────────
async function loadNumRows() {
  if (_numRows) return _numRows;
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await db.from('trade_ideas')
      .select('day_star,entry_pair_middle,total_pnl,session')
      .not('day_star', 'is', null)
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  _numRows = rows;
  return rows;
}

// ── Compute stats (with optional session filter) ──────────────────────────────
function computeNumStats(rows, session = 'ALL') {
  const filtered = session === 'ALL' ? rows : rows.filter(r => r.session === session);
  const starStats = {}, pairStats = {};
  for (const row of filtered) {
    const pnl = parseFloat(row.total_pnl);
    if (!row.day_star || isNaN(pnl)) continue;
    if (!starStats[row.day_star]) starStats[row.day_star] = { trades:0, win:0, loss:0, totalPnl:0 };
    const ss = starStats[row.day_star];
    ss.trades++; ss.totalPnl += pnl;
    pnl > 0 ? ss.win++ : pnl < 0 ? ss.loss++ : null;
    const p = row.entry_pair_middle;
    if (p == null) continue;
    if (!pairStats[p]) pairStats[p] = { trades:0, win:0, loss:0, totalPnl:0 };
    const ps = pairStats[p];
    ps.trades++; ps.totalPnl += pnl;
    pnl > 0 ? ps.win++ : pnl < 0 ? ps.loss++ : null;
  }
  return { starStats, pairStats };
}

// ── Colors ────────────────────────────────────────────────────────────────────
function cellBg(avg) {
  if (avg == null) return 'rgba(36,36,36,1)';
  if (avg >= 0) { const t = Math.min(avg / 12, 1); return `rgba(38,166,154,${0.12 + t * 0.55})`; }
  const t = Math.min(Math.abs(avg) / 60, 1);
  return `rgba(239,83,80,${0.12 + t * 0.55})`;
}
function pnlStr(avg, def = '—') {
  if (avg == null) return def;
  return (avg >= 0 ? '+' : '') + avg.toFixed(1);
}
function pnlColorVar(v) { return v >= 0 ? 'var(--bull)' : 'var(--bear)'; }

// ── Render: NOW panel ─────────────────────────────────────────────────────────
function renderNow(starStats, pairStats) {
  const { timeStr, star, pair } = nowInfo();
  document.getElementById('numTime').textContent = timeStr;
  document.getElementById('numStar').textContent = 'ดาว' + star;
  document.getElementById('numPairNum').textContent = String(pair).padStart(2,'0');

  const ss = starStats[star];
  const starEl = document.getElementById('numStarStat');
  if (ss && ss.trades > 0) {
    const wl = ss.win + ss.loss;
    const pct = wl > 0 ? (ss.win/wl*100).toFixed(0) : '—';
    const avg = ss.totalPnl / ss.trades;
    starEl.innerHTML = `<span>${ss.trades} trades</span><span>Win <b>${pct}%</b></span><span style="color:${pnlColorVar(avg)}">Avg <b>${pnlStr(avg)}</b></span>`;
  } else { starEl.textContent = 'ไม่มีข้อมูล'; }

  const ps = pairStats[pair];
  const pairEl = document.getElementById('numPairStat');
  if (ps && ps.trades > 0) {
    const wl = ps.win + ps.loss;
    const pct = wl > 0 ? (ps.win/wl*100).toFixed(0) : '—';
    const avg = ps.totalPnl / ps.trades;
    pairEl.innerHTML = `<span>${ps.trades} trades</span><span>Win <b>${pct}%</b></span><span style="color:${pnlColorVar(avg)}">Avg <b>${pnlStr(avg)}</b></span>`;
  } else { pairEl.textContent = 'ไม่มีข้อมูล'; }

  document.querySelectorAll('.num-pair-cell').forEach(el => {
    el.classList.toggle('num-pair-now', +el.dataset.pair === pair);
  });
}

// ── Render: Day-star table ────────────────────────────────────────────────────
function renderStarTable(starStats) {
  const DAYS = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  let html = `<table class="num-table">
    <thead><tr><th>วัน</th><th>ดาว / เลข</th><th>Trades</th><th>Win%</th><th>Avg PnL</th><th>Total PnL</th></tr></thead><tbody>`;
  const { star: curStar } = nowInfo();
  DAYS.forEach((star, i) => {
    const s = starStats[star]; if (!s || s.trades === 0) return;
    const wl = s.win + s.loss;
    const pct = wl > 0 ? (s.win/wl*100).toFixed(1) : '—';
    const avg = s.totalPnl / s.trades;
    html += `<tr class="${star === curStar ? 'num-row-today' : ''}">
      <td>วัน${star}</td>
      <td style="color:var(--gold)">ดาว${star} <small style="opacity:.6">(${i+1})</small></td>
      <td>${s.trades}</td><td>${pct}%</td>
      <td style="color:${pnlColorVar(avg)}">${pnlStr(avg)}</td>
      <td style="color:${pnlColorVar(s.totalPnl)}">${pnlStr(s.totalPnl)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  document.getElementById('numStarTableEl').innerHTML = html;
}

// ── Render: Session filter pills ──────────────────────────────────────────────
function renderSessionFilter() {
  const sessions = ['ALL','ASIA','LONDON','NY','OVERLAP'];
  const labels   = { ALL:'ทั้งหมด', ASIA:'Asia', LONDON:'London', NY:'New York', OVERLAP:'Overlap' };
  let html = '<div class="num-session-filter">';
  sessions.forEach(s => {
    html += `<button class="num-sess-btn${s === _numSession ? ' active' : ''}" data-sess="${s}">${labels[s]}</button>`;
  });
  html += '</div>';
  document.getElementById('numSessionFilter').innerHTML = html;

  document.querySelectorAll('.num-sess-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _numSession = btn.dataset.sess;
      const { starStats, pairStats } = computeNumStats(_numRows, _numSession);
      renderSessionFilter();
      renderStarTable(starStats);
      renderPairGrid(pairStats);
      renderNow(starStats, pairStats);
      // restart clock with new stats
      if (_numClock) { clearInterval(_numClock); _numClock = null; }
      startNumClock(starStats, pairStats);
    });
  });
}

// ── Render: Pair heatmap ───────────────────────────────────────────────────────
function renderPairGrid(pairStats) {
  const { pair: curPair } = nowInfo();
  const ROW_LABELS = [
    '00/10/20','01/11/21','02/12/22','03/13/23',
    '04/14','05/15','06/16','07/17','08/18','09/19'
  ];
  let html = '<div class="num-grid">';
  html += '<div class="num-grid-corner">ชม﹨นาที</div>';
  for (let md = 0; md <= 5; md++) {
    html += `<div class="num-grid-head">:${md}0–${md}9</div>`;
  }
  for (let hd = 0; hd <= 9; hd++) {
    html += `<div class="num-grid-head" style="font-size:9px;line-height:1.5">${ROW_LABELS[hd]}</div>`;
    for (let md = 0; md <= 5; md++) {
      const pair = hd * 10 + md;
      const ps   = pairStats[pair];
      const avg  = ps && ps.trades > 0 ? ps.totalPnl / ps.trades : null;
      const pStr = String(pair).padStart(2,'0');
      const wl   = ps ? ps.win + ps.loss : 0;
      const pct  = wl > 0 ? (ps.win/wl*100).toFixed(0)+'%' : '—';
      html += `<div class="num-pair-cell${pair === curPair ? ' num-pair-now' : ''}"
                   data-pair="${pair}" style="background:${cellBg(avg)}"
                   title="คู่ ${pStr} | ${ps?.trades ?? 0} trades | Win ${pct} | avg ${pnlStr(avg,'—')}">
        <div class="num-cell-pair">${pStr}</div>
        <div class="num-cell-avg" style="color:${avg!=null ? pnlColorVar(avg) : 'var(--text-dim)'}">${pnlStr(avg)}</div>
      </div>`;
    }
  }
  html += '</div>';
  document.getElementById('numPairGridEl').innerHTML = html;
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function startNumClock(starStats, pairStats) {
  if (_numClock) clearInterval(_numClock);
  renderNow(starStats, pairStats);
  const msToNext = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    renderNow(starStats, pairStats);
    _numClock = setInterval(() => renderNow(starStats, pairStats), 60000);
  }, msToNext);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function initNumerologyPage() {
  document.getElementById('numStarTableEl').innerHTML =
    '<p style="color:var(--text-dim);padding:8px 0">กำลังโหลดข้อมูล...</p>';
  document.getElementById('numPairGridEl').innerHTML = '';
  _numSession = 'ALL';
  try {
    _numRows = await loadNumRows();
    const { starStats, pairStats } = computeNumStats(_numRows, 'ALL');
    renderSessionFilter();
    renderStarTable(starStats);
    renderPairGrid(pairStats);
    startNumClock(starStats, pairStats);
  } catch (e) {
    document.getElementById('numStarTableEl').innerHTML =
      `<p style="color:var(--bear)">โหลดไม่สำเร็จ: ${e.message}</p>`;
  }
}

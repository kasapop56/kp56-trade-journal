// ── Dashboard ──────────────────────────────────────────────────────────────────
const charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function toLocalYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function filterByRange(data, range) {
  const now = new Date();

  if (range === 'custom') {
    const from = document.getElementById('dateFrom')?.value;
    const to   = document.getElementById('dateTo')?.value;
    return data.filter(t => {
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      return true;
    });
  }

  return data.filter(t => {
    const d = new Date(t.date);
    if (range === 'today') return d.toDateString() === now.toDateString();
    if (range === 'yesterday') {
      const y = new Date(now); y.setDate(now.getDate() - 1);
      return t.date === toLocalYMD(y);
    }
    if (range === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - 6); start.setHours(0,0,0,0);
      return d >= start;
    }
    if (range === 'month') {
      const start = new Date(now); start.setDate(now.getDate() - 29); start.setHours(0,0,0,0);
      return d >= start;
    }
    return true;
  });
}

const CHART_DEFAULTS = {
  color: '#e0e0e0',
  grid: '#2e2e2e',
  gold: '#f0b429',
  bull: '#26a69a',
  bear: '#ef5350',
  blue: '#2196f3',
  dim: '#555',
};

function chartFont() {
  return { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", size: 11 };
}

function baseScales(xLabel = '', yLabel = '') {
  return {
    x: {
      ticks: { color: CHART_DEFAULTS.color, font: chartFont() },
      grid: { color: CHART_DEFAULTS.grid },
      title: xLabel ? { display: true, text: xLabel, color: CHART_DEFAULTS.dim } : undefined,
    },
    y: {
      ticks: { color: CHART_DEFAULTS.color, font: chartFont() },
      grid: { color: CHART_DEFAULTS.grid },
      title: yLabel ? { display: true, text: yLabel, color: CHART_DEFAULTS.dim } : undefined,
    }
  };
}

function baseLegend() {
  return { labels: { color: CHART_DEFAULTS.color, font: chartFont(), boxWidth: 12 } };
}

// ── KPIs ───────────────────────────────────────────────────────────────────────
function renderKPIs(trades) {
  const closed      = trades.filter(t => t.result);
  const tpWins      = closed.filter(t => t.result === 'TP');
  const profWins    = trades.filter(t => t.total_pnl != null && t.total_pnl > 0);
  const losses      = closed.filter(t => t.result === 'SL');
  const be          = closed.filter(t => t.result === 'BE');

  const totalPnl    = trades.reduce((s, t) => s + (t.total_pnl || 0), 0);
  const grossWin    = profWins.reduce((s, t) => s + (t.total_pnl || 0), 0);
  const grossLoss   = Math.abs(trades.filter(t => t.total_pnl < 0).reduce((s, t) => s + t.total_pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞';
  const tpRate      = closed.length ? ((tpWins.length / closed.length) * 100).toFixed(1) : '0';
  const profRate    = trades.filter(t => t.total_pnl != null).length
                      ? ((profWins.length / trades.filter(t => t.total_pnl != null).length) * 100).toFixed(1) : '0';
  const avgDD       = trades.filter(t => t.max_drawdown).reduce((s, t) => s + t.max_drawdown, 0) /
                      (trades.filter(t => t.max_drawdown).length || 1);
  const avgPnl      = trades.filter(t => t.total_pnl != null).reduce((s, t) => s + t.total_pnl, 0) /
                      (trades.filter(t => t.total_pnl != null).length || 1);
  const rr          = avgDD > 0 ? (avgPnl / avgDD).toFixed(2) : '—';
  const pnls        = trades.map(t => t.total_pnl).filter(v => v != null);
  const best        = pnls.length ? Math.max(...pnls) : null;
  const worst       = pnls.length ? Math.min(...pnls) : null;

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = 'kpi-val ' + cls;
  };

  // Recovery Factor = Net P&L / Max single drawdown
  const maxDD = trades.filter(t => t.max_drawdown).reduce((m, t) => Math.max(m, t.max_drawdown), 0);
  const recovery = maxDD > 0 ? (totalPnl / maxDD).toFixed(2) : '—';

  // Trades per week
  const dates = trades.map(t => new Date(t.date)).filter(Boolean);
  const spanWeeks = dates.length > 1
    ? Math.max(1, (Math.max(...dates) - Math.min(...dates)) / (7 * 86400000))
    : 1;
  const perWeek = (trades.length / spanWeeks).toFixed(1);

  // Avg hold time (minutes)
  const holdTimes = trades.filter(t => t.entry_time && t.exit_time).map(t => {
    const [eh, em] = t.entry_time.split(':').map(Number);
    const [xh, xm] = t.exit_time.split(':').map(Number);
    return (xh * 60 + xm) - (eh * 60 + em);
  }).filter(m => m > 0);
  const avgHold = holdTimes.length
    ? holdTimes.reduce((s, m) => s + m, 0) / holdTimes.length
    : null;
  const holdStr = avgHold != null
    ? avgHold >= 60 ? `${Math.floor(avgHold/60)}h ${Math.round(avgHold%60)}m` : `${Math.round(avgHold)}m`
    : '—';

  // Gross profit / loss
  const grossProfit = trades.filter(t => t.total_pnl > 0).reduce((s, t) => s + t.total_pnl, 0);
  const grossLossAmt = Math.abs(trades.filter(t => t.total_pnl < 0).reduce((s, t) => s + t.total_pnl, 0));

  set('kpiTpRate',    tpRate + '%');
  set('kpiProfRate',  profRate + '%');
  set('kpiTrades',    closed.length);
  set('kpiPnl',       (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2), totalPnl >= 0 ? 'pos' : 'neg');
  set('kpiPF',        profitFactor, parseFloat(profitFactor) >= 1 ? 'pos' : 'neg');
  set('kpiRecovery',  recovery, parseFloat(recovery) >= 1 ? 'pos' : 'neg');
  set('kpiRR',        rr);
  set('kpiBE',        be.length);
  set('kpiPerWeek',   perWeek);
  set('kpiHoldTime',  holdStr);
  set('kpiBest',      best != null ? (best >= 0 ? '+' : '') + best.toFixed(2) : '—', 'pos');
  set('kpiWorst',     worst != null ? worst.toFixed(2) : '—', 'neg');
  const grossEl = document.getElementById('kpiGross');
  if (grossEl) grossEl.innerHTML = `<span style="color:var(--bull)">+${grossProfit.toFixed(2)}</span> <span style="color:var(--text-dim);font-size:12px">/</span> <span style="color:var(--bear)">-${grossLossAmt.toFixed(2)}</span>`;
}

// ── Equity Curve ───────────────────────────────────────────────────────────────
function renderEquity(trades) {
  destroyChart('equity');
  const sorted = [...trades].filter(t => t.total_pnl != null).sort((a, b) => new Date(a.date) - new Date(b.date));
  let cum = 0;
  const labels = [], values = [];
  sorted.forEach(t => { cum += t.total_pnl; labels.push(t.date); values.push(parseFloat(cum.toFixed(2))); });
  if (!labels.length) return;

  const ctx = document.getElementById('equityChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, 'rgba(240,180,41,0.25)');
  grad.addColorStop(1, 'rgba(240,180,41,0)');

  charts.equity = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L',
        data: values,
        borderColor: CHART_DEFAULTS.gold,
        backgroundColor: grad,
        fill: true,
        tension: 0.3,
        pointRadius: values.length > 20 ? 0 : 4,
        pointBackgroundColor: CHART_DEFAULTS.gold,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: baseScales('', 'USD'),
    }
  });
}

// ── Result Donut ───────────────────────────────────────────────────────────────
function renderResult(trades) {
  destroyChart('result');
  const counts = { TP: 0, SL: 0, BE: 0, MANUAL: 0 };
  trades.forEach(t => { if (t.result && counts[t.result] !== undefined) counts[t.result]++; });
  if (!Object.values(counts).some(v => v > 0)) return;

  charts.result = new Chart(document.getElementById('resultChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['TP', 'SL', 'BE', 'Manual'],
      datasets: [{
        data: [counts.TP, counts.SL, counts.BE, counts.MANUAL],
        backgroundColor: [CHART_DEFAULTS.bull, CHART_DEFAULTS.bear, CHART_DEFAULTS.blue, CHART_DEFAULTS.gold],
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: { legend: baseLegend() },
    }
  });
}

// ── P&L by Session ─────────────────────────────────────────────────────────────
function renderSession(trades) {
  destroyChart('session');
  const sessions = { ASIA: 0, LONDON: 0, NY: 0 };
  trades.forEach(t => { if (t.session && sessions[t.session] !== undefined) sessions[t.session] += (t.total_pnl || 0); });

  const vals = Object.values(sessions).map(v => parseFloat(v.toFixed(2)));
  charts.session = new Chart(document.getElementById('sessionChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Asia', 'London', 'New York'],
      datasets: [{
        label: 'P&L (USD)',
        data: vals,
        backgroundColor: vals.map(v => v >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)'),
        borderRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: baseScales('', 'USD'),
    }
  });
}

// ── P&L by Day of Week ─────────────────────────────────────────────────────────
function renderDayOfWeek(trades) {
  destroyChart('dow');
  const days = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  trades.forEach(t => {
    const d = dayNames[new Date(t.date + 'T12:00:00').getDay()];
    if (days[d] !== undefined) days[d] += (t.total_pnl || 0);
  });

  const vals = Object.values(days).map(v => parseFloat(v.toFixed(2)));
  charts.dow = new Chart(document.getElementById('dowChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: Object.keys(days),
      datasets: [{
        label: 'P&L (USD)',
        data: vals,
        backgroundColor: vals.map(v => v >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)'),
        borderRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: baseScales('', 'USD'),
    }
  });
}

// ── Drawdown vs P&L Scatter ────────────────────────────────────────────────────
function renderScatter(trades) {
  destroyChart('scatter');
  const points = trades.filter(t => t.max_drawdown && t.total_pnl != null).map(t => ({
    x: t.max_drawdown,
    y: t.total_pnl,
    result: t.result,
  }));
  if (!points.length) return;

  const colorMap = { TP: CHART_DEFAULTS.bull, SL: CHART_DEFAULTS.bear, BE: CHART_DEFAULTS.blue, MANUAL: CHART_DEFAULTS.gold };

  charts.scatter = new Chart(document.getElementById('scatterChart').getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Trades',
        data: points,
        backgroundColor: points.map(p => colorMap[p.result] || CHART_DEFAULTS.dim),
        pointRadius: 6,
        pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => `DD: $${ctx.raw.x} | P&L: $${ctx.raw.y}` } }
      },
      scales: baseScales('Max Drawdown (USD)', 'P&L (USD)'),
    }
  });
}

// ── Bias Accuracy ──────────────────────────────────────────────────────────────
function renderBias(trades) {
  destroyChart('bias');
  const groups = { 'H1 BULL': { wins: 0, total: 0 }, 'H1 BEAR': { wins: 0, total: 0 }, 'M5 BULL': { wins: 0, total: 0 }, 'M5 BEAR': { wins: 0, total: 0 } };
  trades.forEach(t => {
    if (t.result !== 'TP' && t.result !== 'SL') return;
    const win = t.result === 'TP';
    if (t.bias_h1 === 'BULL') { groups['H1 BULL'].total++; if (win) groups['H1 BULL'].wins++; }
    if (t.bias_h1 === 'BEAR') { groups['H1 BEAR'].total++; if (win) groups['H1 BEAR'].wins++; }
    if (t.bias_m5 === 'BULL') { groups['M5 BULL'].total++; if (win) groups['M5 BULL'].wins++; }
    if (t.bias_m5 === 'BEAR') { groups['M5 BEAR'].total++; if (win) groups['M5 BEAR'].wins++; }
  });

  const labels = Object.keys(groups);
  const vals = labels.map(k => groups[k].total ? parseFloat(((groups[k].wins / groups[k].total) * 100).toFixed(1)) : 0);

  charts.bias = new Chart(document.getElementById('biasChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Win Rate %',
        data: vals,
        backgroundColor: [
          'rgba(38,166,154,0.7)', 'rgba(239,83,80,0.7)',
          'rgba(38,166,154,0.5)', 'rgba(239,83,80,0.5)',
        ],
        borderRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { ...baseScales('', 'Win Rate %'), y: { ...baseScales().y, min: 0, max: 100 } },
    }
  });
}

// ── P&L by Hour ────────────────────────────────────────────────────────────────
function renderHour(trades) {
  destroyChart('hour');
  const hours = {};
  trades.forEach(t => {
    if (!t.entry_time || t.total_pnl == null) return;
    const h = parseInt(t.entry_time.split(':')[0]);
    if (!hours[h]) hours[h] = 0;
    hours[h] += t.total_pnl;
  });
  if (!Object.keys(hours).length) return;

  const allHours = Array.from({ length: 24 }, (_, i) => i);
  const vals = allHours.map(h => parseFloat((hours[h] || 0).toFixed(2)));
  const labels = allHours.map(h => `${String(h).padStart(2,'0')}:00`);

  charts.hour = new Chart(document.getElementById('hourChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'P&L (USD)',
        data: vals,
        backgroundColor: vals.map(v => v > 0 ? 'rgba(38,166,154,0.7)' : v < 0 ? 'rgba(239,83,80,0.7)' : 'rgba(80,80,80,0.3)'),
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: baseScales('Hour (Thai Time)', 'USD'),
    }
  });
}

// ── Direction Stats ────────────────────────────────────────────────────────────
function renderDirection(trades) {
  destroyChart('direction');
  const dir = {
    BUY:  { pnl: 0, prof: 0, total: 0 },
    SELL: { pnl: 0, prof: 0, total: 0 },
  };
  trades.forEach(t => {
    if (!t.direction || !dir[t.direction]) return;
    dir[t.direction].pnl += (t.total_pnl || 0);
    if (t.total_pnl != null) {
      dir[t.direction].total++;
      if (t.total_pnl > 0) dir[t.direction].prof++;
    }
  });

  // KPI cards
  ['BUY','SELL'].forEach(d => {
    const rate = dir[d].total ? ((dir[d].prof / dir[d].total) * 100).toFixed(0) + '%' : '—';
    const pnl  = dir[d].pnl.toFixed(2);
    const el   = document.getElementById(`kpiDir${d}`);
    if (el) el.innerHTML =
      `<span class="${d === 'BUY' ? 'pos' : 'neg'}" style="font-weight:700">${d}</span> &nbsp;
       <span style="font-size:13px">${rate} profitable</span><br>
       <span style="font-size:12px;color:var(--text-dim)">P&L: ${dir[d].pnl >= 0 ? '+' : ''}${pnl}</span>`;
  });

  // Bar chart
  const vals = [parseFloat(dir.BUY.pnl.toFixed(2)), parseFloat(dir.SELL.pnl.toFixed(2))];
  charts.direction = new Chart(document.getElementById('directionChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['BUY', 'SELL'],
      datasets: [{
        label: 'Total P&L (USD)',
        data: vals,
        backgroundColor: [
          vals[0] >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)',
          vals[1] >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)',
        ],
        borderRadius: 6,
        barThickness: 60,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: baseScales('', 'USD'),
    }
  });
}

// ── Session Table ──────────────────────────────────────────────────────────────
function renderSessionTable(trades) {
  const sessions = ['ASIA', 'LONDON', 'NY'];
  const tbody = document.getElementById('sessionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  sessions.forEach(s => {
    const t = trades.filter(x => x.session === s);
    const closed = t.filter(x => x.result);
    const tpW   = closed.filter(x => x.result === 'TP').length;
    const profW = t.filter(x => x.total_pnl > 0).length;
    const hasPnl = t.filter(x => x.total_pnl != null).length;
    const pnl   = t.reduce((sum, x) => sum + (x.total_pnl || 0), 0);
    const avgDD = t.filter(x => x.max_drawdown).reduce((sum, x) => sum + x.max_drawdown, 0) /
                  (t.filter(x => x.max_drawdown).length || 1);
    const tpRate   = closed.length ? ((tpW / closed.length) * 100).toFixed(0) + '%' : '—';
    const profRate = hasPnl ? ((profW / hasPnl) * 100).toFixed(0) + '%' : '—';
    const pnlClass = pnl >= 0 ? 'pos' : 'neg';
    tbody.innerHTML += `
      <tr>
        <td>${s}</td>
        <td>${closed.length}</td>
        <td><span style="color:var(--bull)">${profRate}</span> <span style="color:var(--text-dim);font-size:11px">/ TP ${tpRate}</span></td>
        <td class="${pnlClass}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
        <td>${t.filter(x => x.max_drawdown).length ? '$' + avgDD.toFixed(2) : '—'}</td>
      </tr>`;
  });
}

// ── Main render ────────────────────────────────────────────────────────────────
let allDashboardData = [];
let currentRange = 'all';

async function loadDashboard() {
  if (!allDashboardData.length) {
    try {
      allDashboardData = await fetchAllPaged('trade_ideas', q =>
        q.select('*, positions(*)').order('date', { ascending: true })
      );
    } catch (err) {
      console.error('loadDashboard failed', err);
      allDashboardData = [];
    }
  }
  renderDashboard(currentRange);
}

function renderDashboard(range) {
  currentRange = range;
  const trades = filterByRange(allDashboardData, range);
  renderKPIs(trades);
  renderEquity(trades);
  renderResult(trades);
  renderSession(trades);
  renderDayOfWeek(trades);
  renderScatter(trades);
  renderBias(trades);
  renderHour(trades);
  renderDirection(trades);
  renderSessionTable(trades);
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const fromEl = document.getElementById('dateFrom');
    const toEl = document.getElementById('dateTo');
    if (fromEl) { fromEl.value = ''; fromEl.classList.remove('active'); }
    if (toEl)   { toEl.value = '';   toEl.classList.remove('active'); }
    renderDashboard(btn.dataset.range);
  });
});

// Custom date range
['dateFrom', 'dateTo'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('dateFrom').classList.toggle('active', !!document.getElementById('dateFrom').value);
    document.getElementById('dateTo').classList.toggle('active', !!document.getElementById('dateTo').value);
    renderDashboard('custom');
  });
});

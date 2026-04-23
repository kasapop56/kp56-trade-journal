// ── Dashboard ──────────────────────────────────────────────────────────────────
const charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function filterByRange(data, range) {
  const now = new Date();
  return data.filter(t => {
    const d = new Date(t.date);
    if (range === 'today') return d.toDateString() === now.toDateString();
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
  const closed = trades.filter(t => t.result);
  const wins   = closed.filter(t => t.result === 'TP');
  const losses = closed.filter(t => t.result === 'SL');
  const be     = closed.filter(t => t.result === 'BE');

  const totalPnl   = trades.reduce((s, t) => s + (t.total_pnl || 0), 0);
  const grossWin   = wins.reduce((s, t) => s + (t.total_pnl || 0), 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + (t.total_pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞';
  const winRate    = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : '0';
  const avgDD      = trades.filter(t => t.max_drawdown).reduce((s, t) => s + t.max_drawdown, 0) /
                     (trades.filter(t => t.max_drawdown).length || 1);
  const avgPnl     = trades.filter(t => t.total_pnl != null).reduce((s, t) => s + t.total_pnl, 0) /
                     (trades.filter(t => t.total_pnl != null).length || 1);
  const rr         = avgDD > 0 ? (avgPnl / avgDD).toFixed(2) : '—';
  const pnls       = trades.map(t => t.total_pnl).filter(v => v != null);
  const best       = pnls.length ? Math.max(...pnls) : null;
  const worst      = pnls.length ? Math.min(...pnls) : null;

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = 'kpi-val ' + cls;
  };

  set('kpiWinRate',      winRate + '%');
  set('kpiTrades',       closed.length);
  set('kpiPnl',          (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2),
      totalPnl >= 0 ? 'pos' : 'neg');
  set('kpiPF',           profitFactor,
      parseFloat(profitFactor) >= 1 ? 'pos' : 'neg');
  set('kpiRR',           rr);
  set('kpiBE',           be.length);
  set('kpiBest',         best != null ? (best >= 0 ? '+' : '') + best.toFixed(2) : '—', 'pos');
  set('kpiWorst',        worst != null ? worst.toFixed(2) : '—', 'neg');
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

// ── Session Table ──────────────────────────────────────────────────────────────
function renderSessionTable(trades) {
  const sessions = ['ASIA', 'LONDON', 'NY'];
  const tbody = document.getElementById('sessionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  sessions.forEach(s => {
    const t = trades.filter(x => x.session === s);
    const closed = t.filter(x => x.result);
    const wins = closed.filter(x => x.result === 'TP').length;
    const pnl = t.reduce((sum, x) => sum + (x.total_pnl || 0), 0);
    const avgDD = t.filter(x => x.max_drawdown).reduce((sum, x) => sum + x.max_drawdown, 0) /
                  (t.filter(x => x.max_drawdown).length || 1);
    const wr = closed.length ? ((wins / closed.length) * 100).toFixed(0) + '%' : '—';
    const pnlClass = pnl >= 0 ? 'pos' : 'neg';
    tbody.innerHTML += `
      <tr>
        <td>${s}</td>
        <td>${closed.length}</td>
        <td>${wr}</td>
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
    const { data } = await db.from('trade_ideas').select('*, positions(*)').order('date', { ascending: true });
    allDashboardData = data || [];
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
  renderSessionTable(trades);
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderDashboard(btn.dataset.range);
  });
});

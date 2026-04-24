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
  const sessions = { ASIA: 0, LONDON: 0, OVERLAP: 0, NY: 0, QUIET: 0 };
  trades.forEach(t => {
    const s = tradeSession(t);
    if (s && sessions[s] !== undefined) sessions[s] += (t.total_pnl || 0);
  });

  const keys = ['ASIA', 'LONDON', 'OVERLAP', 'NY', 'QUIET'];
  const labels = ['Asia', 'London', 'LDN+NY', 'NY', 'Quiet'];
  const vals = keys.map(k => parseFloat(sessions[k].toFixed(2)));
  charts.session = new Chart(document.getElementById('sessionChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
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
      scales: baseScales(`Hour (broker server time, GMT${getServerTzOffset() >= 0 ? '+' : ''}${getServerTzOffset()})`, 'USD'),
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
  const sessions = ['ASIA', 'LONDON', 'OVERLAP', 'NY', 'QUIET'];
  const tbody = document.getElementById('sessionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  sessions.forEach(s => {
    const t = trades.filter(x => tradeSession(x) === s);
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

// ── Progress Tracker ──────────────────────────────────────────────────────────
// Process > outcome. Shows: (1) discipline rate, (2) before/after baseline split,
// (3) rolling 50-trade profit factor trend. Designed so improvement shows up in
// days, not quarters.
function renderProgress(tradesInFilter, allTrades) {
  renderDisciplineScore(tradesInFilter);
  renderBeforeAfter(allTrades);
  renderRollingPF(allTrades);
}

function renderDisciplineScore(trades) {
  const el = document.getElementById('discScore');
  if (!el) return;
  if (!trades.length) {
    el.innerHTML = '<div class="risk-title">Discipline Score</div><div class="risk-sub">No trades in range.</div>';
    return;
  }
  let slOk = 0, holdOk = 0, soloOk = 0, allOk = 0, holdDenom = 0, allDenom = 0;
  for (const t of trades) {
    const d = tradeDiscipline(t);
    if (d.sl) slOk++;
    if (d.solo) soloOk++;
    if (d.hold != null) { holdDenom++; if (d.hold) holdOk++; }
    if (d.all != null)  { allDenom++;  if (d.all)  allOk++; }
  }
  const N = trades.length;
  const pct = (n, d) => d ? (n / d * 100) : 0;
  const overall = allDenom ? pct(allOk, allDenom) : null;
  const klass = overall == null ? 'neutral' : overall >= 80 ? 'good' : overall >= 50 ? 'neutral' : 'bad';
  el.className = 'risk-card ' + klass;
  el.innerHTML = `
    <div class="risk-title">Discipline Score <span style="text-transform:none;color:var(--text-dim);font-weight:400">(rules followed)</span></div>
    <div class="risk-big">${overall != null ? overall.toFixed(0) + '%' : '—'}</div>
    <div class="risk-sub">
      <div class="disc-row"><span>SL set</span><span><b>${slOk}</b>/${N} · ${pct(slOk,N).toFixed(0)}%</span></div>
      <div class="disc-row"><span>Exit &lt;15m</span><span><b>${holdOk}</b>/${holdDenom || 0} · ${pct(holdOk, holdDenom).toFixed(0)}%</span></div>
      <div class="disc-row"><span>Single entry</span><span><b>${soloOk}</b>/${N} · ${pct(soloOk,N).toFixed(0)}%</span></div>
    </div>
    <div class="risk-verdict">${overall == null ? 'Need exit times on more trades.'
      : overall >= 80 ? 'Strong discipline.'
      : overall >= 50 ? 'Partial — pick the weakest rule and tighten it.'
      : 'Weakest rule is where losses come from. Fix it first.'}</div>`;
}

function computeStats(trades) {
  const withPnl = trades.filter(t => t.total_pnl != null);
  const wins = withPnl.filter(t => t.total_pnl > 0);
  const losses = withPnl.filter(t => t.total_pnl < 0);
  const net = withPnl.reduce((s, t) => s + t.total_pnl, 0);
  const gp = wins.reduce((s, t) => s + t.total_pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.total_pnl, 0));
  const avgW = wins.length ? gp / wins.length : 0;
  const avgL = losses.length ? -gl / losses.length : 0;
  const ratio = avgL !== 0 ? Math.abs(avgW / avgL) : 0;
  const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
  let discAllOk = 0, discDenom = 0;
  for (const t of trades) {
    const d = tradeDiscipline(t);
    if (d.all != null) { discDenom++; if (d.all) discAllOk++; }
  }
  const disc = discDenom ? (discAllOk / discDenom) * 100 : null;
  return { n: trades.length, net, ratio, pf, disc };
}

function renderBeforeAfter(allTrades) {
  const baseline = getBaselineDate();
  const picker = document.getElementById('baselineDate');
  if (picker && picker.value !== baseline) picker.value = baseline;

  const wrap = document.getElementById('beforeAfter');
  if (!wrap) return;
  if (!baseline) {
    wrap.innerHTML = `<div class="risk-title">Before vs After Rules</div>
      <div class="risk-sub" style="padding:8px 0">Pick a <b>"Rules started"</b> date above to see your progress split.</div>
      <div class="risk-verdict">Tip: set it to today, then check back in a week.</div>`;
    wrap.className = 'risk-card neutral';
    return;
  }
  const before = allTrades.filter(t => t.date < baseline);
  const after  = allTrades.filter(t => t.date >= baseline);
  const b = computeStats(before);
  const a = computeStats(after);

  const fmtPct = v => v == null ? '—' : v.toFixed(0) + '%';
  const fmtNum = v => !isFinite(v) ? '∞' : v.toFixed(2);
  const fmtMoney = v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(0);
  const delta = (aV, bV) => {
    if (aV == null || bV == null || !isFinite(aV) || !isFinite(bV)) return '';
    if (aV > bV) return '<span class="delta up">↑</span>';
    if (aV < bV) return '<span class="delta down">↓</span>';
    return '<span class="delta">→</span>';
  };

  const row = (label, bV, aV, fmt) => `
    <tr>
      <td>${label}</td>
      <td>${fmt(bV)}</td>
      <td>${fmt(aV)} ${delta(aV, bV)}</td>
    </tr>`;

  wrap.className = 'risk-card ' + (a.n === 0 ? 'neutral' : (a.pf >= b.pf && a.ratio >= b.ratio ? 'good' : 'bad'));
  wrap.innerHTML = `
    <div class="risk-title">Before vs After Rules <span style="text-transform:none;color:var(--text-dim);font-weight:400">(baseline ${baseline})</span></div>
    <table class="ba-table">
      <thead><tr><th></th><th>Before (${b.n})</th><th>After (${a.n})</th></tr></thead>
      <tbody>
        ${row('Net P&L',        b.net,   a.net,   fmtMoney)}
        ${row('Win/Loss ratio', b.ratio, a.ratio, fmtNum)}
        ${row('Profit factor',  b.pf,    a.pf,    fmtNum)}
        ${row('Discipline',     b.disc,  a.disc,  fmtPct)}
      </tbody>
    </table>
    <div class="risk-verdict">${a.n === 0
      ? 'No trades after baseline yet. Set baseline, then trade.'
      : a.pf > b.pf && a.ratio > b.ratio
        ? 'Clear improvement on both payoff and profit factor.'
        : a.pf < b.pf
          ? 'Post-baseline profit factor is still weaker — rules need tightening.'
          : 'Partial improvement — keep going.'}</div>`;
}

// Rolling profit factor over a sliding window (default 50 trades).
function renderRollingPF(allTrades) {
  destroyChart('rollingPF');
  const ctx = document.getElementById('rollingPFChart');
  if (!ctx) return;
  const sorted = [...allTrades]
    .filter(t => t.total_pnl != null)
    .sort((a, b) => (a.date + (a.entry_time || '')).localeCompare(b.date + (b.entry_time || '')));

  const WIN = 50;
  if (sorted.length < WIN) {
    ctx.parentElement.innerHTML = `<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:40px 0">Need at least ${WIN} trades to plot rolling profit factor. You have ${sorted.length}.</div>`;
    return;
  }
  const labels = [], vals = [];
  for (let i = WIN - 1; i < sorted.length; i++) {
    const slice = sorted.slice(i - WIN + 1, i + 1);
    const gp = slice.filter(t => t.total_pnl > 0).reduce((s, t) => s + t.total_pnl, 0);
    const gl = Math.abs(slice.filter(t => t.total_pnl < 0).reduce((s, t) => s + t.total_pnl, 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? 3 : 0); // clamp ∞ display at 3
    labels.push(sorted[i].date);
    vals.push(parseFloat(Math.min(pf, 3).toFixed(2)));
  }

  const baseline = getBaselineDate();
  // Color points after baseline differently
  const pointColors = labels.map(d => baseline && d >= baseline ? CHART_DEFAULTS.bull : CHART_DEFAULTS.gold);

  charts.rollingPF = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `Profit Factor (rolling ${WIN})`,
        data: vals,
        borderColor: CHART_DEFAULTS.gold,
        backgroundColor: 'rgba(240,180,41,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: pointColors,
        segment: {
          borderColor: c => baseline && labels[c.p1DataIndex] >= baseline ? CHART_DEFAULTS.bull : CHART_DEFAULTS.gold,
        }
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `PF: ${ctx.raw}${ctx.raw >= 3 ? ' (capped)' : ''}` } },
      },
      scales: {
        ...baseScales('', 'Profit Factor'),
        y: { ...baseScales().y, suggestedMin: 0, suggestedMax: 3 },
      },
    }
  });
}

// ── Risk Analysis ──────────────────────────────────────────────────────────────
// The 4 findings that explain most P&L leaks:
//   1. Avg-win vs Avg-loss ratio   (payoff asymmetry)
//   2. Hold-time cliff              (>15 min = losses)
//   3. Scaled vs single entries     (averaging-down damage)
//   4. Trades without SL            (no risk cap)
function renderRiskAnalysis(trades) {
  const withPnl = trades.filter(t => t.total_pnl != null);
  const wins = withPnl.filter(t => t.total_pnl > 0);
  const losses = withPnl.filter(t => t.total_pnl < 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.total_pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.total_pnl, 0) / losses.length : 0;
  const ratio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  // 1. Payoff card
  const payoffEl = document.getElementById('riskPayoff');
  if (payoffEl) {
    const good = ratio >= 1;
    payoffEl.className = 'risk-card ' + (good ? 'good' : 'bad');
    payoffEl.innerHTML = `
      <div class="risk-title">Win vs Loss Size</div>
      <div class="risk-big">${ratio.toFixed(2)}×</div>
      <div class="risk-sub">
        Avg win <b class="pos">+$${avgWin.toFixed(2)}</b><br>
        Avg loss <b class="neg">$${avgLoss.toFixed(2)}</b>
      </div>
      <div class="risk-verdict">${good
        ? 'Wins at least cover losses — healthy.'
        : `Losses are ${(1/ratio || 0).toFixed(1)}× bigger than wins. Cut losers earlier.`}</div>`;
  }

  // 2. Hold-time cliff: <15min vs >=15min
  const withHold = withPnl.map(t => ({ t, m: holdMinutes(t) })).filter(x => x.m != null);
  const quick = withHold.filter(x => x.m < 15);
  const slow = withHold.filter(x => x.m >= 15);
  const quickPnl = quick.reduce((s, x) => s + x.t.total_pnl, 0);
  const slowPnl = slow.reduce((s, x) => s + x.t.total_pnl, 0);
  const cliffEl = document.getElementById('riskCliff');
  if (cliffEl) {
    const bad = slowPnl < 0;
    cliffEl.className = 'risk-card ' + (bad ? 'bad' : 'good');
    cliffEl.innerHTML = `
      <div class="risk-title">15-Minute Cliff</div>
      <div class="risk-big ${slowPnl >= 0 ? 'pos' : 'neg'}">${slowPnl >= 0 ? '+' : ''}$${slowPnl.toFixed(0)}</div>
      <div class="risk-sub">
        <b>${quick.length}</b> quick (&lt;15m) → <b class="${quickPnl>=0?'pos':'neg'}">${quickPnl>=0?'+':''}$${quickPnl.toFixed(0)}</b><br>
        <b>${slow.length}</b> held ≥15m → <b class="${slowPnl>=0?'pos':'neg'}">${slowPnl>=0?'+':''}$${slowPnl.toFixed(0)}</b>
      </div>
      <div class="risk-verdict">${bad
        ? 'Holding past 15 min bleeds — set a time stop.'
        : 'Long holds are working.'}</div>`;
  }

  // 3. Scaled vs Single (infer from positions[] count)
  const single = withPnl.filter(t => (t.positions?.length || 1) === 1);
  const scaled = withPnl.filter(t => (t.positions?.length || 1) > 1);
  const singlePnl = single.reduce((s, t) => s + t.total_pnl, 0);
  const scaledPnl = scaled.reduce((s, t) => s + t.total_pnl, 0);
  const scaledEl = document.getElementById('riskScaled');
  if (scaledEl) {
    const bad = scaledPnl < 0 && scaled.length > 0;
    scaledEl.className = 'risk-card ' + (bad ? 'bad' : scaled.length === 0 ? 'neutral' : 'good');
    scaledEl.innerHTML = `
      <div class="risk-title">Scaling Impact</div>
      <div class="risk-big ${scaledPnl >= 0 ? 'pos' : 'neg'}">${scaledPnl >= 0 ? '+' : ''}$${scaledPnl.toFixed(0)}</div>
      <div class="risk-sub">
        <b>${single.length}</b> single → <b class="${singlePnl>=0?'pos':'neg'}">${singlePnl>=0?'+':''}$${singlePnl.toFixed(0)}</b><br>
        <b>${scaled.length}</b> scaled → <b class="${scaledPnl>=0?'pos':'neg'}">${scaledPnl>=0?'+':''}$${scaledPnl.toFixed(0)}</b>
      </div>
      <div class="risk-verdict">${bad
        ? 'Scaled entries are losing money. Stop averaging down.'
        : scaled.length === 0 ? 'No scaled entries yet.' : 'Scaling is working.'}</div>`;
  }

  // 4. No-SL trades
  const noSl = withPnl.filter(t => !hasStopLoss(t));
  const noSlPnl = noSl.reduce((s, t) => s + t.total_pnl, 0);
  const noSlPct = withPnl.length ? (noSl.length / withPnl.length) * 100 : 0;
  const slEl = document.getElementById('riskNoSl');
  if (slEl) {
    const bad = noSlPct >= 20;
    slEl.className = 'risk-card ' + (bad ? 'bad' : 'good');
    slEl.innerHTML = `
      <div class="risk-title">Trades Without SL</div>
      <div class="risk-big">${noSl.length} <span style="font-size:15px;color:var(--text-dim)">(${noSlPct.toFixed(0)}%)</span></div>
      <div class="risk-sub">
        Net from no-SL trades:<br>
        <b class="${noSlPnl>=0?'pos':'neg'}">${noSlPnl>=0?'+':''}$${noSlPnl.toFixed(2)}</b>
      </div>
      <div class="risk-verdict">${bad
        ? 'Too many trades with no risk cap — one outlier can blow months of wins.'
        : 'Good stop-loss discipline.'}</div>`;
  }
}

// ── Hold-Duration Chart ────────────────────────────────────────────────────────
function renderHoldDuration(trades) {
  destroyChart('hold');
  const buckets = [
    { k: '<1m',   test: m => m < 1 },
    { k: '1-5m',  test: m => m >= 1 && m < 5 },
    { k: '5-15m', test: m => m >= 5 && m < 15 },
    { k: '15-60m',test: m => m >= 15 && m < 60 },
    { k: '1-4h',  test: m => m >= 60 && m < 240 },
    { k: '4-24h', test: m => m >= 240 && m < 1440 },
  ];
  const stats = buckets.map(b => ({ k: b.k, pnl: 0, count: 0 }));
  trades.forEach(t => {
    if (t.total_pnl == null) return;
    const m = holdMinutes(t);
    if (m == null) return;
    const idx = buckets.findIndex(b => b.test(m));
    if (idx === -1) return;
    stats[idx].pnl += t.total_pnl;
    stats[idx].count++;
  });
  const ctx = document.getElementById('holdChart');
  if (!ctx) return;

  charts.hold = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: stats.map(s => `${s.k}\n(${s.count})`),
      datasets: [{
        label: 'P&L (USD)',
        data: stats.map(s => parseFloat(s.pnl.toFixed(2))),
        backgroundColor: stats.map(s => s.pnl >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)'),
        borderRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `$${ctx.raw} — ${stats[ctx.dataIndex].count} trades` } },
      },
      scales: baseScales('Hold Duration', 'USD'),
    }
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
  renderProgress(trades, allDashboardData);
  renderKPIs(trades);
  renderRiskAnalysis(trades);
  renderEquity(trades);
  renderResult(trades);
  renderSession(trades);
  renderDayOfWeek(trades);
  renderHoldDuration(trades);
  renderScatter(trades);
  renderBias(trades);
  renderHour(trades);
  renderDirection(trades);
  renderSessionTable(trades);
}

// Timezone picker — rebuilds session-dependent charts on change.
function initTimezonePicker() {
  const sel = document.getElementById('serverTz');
  if (!sel) return;
  sel.value = String(getServerTzOffset());
  sel.addEventListener('change', () => {
    setServerTzOffset(sel.value);
    renderDashboard(currentRange);
  });
}

// Baseline picker — "Rules started" date used by the Before/After split.
function initBaselinePicker() {
  const input = document.getElementById('baselineDate');
  const todayBtn = document.getElementById('baselineToday');
  const clearBtn = document.getElementById('baselineClear');
  if (!input) return;
  input.value = getBaselineDate();
  input.addEventListener('change', () => {
    setBaselineDate(input.value);
    renderDashboard(currentRange);
  });
  if (todayBtn) todayBtn.addEventListener('click', () => {
    const today = toLocalYMD(new Date());
    input.value = today;
    setBaselineDate(today);
    renderDashboard(currentRange);
  });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    input.value = '';
    setBaselineDate('');
    renderDashboard(currentRange);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTimezonePicker();
  initBaselinePicker();
});

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

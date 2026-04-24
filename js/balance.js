// ── Portfolio / Balance Curve ─────────────────────────────────────────────
// Renders the Portfolio card on the Stats page: 4 KPIs + balance/equity
// time-series chart. Data comes from Supabase `balance_snapshots` (written
// by the MT5 JournalSync EA via the Vercel webhook).

async function loadPortfolio() {
  const wrap = document.getElementById('portfolioCard');
  if (!wrap) return;

  let rows;
  try {
    // Pick the most recently active account — keeps stray test rows from other
    // account_logins (or manual curl tests) out of the portfolio chart.
    const { data: latest, error: latestErr } = await db
      .from('balance_snapshots')
      .select('account_login')
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (latestErr) throw latestErr;
    const acct = latest?.[0]?.account_login;
    if (!acct) { rows = []; }
    else {
      rows = await fetchAllPaged('balance_snapshots', q =>
        q.select('*').eq('account_login', acct).order('recorded_at', { ascending: true })
      );
    }
  } catch (err) {
    wrap.innerHTML = `<h2>Portfolio</h2><p style="color:var(--text-dim);font-size:13px">
      Couldn't load balance snapshots: ${err.message}</p>`;
    return;
  }

  if (!rows.length) {
    wrap.innerHTML = `<h2>Portfolio</h2>
      <p style="color:var(--text-dim);font-size:13px;line-height:1.7">
        No balance snapshots yet. Once the <b>JournalSync EA</b> is attached in MT5,
        a data point will appear here on the next tick, and the curve will build up
        from there. See <code>mt5/SETUP.md</code> for setup.
      </p>`;
    return;
  }

  renderPortfolioKPIs(rows);
  renderBalanceChart(rows);
}

function renderPortfolioKPIs(rows) {
  const first   = rows[0];
  const last    = rows[rows.length - 1];
  const peak    = rows.reduce((m, r) => r.balance > m ? r.balance : m, 0);
  const curDD   = peak > 0 ? ((last.balance - peak) / peak) * 100 : 0;  // negative when below peak
  const netRet  = first.balance > 0 ? ((last.balance - first.balance) / first.balance) * 100 : 0;

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls !== undefined) el.className = 'kpi-val ' + cls;
  };

  set('kpiBalance', '$' + last.balance.toFixed(2));
  set('kpiEquity',  '$' + last.equity.toFixed(2),
      last.equity >= last.balance ? 'pos' : 'neg');
  set('kpiPeak',    '$' + peak.toFixed(2));
  set('kpiDD',      curDD.toFixed(2) + '%', curDD >= -1 ? '' : 'neg');
  set('kpiNetRet',  (netRet >= 0 ? '+' : '') + netRet.toFixed(2) + '%',
      netRet >= 0 ? 'pos' : 'neg');

  const acct = document.getElementById('kpiAcct');
  if (acct) acct.textContent = '#' + last.account_login;
}

let _balanceChart = null;
function renderBalanceChart(rows) {
  const ctx = document.getElementById('balanceChart');
  if (!ctx) return;
  if (_balanceChart) { _balanceChart.destroy(); _balanceChart = null; }

  // Downsample if many points — keeps the chart snappy past ~2000 rows.
  const N = rows.length;
  const maxPoints = 500;
  const step = Math.max(1, Math.ceil(N / maxPoints));
  const sampled = [];
  for (let i = 0; i < N; i += step) sampled.push(rows[i]);
  if (sampled[sampled.length - 1] !== rows[N - 1]) sampled.push(rows[N - 1]);

  const labels = sampled.map(r => {
    const d = new Date(r.recorded_at);
    // Compact label: "Apr 24 15:00"
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
         + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  });
  const balances = sampled.map(r => parseFloat(r.balance));
  const equities = sampled.map(r => parseFloat(r.equity));

  const c = ctx.getContext('2d');
  const grad = c.createLinearGradient(0, 0, 0, 240);
  grad.addColorStop(0, 'rgba(240,180,41,0.25)');
  grad.addColorStop(1, 'rgba(240,180,41,0)');

  _balanceChart = new Chart(c, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Balance',
          data: balances,
          borderColor: CHART_DEFAULTS.gold,
          backgroundColor: grad,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
        {
          label: 'Equity',
          data: equities,
          borderColor: CHART_DEFAULTS.bull,
          backgroundColor: 'transparent',
          borderDash: [4, 4],
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1.5,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: baseLegend(),
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: $${Number(ctx.raw).toFixed(2)}`
          }
        }
      },
      scales: baseScales('', 'USD'),
    }
  });
}

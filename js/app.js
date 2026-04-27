// ── Supabase config (filled after setup) ──────────────────────────────────────
const SUPABASE_URL = 'https://krnorbptbqticmpocdhc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtybm9yYnB0YnF0aWNtcG9jZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4OTYzNDcsImV4cCI6MjA5MjQ3MjM0N30.dpgf9jmQqGmOwoNPjkaSy2zxM9NJLOdA8RP1dUcCqs0';
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Timezone & Session Inference ──────────────────────────────────────────────
// MT5 entry_time is broker server time; HF Markets is usually GMT+3 (summer) /
// GMT+2 (winter). User picks once; default +3. Session is derived from UTC hour.
function getServerTzOffset() {
  const saved = localStorage.getItem('kp56_server_tz');
  return saved == null ? 3 : parseInt(saved, 10);
}
function setServerTzOffset(h) { localStorage.setItem('kp56_server_tz', String(h)); }

function deriveSession(entryTime) {
  if (!entryTime) return null;
  const [h] = entryTime.split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const utcH = ((h - getServerTzOffset()) % 24 + 24) % 24;
  if (utcH < 6) return 'ASIA';
  if (utcH < 12) return 'LONDON';
  if (utcH < 16) return 'OVERLAP';
  if (utcH < 21) return 'NY';
  return 'QUIET';
}

function tradeSession(t) {
  if (t.session) return t.session;
  return deriveSession(t.entry_time);
}

// ── Progress / Discipline ─────────────────────────────────────────────────────
// Baseline = the date the user started trading with the new rules. Before/after
// comparison anchors on this. Stored in localStorage as YYYY-MM-DD.
function getBaselineDate() {
  return localStorage.getItem('kp56_baseline_date') || '';
}
function setBaselineDate(d) {
  if (d) localStorage.setItem('kp56_baseline_date', d);
  else localStorage.removeItem('kp56_baseline_date');
}

// Hold time in minutes (entry_time + exit_time, same-day assumed, wraps at midnight).
function holdMinutes(t) {
  if (!t.entry_time || !t.exit_time) return null;
  const [eh, em] = t.entry_time.split(':').map(Number);
  const [xh, xm] = t.exit_time.split(':').map(Number);
  let diff = (xh * 60 + xm) - (eh * 60 + em);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function hasStopLoss(t) {
  return t.sl_level != null && t.sl_level !== 0 && t.sl_level !== '';
}

// Per-trade discipline — did the trade follow the 3 rules?
// sl   : stop loss was set
// hold : exited within 15 min (requires entry+exit times)
// solo : single entry (no averaging-down)
function tradeDiscipline(t) {
  const sl   = hasStopLoss(t);
  const m    = holdMinutes(t);
  const hold = m != null ? m < 15 : null;   // null = unknown (no exit time)
  const solo = (t.positions?.length || 1) === 1;
  // "all" only counts trades with enough info to judge
  const all = (hold == null) ? null : (sl && hold && solo);
  return { sl, hold, solo, all };
}

// Paginated fetch — Supabase caps each response at 1000 rows by default.
// configure() is a builder fn: (query) => query.select(...).order(...) etc.
async function fetchAllPaged(table, configure, pageSize = 1000) {
  let all = [];
  for (let page = 0; ; page++) {
    const q = configure(db.from(table)).range(page * pageSize, (page + 1) * pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
  }
  return all;
}

// ── Navigation ─────────────────────────────────────────────────────────────────
const pages = document.querySelectorAll('.page');
const navLinks = document.querySelectorAll('nav a[data-page]');

function navigate(pageId) {
  pages.forEach(p => p.classList.toggle('active', p.id === pageId));
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === pageId));
  if (pageId === 'history') loadHistory();  // fires a fresh query (offset 0)
  if (pageId === 'stats') { allDashboardData = []; loadDashboard(); loadPortfolio(); }
  if (pageId === 'numerology') initNumerologyPage();
}

navLinks.forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  navigate(a.dataset.page);
}));

// ── Bias / Result button groups ────────────────────────────────────────────────
function initToggleGroup(selector, dataKey) {
  document.querySelectorAll(selector).forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(selector).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      btn.closest('form') ? null : null;
      window.formState = window.formState || {};
      window.formState[dataKey] = btn.dataset.val;
    });
  });
}
initToggleGroup('.bias-btn[data-group="direction"]', 'direction');
initToggleGroup('.bias-btn[data-group="h1"]', 'bias_h1');
initToggleGroup('.bias-btn[data-group="m5"]', 'bias_m5');
initToggleGroup('.result-btn', 'result');

// ── Positions ──────────────────────────────────────────────────────────────────
let positionCount = 1;

function addPositionRow(container, idx) {
  const row = document.createElement('div');
  row.className = 'position-row';
  row.innerHTML = `
    <div>
      ${idx === 1 ? '<label>Entry Price</label>' : ''}
      <input type="number" step="0.01" placeholder="e.g. 4720.50" class="pos-entry" />
    </div>
    <div>
      ${idx === 1 ? '<label>Lot Size</label>' : ''}
      <input type="number" step="0.01" placeholder="e.g. 0.10" class="pos-lot" />
    </div>
    <div>
      ${idx === 1 ? '<label>&nbsp;</label>' : ''}
      <button type="button" class="btn-icon" onclick="this.closest('.position-row').remove()">×</button>
    </div>
  `;
  container.insertBefore(row, container.querySelector('.btn-add'));
}

document.getElementById('addPosition').addEventListener('click', () => {
  positionCount++;
  addPositionRow(document.getElementById('positionsContainer'), positionCount);
});

// ── Screenshots ────────────────────────────────────────────────────────────────
let screenshotFiles = [];

function initDropZone(zoneId, previewId, fileArray) {
  const zone = document.getElementById(zoneId);
  const preview = document.getElementById(previewId);
  const input = zone.querySelector('input[type="file"]');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files], preview, fileArray);
  });
  input.addEventListener('change', () => handleFiles([...input.files], preview, fileArray));

  // Paste support
  document.addEventListener('paste', e => {
    const items = [...e.clipboardData.items];
    const imgs = items.filter(i => i.type.startsWith('image'));
    if (imgs.length) handleFiles(imgs.map(i => i.getAsFile()), preview, fileArray);
  });
}

function handleFiles(files, preview, fileArray) {
  files.forEach(file => {
    if (!file || !file.type.startsWith('image')) return;
    fileArray.push(file);
    const url = URL.createObjectURL(file);
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const idx = fileArray.length - 1;
    wrap.innerHTML = `
      <img src="${url}" onclick="openImg('${url}')" />
      <button class="img-remove" onclick="removeScreenshot(${idx}, this.closest('.img-wrap'))">×</button>
    `;
    preview.appendChild(wrap);
  });
}

function removeScreenshot(idx, el) {
  screenshotFiles[idx] = null;
  el.remove();
}

window.openImg = url => window.open(url, '_blank');

initDropZone('dropZone', 'screenshotPreview', screenshotFiles);

// ── Form Submit ────────────────────────────────────────────────────────────────
let editingTradeId = null;
let existingScreenshots = [];

document.getElementById('tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = editingTradeId ? 'Updating...' : 'Saving...';

  try {
    const formState = window.formState || {};
    const date = document.getElementById('tradeDate').value;
    const session = document.getElementById('session').value;
    const sl = document.getElementById('slLevel').value;
    const tp = document.getElementById('tpTarget').value;
    const pnl = document.getElementById('totalPnl').value;
    const drawdown = document.getElementById('maxDrawdown').value;
    const entryTime = document.getElementById('entryTime').value;
    const exitTime = document.getElementById('exitTime').value;
    const keyLevels = document.getElementById('keyLevels').value;
    const memo = document.getElementById('memo').value;
    const postNotes = document.getElementById('postNotes').value;

    // Upload new screenshots
    const newUrls = [];
    const validFiles = screenshotFiles.filter(Boolean);
    for (const file of validFiles) {
      const filename = `${Date.now()}_${file.name}`;
      const { error } = await db.storage.from('screenshots').upload(filename, file);
      if (!error) {
        const { data } = db.storage.from('screenshots').getPublicUrl(filename);
        newUrls.push(data.publicUrl);
      }
    }
    const screenshotUrls = [...existingScreenshots, ...newUrls];

    const payload = {
      date, session,
      direction: formState.direction || null,
      bias_h1: formState.bias_h1 || null,
      bias_m5: formState.bias_m5 || null,
      key_levels: keyLevels,
      sl_level: sl ? parseFloat(sl) : null,
      tp_target: tp ? parseFloat(tp) : null,
      result: formState.result || null,
      total_pnl: pnl ? parseFloat(pnl) : null,
      max_drawdown: drawdown ? parseFloat(drawdown) : null,
      entry_time: entryTime || null,
      exit_time: exitTime || null,
      memo, post_trade_notes: postNotes,
      screenshots: screenshotUrls
    };

    let tradeId;
    if (editingTradeId) {
      const { error } = await db.from('trade_ideas').update(payload).eq('id', editingTradeId);
      if (error) throw error;
      tradeId = editingTradeId;
      // Replace positions
      await db.from('positions').delete().eq('trade_idea_id', tradeId);
    } else {
      const { data: trade, error: tradeErr } = await db.from('trade_ideas').insert(payload).select().single();
      if (tradeErr) throw tradeErr;
      tradeId = trade.id;
    }

    // Insert positions
    const posRows = document.querySelectorAll('.position-row');
    const positions = [];
    posRows.forEach(row => {
      const entry = row.querySelector('.pos-entry')?.value;
      const lot = row.querySelector('.pos-lot')?.value;
      if (entry && lot) positions.push({ trade_idea_id: tradeId, entry_price: parseFloat(entry), lot_size: parseFloat(lot) });
    });
    if (positions.length) await db.from('positions').insert(positions);

    showToast(editingTradeId ? 'Trade updated!' : 'Trade saved!', 'success');
    resetForm();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Trade';
  }
});

function resetForm() {
  document.getElementById('tradeForm').reset();
  window.formState = {};
  editingTradeId = null;
  existingScreenshots = [];
  document.querySelectorAll('.bias-btn, .result-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('screenshotPreview').innerHTML = '';
  screenshotFiles.length = 0;
  document.querySelectorAll('.position-row').forEach((r, i) => { if (i > 0) r.remove(); });
  document.querySelector('.pos-entry').value = '';
  document.querySelector('.pos-lot').value = '';
  document.getElementById('submitBtn').textContent = 'Save Trade';
  document.getElementById('tradeDate').value = new Date().toISOString().split('T')[0];
}

function loadTradeIntoForm(t) {
  resetForm();
  editingTradeId = t.id;
  existingScreenshots = t.screenshots || [];

  document.getElementById('tradeDate').value = t.date || '';
  document.getElementById('session').value = t.session || '';
  document.getElementById('keyLevels').value = t.key_levels || '';
  document.getElementById('slLevel').value = t.sl_level || '';
  document.getElementById('tpTarget').value = t.tp_target || '';
  document.getElementById('totalPnl').value = t.total_pnl || '';
  document.getElementById('maxDrawdown').value = t.max_drawdown || '';
  document.getElementById('entryTime').value = t.entry_time ? t.entry_time.slice(0,5) : '';
  document.getElementById('exitTime').value = t.exit_time ? t.exit_time.slice(0,5) : '';
  document.getElementById('memo').value = t.memo || '';
  document.getElementById('postNotes').value = t.post_trade_notes || '';

  // Bias buttons
  window.formState = { direction: t.direction, bias_h1: t.bias_h1, bias_m5: t.bias_m5, result: t.result };
  if (t.direction) document.querySelector(`.bias-btn[data-group="direction"][data-val="${t.direction}"]`)?.classList.add('selected');
  if (t.bias_h1) document.querySelector(`.bias-btn[data-group="h1"][data-val="${t.bias_h1}"]`)?.classList.add('selected');
  if (t.bias_m5) document.querySelector(`.bias-btn[data-group="m5"][data-val="${t.bias_m5}"]`)?.classList.add('selected');
  if (t.result) document.querySelector(`.result-btn[data-val="${t.result}"]`)?.classList.add('selected');

  // Positions
  const container = document.getElementById('positionsContainer');
  document.querySelectorAll('.position-row').forEach((r, i) => { if (i > 0) r.remove(); });
  const firstEntry = container.querySelector('.pos-entry');
  const firstLot = container.querySelector('.pos-lot');
  if (t.positions?.length) {
    firstEntry.value = t.positions[0].entry_price || '';
    firstLot.value = t.positions[0].lot_size || '';
    for (let i = 1; i < t.positions.length; i++) {
      positionCount++;
      addPositionRow(container, positionCount);
      const rows = container.querySelectorAll('.position-row');
      rows[i].querySelector('.pos-entry').value = t.positions[i].entry_price || '';
      rows[i].querySelector('.pos-lot').value = t.positions[i].lot_size || '';
    }
  }

  // Show existing screenshots
  const preview = document.getElementById('screenshotPreview');
  existingScreenshots.forEach((url, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.innerHTML = `
      <img src="${url}" onclick="openImg('${url}')" />
      <button class="img-remove" onclick="existingScreenshots.splice(${i},1);this.closest('.img-wrap').remove()">×</button>
    `;
    preview.appendChild(wrap);
  });

  document.getElementById('submitBtn').textContent = 'Update Trade';
  navigate('new');
}

// ── History ────────────────────────────────────────────────────────────────────
// Unified chronological view across `trade_ideas` (manual logs) and `mt5_trades`
// (auto-synced closed positions). Queries the `v_trades_unified` Postgres view
// with server-side filter pushdown + pagination. Filter changes re-query
// Supabase from offset 0; "Load more" fetches the next page.
const HISTORY_PAGE_SIZE = 50;
let historyRows   = [];     // rows loaded so far (grows with "Load more")
let historyOffset = 0;
let historyTotal  = 0;      // total rows matching current filters (from count)

const historyFilters = {
  direction: 'ALL',   // ALL | BUY | SELL
  outcome:   'ALL',   // ALL | WIN | LOSS | BE
  source:    'ALL',   // ALL | MT5 | MANUAL
  sort:      'newest',
  dateFrom:  '',
  dateTo:    '',
  search:    ''
};

function buildHistoryQuery() {
  let q = db.from('v_trades_unified').select('*', { count: 'exact' });
  const f = historyFilters;
  if (f.direction !== 'ALL') q = q.eq('direction', f.direction);
  if (f.source    !== 'ALL') q = q.eq('source',    f.source);
  if (f.outcome   !== 'ALL') q = q.eq('outcome',   f.outcome);
  if (f.dateFrom) q = q.gte('display_date', f.dateFrom);
  if (f.dateTo)   q = q.lte('display_date', f.dateTo);
  if (f.search) {
    // search_blob is stored lowercased in the view; also escape LIKE wildcards.
    const esc = f.search.toLowerCase().replace(/[%_]/g, '\\$&');
    q = q.ilike('search_blob', `%${esc}%`);
  }
  switch (f.sort) {
    case 'oldest':   q = q.order('sort_key',  { ascending: true  }); break;
    case 'bestpnl':  q = q.order('total_pnl', { ascending: false, nullsFirst: false }); break;
    case 'worstpnl': q = q.order('total_pnl', { ascending: true,  nullsFirst: false }); break;
    default:         q = q.order('sort_key',  { ascending: false });
  }
  return q;
}

async function loadHistory({ append = false } = {}) {
  const container = document.getElementById('historyList');
  const moreBtn   = document.getElementById('loadMoreBtn');

  if (!append) {
    historyRows   = [];
    historyOffset = 0;
    container.innerHTML = '<p class="empty">Loading...</p>';
    if (moreBtn) moreBtn.style.display = 'none';
  } else if (moreBtn) {
    moreBtn.disabled = true;
    moreBtn.textContent = 'Loading...';
  }

  try {
    const q = buildHistoryQuery().range(historyOffset, historyOffset + HISTORY_PAGE_SIZE - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    historyRows   = historyRows.concat(data || []);
    historyOffset = historyRows.length;
    if (count != null) historyTotal = count;
  } catch (err) {
    container.innerHTML = `<p class="empty">Error loading trades: ${err.message}</p>`;
    if (moreBtn) moreBtn.style.display = 'none';
    return;
  }
  renderHistoryCards();
}

function renderHistoryCards() {
  const container = document.getElementById('historyList');
  const summary   = document.getElementById('historySummary');
  const moreBtn   = document.getElementById('loadMoreBtn');
  const rows      = historyRows;

  const net  = rows.reduce((s,r) => s + (Number(r.total_pnl) || 0), 0);
  const wins = rows.filter(r => r.outcome === 'WIN').length;
  const netCls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  summary.innerHTML = historyTotal === 0 && rows.length === 0
    ? ''
    : `Showing <b>${rows.length}</b> of <b>${historyTotal}</b> · ` +
      `<span class="${netCls}">Loaded P&amp;L ${net>=0?'+':''}$${net.toFixed(2)}</span> · ` +
      `${wins} win${wins!==1?'s':''} in loaded page`;

  if (!rows.length) {
    container.innerHTML = historyTotal > 0
      ? '<p class="empty">No trades match your filters.</p>'
      : '<p class="empty">No trades yet. Start logging!</p>';
    if (moreBtn) moreBtn.style.display = 'none';
    return;
  }

  container.innerHTML = '';
  rows.forEach(r => {
    const pnl      = Number(r.total_pnl);
    const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
    const pnlText  = r.total_pnl != null ? (pnl > 0 ? '+' : '') + '$' + pnl.toFixed(2) : '—';
    const card = document.createElement('div');
    card.className = 'trade-card';

    const srcTag = r.source === 'MT5'
      ? '<span class="tag src-mt5">MT5</span>'
      : '<span class="tag src-manual">Manual</span>';
    const dirTag = r.direction
      ? `<span class="tag ${r.direction === 'BUY' ? 'bull' : 'bear'}">${r.direction}</span>`
      : '';
    const extraTags = r.source === 'MT5'
      ? [
          r.symbol ? `<span class="tag session">${r.symbol}</span>` : '',
          r.volume ? `<span class="tag session">${Number(r.volume).toFixed(2)} lots</span>` : ''
        ]
      : [
          r.bias_h1 ? `<span class="tag ${r.bias_h1.toLowerCase()}">M15 ${r.bias_h1}</span>` : '',
          r.bias_m5 ? `<span class="tag ${r.bias_m5.toLowerCase()}">M5 ${r.bias_m5}</span>` : '',
          r.manual_result ? `<span class="tag ${r.manual_result.toLowerCase()}">${r.manual_result}</span>` : '',
          r.positions_count > 1 ? `<span class="tag session">${r.positions_count} pos</span>` : ''
        ];
    // MT5 rows have no stored session — derive from exit_time as before.
    const sessionLabel = r.session || (r.exit_time ? deriveSession(r.exit_time) : null);
    const sessionTag = sessionLabel ? `<span class="tag session">${sessionLabel}</span>` : '';

    card.innerHTML = `
      <div class="header">
        <span class="date">${r.display_date}${r.exit_time ? ' · ' + r.exit_time : ''}</span>
        <span class="pnl ${pnlClass}">${pnlText}</span>
      </div>
      <div class="tags">
        ${srcTag}${dirTag}${extraTags.filter(Boolean).join('')}${sessionTag}
      </div>
    `;
    card.addEventListener('click', () => openTradeCard(r));
    container.appendChild(card);
  });

  if (moreBtn) {
    const remaining = Math.max(0, historyTotal - historyOffset);
    moreBtn.style.display = remaining > 0 ? 'block' : 'none';
    moreBtn.disabled = false;
    moreBtn.textContent = `Load more (${Math.min(HISTORY_PAGE_SIZE, remaining)} of ${remaining} left)`;
  }
}

// On card click, fetch the full base-table row — the view only carries the
// fields needed for the list render, not the full modal detail.
async function openTradeCard(viewRow) {
  try {
    if (viewRow.source === 'MT5') {
      const { data, error } = await db.from('mt5_trades')
        .select('*').eq('id', viewRow.row_id).single();
      if (error) throw error;
      openMT5Modal(data);
    } else {
      const { data, error } = await db.from('trade_ideas')
        .select('*, positions(*)').eq('id', viewRow.row_id).single();
      if (error) throw error;
      openTradeModal(data);
    }
  } catch (err) {
    showToast('Error loading trade: ' + err.message, 'error');
  }
}

// ── History filter wiring ─────────────────────────────────────────────────────
function initHistoryFilters() {
  document.querySelectorAll('.history-filters [data-hfilter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.hfilter;
      document.querySelectorAll(`.history-filters [data-hfilter="${group}"]`)
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      historyFilters[group] = btn.dataset.val;
      loadHistory();
    });
  });
  document.getElementById('historySort').addEventListener('change', e => {
    historyFilters.sort = e.target.value;
    loadHistory();
  });
  document.getElementById('histDateFrom').addEventListener('change', e => {
    historyFilters.dateFrom = e.target.value;
    loadHistory();
  });
  document.getElementById('histDateTo').addEventListener('change', e => {
    historyFilters.dateTo = e.target.value;
    loadHistory();
  });
  let searchTimer = null;
  document.getElementById('histSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      historyFilters.search = e.target.value.trim();
      loadHistory();
    }, 300);
  });
  const moreBtn = document.getElementById('loadMoreBtn');
  if (moreBtn) moreBtn.addEventListener('click', () => loadHistory({ append: true }));
}
initHistoryFilters();

// ── Trade Modal ────────────────────────────────────────────────────────────────
function openTradeModal(t) {
  document.getElementById('modalDate').textContent = `${t.date} — ${t.session || ''}`;
  document.getElementById('modalBias').textContent = `${t.direction || '—'} | M15: ${t.bias_h1 || '—'} | M5: ${t.bias_m5 || '—'}`;
  document.getElementById('modalLevels').textContent = `SL: ${t.sl_level || '—'} | TP: ${t.tp_target || '—'} | Key: ${t.key_levels || '—'}`;
  document.getElementById('modalResult').textContent = `${t.result || '—'} | P&L: ${t.total_pnl != null ? t.total_pnl : '—'}`;
  document.getElementById('modalDrawdown').textContent = t.max_drawdown != null ? `Max Drawdown: -${t.max_drawdown}` : '';
  document.getElementById('modalTime').textContent = (t.entry_time || t.exit_time)
    ? `Entry: ${t.entry_time ? t.entry_time.slice(0,5) : '—'}  →  Exit: ${t.exit_time ? t.exit_time.slice(0,5) : '—'}`
    : '';
  document.getElementById('modalMemo').textContent = t.memo || '—';
  document.getElementById('modalPostNotes').textContent = t.post_trade_notes || '—';

  // Positions
  const posDiv = document.getElementById('modalPositions');
  if (t.positions?.length) {
    posDiv.innerHTML = t.positions.map(p =>
      `<div style="font-size:13px;margin-bottom:4px;">Entry: <b>${p.entry_price}</b> | Lot: <b>${p.lot_size}</b></div>`
    ).join('');
  } else {
    posDiv.textContent = '—';
  }

  // Screenshots
  const imgDiv = document.getElementById('modalImgs');
  imgDiv.innerHTML = '';
  if (t.screenshots?.length) {
    t.screenshots.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      img.onclick = () => window.open(url, '_blank');
      imgDiv.appendChild(img);
    });
  }

  document.getElementById('tradeModal').classList.add('open');
  document.getElementById('editModal').onclick = () => {
    document.getElementById('tradeModal').classList.remove('open');
    loadTradeIntoForm(t);
  };
  document.getElementById('deleteModal').onclick = async () => {
    if (!confirm('Delete this trade? This cannot be undone.')) return;
    await db.from('positions').delete().eq('trade_idea_id', t.id);
    await db.from('trade_ideas').delete().eq('id', t.id);
    document.getElementById('tradeModal').classList.remove('open');
    showToast('Trade deleted', 'error');
    loadHistory();
  };
}

document.getElementById('closeModal').addEventListener('click', () => {
  document.getElementById('tradeModal').classList.remove('open');
});

// ── Setup Verdict (Phase 3b/3c context analysis) ──────────────────────────────
// Scores how each signal (Mario bias / OB / Rainbow per TF) lined up with the
// trade direction at open. All weights default 1.0 — tune individual signals
// once we have enough closed trades to see which actually predict outcomes.
const SIGNAL_WEIGHTS = {
  bias_m15: 1.0, bias_m5: 1.0, ob_status: 1.0,
  rainbow_m1: 1.0, rainbow_m5: 1.0, rainbow_m15: 1.0, rainbow_h1: 1.0,
};
const VERDICT_ICON = { aligned: '✅', against: '❌', neutral: '⚠️', missing: '—' };

function biasVerdict(dir, bias) {
  if (!bias) return 'missing';
  if (dir === 'sell') return bias === 'BEAR' ? 'aligned' : bias === 'BULL' ? 'against' : 'neutral';
  if (dir === 'buy')  return bias === 'BULL' ? 'aligned' : bias === 'BEAR' ? 'against' : 'neutral';
  return 'neutral';
}
function obVerdict(dir, ob) {
  if (!ob) return 'missing';
  const supply = /supply/i.test(ob), demand = /demand/i.test(ob);
  if (dir === 'sell') return supply ? 'aligned' : demand ? 'against' : 'neutral';
  if (dir === 'buy')  return demand ? 'aligned' : supply ? 'against' : 'neutral';
  return 'neutral';
}
// band_idx: -1=above all MAs, 0..6=between MA-N and MA-(N+1), 7=below slow MA.
// "Bear half" is band ≥ 4 (price below MA-5). "Bull half" is band ≤ 1.
function rainbowVerdict(dir, band, stack) {
  if (band == null || !stack) return 'missing';
  if (stack === 'MIXED') return 'neutral';
  const bearHalf = band >= 4;
  const bullHalf = band <= 1;
  if (dir === 'sell') {
    if (bearHalf && stack === 'BEAR_STACK') return 'aligned';
    if (bullHalf && stack === 'BULL_STACK') return 'against';
    return 'neutral';
  }
  if (dir === 'buy') {
    if (bullHalf && stack === 'BULL_STACK') return 'aligned';
    if (bearHalf && stack === 'BEAR_STACK') return 'against';
    return 'neutral';
  }
  return 'neutral';
}
function convictionPct(signals) {
  let earned = 0, total = 0;
  for (const { verdict, weight } of signals) {
    if (verdict === 'missing') continue;
    total += weight;
    if (verdict === 'aligned')      earned += weight;
    else if (verdict === 'neutral') earned += weight * 0.5;
  }
  return total > 0 ? Math.round((earned / total) * 100) : null;
}
function rainbowCell(t, tf, moment) {
  const b = t[`rainbow_${tf}_${moment}_band_idx`];
  const o = t[`rainbow_${tf}_${moment}_order_state`];
  const c = t[`rainbow_${tf}_${moment}_candle`];
  const bp = t[`rainbow_${tf}_${moment}_body_points`];
  if (b == null && !o) return '—';
  const band = b === -1 ? 'above all' : b === 7 ? 'below slow' : `band ${b}`;
  const stk = (o || '').replace('_STACK','').toLowerCase() || '—';
  const candle = c ? ` · ${c}${bp != null ? ' '+bp+'pt' : ''}` : '';
  return `${band} · ${stk}${candle}`;
}
function verdictRow(s) {
  const cls = { aligned:'va', against:'vx', neutral:'vn', missing:'vm' }[s.verdict];
  return `<tr class="${cls}"><td class="vlabel">${s.label}</td><td class="vvalue">${s.value}</td><td class="vicon">${VERDICT_ICON[s.verdict]}</td></tr>`;
}

function setupVerdictHTML(t) {
  const dir = (t.type || '').toLowerCase();
  if (dir !== 'sell' && dir !== 'buy') return '';

  const sig = (key, label, verdict, value) => ({
    key, label, verdict, value, weight: SIGNAL_WEIGHTS[key] ?? 1.0,
  });
  const buildSet = (moment) => [
    sig('bias_m15',    'M15 bias',     biasVerdict(dir, t.bias_m15),  t.bias_m15 || '—'),
    sig('bias_m5',     'M5 bias',      biasVerdict(dir, t.bias_m5),   t.bias_m5  || '—'),
    sig('ob_status',   'OB',           obVerdict(dir, t.ob_status),   t.ob_status || '—'),
    sig('rainbow_m1',  'Rainbow M1',   rainbowVerdict(dir, t[`rainbow_m1_${moment}_band_idx`],  t[`rainbow_m1_${moment}_order_state`]),  rainbowCell(t,'m1',moment)),
    sig('rainbow_m5',  'Rainbow M5',   rainbowVerdict(dir, t[`rainbow_m5_${moment}_band_idx`],  t[`rainbow_m5_${moment}_order_state`]),  rainbowCell(t,'m5',moment)),
    sig('rainbow_m15', 'Rainbow M15',  rainbowVerdict(dir, t[`rainbow_m15_${moment}_band_idx`], t[`rainbow_m15_${moment}_order_state`]), rainbowCell(t,'m15',moment)),
    sig('rainbow_h1',  'Rainbow H1',   rainbowVerdict(dir, t[`rainbow_h1_${moment}_band_idx`],  t[`rainbow_h1_${moment}_order_state`]),  rainbowCell(t,'h1',moment)),
  ];
  const openSig = buildSet('open');
  if (openSig.every(s => s.verdict === 'missing')) return '';

  const closeSig = buildSet('close');
  const rainbowDiffers = ['m1','m5','m15','h1'].some(tf =>
    t[`rainbow_${tf}_open_band_idx`]    !== t[`rainbow_${tf}_close_band_idx`] ||
    t[`rainbow_${tf}_open_order_state`] !== t[`rainbow_${tf}_close_order_state`]
  );
  // Also count Mario bias drift between open and close — bias columns are
  // close-time only today, so this is just open vs same-stored-value (no diff).
  // Future: if we capture bias_at_open separately, expand the comparison.

  const conv = convictionPct(openSig);
  const convCls = conv == null ? '' : conv >= 70 ? 'pos' : conv <= 40 ? 'neg' : '';
  const marioBadge = t.mario_decision ? `
    <span class="tag ${t.mario_decision === 'WAIT' ? 'wait' : t.mario_decision === 'BUY' ? 'bull' : t.mario_decision === 'SELL' ? 'bear' : ''}">Mario: ${t.mario_decision}</span>
  ` : '';
  const num2 = n => n != null ? Number(n).toFixed(2) : '—';
  const svpLine = t.svp_poc != null
    ? `<p class="svp-line">SVP — POC ${num2(t.svp_poc)} · VAH ${num2(t.svp_vah)} · VAL ${num2(t.svp_val)}${t.mario_session ? ' · '+t.mario_session : ''}</p>`
    : '';

  return `
    <div class="modal-section verdict-section">
      <h4>Setup at Open
        ${conv != null ? `<span class="conviction ${convCls}">Conviction ${conv}%</span>` : ''}
        ${marioBadge}
      </h4>
      <table class="verdict-table"><tbody>${openSig.map(verdictRow).join('')}</tbody></table>
      ${svpLine}
      ${rainbowDiffers ? `
        <h4 style="margin-top:14px">Setup at Close <span class="conviction-mini">(differs from open)</span></h4>
        <table class="verdict-table"><tbody>${closeSig.map(verdictRow).join('')}</tbody></table>
      ` : `<p class="close-note">Setup at close: identical to open (trade was short or signals stable)</p>`}
    </div>
  `;
}

// ── MT5 Trade Modal (read-only) ───────────────────────────────────────────────
function openMT5Modal(t) {
  const num = n => n != null ? Number(n).toFixed(2) : '—';
  const px  = n => n != null ? Number(n).toFixed(5) : '—';
  const fmt = s => s ? new Date(s).toLocaleString() : '—';
  const pnl = (Number(t.profit)||0) + (Number(t.swap)||0) + (Number(t.commission)||0);
  const pnlCls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';

  document.getElementById('mt5ModalTitle').textContent =
    `${t.symbol} · ${(t.type||'').toUpperCase()} · ${Number(t.volume).toFixed(2)} lots`;

  document.getElementById('mt5ModalBody').innerHTML = `
    <div class="modal-section"><h4>Result</h4>
      <p class="${pnlCls}" style="font-size:20px;font-weight:700">${pnl>=0?'+':''}$${num(pnl)}</p>
      <p style="font-size:12px;color:var(--text-dim);margin-top:4px">
        Profit $${num(t.profit)} · Swap $${num(t.swap)} · Commission $${num(t.commission)}
      </p>
    </div>
    ${setupVerdictHTML(t)}
    <div class="modal-section"><h4>Time</h4>
      <p>Open: ${fmt(t.open_time)}<br/>Close: ${fmt(t.close_time)}</p>
    </div>
    <div class="modal-section"><h4>Prices</h4>
      <p>Open <b>${px(t.open_price)}</b> → Close <b>${px(t.close_price)}</b><br/>
         SL ${px(t.sl)} · TP ${px(t.tp)}</p>
    </div>
    ${t.balance_after != null ? `
      <div class="modal-section"><h4>After Close</h4>
        <p>Balance $${num(t.balance_after)} · Equity $${num(t.equity_after)}</p>
      </div>` : ''}
    ${t.comment ? `<div class="modal-section"><h4>Comment</h4><p>${t.comment}</p></div>` : ''}
    <div class="modal-section"><h4>IDs</h4>
      <p style="font-size:12px;color:var(--text-dim)">
        Account #${t.account_login} · Deal ${t.deal_ticket} · Position ${t.position_id} · Magic ${t.magic || 0}
      </p>
    </div>
  `;
  document.getElementById('mt5Modal').classList.add('open');
}

document.getElementById('closeMT5Modal').addEventListener('click', () => {
  document.getElementById('mt5Modal').classList.remove('open');
});


// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Init ───────────────────────────────────────────────────────────────────────
// Defer to DOMContentLoaded so dashboard.js + balance.js have parsed first —
// navigate('stats') calls loadDashboard() / loadPortfolio() which live in
// those later <script> tags. Without this gate the call ran synchronously at
// app.js parse time, threw ReferenceError, and Stats stayed empty until the
// user round-tripped through History.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tradeDate').value = new Date().toISOString().split('T')[0];
  navigate('stats');
});
